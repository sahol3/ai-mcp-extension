#!/usr/bin/env node
/*
 * End-to-end proof: launch a real Chromium with the extension loaded, open all three
 * sites, and drive the full chain from a stub MCP server —
 *
 *   stub WS server -> service worker -> content relay -> MAIN world -> the page
 *
 * Does NOT require any account. A signed-out page still exercises injection, transport,
 * routing, the network capture hook, the DOM toolkit and every in-page assertion — which
 * is the part that breaks. Assertions that need a session are in verify-live.mjs.
 *
 * Usage: node scripts/e2e.mjs [--keep] [--profile <dir>] [--visible] [--sites gemini,chatgpt]
 *   Runs headed by default, with the window parked off-screen. Extensions under
 *   --headless=new load but their service worker lifecycle is materially different, and
 *   these apps behave differently again, so headed is the honest configuration.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');

/*
 * The stub has to listen where the extension already dials. A fresh profile has empty
 * extension storage, so the worker uses the built-in default — there is no way to tell it
 * about a different port without a profile that has already been configured by hand.
 * That means the real daemon must not be holding the port while this runs.
 */
const PORT = 8791;
const CDP = 19223;   // only used to diagnose a browser that never connects

/** Read from the source so the suite cannot silently accept a stale staged copy. */
const CORE_EXPECTED = Number(
  /const CORE_VERSION = (\d+)/.exec(readFileSync(join(EXT, 'page', 'core.js'), 'utf8'))?.[1] ?? 0
);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const SITES = (opt('sites') ?? 'gemini,flow,chatgpt').split(',').map((s) => s.trim()).filter(Boolean);

/*
 * Browser choice, in the order that actually works on Windows today.
 *
 * Branded Google Chrome is LAST on purpose. Since Chrome 137 it refuses the switches this
 * needs — its own log says "--disable-extensions-except is not allowed in Google Chrome,
 * ignoring" — and then starts perfectly with no extension loaded, which is indistinguishable
 * from a bridge that will not connect. Edge and Opera still honour them. (Chrome is fine for
 * *using* the bridge; only the command-line switch is blocked, so loading the extension by
 * hand from chrome://extensions works.)
 *
 * The Playwright-managed chromium is skipped for a different reason: it passes existsSync
 * and then fails to spawn with a bare `spawn UNKNOWN` (a broken side-by-side manifest), so
 * "the file is there" is not evidence it will launch — hence the launcher below walks the
 * list until one actually starts.
 */
const CHROMES = [
  opt('chrome'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  join(homedir(), 'AppData/Local/Programs/Opera GX/opera.exe'),
  join(homedir(), 'AppData/Local/Programs/Opera/opera.exe'),
  join(homedir(), 'AppData/Local/Programs/Opera Air/opera.exe'),
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p) => p && existsSync(p));
if (!CHROMES.length) { console.error('No Chromium-based browser found.'); process.exit(2); }

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (s) => console.log('\n' + s);

// A page-side throw must be reported as a failed assertion, not take the whole run down
// with an unhandled rejection three suites early.
process.on('unhandledRejection', (e) => { ok('no unhandled rejection', false, String(e?.message || e)); });

// ------------------------------------------------------- stub MCP server

