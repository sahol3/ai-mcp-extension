#!/usr/bin/env node
/*
 * Live verification against real, signed-in sessions.
 *
 * Everything in e2e.mjs runs without an account, which covers the plumbing but cannot
 * prove the part that matters: that a prompt reaches the model and the answer comes back
 * intact. This suite does that, and it asserts on values rather than on "it did not throw"
 * — a bridge that returns an empty string is the failure mode worth catching, and it looks
 * identical to success if you only check for errors.
 *
 * Prerequisites:
 *   1. node server/src/daemon.js                     (the daemon is running)
 *   2. node scripts/launch-browser.mjs               (a browser with the extension)
 *   3. Sign in to Gemini / Flow / ChatGPT in that window, once.
 *
 * Usage: node scripts/verify-live.mjs [--sites gemini,chatgpt] [--generate] [--keep-chats]
 *   Sends a handful of short prompts. --generate additionally runs ONE Flow generation,
 *   which spends real credits and is off by default. --keep-chats leaves the scratch
 *   conversations in place instead of archiving them.
 *
 * Run from PowerShell, not the Bash tool: that sandbox severs outbound loopback WebSockets.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const HOST = process.env.AI_MCP_HOST || '127.0.0.1';
const PORT = Number(process.env.AI_MCP_PORT || 8791);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const SITES = (opt('sites') ?? 'gemini,flow,chatgpt').split(',').map((s) => s.trim()).filter(Boolean);

let pass = 0, fail = 0, skip = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
};
const note = (name, why) => { skip++; console.log(`  SKIP  ${name} — ${why}`); };
const section = (s) => console.log('\n' + s);

// ------------------------------------------------------------------ transport

const ws = new WebSocket(`ws://${HOST}:${PORT}/?role=client`);
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.kind !== 'res') return;
  const p = pending.get(m.id);
  if (!p) return;
  let body = m.body;
  if (m.total != null && m.total > 1) {
    p.chunks ??= new Array(m.total).fill(null);
    p.chunks[m.seq] = m.body;
    if (p.chunks.some((c) => c === null)) return;
    body = p.chunks.join('');
  }
  pending.delete(m.id);
  clearTimeout(p.timer);
  const parsed = JSON.parse(body);
  m.ok ? p.resolve(parsed.data) : p.reject(new Error(parsed.error?.message || 'error'));
});
ws.on('error', (e) => {
  console.error(`Cannot reach the daemon on ws://${HOST}:${PORT} (${e.message}).\nStart it with:  node server/src/daemon.js`);
  process.exit(2);
});
await new Promise((r) => ws.on('open', r));

const call = (method, params = {}, ms = 120000) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, ms);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ kind: 'req', id, method, params }));
  });
const tryCall = (m, p, ms) => call(m, p, ms).catch((e) => ({ __error: String(e.message) }));

const stamp = Date.now().toString(36).toUpperCase().slice(-5);

console.log(`AI Studio MCP Bridge — live verification\n  daemon: ws://${HOST}:${PORT}\n  sites:  ${SITES.join(', ')}\n  marker: ${stamp}\n`);

// ------------------------------------------------------------------- bring-up

section('bridge');
const ext = await tryCall('ext.status', {}, 20000);
ok('extension is connected', ext.ws === 'connected', ext.__error ?? ext.ws);
ok('extension reports its endpoint', ext.endpoint === `ws://${HOST}:${PORT}`, ext.endpoint);

const live = {};
for (const site of SITES) {
  if (!ext.sites?.[site]) {
    const opened = await tryCall('ext.open', { site, focus: true }, 60000);
    if (opened.__error) { note(`${site} tab`, opened.__error); continue; }
    await new Promise((r) => setTimeout(r, 8000));
  }
  const st = await tryCall(`${site}.status`, {}, 45000);
  live[site] = st;
  ok(`${site}: bridge answers`, st.site === site, st.__error ?? st.site);
}

/* ============================== Gemini ============================== */

