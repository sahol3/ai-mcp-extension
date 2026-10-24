#!/usr/bin/env node
/*
 * Offline self-test: everything that can be proven without a browser.
 *
 * Daemon lifecycle, routing, chunk reassembly, the policy rails, media helpers and the
 * tool catalogue's schemas. Uses a throwaway data directory and port so it never touches
 * a running install.
 *
 * Run from PowerShell, not the Bash tool — that sandbox severs outbound loopback
 * WebSockets a few milliseconds after they connect, which reads exactly like a daemon bug.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PORT = 18894;
const DATA = mkdtempSync(join(tmpdir(), 'ai-mcp-selftest-'));
process.env.AI_MCP_PORT = String(PORT);
process.env.AI_MCP_DATA_DIR = DATA;
process.env.AI_MCP_AUTOSPAWN = '0';

const HERE = dirname(fileURLToPath(import.meta.url));
const { default: WebSocket } = await import('ws');
const { config } = await import('./config.js');
const { Bridge } = await import('./bridge.js');
const { tools, toolMap } = await import('./tools.js');
const policy = await import('./policy.js');
const media = await import('./media.js');

let pass = 0, fail = 0;
const results = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; results.push({ name, detail }); console.log(`  FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (s) => console.log('\n' + s);

// ------------------------------------------------------------------ config

section('config');
ok('data dir is the override', config.dataDir === DATA, config.dataDir);
ok('port is the override', config.port === PORT, config.port);
ok('media dir exists', existsSync(config.mediaDir));
ok('default host is loopback only', config.host === '127.0.0.1', config.host);
ok('ask timeout is generous enough for deep research', config.askTimeoutMs >= 300000, config.askTimeoutMs);
ok('generate timeout exceeds ask timeout', config.generateTimeoutMs > config.askTimeoutMs);
ok('all three sites enabled by default', ['gemini', 'flow', 'chatgpt'].every((s) => config.enabledSites.includes(s)), config.enabledSites);
ok('delete is off by default', config.allowDelete === false);
ok('port differs from the whatsapp bridge', config.port !== 8788);

// ------------------------------------------------------------------- media

section('media helpers');
ok('mime with parameters resolves', media.extensionFor('audio/ogg; codecs=opus') === 'ogg', media.extensionFor('audio/ogg; codecs=opus'));
ok('charset parameter ignored', media.extensionFor('text/plain; charset=utf-8') === 'txt');
ok('known image type', media.extensionFor('image/webp') === 'webp');
ok('unknown subtype falls back to top level', media.extensionFor('video/x-matroska') === 'mp4', media.extensionFor('video/x-matroska'));
ok('wholly unknown type falls back to bin', media.extensionFor('application/x-thing') === 'bin');
ok('isImage true for jpeg with params', media.isImage('image/jpeg; foo=1') === true);
ok('isImage false for video', media.isImage('video/mp4') === false);
ok('isImage false for undefined', media.isImage(undefined) === false);

const saved = media.saveMedia(Buffer.from('hello').toString('base64'), 'text/plain', 'note.txt');
ok('saveMedia writes the bytes', existsSync(saved.path) && readFileSync(saved.path, 'utf8') === 'hello', saved);
ok('saveMedia reports the length', saved.bytes === 5, saved);
// Filenames from a web page are untrusted; a traversal attempt must not escape the dir.
const evil = media.saveMedia(Buffer.from('x').toString('base64'), 'text/plain', '../../../../escaped.txt');
ok('saveMedia refuses path traversal', evil.path.startsWith(config.mediaDir) && !evil.path.includes('..'), evil.path);
ok('saveMedia keeps a usable extension', evil.filename.endsWith('.txt'), evil.filename);

const outText = media.resolveOutgoing({ text: 'inline' });
ok('resolveOutgoing passes text through', outText.text === 'inline' && outText.mimetype === 'text/plain', outText);
const outB64 = media.resolveOutgoing({ base64: 'AAAA', mimetype: 'image/png' });
ok('resolveOutgoing names a base64 upload', outB64.filename === 'upload.png', outB64);
const outFile = media.resolveOutgoing({ path: join(HERE, 'config.js') });
ok('resolveOutgoing reads a real file', outFile.base64.length > 100 && outFile.filename === 'config.js', { len: outFile.base64.length, name: outFile.filename });
ok('resolveOutgoing infers the mime type', outFile.mimetype === 'application/octet-stream' || outFile.mimetype.includes('/'), outFile.mimetype);
let threw = null;
try { media.resolveOutgoing({}); } catch (e) { threw = e.message; }
ok('resolveOutgoing rejects an empty attachment', /needs one of/.test(threw ?? ''), threw);
try { media.resolveOutgoing({ path: join(DATA, 'nope.bin') }); threw = null; } catch (e) { threw = e.message; }
ok('resolveOutgoing rejects a missing file', /file_not_found/.test(threw ?? ''), threw);

// ------------------------------------------------------------------ policy

section('policy');
ok('ask is a write tool', policy.WRITE_TOOLS.has('chatgpt_ask'));
ok('status is not a write tool', !policy.WRITE_TOOLS.has('ai_status'));
ok('reads are not rate limited', !policy.PROMPT_TOOLS.has('chatgpt_conversations'));
ok('flow generation has its own budget', policy.GENERATE_TOOLS.has('flow_generate'));
/*
 * Every tool that can spend Flow credits has to be inside BOTH gates. A credit-spending tool
 * that is only a write tool would be billed without ever touching the generation budget, and
 * one that is neither would run in read-only mode.
 */