let ext = null;
const pending = new Map();
const events = [];
let reqId = 0;

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — the real ai-mcp daemon is probably running.\n` +
      'Stop it first (the extension must dial this stub, not the daemon):\n' +
      '  Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*daemon.js*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId }\n'
    );
    process.exit(2);
  }
  console.error('stub server error: ' + e.message);
  process.exit(2);
});
wss.on('connection', (socket, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');
  if (role !== 'extension') return socket.close();
  ext = socket;
  console.log('  ..    extension connected to the stub server');
  socket.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.kind === 'evt') { events.push(JSON.parse(m.body)); return; }
    if (m.kind === 'ping') { socket.send(JSON.stringify({ kind: 'pong' })); return; }
    if (m.kind !== 'res') return;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.total > 1) {
      p.chunks ??= new Array(m.total).fill(null);
      p.chunks[m.seq] = m.body;
      if (p.chunks.some((c) => c === null)) return;
      m.body = p.chunks.join('');
    }
    pending.delete(m.id);
    clearTimeout(p.timer);
    const parsed = JSON.parse(m.body);
    m.ok ? p.resolve(parsed.data) : p.reject(new Error(parsed.error?.message || 'error'));
  });
  socket.on('close', () => { if (ext === socket) ext = null; });
});

const call = (method, params = {}, ms = 60000) =>
  new Promise((resolve, reject) => {
    if (!ext) return reject(new Error('extension not connected'));
    const id = 'e2e-' + ++reqId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, ms);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ kind: 'req', id, method, params }));
  });

const tryCall = (m, p, ms) => call(m, p, ms).catch((e) => ({ __error: String(e.message) }));

// ------------------------------------------------------------ launch chrome

/*
 * Kill every other browser carrying this extension, first thing.
 *
 * Any of them — a previous run that died mid-suite, or the persistent
 * scripts/launch-browser.mjs window — keeps reconnecting to whatever is listening on the
 * port, and the stub simply accepts the newest connection. The suite then drives someone
 * else's browser running an older staged build while appearing to test this one, and every
 * resulting failure points at the wrong thing. The match is deliberately broad: every path
 * this project uses contains "ai-mcp" (ai-mcp-e2e-*, ai-mcp-ext-*, ~/.ai-mcp/*).
 */
if (process.platform === 'win32') {
  const killed = spawnSync('powershell', ['-NoProfile', '-Command',
    // Any browser carrying an unpacked extension from one of this project's paths.
    // Matching on --load-extension keeps it from touching the user's own browsers.
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--load-extension*' -and ($_.CommandLine -like '*ai-mcp*' -or $_.CommandLine -like '*aimcp*') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; 'killed ' + $_.ProcessId } catch {} }",
  ], { encoding: 'utf8', cwd: tmpdir() });
  const lines = String(killed.stdout || '').trim();
  if (lines) console.log('  ..    cleaned up leftovers: ' + lines.split(/\r?\n/).length + ' process(es)');
} else {
  spawnSync('pkill', ['-f', '[a]i-mcp'], { encoding: 'utf8' });
}
await sleep(2500);

const profile = opt('profile') ?? mkdtempSync(join(tmpdir(), 'ai-mcp-e2e-'));

/*
 * The extension is staged onto local disk before loading. This project lives on a mapped
 * network drive, and Chrome silently declines to load an unpacked extension from one —
 * the browser starts, the page loads, and nothing ever connects, which looks exactly like
 * a bridge bug rather than a path problem.
 */
const staged = join(mkdtempSync(join(tmpdir(), 'ai-mcp-ext-')), 'extension');
cpSync(EXT, staged, { recursive: true });

const args = [
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${staged}`,
  `--load-extension=${staged}`,
  '--no-first-run',
  '--no-default-browser-check',
  /*
   * Chrome 137 disabled the --load-extension switch behind a feature flag. Without turning
   * that feature off, the browser starts perfectly, loads no extension, and reports nothing
   * — the failure is indistinguishable from a bridge that will not connect. Merged into one
   * --disable-features because a second occurrence of the flag replaces the first.
   */
  '--disable-features=DisableLoadExtensionCommandLineSwitch,Translate,OptimizationGuideModelDownloading',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  `--remote-debugging-port=${CDP}`,
  ...(flag('visible') ? [] : ['--window-position=-2400,-2400', '--window-size=1280,900']),
  'about:blank',
];

console.log(`AI Studio MCP Bridge — end-to-end\n  profile: ${profile}\n  sites:   ${SITES.join(', ')}\n`);

/*
 * Walk the candidates until one actually starts. cwd is forced onto a local path: this
 * project lives on a mapped network drive, and spawning a browser with a UNC-backed
 * working directory fails with a bare `spawn UNKNOWN` that says nothing about the cause.
 */
function launch() {
  for (const path of CHROMES) {
    try {
      const proc = spawn(path, args, { stdio: 'ignore', detached: false, cwd: tmpdir() });
      let died = null;
      proc.on('error', (e) => { died = e; });
      if (!died && proc.pid) { console.log(`  browser: ${path} (pid ${proc.pid})\n`); return proc; }
    } catch (e) {
      console.log(`  ..    ${path} would not start (${e.code}); trying the next candidate`);
    }
  }
  console.error('Every browser candidate failed to launch:\n' + CHROMES.join('\n'));
  process.exit(2);
}
const chrome = launch();

async function cleanup(code) {
  try { chrome.kill(); } catch {}
  await sleep(400);
  wss.close();
  if (!opt('profile') && !flag('keep')) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
  process.exit(code);
}

/*
 * The browser must die even when the suite does not reach cleanup(). A run that ends on an
 * unhandled rejection used to leave its browser alive, and that browser kept reconnecting
 * to whatever was listening on the port — so the *next* run silently drove the previous
 * build. Every exit path now kills it.
 */
