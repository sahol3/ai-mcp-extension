#!/usr/bin/env node
/*
 * MCP protocol conformance, over a real stdio transport.
 *
 * A fresh server process is the only honest check of a tools.js change: an agent that is
 * already connected keeps the schema it saw at session start, so edits are invisible to it
 * until it restarts. This spawns one, speaks JSON-RPC to it, and asserts on the answers.
 *
 * No browser required — the tool calls here are expected to report "no extension", and
 * asserting that they do so *cleanly* is the point.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'src', 'index.js');
const DATA = mkdtempSync(join(tmpdir(), 'ai-mcp-mcpcheck-'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
};

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AI_MCP_DATA_DIR: DATA,
    AI_MCP_PORT: '18895',       // nothing listens here
    AI_MCP_AUTOSPAWN: '0',      // and nothing should be started
  },
});

let stdout = '';
let stderr = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  stdout += d.toString();
  let nl;
  while ((nl = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, nl).trim();
    stdout = stdout.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { pending.get('__nonjson__')?.(line); nonJson.push(line); continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});
child.stderr.on('data', (d) => { stderr += d.toString(); });

const nonJson = [];

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}

console.log('MCP protocol check\n');

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'mcp-check', version: '1.0.0' },
});
ok('initialize answers', !!init.result, init);
ok('server identifies itself', init.result?.serverInfo?.name === 'ai-studio', init.result?.serverInfo);
ok('server declares tool capability', !!init.result?.capabilities?.tools, init.result?.capabilities);
ok('server ships usage instructions', (init.result?.instructions ?? '').length > 200, (init.result?.instructions ?? '').length);
ok('instructions name the entry point', /ai_status/.test(init.result?.instructions ?? ''));
ok('instructions carry the untrusted-content warning', /untrusted/.test(init.result?.instructions ?? ''));

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await rpc('tools/list', {});
const tools = list.result?.tools ?? [];
ok('tools/list answers', tools.length > 0, list);
ok('catalogue is substantial', tools.length >= 70, tools.length);
ok('every tool has name, description and schema', tools.every((t) => t.name && t.description && t.inputSchema?.type === 'object'));
ok('no handler leaks into the wire schema', tools.every((t) => !('handler' in t)));
for (const name of ['ai_status', 'ai_open_site', 'ai_probe', 'ai_selftest', 'ai_replay', 'gemini_ask', 'chatgpt_ask', 'flow_generate', 'flow_observe']) {
  ok(`catalogue includes ${name}`, tools.some((t) => t.name === name));
}

// With nothing listening on the port and autospawn off, ai_status must still answer — and
// it must answer with the command to fix it rather than an opaque failure.
const status = await rpc('tools/call', { name: 'ai_status', arguments: {} }, 40000);
const statusText = status.result?.content?.[0]?.text ?? '';
ok('ai_status answers with no daemon running', !!statusText, status);
ok('ai_status reports the problem', /Cannot reach the ai-mcp daemon/.test(statusText), statusText.slice(0, 200));
ok('ai_status gives the exact start command', /node "?.*daemon\.js/.test(statusText), statusText.slice(0, 400));
ok('ai_status still reports local policy', /policy/.test(statusText));

const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
ok('unknown tool is an error result, not a crash', unknown.result?.isError === true, unknown);
ok('unknown tool names itself', /no_such_tool/.test(unknown.result?.content?.[0]?.text ?? ''));

// A page tool with no browser: the failure must be typed and actionable.
const noBrowser = await rpc('tools/call', { name: 'chatgpt_status', arguments: {} }, 40000);
const nbText = noBrowser.result?.content?.[0]?.text ?? '';
ok('page tool without a browser fails cleanly', noBrowser.result?.isError === true, noBrowser);
ok('that failure suggests the fix', /daemon|extension/.test(nbText), nbText.slice(0, 300));

// Policy errors must arrive as tool errors too, not as protocol errors.
const del = await rpc('tools/call', { name: 'chatgpt_delete', arguments: { conversation_id: 'x' } }, 20000);
ok('delete is refused by policy', /delete_disabled/.test(del.result?.content?.[0]?.text ?? ''), del.result?.content?.[0]?.text);
ok('policy refusal is a tool error, not a protocol error', del.result?.isError === true && !del.error, del);

/*
 * A missing required argument must be refused here and now. Clients are not obliged to
 * validate against inputSchema, and letting the call through means it travels to the
 * browser and returns a timeout minutes later — which looks like a broken bridge.
 */