for (const t of ['flow_generate_image', 'flow_generate_video', 'flow_upscale_image']) {
  ok(`${t} is budgeted and gated`, policy.GENERATE_TOOLS.has(t) && policy.WRITE_TOOLS.has(t));
}
ok('siteOfTool reads the prefix', policy.siteOfTool('gemini_ask') === 'gemini' && policy.siteOfTool('ai_status') === null);

config.allowDelete = false;
threw = null;
try { policy.checkPolicy('chatgpt_delete', {}); } catch (e) { threw = e.message; }
ok('delete blocked by default', /delete_disabled/.test(threw ?? ''), threw);
threw = null;
try { policy.checkPolicy('gemini_conversation_action', { action: 'rename' }); } catch (e) { threw = e.message; }
ok('non-destructive conversation actions are allowed', threw === null, threw);
threw = null;
try { policy.checkPolicy('gemini_conversation_action', { action: 'delete' }); } catch (e) { threw = e.message; }
ok('destructive conversation action is blocked', /delete_disabled/.test(threw ?? ''), threw);
config.allowDelete = true;
threw = null;
try { policy.checkPolicy('chatgpt_delete', {}); } catch (e) { threw = e.message; }
ok('delete permitted once opted in', threw === null, threw);
config.allowDelete = false;

config.readOnly = true;
threw = null;
try { policy.checkPolicy('gemini_ask', { prompt: 'x' }); } catch (e) { threw = e.message; }
ok('read-only blocks prompting', /read_only_mode/.test(threw ?? ''), threw);
threw = null;
try { policy.checkPolicy('gemini_messages', {}); } catch (e) { threw = e.message; }
ok('read-only still allows reading', threw === null, threw);
config.readOnly = false;

config.allowEval = false;
threw = null;
try { policy.checkPolicy('ai_eval', { code: '1' }); } catch (e) { threw = e.message; }
ok('eval can be disabled', /eval_disabled/.test(threw ?? ''), threw);
config.allowEval = true;

config.enabledSites = ['chatgpt'];
threw = null;
try { policy.checkPolicy('gemini_ask', { prompt: 'x' }); } catch (e) { threw = e.message; }
ok('disabled site is refused', /site_disabled/.test(threw ?? ''), threw);
threw = null;
try { policy.checkPolicy('chatgpt_messages', {}); } catch (e) { threw = e.message; }
ok('enabled site still works', threw === null, threw);
threw = null;
try { policy.checkPolicy('ai_click', { site: 'flow' }); } catch (e) { threw = e.message; }
ok('site gate also applies to generic tools', /site_disabled/.test(threw ?? ''), threw);
config.enabledSites = ['gemini', 'flow', 'chatgpt'];