if (SITES.includes('gemini') && live.gemini?.site === 'gemini') {
  section('gemini');
  const st = live.gemini;
  if (!st.signed_in) {
    note('gemini live checks', `not signed in (state=${st.ready?.state}) — sign in to gemini.google.com in the bridge browser`);
  } else {
    ok('gemini: session is signed in', st.signed_in === true, st.ready);
    ok('gemini: XSRF token resolved', st.tokens?.at != null, st.tokens);
    ok('gemini: build label resolved', /^boq_/.test(st.tokens?.bl ?? ''), st.tokens?.bl);
    ok('gemini: language tag is sane', /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(st.tokens?.hl ?? ''), st.tokens?.hl);
    ok('gemini: reports a selected model', typeof st.model === 'string' && st.model.length > 0, st.model);
    ok('gemini: discovered live rpcids', (st.captured_rpcids ?? []).length >= 3, st.captured_rpcids);

    const models = await tryCall('gemini.models', {}, 60000);
    ok('gemini: mode picker lists options', (models.options ?? []).length > 0, models.__error ?? models);

    await tryCall('gemini.new_chat', {}, 45000);
    await new Promise((r) => setTimeout(r, 1500));

    // The whole point of the bridge: a prompt in, the model's own words out.
    const answer = await tryCall('gemini.ask', {
      prompt: `Reply with exactly this token and nothing else: GEM-${stamp}`,
      timeout_ms: 240000,
    }, 300000);
    ok('gemini: ask returns the model\'s answer', typeof answer.text === 'string' && answer.text.length > 0, answer.__error ?? answer);
    ok('gemini: the answer is the one we asked for', String(answer.text ?? '').includes(`GEM-${stamp}`), String(answer.text ?? '').slice(0, 200));
    ok('gemini: answer is settled, not mid-stream', answer.settled === true && answer.still_streaming === false, { settled: answer.settled, streaming: answer.still_streaming });
    ok('gemini: a conversation id was captured', typeof answer.conversation_id === 'string' && answer.conversation_id.length > 3, answer.conversation_id);

    // Markdown reconstruction is the piece most likely to silently degrade.
    const code = await tryCall('gemini.ask', {
      prompt: 'Reply with ONLY a python code block that prints the number 424242. No commentary.',
      timeout_ms: 240000,
    }, 300000);
    ok('gemini: code answers keep their fences', /```/.test(code.markdown ?? ''), (code.markdown ?? '').slice(0, 300));
    ok('gemini: code block content survives', /424242/.test(code.markdown ?? ''), (code.markdown ?? '').slice(0, 300));
    ok('gemini: markdown differs from flattened text', (code.markdown ?? '') !== (code.text ?? ''), { md: (code.markdown ?? '').slice(0, 120), txt: (code.text ?? '').slice(0, 120) });

    const msgs = await tryCall('gemini.messages', {}, 60000);
    ok('gemini: conversation reads back both roles', (msgs.turns ?? []).some((t) => t.role === 'user') && (msgs.turns ?? []).some((t) => t.role === 'model'), msgs.__error ?? (msgs.turns ?? []).map((t) => t.role));
    ok('gemini: our prompt is in the transcript', JSON.stringify(msgs.turns ?? []).includes(`GEM-${stamp}`), (msgs.turns ?? []).length);

    const convos = await tryCall('gemini.conversations', { scroll_pages: 1 }, 90000);
    ok('gemini: sidebar lists conversations', (convos.conversations ?? []).length > 0, convos.__error ?? convos.total);
    ok('gemini: conversations have titles', (convos.conversations ?? []).every((c) => typeof c.title === 'string'), (convos.conversations ?? []).slice(0, 3));

    const last = await tryCall('gemini.last_reply', {}, 45000);
    ok('gemini: last_reply matches the thread', last.found === true && (last.markdown ?? '').length > 0, last.__error ?? last.found);
  }
}

/* ============================== ChatGPT ============================== */

if (SITES.includes('chatgpt') && live.chatgpt?.site === 'chatgpt') {
  section('chatgpt');
  const st = live.chatgpt;
  if (!st.auth?.ok) {
    note('chatgpt live checks', `no session token (${st.auth?.error ?? st.ready?.state}) — sign in to chatgpt.com in the bridge browser`);
  } else {
    ok('chatgpt: bearer token resolved', st.auth.ok === true, st.auth);
    ok('chatgpt: account details resolved', !!st.account?.plan, st.account);

    const models = await tryCall('chatgpt.models', {}, 60000);
    ok('chatgpt: account model list is populated', (models.models ?? []).length > 0, models.__error ?? models);
    ok('chatgpt: models carry slugs', (models.models ?? []).every((m) => typeof m.slug === 'string'), (models.models ?? []).slice(0, 3));

    const convos = await tryCall('chatgpt.conversations', { limit: 5 }, 60000);
    ok('chatgpt: conversation list loads', Array.isArray(convos.items), convos.__error ?? convos);
    ok('chatgpt: conversations carry ids and titles', (convos.items ?? []).every((c) => c.id && 'title' in c), (convos.items ?? []).slice(0, 2));

    await tryCall('chatgpt.new_chat', {}, 45000);
    await new Promise((r) => setTimeout(r, 1500));

    const answer = await tryCall('chatgpt.ask', {
      prompt: `Reply with exactly this token and nothing else: GPT-${stamp}`,
      timeout_ms: 240000,
    }, 300000);
    ok('chatgpt: ask returns the model\'s answer', typeof answer.text === 'string' && answer.text.length > 0, answer.__error ?? answer);
    ok('chatgpt: the answer is the one we asked for', String(answer.text ?? '').includes(`GPT-${stamp}`), String(answer.text ?? '').slice(0, 200));
    // The stream is the preferred source precisely because the DOM has already lost the markdown.
    ok('chatgpt: answer text came from the response stream', answer.text_source === 'stream', { source: answer.text_source, stream_id: answer.stream_request_id });
    ok('chatgpt: conversation id captured from the stream', /^[0-9a-f-]{36}$/i.test(answer.conversation_id ?? ''), answer.conversation_id);
    ok('chatgpt: message id captured', typeof answer.message_id === 'string' && answer.message_id.length > 10, answer.message_id);
    ok('chatgpt: model slug captured', typeof answer.model_slug === 'string' && answer.model_slug.length > 0, answer.model_slug);
    ok('chatgpt: answer is settled', answer.settled === true && answer.still_streaming === false, { settled: answer.settled, streaming: answer.still_streaming });

    const code = await tryCall('chatgpt.ask', {
      prompt: 'Reply with ONLY a python code block that prints the number 424242. No commentary.',
      timeout_ms: 240000,
    }, 300000);
    ok('chatgpt: code answers keep their fences', /```/.test(code.text ?? ''), (code.text ?? '').slice(0, 300));
    ok('chatgpt: code block content survives', /424242/.test(code.text ?? ''), (code.text ?? '').slice(0, 300));
    const blocks = await tryCall('chatgpt.code_blocks', {}, 45000);
    ok('chatgpt: code blocks extract from the DOM too', (blocks.blocks ?? []).some((b) => /424242/.test(b.code ?? '')), blocks.__error ?? blocks.blocks);

    // Reading the stored tree back must return the branch we are looking at.
    const convo = await tryCall('chatgpt.conversation', { conversation_id: answer.conversation_id }, 60000);
    ok('chatgpt: stored conversation reads back', (convo.messages ?? []).length >= 2, convo.__error ?? convo.messages?.length);
    ok('chatgpt: our prompt is in the stored branch', JSON.stringify(convo.messages ?? []).includes(`GPT-${stamp}`), (convo.messages ?? []).map((m) => m.role));
    ok('chatgpt: reasoning traces are excluded by default', (convo.messages ?? []).every((m) => m.content_type !== 'thoughts'), (convo.messages ?? []).map((m) => m.content_type));

    const msgs = await tryCall('chatgpt.messages', {}, 60000);
    ok('chatgpt: DOM transcript has both roles', (msgs.messages ?? []).some((m) => m.role === 'user') && (msgs.messages ?? []).some((m) => m.role === 'assistant'), msgs.__error ?? (msgs.messages ?? []).map((m) => m.role));

    if (!flag('keep-chats') && answer.conversation_id) {
      const archived = await tryCall('chatgpt.archive', { conversation_id: answer.conversation_id }, 45000);
      ok('chatgpt: scratch conversation archived', archived.ok === true, archived);
    }
  }
}