process.on('exit', () => { if (!flag('keep')) { try { chrome.kill(); } catch {} } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup(130));
process.on('uncaughtException', (e) => { console.error('uncaught: ' + (e?.stack || e)); cleanup(1); });

// The service worker dials in on its own as soon as it starts.
section('extension bring-up');
let connected = false;
for (let i = 0; i < 80 && !connected; i++) { await sleep(500); connected = !!ext; }
ok('service worker connects to the local socket', connected);
if (!connected) {
  // Ask the browser what it actually loaded, rather than guessing.
  let targets = [];
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch (e) { targets = [{ error: String(e.message) }]; }
  console.log('\nThe worker never connected. Browser targets:');
  for (const t of targets) console.log(`  ${t.type ?? '?'}  ${t.title ?? ''}  ${t.url ?? t.error ?? ''}`);
  console.log(
    targets.some((t) => String(t.url ?? '').startsWith('chrome-extension://'))
      ? '\nThe extension IS loaded, so the worker started and failed to reach the socket. Check that nothing else holds port ' + PORT + '.'
      : '\nNo extension target — the browser did not load it at all. Chrome 137+ ignores --load-extension unless DisableLoadExtensionCommandLineSwitch is turned off.'
  );
  await cleanup(1);
}

const status0 = await call('ext.status');
ok('ext.status answers', !!status0.endpoint, status0);
ok('worker knows all three sites', ['gemini', 'flow', 'chatgpt'].every((s) => s in (status0.known_sites ?? {})), Object.keys(status0.known_sites ?? {}));
/*
 * Nothing should be connected before this run opens its own tabs. If something is, another
 * browser has the socket and every assertion after this point would describe that browser
 * instead of ours — so stop here rather than producing a page of misleading failures.
 */
ok('no site tabs yet', Object.keys(status0.sites ?? {}).length === 0, status0.sites);
if (Object.keys(status0.sites ?? {}).length > 0) {
  console.log(
    '\nAnother browser with this extension is already connected to port ' + PORT + '.\n' +
    'Close it (or let the leftover cleanup above run) and try again — the suite cannot tell\n' +
    'its own browser from someone else\'s, and would report that one\'s results as this one\'s.'
  );
  await cleanup(1);
}

// Routing must refuse rather than guess when there is nothing to route to.
const noTab = await tryCall('sys.status', {}, 15000);
ok('site-agnostic call with no tabs is refused clearly', /no_site_tab_connected/.test(noTab.__error ?? ''), noTab);
const badSite = await tryCall('sys.status', { site: 'banana' }, 15000);
ok('unknown site is refused', /unknown_site/.test(badSite.__error ?? ''), badSite);
const noGemini = await tryCall('gemini.status', {}, 20000);
ok('namespaced call with no tab names the site', /no_gemini_tab/.test(noGemini.__error ?? ''), noGemini);

// ------------------------------------------------------------------ per site

const siteResults = {};
for (const site of SITES) {
  section(`site: ${site}`);
  const opened = await call('ext.open', { site, focus: true }, 60000);
  ok(`${site}: tab opens`, !!opened.tabId, opened);

  /*
   * Wait for the bridge to answer, and then keep waiting for the app itself to finish
   * rendering. The bridge answers long before Angular/React has painted anything, so
   * stopping at the first successful sys.status probes an empty page and reports every
   * selector as missing — which looks like broken selectors rather than an early read.
   */
  let ready = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = await tryCall('sys.status', { site }, 20000);
    if (s.__error) continue;
    ready = s;
    // A signed-out wall is a settled state too; there is nothing further to wait for.
    if (s.ready?.ready || /signed_out|not_on_flow/.test(s.ready?.state ?? '')) break;
  }
  ok(`${site}: page bridge answers`, !!ready, ready);
  if (!ready) {
    // Say what the browser actually has open, rather than leaving "it didn't answer".
    const t = await tryCall('ext.tabs', {}, 15000);
    console.log(`  ..    worker sees tabs: ${JSON.stringify(t.tabs ?? t)}`);
    let targets = [];
    try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch {}
    for (const x of targets) console.log(`  ..    target ${x.type}: ${String(x.url).slice(0, 120)}`);
    siteResults[site] = { reachable: false };
    continue;
  }

  ok(`${site}: bridge reports the right site`, ready.site === site, ready.site);
  // Pinning the version catches the failure mode that wasted the most time here: a browser
  // left over from an earlier run reconnecting to this stub, so the suite drives the old
  // staged extension while appearing to test the new one.
  ok(`${site}: bridge is the current build (core v${CORE_EXPECTED})`, ready.core_version === CORE_EXPECTED, ready.core_version);
  ok(`${site}: site module loaded`, typeof ready.site_version === 'number', ready.site_version);
  ok(`${site}: readiness has a named state`, typeof ready.ready?.state === 'string', ready.ready);
  ok(`${site}: url matches the site`, typeof ready.url === 'string' && ready.url.startsWith('https://'), ready.url);

  /*
   * The capture hook installs at document_start, so an app that has booted at all makes
   * requests through it — but not necessarily by the time readiness first reports true,
   * which on a server-rendered page can precede the first client fetch. Poll rather than
   * sample once; a hook that is genuinely absent still fails.
   */
  let records = ready.net_records;
  for (let i = 0; i < 20 && records === 0; i++) {
    await sleep(1000);
    records = (await tryCall('sys.status', { site }, 20000)).net_records ?? 0;
  }
  ok(`${site}: network hook captured the app's own traffic`, records > 0, records);

  const st = await call('ext.status');
  ok(`${site}: worker tracks the tab`, !!st.sites?.[site], st.sites);

  // ---- in-page assertion suite (works signed out) ----
  const self = await tryCall('sys.selftest', { site }, 180000);
  ok(`${site}: in-page selftest ran`, typeof self.total === 'number' && self.total > 30, self.__error ?? self.total);
  ok(`${site}: in-page selftest fully passed`, self.failed === 0, self.failures?.slice(0, 8) ?? self.__error);
  siteResults[site] = { selftest: `${self.passed ?? '?'}/${self.total ?? '?'}`, state: ready.ready?.state };

  // ---- probe ----
  const probe = await call('sys.probe', { site }, 60000);
  ok(`${site}: probe resolves selectors`, Object.keys(probe.selectors ?? {}).length > 5, Object.keys(probe.selectors ?? {}).length);
  ok(`${site}: probe lists visible buttons`, Array.isArray(probe.buttons), probe.buttons?.length);
  // Only an app that has actually rendered can be expected to match anything. On a
  // signed-out wall, "nothing matched" is the correct answer, not a broken selector.
  if (ready.ready?.ready) {
    ok(`${site}: probe reports which candidate matched`, Object.values(probe.selectors ?? {}).some((v) => v.matched_selector), probe.selectors);
    ok(`${site}: probe found the site's primary input`, !!probe.selectors?.composer?.matched_selector || !!probe.selectors?.promptBox?.matched_selector, probe.selectors?.composer ?? probe.selectors?.promptBox);
  } else {
    console.log(`  ..    ${site} is "${ready.ready?.state}" — selector matching not asserted (needs a signed-in session)`);
  }

  // ---- generic DOM ----
  const q = await call('dom.query', { site, selector: 'body', limit: 1 }, 30000);
  ok(`${site}: dom.query returns a described element`, q.items?.[0]?.tag === 'body', q.items?.[0]);
  const txt = await call('dom.text', { site, max: 500 }, 30000);
  ok(`${site}: dom.text returns a string`, typeof txt.text === 'string', txt);
  if (ready.ready?.ready) ok(`${site}: dom.text returns rendered text`, txt.text.length > 0, txt.text?.slice(0, 80));
  const missing = await tryCall('dom.click', { site, selector: '#definitely-not-here-aimcp' }, 20000);
  ok(`${site}: clicking a missing element fails loudly`, /click_target_not_found/.test(missing.__error ?? ''), missing);

  // ---- captured network ----
  const netList = await call('net.list', { site, limit: 5 }, 30000);
  ok(`${site}: net.list returns records`, netList.total_captured > 0, netList.total_captured);
  ok(`${site}: records carry a url and method`, !!netList.items?.[0]?.url && !!netList.items?.[0]?.method, netList.items?.[0]);
  ok(`${site}: bodies are withheld unless asked`, netList.items?.[0]?.text === undefined, netList.items?.[0]);
  const netFull = await call('net.list', { site, limit: 1, body: true }, 30000);
  ok(`${site}: bodies are included when asked`, 'text' in (netFull.items?.[0] ?? {}), Object.keys(netFull.items?.[0] ?? {}));

  // A request we make ourselves, captured by our own hook — proves the loop end to end.
  const marker = `aimcp-e2e-${Date.now()}`;
  const made = await call('net.request', { site, url: `${new URL(ready.url).origin}/${marker}` }, 45000);
  ok(`${site}: net.request executes in the page`, typeof made.status === 'number', made.status);
  // A request the bridge issues itself must land in the capture buffer like any other,
  // or a replay is invisible to net.list and cannot be inspected or re-issued.
  const found = await call('net.list', { site, url: marker, limit: 5 }, 30000);
  ok(`${site}: a bridge-issued request is captured too`, found.matched >= 1, found.matched);
  const id = found.items?.at(-1)?.id;
  const one = await tryCall('net.get', { site, id }, 30000);
  ok(`${site}: net.get returns headers and body`, !!one.req_headers && typeof one.text === 'string', one.__error ?? Object.keys(one));
  ok(`${site}: net.get decodes the response`, !!one.decoded?.format, one.__error ?? one.decoded?.format);

  // ---- replay ----
  const replayed = await tryCall('net.replay', { site, id, decode: true }, 60000);
  ok(`${site}: replay re-issues a captured request`, typeof replayed.status === 'number', replayed.__error ?? replayed.status);
  ok(`${site}: replay names its template`, replayed.template_id === id, { got: replayed.template_id, want: id });
  const noTemplate = await tryCall('net.replay', { site, id: 'n999999' }, 20000);
  ok(`${site}: replay without a template is refused`, /no_template_request/.test(noTemplate.__error ?? ''), noTemplate);

  // ---- eval, across whatever CSP this site ships ----
  const ev = await tryCall('sys.eval', { site, code: 'return 6 * 7;' }, 60000);
  ok(`${site}: eval returns a value`, ev.value === 42, ev.__error ?? ev);
  ok(`${site}: eval reports which strategy the CSP allowed`, ['function', 'blob-module', 'inline-nonce'].includes(ev.via), ev.__error ?? ev.via);
  const evArgs = await tryCall('sys.eval', { site, code: 'return args.a + args.b;', args: { a: 2, b: 3 } }, 60000);
  ok(`${site}: eval receives arguments`, evArgs.value === 5, evArgs.__error ?? evArgs);
  const evThrow = await tryCall('sys.eval', { site, code: 'throw new Error("boom");' }, 60000);
  ok(`${site}: eval surfaces page exceptions`, /boom|eval_blocked/.test(evThrow.__error ?? JSON.stringify(evThrow)), evThrow);

  // ---- unknown method ----
  const unknown = await tryCall('gemini.not_a_real_method', { site }, 20000);
  ok(`${site}: unknown methods list what is available`, /unknown_method|no_gemini_tab/.test(unknown.__error ?? ''), unknown);
}