const beforeMin = config.maxPromptsPerMinute;
config.maxPromptsPerMinute = 3;
let allowed = 0;
threw = null;
for (let i = 0; i < 6; i++) {
  try { policy.checkPolicy('chatgpt_ask', { prompt: 'x' }); allowed++; } catch (e) { threw = e.message; break; }
}
ok('prompt rate limit trips at the configured ceiling', allowed === 3, { allowed, threw });
ok('rate limit message explains itself', /runaway agent loops/.test(threw ?? ''), threw);
config.maxPromptsPerMinute = beforeMin;

const beforeGen = config.maxGenerationsPerHour;
config.maxGenerationsPerHour = 2;
let genAllowed = 0;
threw = null;
for (let i = 0; i < 5; i++) {
  try { policy.checkPolicy('flow_generate', { prompt: 'x' }); genAllowed++; } catch (e) { threw = e.message; break; }
}
ok('generation budget is separate and tighter', genAllowed === 2, { genAllowed, threw });
ok('generation limit mentions credits', /credits/.test(threw ?? ''), threw);
config.maxGenerationsPerHour = beforeGen;

const rs = policy.rateStatus();
ok('rateStatus reports the counters', typeof rs.prompts_last_hour === 'number' && Array.isArray(rs.enabled_sites), rs);

policy.audit('chatgpt_ask', { prompt: 'x'.repeat(1000), base64: 'y'.repeat(500) }, 'ok');
const auditLine = existsSync(config.logPath) ? readFileSync(config.logPath, 'utf8').trim().split('\n').pop() : '';
const auditRec = auditLine ? JSON.parse(auditLine) : null;
ok('audit writes a line for writes', !!auditRec, auditLine);
ok('audit truncates long prompts', auditRec?.args?.prompt?.length < 500, auditRec?.args?.prompt?.length);
ok('audit redacts base64 payloads', /^<\d+ chars>$/.test(auditRec?.args?.base64 ?? ''), auditRec?.args?.base64);

// ------------------------------------------------------------- tool catalogue

section('tool catalogue');
ok('tools are registered', tools.length >= 70, tools.length);
ok('tool names are unique', new Set(tools.map((t) => t.name)).size === tools.length);
ok('every tool has a handler', tools.every((t) => typeof t.handler === 'function'));
ok('every tool has a description', tools.every((t) => typeof t.description === 'string' && t.description.length > 30));
ok('every schema is a closed object', tools.every((t) => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false));
const badRequired = tools.filter((t) => (t.inputSchema.required ?? []).some((r) => !(r in t.inputSchema.properties)));
ok('required fields all exist in properties', badRequired.length === 0, badRequired.map((t) => t.name));
const undescribed = tools.flatMap((t) => Object.entries(t.inputSchema.properties).filter(([, s]) => !s.description).map(([k]) => `${t.name}.${k}`));
ok('every parameter is described', undescribed.length === 0, undescribed);
for (const prefix of ['ai_', 'gemini_', 'chatgpt_', 'flow_']) {
  ok(`catalogue covers ${prefix}*`, tools.filter((t) => t.name.startsWith(prefix)).length >= 8, tools.filter((t) => t.name.startsWith(prefix)).length);
}
ok('site enum matches the three sites', tools.find((t) => t.name === 'ai_open_site').inputSchema.properties.site.enum.join(',') === 'gemini,flow,chatgpt');
ok('toolMap is complete', toolMap.size === tools.length && toolMap.get('ai_status'));
// Every write tool the catalogue exposes should be known to the policy layer, or the rails
// silently do not apply to it.
const unknownWrites = tools.filter((t) => /^(gemini|chatgpt|flow)_(ask|send|generate)/.test(t.name)).filter((t) => !policy.WRITE_TOOLS.has(t.name));
ok('policy knows every prompting tool', unknownWrites.length === 0, unknownWrites.map((t) => t.name));