const started = Date.now();
const missing = await rpc('tools/call', { name: 'gemini_ask', arguments: {} }, 20000);
const missingText = missing.result?.content?.[0]?.text ?? '';
ok('missing required argument is refused', missing.result?.isError === true, missing);
ok('the refusal names the argument', /prompt/.test(missingText), missingText);
ok('the refusal is immediate, not a timeout', Date.now() - started < 3000, Date.now() - started);

ok('stdout carried only JSON-RPC', nonJson.length === 0, nonJson.slice(0, 3));
ok('diagnostics went to stderr', /MCP server ready/.test(stderr), stderr.slice(0, 300));
ok('stderr names the tool count', /\d+ tools/.test(stderr), stderr.slice(0, 300));

child.kill();

/*
 * With --live, run the same checks against the real daemon and browser. This is the only
 * assertion that exercises every hop at once — MCP client, stdio, daemon, service worker,
 * content relay, page — and a fresh server process is the only honest way to do it, because
 * an already-connected agent keeps the schema and the connection it had at session start.
 */
if (argvHas('live')) {
  console.log('\nlive stack (daemon + browser must be running)');
  const liveChild = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const livePending = new Map();
  let liveOut = '';
  let liveId = 1;
  liveChild.stdout.on('data', (d) => {
    liveOut += d.toString();
    let nl;
    while ((nl = liveOut.indexOf('\n')) >= 0) {
      const line = liveOut.slice(0, nl).trim();
      liveOut = liveOut.slice(nl + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); livePending.get(m.id)?.(m); livePending.delete(m.id); } catch {}
    }
  });
  liveChild.stderr.on('data', () => {});
  const liveRpc = (method, params, ms = 120000) => {
    const id = liveId++;
    liveChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      const t = setTimeout(() => { livePending.delete(id); rej(new Error('timeout ' + method)); }, ms);
      livePending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  };

  await liveRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-check-live', version: '1' } });
  liveChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const statusRes = await liveRpc('tools/call', { name: 'ai_status', arguments: {} }, 120000);
  const body = statusRes.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  ok('live: ai_status returns parseable JSON', !!parsed, body.slice(0, 200));
  ok('live: the whole chain is up', parsed?.ok === true, parsed?.problem ?? parsed);
  // ai_status is a compact summary: a connected tab is an object with a `state`; a missing
  // one is the string "no tab". (The check used to read the verbose tree's fields.)
  const connected = ['gemini', 'chatgpt', 'flow'].filter((s) => parsed?.sites?.[s] && typeof parsed.sites[s] === 'object' && parsed.sites[s].state);
  ok('live: the daemon sees the extension', !!parsed?.daemon?.pid && connected.length > 0, { daemon: parsed?.daemon, connected });
  ok('live: every site reports a state', ['gemini', 'flow', 'chatgpt'].every((s) => !!parsed?.sites?.[s]), Object.keys(parsed?.sites ?? {}));

  const first = connected[0];
  if (first) {
    const probe = await liveRpc('tools/call', { name: 'ai_probe', arguments: { site: first } }, 90000);
    const ptext = probe.result?.content?.[0]?.text ?? '';
    ok(`live: ai_probe reaches the ${first} page`, /"matched"|"selectors"/.test(ptext) && !probe.result?.isError, ptext.slice(0, 200));
  } else {
    ok('live: at least one site tab is connected', false, parsed?.sites);
  }
  liveChild.kill();
}

function argvHas(n) { return process.argv.slice(2).includes('--' + n); }
rmSync(DATA, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) for (const f of failures) console.log('  - ' + f.name);
process.exit(fail ? 1 : 0);