// ------------------------------------------------------------ cross-site

section('cross-site routing');
const tabs = await call('ext.tabs');
ok('worker lists one tab per site', tabs.tabs.filter((t) => SITES.includes(t.site)).length >= SITES.length, tabs.tabs.map((t) => t.site));
ok('every tab reports as connected', tabs.tabs.filter((t) => SITES.includes(t.site)).every((t) => t.connected), tabs.tabs);

if (SITES.length > 1) {
  const ambiguous = await tryCall('sys.status', {}, 15000);
  ok('site-agnostic call with several tabs is refused, not guessed', /ambiguous_site/.test(ambiguous.__error ?? ''), ambiguous);
  ok('the refusal lists the candidates', SITES.every((s) => (ambiguous.__error ?? '').includes(s)), ambiguous.__error);
}

// Each namespace must land in its own tab, not merely in "a" tab — and a site's own status
// call must answer even when that site is not ready, because that is when you need it.
for (const site of SITES) {
  const r = await tryCall(`${site}.status`, {}, 45000);
  ok(`${site}.* routes to the ${site} tab even when not ready`, r.site === site, { got: r.site, error: r.__error });
}

section('reinjection');
const re = await call('ext.reinject', { force: true }, 90000);
ok('reinject reports per-tab results', Array.isArray(re.results) && re.results.length >= SITES.length, re.results?.length);
ok('reinject succeeded everywhere', re.results.every((r) => r.ok), re.results?.filter((r) => !r.ok));
await sleep(2500);
const afterRe = await tryCall('sys.status', { site: SITES[0] }, 30000);
ok('the bridge still answers after reinjection', afterRe.site === SITES[0], afterRe);
ok('reinjection installed a fresh epoch', typeof afterRe.epoch === 'number' && afterRe.epoch >= 2, afterRe.epoch);

// -------------------------------------------------------------------- done

section('summary');
console.log(JSON.stringify(siteResults, null, 2));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  - ' + f.name + (f.detail !== undefined ? ': ' + JSON.stringify(f.detail).slice(0, 300) : '')); }

if (flag('keep')) {
  console.log(`\nLeaving the browser open (profile: ${profile}). Ctrl-C when done.`);
  await new Promise(() => {});
}
await cleanup(fail ? 1 : 0);