// -------------------------------------------------------------------- daemon

section('daemon lifecycle');
const daemon = spawn(process.execPath, [join(HERE, 'daemon.js')], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
let daemonLog = '';
daemon.stderr.on('data', (d) => { daemonLog += d.toString(); });

const dial = (role, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?role=${role}${token ? '&token=' + token : ''}`);
    const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });

let daemonUp = false;
for (let i = 0; i < 40 && !daemonUp; i++) {
  await sleep(150);
  daemonUp = /daemon listening/.test(daemonLog);
}
ok('daemon starts and announces its port', daemonUp, daemonLog.slice(0, 300));
ok('daemon writes its own log file', existsSync(config.daemonLogPath));

// A second daemon on the same port must exit cleanly rather than fight for it — this is
// what makes the on-demand spawn safe to fire blindly from every agent session.
const dup = spawn(process.execPath, [join(HERE, 'daemon.js')], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
let dupLog = '';
dup.stderr.on('data', (d) => { dupLog += d.toString(); });
const dupCode = await new Promise((r) => { dup.on('exit', r); setTimeout(() => r('did-not-exit'), 6000); });
ok('duplicate daemon exits instead of fighting for the port', dupCode === 3, { dupCode, dupLog: dupLog.slice(0, 200) });
ok('duplicate daemon says why', /already in use/.test(dupLog), dupLog.slice(0, 200));

const bridge = new Bridge();
bridge.start();
ok('client connects to the daemon', await bridge.ready(10000));

const st = await bridge.daemonStatus();
ok('bridge.status reports the endpoint', st.endpoint === `ws://127.0.0.1:${PORT}`, st.endpoint);
ok('bridge.status reports no extension yet', st.extension_connected === false, st);
ok('bridge.status counts this client', st.mcp_clients >= 1, st);

// With no extension attached, a page call must fail with an actionable message rather than
// hanging until the timeout.
let pageErr = null;
try { await bridge.call('chatgpt.status', {}, 5000); } catch (e) { pageErr = e.message; }
ok('page call without an extension fails fast', /extension_not_connected/.test(pageErr ?? ''), pageErr);
ok('that failure names what to check', /AI Studio MCP Bridge/.test(pageErr ?? ''), pageErr);

// ---------------------------------------------------- routing & reassembly

section('routing and chunk reassembly');
const fakeExt = await dial('extension');
const seenMethods = [];
fakeExt.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === 'ping') { fakeExt.send(JSON.stringify({ kind: 'pong' })); return; }
  if (msg.kind !== 'req') return;
  seenMethods.push({ method: msg.method, params: msg.params });

  if (msg.method === 'test.small') {
    fakeExt.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, body: JSON.stringify({ data: { echo: msg.params } }) }));
    return;
  }
  if (msg.method === 'test.big') {
    // Deliberately out of order: reassembly must key on seq, not arrival.
    const body = JSON.stringify({ data: { blob: 'x'.repeat(30000) } });
    const parts = [body.slice(0, 10000), body.slice(10000, 20000), body.slice(20000)];
    const frames = parts.map((b, i) => ({ kind: 'res', id: msg.id, ok: true, seq: i, total: 3, body: b }));
    for (const f of [frames[2], frames[0], frames[1]]) fakeExt.send(JSON.stringify(f));
    return;
  }
  if (msg.method === 'test.error') {
    fakeExt.send(JSON.stringify({ kind: 'res', id: msg.id, ok: false, body: JSON.stringify({ error: { message: 'page_said_no', code: 42 } }) }));
    return;
  }
});
await sleep(400);

const st2 = await bridge.daemonStatus();
ok('daemon sees the extension', st2.extension_connected === true, st2);