/* =============================== Flow =============================== */

if (SITES.includes('flow') && live.flow?.site === 'flow') {
  section('flow');
  const st = live.flow;
  if (!st.on_flow || !st.signed_in || st.ready?.state !== 'app') {
    note('flow live checks', `not on a signed-in Flow app page (state=${st.ready?.state}) — open labs.google/fx/tools/flow and sign in`);
  } else {
    ok('flow: on a Flow page', st.on_flow === true, st.url);
    const projects = await tryCall('flow.projects', {}, 90000);
    ok('flow: projects enumerate', Array.isArray(projects.dom_projects), projects.__error ?? projects);

    const credits = await tryCall('flow.credits', {}, 45000);
    ok('flow: credits are readable', credits.credits != null || credits.source === 'unknown', credits);

    const options = await tryCall('flow.options', {}, 120000);
    ok('flow: option pickers enumerate', Array.isArray(options.pickers), options.__error ?? options);

    const observed = await tryCall('flow.observe', { host: 'all', limit: 10 }, 60000);
    ok('flow: app traffic is captured', (observed.requests ?? []).length > 0, observed.__error ?? observed.count);

    if (flag('generate')) {
      const gen = await tryCall('flow.generate', {
        prompt: 'A slow overhead shot of morning fog drifting across a still lake.',
        timeout_ms: 900000,
      }, 960000);
      ok('flow: generation produced media', (gen.media ?? []).length > 0, gen.__error ?? gen);
      ok('flow: generation reached the backend', gen.started_request === true, gen.generation_requests);
    } else {
      note('flow generation', 'off by default because it spends real credits — pass --generate to run one');
    }
  }
}

// -------------------------------------------------------------------- done

section('summary');
console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  - ' + f.name + (f.detail !== undefined ? ': ' + JSON.stringify(f.detail).slice(0, 300) : '')); }
if (skip) console.log('\nSkipped checks need a signed-in session in the bridge browser (scripts/launch-browser.mjs).');
ws.close();
process.exit(fail ? 1 : 0);