const echo = await bridge.call('test.small', { a: 1, site: 'gemini' }, 8000);
ok('request routes to the extension', echo.echo.a === 1, echo);
ok('parameters survive the round trip', echo.echo.site === 'gemini', echo);
ok('daemon forwarded the method name unchanged', seenMethods.at(-1)?.method === 'test.small', seenMethods.at(-1));

const big = await bridge.call('test.big', {}, 10000);
ok('chunked response reassembles', big.blob.length === 30000, big.blob?.length);
ok('reassembly is order independent', big.blob === 'x'.repeat(30000));

let perr = null;
try { await bridge.call('test.error', {}, 8000); } catch (e) { perr = e; }
ok('page errors surface as errors', perr?.message === 'page_said_no', perr?.message);
ok('page error detail is preserved', perr?.detail?.code === 42, perr?.detail);

// Concurrency: ids must not collide, and one slow call must not block another.
const many = await Promise.all([1, 2, 3, 4, 5].map((n) => bridge.call('test.small', { n }, 8000)));
ok('concurrent calls each get their own reply', many.map((m) => m.echo.n).join(',') === '1,2,3,4,5', many.map((m) => m.echo.n));

// ------------------------------------------------------------------- events

section('events');
fakeExt.send(JSON.stringify({ kind: 'evt', body: JSON.stringify({ event: 'net.response', data: { id: 'n1', url: 'https://chatgpt.com/backend-api/conversation' } }) }));
fakeExt.send(JSON.stringify({ kind: 'evt', body: JSON.stringify({ event: 'net.response', data: { id: 'n2', url: 'https://gemini.google.com/x' } }) }));
await sleep(300);

const evs = await bridge.getEvents({ limit: 10 });
ok('events are buffered', evs.events.length >= 2, evs.count);
ok('event cursor advances', evs.cursor >= 2, evs.cursor);
const filtered = await bridge.getEvents({ contains: 'backend-api' });
ok('events filter by payload content', filtered.events.length === 1, filtered.events.map((e) => e.data?.url));
const sinceAll = await bridge.getEvents({ since: evs.cursor });
ok('since cursor excludes what was already read', sinceAll.events.length === 0, sinceAll.events.length);

const waitPromise = bridge.waitEvent({ types: ['net.response'], contains: 'labs.google', timeout_ms: 6000 });
await sleep(200);
fakeExt.send(JSON.stringify({ kind: 'evt', body: JSON.stringify({ event: 'net.response', data: { url: 'https://labs.google/fx' } }) }));
const waited = await waitPromise;
ok('wait_event resolves on a match', waited.matched === true && /labs\.google/.test(JSON.stringify(waited.data)), waited);
const timedOut = await bridge.waitEvent({ types: ['never.happens'], timeout_ms: 800 });
ok('wait_event times out cleanly', timedOut.matched === false && timedOut.timed_out === true, timedOut);

// ------------------------------------------------------------ socket hygiene

section('socket hygiene');
const stranger = new WebSocket(`ws://127.0.0.1:${PORT}/?role=banana`);
const strangerClose = await new Promise((r) => { stranger.on('close', (c) => r(c)); stranger.on('error', () => r('error')); setTimeout(() => r('open'), 3000); });
ok('unknown roles are rejected', strangerClose === 4400, strangerClose);

// A newer extension supersedes the old one; the old socket closing must not disturb the
// live one, which is the bug that produced an endless reconnect storm.
const secondExt = await dial('extension');
await sleep(500);
const st3 = await bridge.daemonStatus();
ok('a replacement extension is still connected', st3.extension_connected === true, st3);
secondExt.close();
await sleep(400);

// -------------------------------------------------------------------- done

daemon.kill();
fakeExt.close();
try { bridge.ws?.close(); } catch {}
await sleep(200);
rmSync(DATA, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const r of results) console.log('  - ' + r.name + (r.detail !== undefined ? ': ' + JSON.stringify(r.detail).slice(0, 400) : ''));
}
process.exit(fail ? 1 : 0);
