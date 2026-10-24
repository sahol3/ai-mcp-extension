import { bridge, DAEMON_PATH } from './bridge.js';
import { config } from './config.js';
import { saveMedia, saveMediaTo, resolveOutgoing, isImage } from './media.js';
import { rateStatus } from './policy.js';
import { holdBrowserFocus, releaseBrowserFocus, warmFocusHelper } from './winfocus.js';
import { normId, readLedger, recordConversation, touchConversation, isRecorded, forgetConversations, idleConversations, flowLedger } from './ledger.js';
import { mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';

// ------------------------------------------------------------ schema sugar

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const arr = (description, items = { type: 'string' }) => ({ type: 'array', description, items });
const enm = (description, values) => ({ type: 'string', description, enum: values });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const SITES = {
  gemini: 'https://gemini.google.com/app',
  flow: 'https://flow.google.com/', // moved from labs.google/fx/tools/flow in Sep 2026 (308)
  chatgpt: 'https://chatgpt.com/',
};

const SITE = enm('Which site tab to act on.', ['gemini', 'flow', 'chatgpt']);

const ATTACHMENT = {
  type: 'object',
  description: 'A file to attach. Give exactly one of path, base64 or text.',
  properties: {
    path: { type: 'string', description: 'Absolute path to a local file.' },
    base64: { type: 'string', description: 'File bytes, base64 encoded.' },
    text: { type: 'string', description: 'Inline text content, uploaded as a text file.' },
    filename: { type: 'string', description: 'Name shown in the upload chip.' },
    mimetype: { type: 'string', description: 'Content type; inferred from the path when omitted.' },
  },
  additionalProperties: false,
};

// --------------------------------------------------------------- responses

const cap = (v) => {
  if (typeof v !== 'string') return v;
  return v.length > config.maxTextChars ? v.slice(0, config.maxTextChars) + `\n\n…[truncated ${v.length - config.maxTextChars} chars]` : v;
};

/*
 * Every byte here is a token the caller pays for, so responses are shaped rather than
 * dumped:
 *
 *   - JSON is emitted compact. Pretty-printing costs roughly a fifth of the payload in
 *     indentation alone and buys nothing a model needs.
 *   - Null, empty and false fields are dropped. Their absence carries the same information.
 *   - Answers are returned as prose, not wrapped in JSON, with one compact metadata line
 *     after them — see answer(). Wrapping a 2,000-token reply in JSON escapes every
 *     newline and quote in it for no benefit.
 */
function prune(v, depth = 0) {
  if (Array.isArray(v)) {
    const out = v.map((x) => prune(x, depth + 1)).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val, depth + 1);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : depth === 0 ? {} : undefined;
  }
  /*
   * `false` is KEPT. Dropping it deleted exactly the fields that carry a decision —
   * signed_in:false, found:false, ok:false, settled:false, started_request:false — so a
   * negative result arrived indistinguishable from a field that was never set, and a caller
   * reading `{state:'app'}` had no way to know it meant "not signed in".
   */
  if (v === null || v === undefined || v === '') return undefined;
  return v;
}

const text = (data, { raw = false } = {}) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? cap(data) : cap(JSON.stringify(raw ? data : prune(data) ?? {})) }],
});

/**
 * A model's reply, shaped for the caller rather than for a serializer.
 *
 * The answer is the content. Everything else is one short trailing line, because an agent
 * that wants the conversation id can read it there and an agent that just wants the answer
 * pays nothing for it.
 */
const answer = (body, meta) => {
  const m = prune(meta);
  const footer = m && Object.keys(m).length ? `\n\n---\n${JSON.stringify(m)}` : '';
  return { content: [{ type: 'text', text: cap(String(body ?? '')) + footer }] };
};

const withImage = (data, { base64, mimetype }) => {
  const content = [{ type: 'text', text: cap(JSON.stringify(prune(data) ?? {})) }];
  if (base64 && isImage(mimetype) && Buffer.byteLength(base64, 'base64') <= config.inlineImageMaxBytes) {
    content.push({ type: 'image', data: base64, mimeType: mimetype });
  }
  return { content };
};

// ------------------------------------------------------------------- calls

/** Site-namespaced page call (gemini.*, chatgpt.*, flow.*): routed by the namespace. */
const page = (method, params = {}, timeout = config.timeoutMs) => bridge.call(method, params, timeout);

/** Site-agnostic page call (sys.*, dom.*, net.*): needs to be told which tab. */
const on = (site, method, params = {}, timeout = config.timeoutMs) => bridge.call(method, { ...params, site }, timeout);

/** Service-worker call (ext.*). */
const ext = (method, params = {}, timeout = 60000) => bridge.call(method, params, timeout);

/*
 * Gemini (observed from boq_assistant-bard-web-server_20260821.03_p0) accepts a synthetic
 * `input.files` + `change` dispatch without error, but its own handler never fires from it —
 * no upload request, no chip, same isTrusted hazard as the Enter-key case `gemini.ask`
 * already routes around. `DOM.setFileInputFiles` via chrome.debugger goes through the
 * browser's real input pipeline, so the resulting events are trusted. It reads from disk on
 * the browser's side, so base64/text attachments are materialized to a file first.
 *
 * Getting to a live file input is its own fight, confirmed live against the real app: the
 * "Upload & tools" menu comes up genuinely empty — not a selector miss, an empty
 * `mat-action-list` — on any tab that is not *currently* genuinely OS-visible; this is a
 * reactive gate, not a one-time bootstrap check, so a single focus pulse routinely loses
 * itself again before the multi-step reveal (open menu, wait for its item, click it, wait
 * for the input) finishes. Chrome blocks a background process from stealing foreground focus
 * at all, so `holdBrowserFocus` (server/src/winfocus.js) re-asserts SetForegroundWindow every
 * 250ms via AttachThreadInput for the whole attempt — not spoofing, document.visibilityState
 * /hasFocus genuinely flip true. If the menu is still empty even held-focused, the tab most
 * likely bootstrapped hidden and needs a fresh mount under real visibility; `ext.set_file_
 * input` throws a distinct `file_input_not_found_via_cdp` for that one case, which is worth a
 * reload-and-retry rather than surfacing the error.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE_TITLE = { gemini: 'Gemini', flow: 'Flow', chatgpt: 'ChatGPT' };

/*
 * Make a site tab genuinely visible for the duration of `fn`, then hand the operator's
 * previous tab back.
 *
 * Three steps, each measured necessary on 2026-09-30:
 *   1. ext.focus makes the site's tab the ACTIVE tab. The OS-level hold picks the browser
 *      window by title, and the title follows the active tab — without this it foregrounded
 *      a window showing Flow, and Gemini stayed `hidden` for good.
 *   2. holdBrowserFocus puts that window in front and keeps it there. (It had been spawning
 *      a detached PowerShell that exits in ~70ms, so it never held anything.)
 *   3. Wait until the page itself reports `visible` rather than sleeping a guess.
 * Nesting is safe: an inner call sees the tab already visible and returns at once.
 */
let focusDepth = 0;
// Compile the focus helper now, in the background, so the first hold is already warm.
if (!process.env.AI_MCP_NO_FOCUS_WARMUP) warmFocusHelper();
async function withSiteFocus(site, fn, { holdMs = 12000 } = {}) {
  if (focusDepth > 0) return await fn();
  focusDepth++;
  let previous = null;
  try {
    const f = await ext('ext.focus', { site, settle_ms: 150 }, 15000).catch(() => null);
    previous = f?.previous_tab_id ?? null;
    if (f?.visibility !== 'visible') {
      await holdBrowserFocus(holdMs, { titleMatch: SITE_TITLE[site] ?? site });
      const until = Date.now() + 6000;
      while (Date.now() < until) {
        const v = await on(site, 'sys.eval', { code: 'return document.visibilityState' }, 5000).catch(() => null);
        if ((v?.value ?? v) === 'visible') break;
        await sleep(40);
      }
    } else {
      holdBrowserFocus(holdMs, { titleMatch: SITE_TITLE[site] ?? site });
    }
    return await fn();
  } finally {
    focusDepth--;
    await releaseBrowserFocus().catch(() => {});
    if (previous != null) await ext('ext.activate', { tab_id: previous }, 10000).catch(() => {});
  }
}

async function attachGeminiTrusted(resolved) {
  const media = resolved.source_path
    ? { path: resolved.source_path, bytes: resolved.bytes }
    : saveMedia(resolved.base64, resolved.mimetype, resolved.filename);

  // The upload menu's items are gated on *current* visibility, not a one-time bootstrap
  // check, so the whole reveal-and-inject runs inside a held, verified-visible focus window.
  let since_id = null;
  await withSiteFocus('gemini', async () => {
    since_id = (await page('gemini.net_snapshot', {}, config.timeoutMs)).since_id;
    try {
      await ext('ext.set_file_input', { site: 'gemini', path: media.path }, config.timeoutMs);
    } catch (e) {
      if (!/file_input_not_found_via_cdp/.test(String(e?.message || e))) throw e;
      // Still empty while genuinely visible — the tab most likely bootstrapped hidden and
      // needs a fresh mount under real visibility, not just a reactive re-check.
      await ext('ext.reload_tab', { site: 'gemini' }, config.timeoutMs);
      await on('gemini', 'sys.ready', { timeout_ms: 90000 }, 105000);
      since_id = (await page('gemini.net_snapshot', {}, config.timeoutMs)).since_id;
      await ext('ext.set_file_input', { site: 'gemini', path: media.path }, config.timeoutMs);
    }
  }, { holdMs: 15000 });
  const settle = await page('gemini.wait_attach_settle', { since_id }, config.timeoutMs * 3);
  return { ...settle, filename: resolved.filename, bytes: media.bytes };
}

/** Put Gemini in its zero state for real: the button when it works, navigation otherwise. */
async function geminiFreshChat() {
  const r = await page('gemini.new_chat', {}, 45000);
  if (r?.ok) return r;
  await ext('ext.navigate', { site: 'gemini', url: r?.url || SITES.gemini });
  await on('gemini', 'sys.ready', { timeout_ms: 90000 }, 105000);
  const again = await page('gemini.composer_state', {}, 30000);
  if (!again.zero_state) throw new Error('gemini_new_chat_failed — navigated to /app but the page still shows a conversation');
  return { ok: true, conversation_id: null, turns: 0, via: 'navigation' };
}

/*
 * The UI route, orchestrated from here because only the server can hold OS focus and send a
 * debugger-level Enter. Used whenever the composer has to carry more than text (files, tools)
 * or the caller asked for the UI. In an existing conversation a synthetic Enter sends; in the
 * zero state only a trusted Enter on a visible tab does (measured 2026-09-30).
 */
async function geminiUiAsk(a) {
  /*
   * The send AND the wait run inside one focus hold. Measured 2026-10-01: once the tab went back
   * to the background right after the send, Gemini's page stopped reading its own reply stream
   * (it reads while it paints), and a one-line answer took 202 s to arrive. Held visible, the
   * same answer lands in a few seconds; the hold is released the moment it has.
   * Capped (focus_hold_max_ms, default 120 s) so a long Deep Research run does not keep the
   * operator's screen for minutes; past the cap it keeps going in the background.
   */
  const holdCap = Math.min(a.focus_hold_max_ms ?? 120000, a.timeout_ms ?? config.askTimeoutMs);
  const run = async () => {
    for (const t of a.tools ?? []) await page('gemini.toggle_tool', { tool: t }, 45000);
    if (a.attachments?.length) await attachAll('gemini', a.attachments);
    const st = await page('gemini.composer_state', {}, 30000);
    const baseline = st.model_turns;
    // A temporary chat never gets a conversation id, so it is sent like the zero state.
    if (st.zero_state || st.temporary) {
      await page('gemini.send', { prompt: a.prompt, send: false }, 60000);
      await ext('ext.trusted_input', { site: 'gemini', key: 'Enter' }, 20000);
      const sent = await waitFor(async () => {
        const s = await page('gemini.composer_state', {}, 15000);
        return s.conversation_id || s.model_turns > baseline || s.streaming || !s.composer_text.trim() ? s : null;
      }, 12000, 80);
      if (!sent) throw new Error('gemini_send_not_accepted — the trusted Enter did not leave the composer (is the Opera window on screen?)');
    } else {
      await page('gemini.send', { prompt: a.prompt }, 60000);
    }
    return await page('gemini.wait_reply', {
      baseline_count: baseline, since_request_id: st.since_id, timeout_ms: a.timeout_ms ?? config.askTimeoutMs,
      quiet_ms: a.quiet_ms, lean: a.verbose !== true,
    }, (a.timeout_ms ?? config.askTimeoutMs) + 60000);
  };
  return await withSiteFocus('gemini', run, { holdMs: holdCap });
}
async function waitFor(fn, timeoutMs, interval = 120) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

async function attachAll(site, attachments = []) {
  const done = [];
  for (const a of attachments) {
    const resolved = resolveOutgoing(a);
    if (site === 'gemini') {
      try {
        done.push(await attachGeminiTrusted(resolved));
        continue;
      } catch (e) {
        // Fall back to the legacy DataTransfer path — e.g. debugger permission denied, or a
        // build that never had the isTrusted gate and doesn't need the CDP route at all.
      }
    }
    done.push(await page(`${site}.attach`, resolved, config.timeoutMs * 2));
  }
  return done;
}

// ------------------------------------------------------------------ tools

const T = [];
const tool = (name, description, properties, handler, { required = [] } = {}) => {
  T.push({ name, description, inputSchema: obj(properties, required), handler });
};

/* ==================== connection & diagnostics ==================== */

tool('ai_status',
  'Health of the whole bridge: daemon, browser extension, and each of the three site tabs (Gemini, Google Flow, ChatGPT) with whether it is signed in and ready. Call this first whenever anything misbehaves — it names the exact thing to fix. Returns a compact summary; pass verbose for the full diagnostic tree.',
  { verbose: bool('Include the full extension, tab and per-site detail. Off by default — the summary is a fraction of the size and answers the question in nearly every case.') },
  async (a = {}) => {
    const local = { policy: rateStatus(), data_dir: config.dataDir, endpoint: `ws://${config.host}:${config.port}` };

    if (!(await bridge.ready())) {
      return text({
        ...local,
        ok: false,
        problem: `Cannot reach the ai-mcp daemon on ws://${config.host}:${config.port}.`,
        fix: [
          `1. Start it:  node "${DAEMON_PATH}"`,
          `2. If it exits immediately, read ${config.daemonLogPath} — a stale daemon on the same port exits with EADDRINUSE, which is harmless.`,
        ],
      });
    }

    const daemon = await bridge.daemonStatus().catch((e) => ({ error: String(e.message) }));
    if (!daemon?.extension_connected) {
      return text({
        ...local,
        ok: false,
        daemon,
        problem: 'The daemon is up, but the browser extension has not connected to it.',
        fix: [
          '1. The browser is running and the "AI Studio MCP Bridge" extension is enabled.',
          '2. At least one of gemini.google.com, labs.google/fx/tools/flow or chatgpt.com is open in a tab.',
          `3. The extension popup points at ${config.host}:${config.port} and the Bridge switch is on.`,
          '4. If the extension was just reloaded, reload the site tabs (or run ai_reinject).',
        ],
      });
    }

    const extStatus = await ext('ext.status', {}, 15000).catch((e) => ({ error: String(e.message) }));
    const tabs = await ext('ext.tabs', {}, 15000).catch(() => null);

    // Ask each connected page for its own view; a site with no tab is reported, not an error.
    const sites = {};
    for (const id of Object.keys(SITES)) {
      const connected = !!extStatus?.sites?.[id];
      if (!connected) {
        sites[id] = { connected: false, hint: `No tab. Call ai_open_site with site:"${id}".`, url: SITES[id] };
        continue;
      }
      sites[id] = await on(id, 'sys.status', {}, 20000).catch((e) => ({ connected: true, error: String(e.message) }));
    }

    const ready = Object.entries(sites).filter(([, s]) => s?.ready?.ready).map(([k]) => k);
    const note = ready.length === 0 ? 'No site is ready yet. Open one with ai_open_site and make sure you are signed in to it.' : undefined;

    if (a.verbose) {
      return text({ ...local, ok: true, ready_sites: ready, daemon, extension: extStatus, tabs: tabs?.tabs ?? null, sites, note });
    }

    /*
     * The summary answers the only questions this tool is ever asked — is it up, which
     * sites can I drive, am I signed in — in a couple of hundred bytes. The full tree runs
     * to several thousand and is one flag away.
     */
    return text({
      ok: true,
      ready: ready,
      sites: Object.fromEntries(Object.entries(sites).map(([k, s]) => [
        k,
        s?.connected === false ? 'no tab'
          : {
              state: s?.ready?.state ?? (s?.error ? 'error' : 'unknown'),
              signed_in: s?.site_status?.signed_in ?? s?.ready?.signed_in,
              conversation: s?.site_status?.conversation_id ?? undefined,
              project: s?.site_status?.project_id ?? undefined,
              captured: s?.net_records,
              error: s?.error,
            },
      ])),
      daemon: { pid: daemon?.daemon?.pid, uptime_s: daemon?.daemon?.uptime_s, clients: daemon?.mcp_clients },
      limits: { prompts_hr: `${local.policy.prompts_last_hour}/${local.policy.limit_prompts_per_hour}`, gens_hr: `${local.policy.generations_last_hour}/${local.policy.limit_generations_per_hour}`, read_only: local.policy.read_only, delete: local.policy.delete_enabled },
      note,
    });
  });

tool('ai_sites',
  'List the browser tabs the bridge can drive, with their site, URL and whether the page bridge is loaded and ready.',
  {},
  async () => text({ ...(await ext('ext.status')), tabs: (await ext('ext.tabs')).tabs }));

tool('ai_open_site',
  'Open (or focus) a tab for one of the three sites. Use this before the first call to that site. Existing tabs are reused unless new_tab is set.',
  {
    site: SITE,
    url: str('Specific URL to open instead of the site default.'),
    focus: bool('Bring the tab to the front (default true). Some pages will not finish loading while hidden.'),
    new_tab: bool('Force a new tab even if one is already open.'),
    wait_ready: bool('Wait until the page bridge reports the app is usable (default true).'),
    timeout_ms: num('How long to wait for readiness (default 90000).'),
  },
  async (a) => {
    const opened = await ext('ext.open', { site: a.site, url: a.url, focus: a.focus !== false, new_tab: !!a.new_tab });
    if (a.wait_ready === false) return text(opened);
    // A freshly created tab needs a moment before its content scripts have connected.
    let ready = null, error = null;
    for (let i = 0; i < 3 && !ready; i++) {
      ready = await on(a.site, 'sys.ready', { timeout_ms: a.timeout_ms ?? 90000 }, (a.timeout_ms ?? 90000) + 15000)
        .catch((e) => { error = String(e.message); return null; });
      if (!ready) await new Promise((r) => setTimeout(r, 400));
    }
    return text({ ...opened, ready, ...(ready ? {} : { not_ready: error, hint: `Open ${SITES[a.site]} yourself and check you are signed in.` }) });
  },
  { required: ['site'] });

tool('ai_navigate',
  'Point a site tab at a specific URL (a conversation, a Flow project, a settings page). This is a full page load, so anything captured in that tab is lost.',
  { site: SITE, url: str('Absolute URL. Must belong to the site.'), wait_ready: bool('Wait for the app to be usable again (default true).') },
  async (a) => {
    const r = await ext('ext.navigate', { site: a.site, url: a.url });
    if (a.wait_ready === false) return text(r);
    const ready = await on(a.site, 'sys.ready', { timeout_ms: 90000 }, 105000).catch((e) => ({ error: String(e.message) }));
    return text({ ...r, ready });
  },
  { required: ['site', 'url'] });

tool('ai_focus_tab',
  'Bring a site tab to the foreground. Needed at least once per page load for apps that will not finish booting while hidden, and worth doing before a long generation.',
  { site: SITE, restore: bool('Switch back to the previously active tab afterwards.'), settle_ms: num('Pause after focusing (default 1200).') },
  async (a) => text(await ext('ext.focus', a)),
  { required: ['site'] });

tool('ai_reload_tab',
  'Reload a site tab. Use when a page is wedged; everything captured in that tab is discarded.',
  { site: SITE, bypass_cache: bool('Hard reload.'), wait_ready: bool('Wait for the app to come back (default true).') },
  async (a) => {
    const r = await ext('ext.reload_tab', a);
    if (a.wait_ready === false) return text(r);
    return text({ ...r, ready: await on(a.site, 'sys.ready', { timeout_ms: 90000 }, 105000).catch((e) => ({ error: String(e.message) })) });
  },
  { required: ['site'] });

tool('ai_close_tab', 'Close a site tab (or one specific tab id).', { site: SITE, tab_id: num('Close this tab id instead of every tab for the site.') },
  async (a) => text(await ext('ext.close_tab', a)));

tool('ai_reinject',
  'Re-inject the page bridge into every open site tab. Fixes "no bridge in the page" after the extension was reloaded, without reloading the pages.',
  { force: bool('Replace the bridge even when one is already present (default true). The page world survives an extension reload, so a present bridge may be the old build.') },
  async (a) => text(await ext('ext.reinject', a)));

tool('ai_reload_extension',
  'Reload the browser extension itself. Needed after editing extension source, because browsers cache an unpacked extension\'s files and reloading the page re-injects the cached copy. The socket drops and comes back within a few seconds.',
  {},
  async () => text(await ext('ext.reload_extension', {}, 10000).catch((e) => ({ ok: true, note: 'no reply, as expected — the worker was torn down mid-call', detail: String(e.message) }))));

tool('ai_screenshot',
  'Screenshot the visible area of a site tab. Requires the one-time "Enable screenshots" click in the extension popup, because Chrome only grants capture permission from a user gesture.',
  { site: SITE, format: enm('Image format (default png).', ['png', 'jpeg']), quality: num('JPEG quality 0-100.'), activate: bool('Focus the tab briefly if it is not active (default true).'), save: bool('Also write the image into the data directory.') },
  async (a) => {
    const shot = await ext('ext.screenshot', a, 60000);
    const saved = a.save ? saveMedia(shot.base64, shot.mimetype, `${a.site ?? 'tab'}.png`) : null;
    return withImage({ site: a.site ?? null, url: shot.url, mimetype: shot.mimetype, bytes: Buffer.byteLength(shot.base64, 'base64'), ...(saved ? { saved_to: saved.path } : {}) }, shot);
  });

tool('ai_download',
  'Save a URL with the browser\'s own downloader. This is how to keep generated Flow videos and images: their links are short-lived and credentialed, and the browser already holds what they need.',
  { url: str('The media URL, usually from flow_media or gemini_images.'), filename: str('Filename (relative to the browser download folder).'), wait: bool('Block until the download finishes (default true).'), timeout_ms: num('How long to wait (default 180000).') },
  async (a) => text(await ext('ext.download', a, (a.timeout_ms ?? 180000) + 15000)),
  { required: ['url'] });

tool('ai_fetch_media',
  'Fetch a media URL through the page and save the bytes locally, returning the size and a SHA-256 so you can prove what arrived. Use this — not ai_download — for a `blob:` URL (Flow\'s video player hands you one, and the browser\'s downloader cannot read a blob minted in another context), for anything whose authorisation lives in the page, or whenever you need the file at an exact path. ai_download stays the better choice for large files: it streams to disk instead of moving bytes across the bridge.',
  {
    site: SITE,
    url: str('The media URL, from flow_media, gemini_images or a captured request.'),
    save_path: str('Absolute path to write to. Defaults to a timestamped file in the data directory.'),
    max_bytes: num('Refuse anything larger (default 24 MB). Above this, use ai_download.'),
    inline: bool('Return the image in the response as well as saving it (default true for images under the inline cap).'),
  },
  async (a) => {
    /*
     * The page is tried first: it holds the site's cookies and is the fastest path for
     * same-origin media, and it is the only context that can read a `blob:` URL.
     *
     * Generated media, though, lives on CDNs that send no CORS headers — googleusercontent,
     * oaiusercontent, flow-content — where a page-context fetch fails with an opaque
     * "Failed to fetch" however valid the session is. The service worker is exempt from CORS
     * for the hosts in host_permissions, so it takes over. A `blob:` URL is page-only by
     * definition and is not retried there.
     */
    let r;
    try {
      r = await on(a.site, 'net.fetch_media', { url: a.url, max_bytes: a.max_bytes }, 300000);
    } catch (e) {
      if (/^blob:/i.test(String(a.url)) || !/failed to fetch|networkerror|load failed/i.test(String(e.message))) throw e;
      r = await ext('ext.fetch_media', { url: a.url, max_bytes: a.max_bytes }, 300000);
    }
    const saved = a.save_path
      ? saveMediaTo(r.base64, a.save_path)
      : saveMedia(r.base64, r.mimetype, (() => { try { return decodeURIComponent(new URL(r.url).pathname.split('/').pop() || ''); } catch { return ''; } })());
    const out = {
      url: r.url,
      mimetype: r.mimetype,
      bytes: r.bytes,
      sha256: saved.sha256,
      saved_to: saved.path,
      timing: { page_fetch_ms: r.fetch_ms, base64_encode_ms: r.encode_ms },
    };
    return a.inline === false ? text(out) : withImage(out, r);
  },
  { required: ['site', 'url'] });

tool('ai_ready',
  'Block until a site\'s app is actually usable, and report what state it is in. Cheaper and clearer than polling ai_status.',
  { site: SITE, timeout_ms: num('Default 90000.') },
  async (a) => text(await on(a.site, 'sys.ready', { timeout_ms: a.timeout_ms ?? 90000 }, (a.timeout_ms ?? 90000) + 15000)),
  { required: ['site'] });

tool('ai_probe',
  'Report what is actually on a site page right now: which of the bridge\'s selectors match, plus the page\'s visible buttons, custom elements and test ids. This is the first call when a site tool stops working — it turns "it broke" into "this selector no longer matches". Returns a summary; pass verbose for every element.',
  { site: SITE, verbose: bool('Return the full element dump instead of the summary. The summary names which selectors matched and which did not, which is what you need to diagnose a break.') },
  async (a) => {
    const p = await on(a.site, 'sys.probe', {}, 45000);
    if (a.verbose) return text(p);
    const sel = p.selectors ?? {};
    const matched = {}, unmatched = [];
    for (const [name, v] of Object.entries(sel)) {
      if (v.matched_selector) matched[name] = `${v.matched_selector} (${v.visible_matches}/${v.matches} visible)`;
      else unmatched.push(name);
    }
    return text({
      site: a.site,
      url: p.url,
      matched,
      unmatched,
      // Enough of the page to recognise a redesign, without dumping all of it.
      buttons: (p.buttons ?? []).map((b) => b.aria || b.text || b.testid).filter(Boolean).slice(0, 40),
      testids: (p.testids ?? []).slice(0, 40),
      custom_elements: (p.custom_elements ?? []).slice(0, 40),
      hint: unmatched.length ? 'Unmatched selectors are often just absent controls (no send button on an empty composer). Re-probe in the state where you expect them.' : undefined,
    });
  },
  { required: ['site'] });

tool('ai_selftest',
  'Run the in-page assertion suite for a site: transport, serialisation, stream decoding, markdown reconstruction and the DOM toolkit, all against synthetic data. Works signed out, so it separates "the bridge is broken" from "the account is not logged in".',
  { site: SITE },
  async (a) => {
    const r = await on(a.site, 'sys.selftest', {}, 120000);
    return text({ site: a.site, ...r });
  },
  { required: ['site'] });

tool('ai_eval',
  'Run JavaScript inside a site page and return the result. The escape hatch for anything the typed tools do not cover. These pages ship a CSP without unsafe-eval, so three execution strategies are tried in turn and the one that worked is reported.',
  { site: SITE, code: str('Function body. Use `return` for the value; `args` holds whatever you pass in args. Async is supported.'), args: { type: 'object', description: 'Values exposed to the code as `args`.', additionalProperties: true } },
  async (a) => text(await on(a.site, 'sys.eval', { code: a.code, args: a.args ?? {} }, 120000)),
  { required: ['site', 'code'] });

/* ==================== generic DOM ==================== */

tool('ai_query', 'Query the DOM of a site page and describe the matches (tag, id, classes, aria label, test id, text, visibility).',
  { site: SITE, selector: str('CSS selector.'), limit: num('Max matches (default 30).'), html: bool('Include outerHTML for each match.'), full_text: bool('Include the full innerText for each match.') },
  async (a) => text(await on(a.site, 'dom.query', a, 45000)),
  { required: ['site', 'selector'] });

tool('ai_text', 'Read visible text from a site page, optionally scoped to a selector.',
  { site: SITE, selector: str('Scope; omit for the whole body.'), max: num('Character cap (default 200000).') },
  async (a) => text(await on(a.site, 'dom.text', a, 45000)),
  { required: ['site'] });

tool('ai_click', 'Click an element in a site page, by CSS selector or by its visible text. Dispatches the full pointer sequence, so frameworks that ignore a bare .click() still react.',
  { site: SITE, selector: str('CSS selector (or an array of fallbacks).'), text: str('Visible text or aria-label to match instead of a selector.'), index: num('Which match to click when several (default 0).'), settle_ms: num('Pause after clicking.') },
  async (a) => text(await on(a.site, 'dom.click', a, 45000)),
  { required: ['site'] });

tool('ai_type', 'Type into an editor in a site page. Handles ProseMirror and Quill, which ignore direct DOM writes, and reports which insertion strategy the editor actually accepted.',
  { site: SITE, selector: str('CSS selector for the editor.'), text: str('Text to insert.'), replace: bool('Clear existing content first (default true).'), enter: bool('Press Enter afterwards.') },
  async (a) => text(await on(a.site, 'dom.type', a, 45000)),
  { required: ['site', 'selector', 'text'] });

tool('ai_press_key', 'Send a key to a site page (Enter, Escape, Tab, arrows, or a character).',
  { site: SITE, key: str('Key name, e.g. "Enter", "Escape", "ArrowDown".'), selector: str('Target element; defaults to whatever has focus.'), modifiers: { type: 'object', description: 'e.g. {"shiftKey":true,"ctrlKey":true}', additionalProperties: true } },
  async (a) => text(await on(a.site, 'dom.key', a, 30000)),
  { required: ['site', 'key'] });

tool('ai_wait_for', 'Block until a selector appears (and optionally contains some text) in a site page.',
  { site: SITE, selector: str('CSS selector (or an array of fallbacks).'), text: str('Also require this text inside the match.'), timeout_ms: num('Default 30000.'), interval_ms: num('Poll interval (default 200).') },
  async (a) => text(await on(a.site, 'dom.wait', a, (a.timeout_ms ?? 30000) + 15000)),
  { required: ['site', 'selector'] });

tool('ai_scroll', 'Scroll a site page or a scrollable element — needed to load virtualised lists such as conversation history.',
  { site: SITE, selector: str('Element to scroll; defaults to the page.'), to: enm('Jump to an end.', ['top', 'bottom']), by: num('Pixels to scroll instead.'), settle_ms: num('Pause afterwards (default 250).') },
  async (a) => text(await on(a.site, 'dom.scroll', a, 30000)),
  { required: ['site'] });

/* ==================== captured network ==================== */

tool('ai_net_list',
  'List the HTTP requests a site page has made, newest last. The bridge hooks fetch and XHR before the app boots, so this is a complete record of the internal API — the fastest way to learn what a feature actually calls.',
  { site: SITE, url: str('Regex filtered against the URL.'), method: str('GET, POST, …'), status: num('Exact HTTP status.'), body_contains: str('Only requests whose body contains this.'), text_contains: str('Only requests whose response contains this.'), limit: num('Max results (default 40).'), body: bool('Include request/response bodies.'), decode: bool('Also decode each response (SSE, Google chunked arrays, JSON, NDJSON).') },
  async (a) => {
    const { site, ...match } = a;
    const { limit, body, decode, ...filters } = match;
    return text(await on(site, 'net.list', { match: filters, limit, body, decode }, 60000));
  },
  { required: ['site'] });

tool('ai_net_get',
  'Fetch one captured request in full — headers, body, response — with the response decoded into whatever it actually is.',
  { site: SITE, id: str('Request id from ai_net_list.'), url: str('Regex to match the newest request instead of giving an id.'), decode: bool('Decode the response (default true).'), max: num('Character cap on the body (default 200000).') },
  async (a) => text(await on(a.site, 'net.get', { id: a.id, match: a.url ? { url: a.url } : {}, decode: a.decode, max: a.max }, 60000)),
  { required: ['site'] });

tool('ai_net_wait',
  'Block until a request matching a URL pattern completes in a site page, then return it decoded. Use this to catch an API call a UI action triggers.',
  { site: SITE, url: str('Regex matched against the URL.'), method: str('Restrict to a method.'), timeout_ms: num('Default 120000.'), include_existing: bool('Return an already-completed match immediately (default true).') },
  async (a) => text(await on(a.site, 'net.wait', { match: { url: a.url, method: a.method }, timeout_ms: a.timeout_ms ?? 120000, include_existing: a.include_existing }, (a.timeout_ms ?? 120000) + 15000)),
  { required: ['site', 'url'] });

tool('ai_net_clear', 'Empty a page\'s captured-request buffer, so the next action is easy to isolate.',
  { site: SITE },
  async (a) => text(await on(a.site, 'net.clear', {}, 30000)),
  { required: ['site'] });

tool('ai_replay',
  'Re-issue a captured request from inside the page, optionally with a patched body. This is the most powerful tool here: the page\'s cookies, bearer token, XSRF token and abuse-prevention headers ride along, which is exactly the part an external HTTP client cannot reproduce.',
  {
    site: SITE,
    id: str('Request id to use as the template (from ai_net_list).'),
    url_match: str('Regex to pick the newest matching request as the template instead.'),
    url: str('Override the URL.'),
    method: str('Override the method.'),
    json_patch: { type: 'object', description: 'Deep-merged into the template\'s JSON body.', additionalProperties: true },
    replace: { type: 'object', description: 'Literal string substitutions applied to the body.', additionalProperties: true },
    query: { type: 'object', description: 'Query parameters to set or (with null) remove.', additionalProperties: true },
    body: str('Replace the body outright.'),
    headers: { type: 'object', description: 'Extra headers, merged over the template\'s.', additionalProperties: true },
    inherit_headers: bool('Reuse the template\'s headers (default true — this is what carries the credentials).'),
    decode: bool('Decode the response (default true).'),
  },
  async (a) => {
    const { site, url_match, ...rest } = a;
    return text(await on(site, 'net.replay', { ...rest, match: url_match ? { url: url_match } : undefined }, 180000));
  },
  { required: ['site'] });

tool('ai_request',
  'Make an arbitrary HTTP request from inside a site page, with that page\'s credentials. Use when there is no captured request to replay.',
  { site: SITE, url: str('Absolute URL.'), method: str('Default GET.'), json: { type: 'object', description: 'JSON body (sets Content-Type).', additionalProperties: true }, body: str('Raw body, if not JSON.'), headers: { type: 'object', description: 'Request headers.', additionalProperties: true }, decode: bool('Decode the response (default true).') },
  async (a) => text(await on(a.site, 'net.request', a, 180000)),
  { required: ['site', 'url'] });

tool('ai_events',
  'Read buffered events the pages have pushed (network completions, when enabled). Poll with the returned cursor.',
  { since: num('Only events after this cursor.'), types: arr('Restrict to these event names.'), contains: str('Only events whose payload contains this string.'), limit: num('Default 100.') },
  async (a) => text(await bridge.getEvents(a)));

tool('ai_wait_event', 'Block until a matching event arrives, or the timeout elapses.',
  { types: arr('Event names to wait for.'), contains: str('Payload substring to require.'), since: num('Start from this cursor.'), timeout_ms: num('Default 120000.') },
  async (a) => text(await bridge.waitEvent(a)));

/* ==================== Gemini ==================== */

tool('gemini_status', 'Gemini tab state: signed in, current conversation, selected model, turn counts, and which BoQ tokens the bridge could resolve.',
  {}, async () => text(await page('gemini.status', {}, 30000)));

tool('gemini_ask',
  'Send a prompt to Gemini and return the finished answer as markdown. Routes through Gemini\'s own StreamGenerate API when a request has been captured this session — that is faster and, unlike the UI, works from the new-chat zero state, which ignores every synthetic event. Waits through the whole response, including Deep Research runs that pause for minutes — the default timeout is 10 minutes. Optionally switches model, enables a tool, and attaches files first.',
  {
    prompt: str('What to ask.'),
    model: str('Switch the model first — menu text such as "3.1 Pro", "3.8 Flash", "3.5 Flash-Lite" (or "Pro", "Flash", "Flash-Lite"). gemini_models lists them.'),
    thinking: bool('Turn Extended thinking on (true) or off (false) for this and later prompts. It layers on the selected model.'),
    fallback_model: str('For file asks: if Gemini answers "Sorry, something went wrong", re-send once in the same chat on this model (default "3.1 Pro"; pass "" or set false-y to disable).'),
    tools: arr('Tools to enable first, by label: "Create image", "Create video", "Create music", or a More-tools item such as "Deep Research" / "Canvas" (gemini_tools lists them).'),
    attachments: arr('Files to attach before sending.', ATTACHMENT),
    wait: bool('Wait for the answer (default true). False returns as soon as it is sent.'),
    verbose: bool('Return the full diagnostic object instead of just the answer. Off by default: the plain answer plus a one-line metadata footer is a fraction of the size.'),
    via: enm('Force a route. "api" uses StreamGenerate directly (fast, works from any state, does not render in the tab); "ui" drives the composer (renders, but cannot send from the zero state). Default "auto".', ['auto', 'api', 'ui']),
    new_chat: bool('Start a new conversation rather than continuing the open one.'),
    temporary: bool('Use a Gemini Temporary chat: never saved to your history. Continues the open temporary chat unless new_chat is also set. Best for transcriptions and throwaway work.'),
    delete_after: bool('Delete the conversation this call created as soon as the answer is read.'),
    keep: bool('Keep a conversation the bridge creates (it is otherwise auto-deleted after it has been idle for the configured time, 30 minutes by default).'),
    focus_hold_max_ms: num('UI route only: how long the Gemini tab may be held in front while the answer streams (default 120000). Gemini stops reading its reply while hidden, so shorter caps make long answers slower.'),
    timeout_ms: num('How long to wait for the answer (default 600000).'),
    quiet_ms: num('How long the text must stop changing before it counts as finished (default 1500).'),
  },
  (a) => geminiAsk(a),
  { required: ['prompt'] });

/*
 * The core ask: route choice, mode, tools, files, and the one-shot fallback. Returns the raw
 * page result; geminiAsk() around it owns the ledger, temporary chats and cleanup.
 */
async function geminiAskCore(a) {
  const { attachments, tools, model, thinking, ...rest } = a;
  /*
   * Order matters: a fresh chat first (it resets tools), then the mode (the picker works in
   * a hidden tab), then either the plain API/auto route or the UI route. Files and tools
   * only travel through the UI — the API route sends the prompt text alone, which is how
   * every voice note sent into a fresh chat used to arrive with no audio.
   */
  const needsUi = !!(attachments?.length || tools?.length || a.via === 'ui');
  if (a.new_chat && needsUi) await geminiFreshChat();
  if (model || thinking != null) await page('gemini.set_model', { model, thinking }, 45000);
  let r = needsUi
    ? await geminiUiAsk({ ...a, attachments, tools })
    : await page('gemini.ask', { ...rest, trusted_send: true, lean: a.verbose !== true }, (a.timeout_ms ?? config.askTimeoutMs) + 60000);
  if (r?.error === 'zero_state_needs_trusted_send') {
    // No template to replay yet (first send of the session, from a fresh chat): UI route.
    return await geminiAskCore({ ...a, via: 'ui' });
  }
  r = { ...r, __needs_ui: needsUi };
  /*
   * Gemini's generic failure text comes back as an ordinary answer. Measured 2026-09-30: a
   * 50s Bengali WhatsApp voice note failed this way on 3.8 Flash (as OGG and as MP3) while
   * 3.1 Pro transcribed it; a 43s English clip worked on Flash. So a file ask that fails
   * like this is re-sent once in the same chat on the fallback model, and the model the
   * caller had is restored afterwards. Both wordings seen 2026-09-30; whole-answer matches
   * only, so a transcript that merely contains the phrase is never mistaken for a failure.
   */
  const failedText = /^\s*(sorry,?\s*)?(something went wrong|i encountered an error( doing what you asked)?)[.!]?(\s*(please\s+)?(could you\s+)?try( your request)? again[.?!]?)?\s*$/i;
  if (failedText.test(String(r?.markdown || r?.text || '')) && attachments?.length && a.fallback_model !== false && a.fallback_model !== '' && !a.__fallback) {
    const fallback = typeof a.fallback_model === 'string' ? a.fallback_model : '3.1 Pro';
    const before = await page('gemini.composer_state', {}, 30000).catch(() => null);
    if ((before?.mode?.model || '').toLowerCase() !== fallback.toLowerCase()) {
      try {
        const again = await geminiAskCore({ ...a, new_chat: false, model: fallback, thinking: false, __fallback: true });
        return { ...again, __fallback: { fallback_model: fallback, first_model: before?.mode?.model ?? '?', first_answer: 'gemini_error' } };
      } finally {
        if (before?.mode?.model) await page('gemini.set_model', { model: before.mode.model, thinking: !!before.mode.thinking }, 45000).catch(() => {});
      }
    }
  }
  return r;
}

/*
 * Keeping the operator's Gemini history clean.
 *
 * The account is also used by hand, so agent chats (transcriptions, image runs) must not pile
 * up there. Three ways, in order of preference:
 *   temporary:true   — Gemini's own Temporary chat; never saved to history at all.
 *   delete_after:true — the conversation this call created is deleted once the answer is read.
 *   (default)        — every conversation the bridge creates goes in gemini-ledger.json and is
 *                      deleted after geminiAutoDeleteMinutes idle (30 by default); keep:true opts out.
 * Only ledger conversations can be deleted without AI_MCP_ALLOW_DELETE.
 */
let lastPurge = 0;
function maybePurgeGemini(currentId) {
  const minutes = config.geminiAutoDeleteMinutes;
  if (!(minutes > 0) || Date.now() - lastPurge < 5 * 60000) return;
  lastPurge = Date.now();
  const idle = idleConversations(minutes).map((c) => c.conversation_id).filter((id) => id !== normId(currentId));
  if (!idle.length) return;
  // Background: an old chat's cleanup must not slow down the ask that triggered it.
  deleteGeminiConversations(idle, { reason: 'idle' }).catch(() => {});
}

async function deleteGeminiConversations(ids, { allowUnrecorded = false } = {}) {
  const want = [...new Set(ids.map(normId).filter(Boolean))];
  const refused = want.filter((id) => !isRecorded(id) && !(allowUnrecorded && config.allowDelete));
  const go = want.filter((id) => !refused.includes(id));
  let res = { deleted: 0, results: [] };
  if (go.length) {
    res = await page('gemini.delete_conversations', { ids: go }, 90000);
    forgetConversations(res.results.filter((x) => x.ok).map((x) => x.conversation_id));
    if (res.was_open) await geminiFreshChat().catch(() => {});
  }
  return {
    ...res,
    ...(refused.length ? {
      refused,
      refused_reason: config.allowDelete
        ? 'not created by the bridge — pass include_unrecorded:true to delete it anyway'
        : 'not created by the bridge; deleting other conversations needs AI_MCP_ALLOW_DELETE=1',
    } : {}),
  };
}

async function geminiAsk(a) {
  // Anything that needs the UI runs inside ONE focus hold, so navigation, the temporary switch,
  // attaching and sending all happen on a visible tab (a page loaded in the background was
  // measured taking 6-10 s longer to become usable).
  const uiBound = !!(a.temporary || a.attachments?.length || a.tools?.length || a.via === 'ui');
  if (uiBound && focusDepth === 0) {
    return await withSiteFocus('gemini', () => geminiAskInner(a), { holdMs: Math.min(a.focus_hold_max_ms ?? 120000, a.timeout_ms ?? config.askTimeoutMs) });
  }
  return await geminiAskInner(a);
}

async function geminiAskInner(a) {
  const before = await page('gemini.composer_state', {}, 30000).catch(() => null);
  maybePurgeGemini(before?.conversation_id);

  let args = a;
  if (a.temporary) {
    if (a.new_chat || !before?.temporary) {
      await geminiFreshChat();
      // The switch ignores clicks while the tab is hidden, like Gemini's other menus.
      const t = await page('gemini.temporary_chat', {}, 20000);
      if (!t?.ok) throw new Error('gemini_temporary_chat_failed — ' + (t?.error ?? 'the switch did not take') + '. Nothing was sent.');
    }
    // Temporary chats go through the UI (an API send would create a saved chat).
    args = { ...a, via: 'ui', new_chat: false };
  }

  const r = await geminiAskCore(args);

  const beforeId = normId(before?.conversation_id);
  const afterId = normId(r?.conversation_id);
  let recorded = false;
  let deleted = null;
  if (!a.temporary && afterId) {
    if (afterId !== beforeId) {
      recordConversation(afterId, { tool: 'gemini_ask', first_prompt: String(a.prompt).slice(0, 80), ...(a.keep ? { keep: true } : {}) });
      recorded = true;
    } else if (isRecorded(afterId)) touchConversation(afterId);
    if (a.delete_after && isRecorded(afterId)) {
      // In the background: the answer is ready now, and the delete's own history-list check
      // takes 1-3 s. A failure leaves it in the ledger, so idle cleanup still removes it.
      deleteGeminiConversations([afterId]).catch(() => {});
      deleted = 'pending';
    }
  }

  if (a.verbose) return text({ ...r, recorded, ...(deleted != null ? { deleted } : {}) });
  return answer(r.markdown || r.text, {
    conversation_id: a.temporary ? undefined : r.conversation_id,
    response_id: r.response_id,
    ms: r.elapsed_ms,
    via: r.sent?.via ?? (r.__needs_ui ? 'ui' : undefined),
    ...(a.temporary ? { temporary: true } : {}),
    ...(deleted != null ? { deleted } : (recorded && !a.keep && config.geminiAutoDeleteMinutes > 0 ? { auto_delete_after_min: config.geminiAutoDeleteMinutes } : {})),
    ...(r.mode ? { mode: `${r.mode.model ?? '?'}${r.mode.thinking ? '+thinking' : ''}`, ...(r.mode.thinking_not_applied ? { thinking_not_applied: true } : {}) } : {}),
    ...(r.__fallback ?? {}),
    ...(r.settled === false ? { unsettled: true } : {}),
    ...(r.timed_out ? { timed_out: true } : {}),
    ...(r.still_streaming ? { still_streaming: true } : {}),
  });
}

tool('gemini_temporary_chat', 'Open a fresh Gemini Temporary chat — it is never saved to your history. Later gemini_ask calls with temporary:true continue in it.',
  {}, async () => {
    await geminiFreshChat();
    return text(await withSiteFocus('gemini', () => page('gemini.temporary_chat', {}, 20000)));
  });

tool('gemini_delete_conversation', 'Delete Gemini conversations the bridge created (tracked in its ledger): one id, several, every recorded one, or those idle for a while. Conversations you started yourself are refused unless AI_MCP_ALLOW_DELETE=1 and include_unrecorded is set. Verified against the history list afterwards.',
  {
    conversation_id: str('One conversation id (with or without the c_ prefix).'),
    conversation_ids: arr('Several ids.'),
    all_created: bool('Every conversation in the bridge ledger.'),
    idle_minutes: num('With all_created: only those unused for at least this many minutes.'),
    include_unrecorded: bool('Also delete ids the bridge did not create (needs AI_MCP_ALLOW_DELETE=1).'),
  },
  async (a) => {
    let ids = [...(a.conversation_ids ?? []), ...(a.conversation_id ? [a.conversation_id] : [])];
    if (a.all_created) ids = [...ids, ...idleConversations(a.idle_minutes ?? 0).map((c) => c.conversation_id)];
    if (!ids.length) return text({ deleted: 0, note: 'nothing to delete — pass conversation_id(s) or all_created:true' });
    return text(await deleteGeminiConversations(ids, { allowUnrecorded: !!a.include_unrecorded }));
  });

tool('gemini_created_conversations', 'The Gemini conversations the bridge created and has not deleted yet (its ledger), with when each was last used and whether it still exists.',
  {}, async () => {
    const l = readLedger().conversations;
    const live = new Set(((await page('gemini.list_conversations_api', { limit: 100 }, 30000).catch(() => null))?.conversations ?? []).map((c) => c.conversation_id));
    return text({
      auto_delete_after_min: config.geminiAutoDeleteMinutes,
      conversations: Object.entries(l).map(([id, v]) => ({ conversation_id: id, ...v, listed: live.size ? live.has(id) : undefined })),
    });
  });

tool('gemini_send', 'Type a prompt into Gemini and send it without waiting for the answer. Pair with gemini_wait_reply.',
  { prompt: str('What to ask.'), send: bool('Actually send (default true); false just fills the composer.') },
  async (a) => text(await page('gemini.send', a, 60000)),
  { required: ['prompt'] });

tool('gemini_wait_reply', 'Wait for Gemini\'s in-flight answer to finish and return it.',
  { timeout_ms: num('Default 600000.'), quiet_ms: num('Default 1500.'), baseline_count: num('Number of model turns before the prompt was sent.') },
  async (a) => text(await page('gemini.wait_reply', a, (a.timeout_ms ?? config.askTimeoutMs) + 60000)));

tool('gemini_stop', 'Stop Gemini mid-response. The partial answer stays in the conversation and can be read with gemini_last_reply.', {}, async () => text(await page('gemini.stop', {}, 30000)));

tool('gemini_last_reply', 'Gemini\'s most recent answer, as text and as reconstructed markdown (code fences, lists, tables and links preserved).',
  {}, async () => text(await page('gemini.last_reply', {}, 45000)));

tool('gemini_messages', 'The whole visible Gemini conversation: every user and model turn with markdown, images, sources and code blocks.',
  { count: num('Only the last N turns.'), markdown: bool('Include reconstructed markdown (default true).') },
  async (a) => text(await page('gemini.messages', a, 60000)));

tool('gemini_sources', 'Citations attached to Gemini\'s latest answer.', {}, async () => text(await page('gemini.sources', {}, 30000)));

tool('gemini_images', 'Images in Gemini\'s latest answer (generated pictures, charts, diagrams), with their URLs. Pass a URL to ai_download to save it.',
  { last_only: bool('Restrict to the latest answer (default true).') },
  async (a) => text(await page('gemini.images', a, 30000)));

tool('gemini_canvas', 'Read the Gemini Canvas / immersive panel, if one is open.', {}, async () => text(await page('gemini.canvas', {}, 30000)));

tool('gemini_regenerate', 'Regenerate Gemini\'s latest answer, replacing it with a new draft for the same prompt.', { wait: bool('Wait for the new answer (default true).'), timeout_ms: num('Default 600000.') },
  async (a) => text(await page('gemini.regenerate', a, (a.timeout_ms ?? config.askTimeoutMs) + 60000)));

tool('gemini_modify_response', 'Ask Gemini to redo its latest answer in a different register.',
  { style: str('Menu label: "Shorter", "Longer", "Simpler", "More casual", "More professional".'), wait: bool('Wait for the new answer (default true).'), timeout_ms: num('Default 300000.') },
  async (a) => text(await page('gemini.modify_response', a, (a.timeout_ms ?? 300000) + 60000)),
  { required: ['style'] });

tool('gemini_new_chat', 'Start a fresh Gemini conversation, clearing the current thread and any tools enabled for it. Verified: returns only once the page is in the empty new-chat state.', {}, async () => text(await geminiFreshChat()));

tool('gemini_conversations', 'List Gemini conversations (id, title, last update) straight from Gemini\'s history API — fast, works with the tab hidden. Each is marked bridge_created when the bridge made it (those are the ones cleanup can delete). Pass sidebar:true for the old scroll-the-sidebar listing.',
  { limit: num('Max returned (default 100).'), sidebar: bool('Read the sidebar instead of the API.'), scroll: bool('Sidebar mode: scroll to load more (default true).'), scroll_pages: num('Sidebar mode: how many times to scroll (default 3).') },
  async (a) => {
    if (a.sidebar) return text(await page('gemini.conversations', a, 90000));
    const r = await page('gemini.list_conversations_api', { limit: a.limit ?? 100 }, 30000);
    const mine = readLedger().conversations;
    return text({ conversations: (r.conversations ?? []).map((c) => ({ ...c, ...(mine[c.conversation_id] ? { bridge_created: true } : {}) })) });
  });

tool('gemini_open_conversation', 'Switch Gemini to another conversation, by sidebar index or title.',
  { index: num('Index from gemini_conversations.'), title: str('Match on the conversation title.'), conversation_id: str('Falls back to navigation if the conversation is not in the loaded sidebar.') },
  async (a) => {
    const r = await page('gemini.open_conversation', a, 60000);
    if (r?.needs_navigation) {
      await ext('ext.navigate', { site: 'gemini', url: r.url });
            return text({ ...r, navigated: true, ready: await on('gemini', 'sys.ready', { timeout_ms: 90000 }, 105000).catch((e) => ({ error: String(e.message) })) });
    }
    return text(r);
  });

tool('gemini_conversation_action', 'Rename, pin or delete a Gemini conversation from its sidebar menu. Deleting is blocked unless AI_MCP_ALLOW_DELETE is set.',
  { action: enm('What to do.', ['rename', 'delete', 'pin']), index: num('Sidebar index.'), title: str('Match on title instead.'), new_title: str('New title, for rename.'), confirm: bool('Accept the confirmation dialog (default true).') },
  async (a) => text(await page('gemini.conversation_action', a, 60000)),
  { required: ['action'] });

tool('gemini_models',
  'List what the Gemini mode picker currently offers, and which one is selected. The picker is state-dependent — it is not rendered while a response is generating, so call this from an idle chat. gemini_status reports the current mode without needing the picker at all.',
  {}, async () => text(await page('gemini.models', {}, 45000)));

tool('gemini_set_model', 'Switch the Gemini model and/or Extended thinking. Verified by reading the picker back. Models are menu text ("3.1 Pro", "3.8 Flash", "3.5 Flash-Lite", or just "Pro"/"Flash"/"Flash-Lite"); Extended thinking is a separate on/off that layers on the model.',
  { model: str('Model menu text; omit to change only thinking.'), thinking: bool('true = Extended thinking on, false = off.') },
  async (a) => text(await page('gemini.set_model', a, 45000)));

/*
 * The "Upload & tools" menu renders EMPTY unless the tab is genuinely visible, so both of
 * these run inside a verified focus hold and hand the operator's tab back afterwards.
 */
tool('gemini_tools', 'List the tools Gemini offers in its "Upload & tools" menu and toolbox drawer. Briefly brings the Gemini tab to the front (the menu is empty while hidden).',
  {}, async () => text(await withSiteFocus('gemini', () => page('gemini.tool_options', {}, 45000))));

tool('gemini_use_tool', 'Turn a Gemini tool on (or off) for the next prompt: Create image, Create video, Create music, or anything under More tools (Deep Research, Canvas, …). gemini_tools lists them. Briefly brings the Gemini tab to the front.',
  { tool: str('Tool label, e.g. "Create image", "Deep Research" (aliases: image, video, music).'), enable: bool('false turns it off (default true).') },
  async (a) => text(await withSiteFocus('gemini', () => page('gemini.toggle_tool', a, 45000))),
  { required: ['tool'] });

tool('gemini_gems', 'List the Gems in the sidebar, or open one. Opening a Gem starts a new conversation governed by that Gem\'s instructions.', { select: str('Gem name to open; omit to just list them.') },
  async (a) => text(await page('gemini.gems', a, 60000)));

tool('gemini_attach', 'Attach a file to the Gemini composer, ready for the next prompt.',
  { path: str('Absolute path to a local file.'), base64: str('File bytes, base64 encoded.'), text: str('Inline text, uploaded as a text file.'), filename: str('Name shown in the chip.'), mimetype: str('Content type.'), wait: bool('Wait for the upload chip to appear (default true).') },
  async (a) => {
    const resolved = resolveOutgoing(a);
    if (a.wait === false) {
      const media = resolved.source_path ? { path: resolved.source_path, bytes: resolved.bytes } : saveMedia(resolved.base64, resolved.mimetype, resolved.filename);
      await withSiteFocus('gemini', () => ext('ext.set_file_input', { site: 'gemini', path: media.path }, config.timeoutMs));
      return text({ ok: true, filename: resolved.filename, bytes: media.bytes, waited: false });
    }
    try {
      return text(await attachGeminiTrusted(resolved));
    } catch (e) {
      return text(await page('gemini.attach', { ...resolved, wait: a.wait }, config.timeoutMs * 3));
    }
  });

tool('gemini_share', 'Open Gemini\'s share/export menu, or run one of its actions (create a public link, export to Docs, draft in Gmail).',
  { action: str('Menu label to click; omit to list the menu.') },
  async (a) => text(await page('gemini.share', a, 60000)));

tool('gemini_feedback', 'Thumbs-up or thumbs-down Gemini\'s latest answer.', { rating: enm('Which way.', ['up', 'down']) },
  async (a) => text(await page('gemini.feedback', a, 30000)));

tool('gemini_send_api',
  'Send a prompt straight to Gemini\'s StreamGenerate endpoint and return the answer, bypassing the UI entirely. Needs one prompt to have gone through the UI this session first: the request carries an opaque anti-abuse token that is issued to the page and cannot be constructed. Use this for speed, for batches, and for the new-chat zero state that the UI cannot send from.',
  {
    prompt: str('What to ask.'),
    new_chat: bool('Start a new conversation instead of continuing.'),
    conversation_id: str('Continue this conversation (c_… id).'),
    response_id: str('Previous response id (r_…), for continuation.'),
    candidate_id: str('Previous candidate id (rc_…), for continuation.'),
    request_id: str('Use a specific captured request as the template.'),
    raw: bool('Include the raw response body, for when a field has moved.'),
  },
  async (a) => {
    const r = await page('gemini.send_api', a, 300000);
    if (!r.ok) return text(r);
    return answer(r.text, { conversation_id: r.conversation_id, response_id: r.response_id, candidate_id: r.candidate_id, model: r.model, ms: r.elapsed_ms });
  },
  { required: ['prompt'] });

tool('gemini_rpc',
  'Call a Gemini batchexecute RPC directly, with the page\'s XSRF token. Call it with no rpcid to see which ones the app has already used this session.',
  { rpcid: str('RPC id, e.g. "otAQ7b" for the model catalogue.'), payload: { type: 'array', description: 'The RPC payload array.', items: {} }, raw: bool('Include the raw response body.') },
  async (a) => text(await page('gemini.rpc', a, 90000)));

/* ==================== ChatGPT ==================== */

tool('chatgpt_status', 'ChatGPT tab state: signed in, account and plan, current conversation, streaming, and where the bridge got its bearer token.',
  {}, async () => text(await page('chatgpt.status', {}, 45000)));

tool('chatgpt_ask',
  'Send a prompt to ChatGPT and return the finished answer. The text comes from the response stream rather than the rendered HTML, so code fences, tables and maths survive intact; the rendered text is returned alongside as a cross-check. Waits through reasoning models and tool use.',
  {
    prompt: str('What to ask.'),
    model: str('Switch the model picker first, e.g. "GPT-5.2", "Thinking", "Auto". Matched against the visible menu text.'),
    tools: arr('Composer tools to enable first, by label: "Search", "Deep research", "Create image", "Study", "Canvas", "Agent mode".'),
    attachments: arr('Files to attach before sending.', ATTACHMENT),
    wait: bool('Wait for the answer (default true).'),
    verbose: bool('Return the full diagnostic object instead of just the answer. Off by default: the plain answer plus a one-line metadata footer is a fraction of the size.'),
    timeout_ms: num('How long to wait (default 600000).'),
    quiet_ms: num('How long the answer must stop changing before it counts as finished (default 1200).'),
  },
  async (a) => {
    const { attachments, ...rest } = a;
    if (attachments?.length) await attachAll('chatgpt', attachments);
    const r = await page('chatgpt.ask', { ...rest, lean: a.verbose !== true }, (a.timeout_ms ?? config.askTimeoutMs) + 60000);
    if (a.verbose) return text(r);
    return answer(r.text, {
      conversation_id: r.conversation_id,
      message_id: r.message_id,
      model: r.model_slug,
      ms: r.elapsed_ms,
      ...(r.text_source !== 'stream' ? { text_source: r.text_source } : {}),
      ...(r.settled === false ? { unsettled: true } : {}),
      ...(r.timed_out ? { timed_out: true } : {}),
      ...(r.stream_error ? { stream_error: r.stream_error } : {}),
    });
  },
  { required: ['prompt'] });

tool('chatgpt_send', 'Type a prompt into ChatGPT and send it without waiting. Pair with chatgpt_wait_reply.',
  { prompt: str('What to ask.'), send: bool('Actually send (default true); false just fills the composer.') },
  async (a) => text(await page('chatgpt.send', a, 60000)),
  { required: ['prompt'] });

tool('chatgpt_wait_reply', 'Wait for ChatGPT\'s in-flight answer to finish and return it.',
  { timeout_ms: num('Default 600000.'), quiet_ms: num('Default 1200.'), baseline_count: num('Number of assistant messages before the prompt was sent.') },
  async (a) => text(await page('chatgpt.wait_reply', a, (a.timeout_ms ?? config.askTimeoutMs) + 60000)));

tool('chatgpt_stop', 'Stop ChatGPT mid-response. The partial answer stays in the thread and can be read with chatgpt_last_reply.', {}, async () => text(await page('chatgpt.stop', {}, 30000)));

tool('chatgpt_last_reply', 'ChatGPT\'s most recent answer, preferring the raw markdown from the response stream over the rendered HTML.',
  {}, async () => text(await page('chatgpt.last_reply', {}, 45000)));

tool('chatgpt_messages', 'The visible ChatGPT thread: every message with role, id, model, text, code blocks, images and links.',
  { count: num('Only the last N messages.'), include_code: bool('Include extracted code blocks (default true).') },
  async (a) => text(await page('chatgpt.messages', a, 60000)));

tool('chatgpt_code_blocks', 'Extract code blocks with their languages from ChatGPT\'s answer.',
  { last_only: bool('Only the latest answer (default true).') },
  async (a) => text(await page('chatgpt.code_blocks', a, 30000)));

tool('chatgpt_canvas', 'Read the ChatGPT Canvas document for a conversation, from the API when available and the panel otherwise.',
  { conversation_id: str('Defaults to the open conversation.') },
  async (a) => text(await page('chatgpt.canvas', a, 45000)));

tool('chatgpt_regenerate', 'Regenerate ChatGPT\'s latest answer. This forks the conversation tree; chatgpt_conversation follows whichever branch is current.', { wait: bool('Wait for the new answer (default true).'), timeout_ms: num('Default 600000.') },
  async (a) => text(await page('chatgpt.regenerate', a, (a.timeout_ms ?? config.askTimeoutMs) + 60000)));

tool('chatgpt_continue', 'Press "Continue generating" when ChatGPT stopped on a length limit.',
  { wait: bool('Wait for the continuation (default true).'), timeout_ms: num('Default 600000.') },
  async (a) => text(await page('chatgpt.continue', a, (a.timeout_ms ?? config.askTimeoutMs) + 60000)));

tool('chatgpt_new_chat', 'Start a fresh ChatGPT conversation, clearing the thread and any composer tools enabled for it.', {},
  async () => {
    const r = await page('chatgpt.new_chat', {}, 45000);
    if (r?.needs_navigation) {
      await ext('ext.navigate', { site: 'chatgpt', url: r.url });
            return text({ ...r, navigated: true, ready: await on('chatgpt', 'sys.ready', { timeout_ms: 90000 }, 105000).catch((e) => ({ error: String(e.message) })) });
    }
    return text(r);
  });

tool('chatgpt_conversations', 'List ChatGPT conversations from the account API, with ids, titles and timestamps.',
  { limit: num('Page size (default 28, max 100).'), offset: num('Pagination offset.'), order: str('"updated" (default) or "created".'), archived: bool('List archived conversations instead.') },
  async (a) => text(await page('chatgpt.conversations', a, 45000)));

tool('chatgpt_search_conversations', 'Search your ChatGPT conversation history.', { query: str('Search text.') },
  async (a) => text(await page('chatgpt.search_conversations', a, 45000)),
  { required: ['query'] });

tool('chatgpt_conversation',
  'Read a full ChatGPT conversation from the API. The stored form is a tree — every edit and regeneration forks it — so this walks back from the current node to return the branch you are actually looking at.',
  { conversation_id: str('Defaults to the open conversation.'), count: num('Only the last N messages.'), include_tool_messages: bool('Include reasoning traces and tool calls (default false).') },
  async (a) => text(await page('chatgpt.conversation', a, 60000)));

tool('chatgpt_open_conversation', 'Switch ChatGPT to another conversation by id.', { conversation_id: str('Conversation id from chatgpt_conversations.') },
  async (a) => {
    const r = await page('chatgpt.open_conversation', a, 45000);
    if (r?.needs_navigation) {
      await ext('ext.navigate', { site: 'chatgpt', url: r.url });
            return text({ ...r, navigated: true, ready: await on('chatgpt', 'sys.ready', { timeout_ms: 90000 }, 105000).catch((e) => ({ error: String(e.message) })) });
    }
    return text(r);
  },
  { required: ['conversation_id'] });

tool('chatgpt_rename', 'Rename a ChatGPT conversation. Affects the stored title only, not its contents.', { conversation_id: str('Defaults to the open one.'), title: str('New title.') },
  async (a) => text(await page('chatgpt.rename', a, 45000)),
  { required: ['title'] });

tool('chatgpt_archive', 'Archive (or unarchive) a ChatGPT conversation.', { conversation_id: str('Defaults to the open one.'), archived: bool('False unarchives (default true).') },
  async (a) => text(await page('chatgpt.archive', a, 45000)));

tool('chatgpt_delete', 'Delete a ChatGPT conversation. Blocked unless AI_MCP_ALLOW_DELETE is set, because there is no undo.',
  { conversation_id: str('Defaults to the open one.') },
  async (a) => text(await page('chatgpt.delete', a, 45000)));

tool('chatgpt_share', 'Create a public share link for a ChatGPT conversation.',
  { conversation_id: str('Defaults to the open one.'), anonymous: bool('Hide your name (default true).'), publish: bool('Publish immediately (default true); false creates an unpublished link.'), title: str('Title for the shared page.') },
  async (a) => text(await page('chatgpt.share', a, 60000)));

tool('chatgpt_feedback', 'Send a thumbs-up or thumbs-down rating on a ChatGPT message, with optional free-text feedback and tags.', { rating: enm('Which way.', ['up', 'down']), conversation_id: str('Defaults to the open one.'), message_id: str('Defaults to the latest answer.'), text: str('Free-text feedback.'), tags: arr('Feedback tags.') },
  async (a) => text(await page('chatgpt.feedback', a, 45000)),
  { required: ['rating'] });

tool('chatgpt_models', 'List the models your ChatGPT account can use, with token limits and capabilities.',
  {}, async () => text(await page('chatgpt.models', {}, 45000)));

tool('chatgpt_set_model', 'Switch the ChatGPT model picker. Matching is on the visible menu text; chatgpt_model_options reports exactly what is on offer.', { model: str('Menu text to match, e.g. "Thinking", "Auto", "GPT-5.2".') },
  async (a) => text(await page('chatgpt.set_model', a, 45000)),
  { required: ['model'] });

tool('chatgpt_model_options',
  'Open the ChatGPT model menu and report exactly what it offers right now. The switcher is not present on every plan or in every state — chatgpt_models reads the account\'s model list from the API instead and always works.',
  {}, async () => text(await page('chatgpt.model_options', {}, 45000)));

tool('chatgpt_tools', 'List the composer tools ChatGPT offers (search, deep research, image, study, agent, canvas).',
  {}, async () => text(await page('chatgpt.tool_options', {}, 45000)));

tool('chatgpt_use_tool', 'Turn on a ChatGPT composer tool for the next prompt.', { tool: str('Label to match, e.g. "Search", "Deep research", "Create image".') },
  async (a) => text(await page('chatgpt.toggle_tool', a, 45000)),
  { required: ['tool'] });

tool('chatgpt_attach', 'Attach a file to the ChatGPT composer, ready for the next prompt.',
  { path: str('Absolute path to a local file.'), base64: str('File bytes, base64 encoded.'), text: str('Inline text, uploaded as a text file.'), filename: str('Name shown in the chip.'), mimetype: str('Content type.'), wait: bool('Wait for the upload chip to appear (default true).') },
  async (a) => text(await page('chatgpt.attach', { ...resolveOutgoing(a), wait: a.wait }, config.timeoutMs * 3)));

tool('chatgpt_custom_instructions', 'Read or set ChatGPT\'s custom instructions.',
  { set: bool('Set instead of read.'), about_user: str('"What should ChatGPT know about you".'), about_model: str('"How should ChatGPT respond".'), enabled: bool('Whether custom instructions are on (default true).') },
  async (a) => text(await page('chatgpt.custom_instructions', a, 45000)));

tool('chatgpt_memories', 'Read your ChatGPT saved memories, or delete one / all of them.',
  { delete_id: str('Delete a single memory.'), clear: bool('Delete every memory.') },
  async (a) => text(await page('chatgpt.memories', a, 45000)));

tool('chatgpt_projects', 'List ChatGPT projects, or read one project with its conversations.',
  { project_id: str('Read this project instead of listing.'), limit: num('Conversations per project (default 5, or 25 when reading one).') },
  async (a) => text(await page('chatgpt.projects', a, 45000)));

tool('chatgpt_gpts', 'List your custom GPTs, read one by id, or search the GPT store.', { gizmo_id: str('Read this GPT.'), query: str('Search the GPT store.') },
  async (a) => text(await page('chatgpt.gpts', a, 45000)));

tool('chatgpt_settings', 'ChatGPT account details, entitlements and beta feature flags.', {}, async () => text(await page('chatgpt.settings', {}, 45000)));

tool('chatgpt_api',
  'Call any ChatGPT backend-api endpoint with the session\'s bearer token. The escape hatch for anything not covered above.',
  { path: str('Path or absolute URL, e.g. "/backend-api/models".'), method: str('Default GET.'), json: { type: 'object', description: 'JSON body.', additionalProperties: true }, headers: { type: 'object', description: 'Extra headers.', additionalProperties: true }, max: num('Character cap on a non-JSON body.') },
  async (a) => text(await page('chatgpt.api', a, 90000)),
  { required: ['path'] });

/* ==================== Google Flow ==================== */

/*
 * Flow moved to https://flow.google.com/ in Sep 2026 and was rebuilt. Generation there is
 * deliberately human-gated: the app labels any reCAPTCHA token an extension mints as
 * "extension_hijack_detected" and ignores untrusted submits. So these tools do everything
 * around the click — project, mode, model, aspect, count, duration, resolution, prompt — and
 * then wait for the user to press Generate in the Flow tab and collect what the app produced.
 * Nothing here ever calls reCAPTCHA or a generation RPC.
 */

const FLOW_OPTS = {
  mode: enm('Image or Video.', ['Image', 'Video']),
  model: str('Model as the menu shows it — image: "Nano Banana Pro", "Nano Banana 2", "Nano Banana 2 Lite"; video: "Omni 1.1 Flash", "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality". Keys like NARWHAL or veo_3_1_t2v_fast also work.'),
  aspect_ratio: str('"16:9", "4:3", "1:1", "3:4", "9:16" (video offers 16:9 and 9:16).'),
  count: num('Outputs per generation, 1-4.'),
  duration: str('Video clip length, e.g. "8s" (Omni offers 4/6/8/10s; Veo 3.1 has no duration choice).'),
  resolution: str('Video resolution, "360p" or "720p" (Omni only).'),
  video_input: enm('Video source mode.', ['Frames', 'Ingredients']),
};

/** Follow a page-side needs_navigation answer, then wait for the app to be usable. */
async function flowNavigate(r) {
  await ext('ext.navigate', { site: 'flow', url: r.url });
  return await on('flow', 'sys.ready', { timeout_ms: 90000 }, 105000).catch((e) => ({ error: String(e.message) }));
}

tool('flow_status', 'Flow tab state: signed in, account, current project, credits, the current settings summary and whether any generation has been started.',
  {}, async () => text(await page('flow.status', {}, 45000)));

tool('flow_credits', 'Your remaining Flow credits, from Flow\'s own GetCredits RPC.',
  {}, async () => text(await page('flow.credits', {}, 30000)));

tool('flow_models', 'The model catalogue from Flow\'s own GetModels RPC: image and video model keys, display names, credit cost per tier and clip length. Legacy and Ultra-only video keys are hidden unless all_video is set.',
  { refresh: bool('Re-read instead of using the cached answer.'), all_video: bool('Include legacy, Ultra-tier and relaxed/low-priority video keys.') },
  async (a) => text(await page('flow.models', a, 60000)));

tool('flow_options', 'Every choice the settings panel offers right now, for both Image and Video mode: models, aspect ratios, counts, durations, resolutions, video input modes, plus the current selection and its credit cost.',
  {}, async () => text(await page('flow.options', {}, 120000)));

tool('flow_configure', 'Set any combination of mode / model / aspect ratio / count / duration / resolution / video input through Flow\'s real settings panel, and read it back with the credit cost the panel shows. Spends nothing.',
  FLOW_OPTS, async (a) => text(await page('flow.configure', a, 90000)));

tool('flow_set_option', 'Select one Flow option by its visible text ("9:16", "x2", "8s", "720p", "Video", "Veo 3.1 - Fast").',
  { label: str('Option text.') },
  async (a) => text(await page('flow.set_option', a, 60000)),
  { required: ['label'] });

tool('flow_set_prompt', 'Type a prompt into the Flow composer without generating.',
  { prompt: str('The prompt.') },
  async (a) => text(await page('flow.set_prompt', a, 60000)),
  { required: ['prompt'] });

tool('flow_projects', 'List Flow projects (id, title, last update, thumbnail).',
  { limit: num('Max projects (default 50).') },
  async (a) => text(await page('flow.projects', a, 60000)));

tool('flow_open_project', 'Open a Flow project by id, title or index from flow_projects.',
  { project_id: str('Project id.'), index: num('Index from flow_projects.'), title: str('Match on the project title.') },
  async (a) => {
    const r = await page('flow.open_project', a, 60000);
    if (r?.needs_navigation) return text({ ...r, navigated: true, ready: await flowNavigate(r) });
    return text(r);
  });

/*
 * Projects are created with Flow's own CreateProject RPC (one call, no home page, no clicks)
 * and recorded in the bridge's Flow ledger, which is what lets flow_delete_project remove them
 * later without AI_MCP_ALLOW_DELETE.
 */
async function flowCreateProject({ title, open = true } = {}) {
  const r = await page('flow.create_project', { title }, 30000);
  flowLedger.record(r.project_id, { tool: 'flow_create_project', title: r.title });
  if (open) { await ext('ext.navigate', { site: 'flow', url: r.url }); await on('flow', 'sys.ready', { timeout_ms: 60000 }, 70000).catch(() => null); }
  return { ...r, opened: !!open };
}

tool('flow_new_project', 'Create a new Flow project (one API call) and open it.', { title: str('Project title (defaults to the date and time).'), open: bool('Open it in the Flow tab (default true).') },
  async (a) => text(await flowCreateProject(a)));

tool('flow_create_project', 'Create a Flow project with one API call, optionally without opening it. Projects made here can later be removed with flow_delete_project.',
  { title: str('Project title.'), open: bool('Open it in the Flow tab (default false).') },
  async (a) => text(await flowCreateProject({ ...a, open: !!a.open })));

const FLOW_GEN = {
  prompt: str('The prompt.'),
  ...FLOW_OPTS,
  wait: bool('Wait for the Generate click and the finished media (default true). false = set everything up and return at once; then call flow_wait_generation.'),
  save_to: str('Folder to save the results into once they land (full resolution).'),
  click_timeout_ms: num('How long to wait for the Generate click (default 600000).'),
  timeout_ms: num('Overall wait including generation (default 900000).'),
};

const { mode: _mode, ...FLOW_GEN_NOMODE } = FLOW_GEN;

const flowGenerate = (method, fixed = {}) => async (a) => text(await flowGenerateRun(method, { ...a, ...fixed }));

async function flowGenerateRun(method, a) {
  const { save_to, ...args } = a;
  await ext('ext.focus', { site: 'flow', settle_ms: 150 }, 15000).catch(() => null);
  const r = await page(method, args, (a.wait === false ? 0 : (a.timeout_ms ?? 900000)) + 120000);
  if (save_to && r?.ok && r.media?.length) r.saved = await flowSave({ ids: r.media.map((m) => m.media_id), dir: save_to, project_id: r.project_id });
  return r;
}

/*
 * Saving uses the browser's own downloader on the signed lh3 url from the project contents:
 * verified 2026-10-01 that it returns the full-resolution file. The flow-content.google links
 * the page shows only work with cookies partitioned to the Flow page itself (403 to the
 * worker, SERVER_FORBIDDEN to the downloader), and page fetches of lh3 are blocked by CORS.
 */
async function flowSave({ ids, baseline_ids, source, limit, dir, project_id, subdir = 'ai-mcp/flow' } = {}) {
  const { items } = await page('flow.media_urls', { ids, baseline_ids, source, limit, project_id }, 45000);
  const out = [];
  const used = new Set();
  for (const it of items) {
    if (!it.url) { out.push({ media_id: it.media_id, ok: false, error: 'no_url' }); continue; }
    const suffix = it.type === 'video' ? 'mp4' : (/png/.test(it.mime || '') ? 'png' : 'jpg');
    let base = it.name || it.media_id;
    if (used.has(base)) base = `${base} ${it.media_id.slice(0, 8)}`;
    used.add(base);
    try {
      const d = await ext_download(it.url, `${subdir}/${base}.${suffix}`);
      let path = d.path;
      if (dir && path) {
        mkdirSync(dir, { recursive: true });
        const target = join(dir, basename(path));
        copyFileSync(path, target);
        unlinkSync(path);
        path = target;
      }
      out.push({ media_id: it.media_id, ok: true, path, bytes: d.bytes, mime: d.mime });
    } catch (e) {
      out.push({ media_id: it.media_id, ok: false, error: String(e.message || e) });
    }
  }
  return out;
}
const ext_download = (url, filename) => ext('ext.download', { url, filename, wait: true, timeout_ms: 180000 }, 200000);

tool('flow_generate',
  'Set up a Flow generation and collect the result. Configures mode/model/aspect/count/duration/resolution, types the prompt, brings the Flow tab forward and waits for YOU to press Generate there (Flow refuses automated submits by design), then returns the new media with URLs. Credits are spent by your click, at the cost reported in credits_cost.',
  FLOW_GEN, flowGenerate('flow.generate'), { required: ['prompt'] });

tool('flow_generate_image', 'flow_generate in Image mode. Image models currently cost 0 credits on this account (see flow_models).',
  FLOW_GEN_NOMODE, flowGenerate('flow.generate_image'), { required: ['prompt'] });

tool('flow_generate_video', 'flow_generate in Video mode (Omni / Veo 3.1). The credit cost of the chosen settings comes back as credits_cost before you click.',
  FLOW_GEN_NOMODE, flowGenerate('flow.generate_video'), { required: ['prompt'] });

tool('flow_wait_generation', 'Wait for a Generate click in the Flow tab and for its media to land; returns the new media. Pass baseline_ids and since_request_id from a flow_generate call made with wait:false.',
  { baseline_ids: arr('Media ids that existed before.'), since_request_id: str('Capture-buffer id from before the click.'), expect: num('How many outputs to wait for (default 1).'), click_timeout_ms: num('Default 600000.'), timeout_ms: num('Default 900000.'), project_id: str('Defaults to the open project.') },
  async (a) => text(await page('flow.wait_generation', a, (a.timeout_ms ?? 900000) + 60000)));

tool('flow_poll_video', 'One-shot check for new media in the open project since a baseline (no waiting for a click).',
  { baseline_ids: arr('Media ids that existed before.'), timeout_ms: num('How long to keep checking (default 600000).'), project_id: str('Defaults to the open project.') },
  async (a) => text(await page('flow.poll_video', a, (a.timeout_ms ?? 600000) + 60000)));

tool('flow_media', 'Media in the open project — generated and uploaded, with URLs, prompts and sizes — plus media visible on the page. Save one with ai_fetch_media or ai_download.',
  { limit: num('Max per list (default 50).') },
  async (a) => text(await page('flow.media', a, 45000)));

tool('flow_media_url', 'The current URL of a media id in the open (or given) project.',
  { media_id: str('The media id.'), project_id: str('Defaults to the open project.') },
  async (a) => text(await page('flow.media_url', a, 30000)),
  { required: ['media_id'] });

tool('flow_scenes', 'The open project\'s generated media grouped by workflow.', {}, async () => text(await page('flow.scenes', {}, 45000)));

tool('flow_upload', 'Put an image into the open Flow project by dropping it onto the project, like dragging a file in (Flow then uploads it itself). Returns the new upload with its media id and url.',
  { path: str('Absolute path to a local image.'), base64: str('Image bytes, base64 encoded.'), filename: str('File name.'), mimetype: str('Content type.'), open_label: str('Menu item text that opens the picker (default "Upload").'), timeout_ms: num('How long to wait for it to appear (default 45000).') },
  async (a) => text(await page('flow.upload', { ...resolveOutgoing(a), timeout_ms: a.timeout_ms }, (a.timeout_ms ?? 45000) + 30000)));

tool('flow_upload_image', 'Alias of flow_upload (Flow\'s upload API needs a reCAPTCHA token, so uploads go through the page\'s own picker).',
  { path: str('Absolute path to a local image.'), base64: str('Image bytes, base64 encoded.'), filename: str('File name.'), mimetype: str('Content type.') },
  async (a) => text(await page('flow.upload', { ...resolveOutgoing(a) }, 90000)));

tool('flow_upscale_image', 'Not automatable on the new Flow (upscaling mints a reCAPTCHA token). Explains the manual route.',
  { media_id: str('The image media id.') },
  async (a) => text(await page('flow.upscale_image', a, 20000)));

tool('flow_generate_batch', 'Run several Flow generations back to back with the same settings: for each prompt the tool sets everything up, you press Generate, it collects (and optionally saves) the media, then moves straight to the next prompt.',
  { prompts: arr('The prompts, in order.'), ...FLOW_OPTS, save_to: str('Folder to save every result into.'), click_timeout_ms: num('Per prompt, how long to wait for your click (default 600000).'), timeout_ms: num('Per prompt, overall wait (default 900000).') },
  async (a) => {
    const results = [];
    for (const [i, prompt] of (a.prompts ?? []).entries()) {
      const r = await flowGenerateRun('flow.generate', { ...a, prompts: undefined, prompt });
      results.push({ index: i, prompt: prompt.slice(0, 80), ok: !!r?.ok, error: r?.error, media: r?.media?.map((m) => ({ media_id: m.media_id, url: m.url })), saved: r?.saved });
      if (!r?.ok && r?.error === 'flow_not_clicked') break;
    }
    return text({ done: results.filter((x) => x.ok).length, of: a.prompts?.length ?? 0, results });
  }, { required: ['prompts'] });

tool('flow_save', 'Download Flow media at full resolution: by id, everything new since a baseline, or the last N of a kind. Files land in Downloads/ai-mcp/flow, or in dir if given.',
  { media_ids: arr('Media (or workflow) ids.'), baseline_ids: arr('Save everything NOT in this list (e.g. from a wait:false generate).'), source: enm('With no ids: only this kind.', ['generated', 'upload']), limit: num('With no ids: only the newest N.'), dir: str('Absolute folder to move the files into.'), project_id: str('Defaults to the open project.') },
  async (a) => text({ saved: await flowSave({ ids: a.media_ids, baseline_ids: a.baseline_ids, source: a.source, limit: a.limit, dir: a.dir, project_id: a.project_id }) }));

tool('flow_favorite', 'Favorite (or unfavorite) Flow media — one direct API call per item, no menus.',
  { media_ids: arr('Media or workflow ids.'), value: bool('false to unfavorite (default true).'), project_id: str('Defaults to the open project.') },
  async (a) => text(await page('flow.favorite', { ids: a.media_ids, value: a.value, project_id: a.project_id }, 30000)), { required: ['media_ids'] });

tool('flow_delete_media', 'Delete Flow media directly (no menus). Default moves it to the project\'s trash — recoverable with flow_restore. permanent:true purges it for good, allowed for projects the bridge created or with AI_MCP_ALLOW_DELETE=1.',
  { media_ids: arr('Media or workflow ids.'), permanent: bool('Purge instead of trashing.'), project_id: str('Defaults to the open project.') },
  async (a) => {
    if (!a.permanent) return text(await page('flow.trash', { ids: a.media_ids, project_id: a.project_id }, 30000));
    const st = await page('flow.status', {}, 30000);
    const pid = a.project_id || st.project_id;
    if (!flowLedger.has(pid) && !config.allowDelete) {
      return text({ ok: false, error: 'permanent_delete_refused', reason: 'this project was not created by the bridge; permanent deletes elsewhere need AI_MCP_ALLOW_DELETE=1. Trash (the default) is always allowed.' });
    }
    return text(await page('flow.delete_media', { ids: a.media_ids, project_id: pid, __server_authorised: true }, 30000));
  }, { required: ['media_ids'] });

tool('flow_restore', 'Restore trashed Flow media (one API call).',
  { media_ids: arr('Media or workflow ids.'), project_id: str('Defaults to the open project.') },
  async (a) => text(await page('flow.restore', { ids: a.media_ids, project_id: a.project_id }, 30000)), { required: ['media_ids'] });

tool('flow_trash_list', 'What is in a Flow project\'s trash.', { project_id: str('Defaults to the open project.') },
  async (a) => text(await page('flow.trash_list', a, 30000)));

tool('flow_rename', 'Rename a Flow media item or a project — direct API call.',
  { media_id: str('Media or workflow id to rename.'), name: str('New name for the media.'), project_id: str('Project id; with title and no media_id, renames the project.'), title: str('New project title.') },
  async (a) => text(a.media_id
    ? await page('flow.rename_media', { id: a.media_id, name: a.name, project_id: a.project_id }, 30000)
    : await page('flow.rename_project', { project_id: a.project_id, title: a.title }, 30000)));

tool('flow_delete_project', 'Delete a Flow project with one API call. Allowed for projects the bridge created (flow_new_project / flow_create_project); others need AI_MCP_ALLOW_DELETE=1.',
  { project_id: str('The project id.') },
  async (a) => {
    const pid = normId(a.project_id);
    if (!pid) return text({ ok: false, error: 'project_id_required' });
    if (!flowLedger.has(pid) && !config.allowDelete) {
      return text({ ok: false, error: 'delete_refused', reason: 'not created by the bridge; deleting other projects needs AI_MCP_ALLOW_DELETE=1' });
    }
    const r = await page('flow.delete_project', { project_id: pid, __server_authorised: true }, 45000);
    if (r.ok) flowLedger.forget([pid]);
    if (r.was_open) await ext('ext.navigate', { site: 'flow', url: SITES.flow }).catch(() => {});
    return text(r);
  }, { required: ['project_id'] });

tool('flow_history', 'Everything generated across your recent Flow projects, newest first: model, prompt, title, url.',
  { projects: num('How many recent projects to scan (default 10).'), limit: num('Max generations (default 100).'), prompt_chars: num('Prompt characters to keep (default 300).') },
  async (a) => text(await page('flow.history', a, 120000)));

tool('flow_characters', 'Your Flow characters (likenesses).', {}, async () => text(await page('flow.characters', {}, 30000)));

tool('flow_probe', 'What is on the Flow page right now: matched selectors, visible buttons, editors, and the settings panel if open.',
  {}, async () => text(await page('flow.probe', {}, 60000)));

tool('flow_observe', 'The batchexecute RPCs the Flow page has made, named (e.g. nzlxg = VideoFxService.GetCredits), with request payloads and any error codes.',
  { host: enm('Only generation RPCs, or all (default).', ['generation', 'all']), limit: num('Max requests (default 20).'), body: bool('Include full request and response payloads.') },
  async (a) => text(await page('flow.observe', a, 60000)));

tool('flow_rpc', 'Call one of Flow\'s batchexecute RPCs by id or method name with a JSPB array payload (e.g. method "GetCredits", inner []). Call with no arguments for the method table. Token-gated RPCs (generation, upload, upscale) are refused.',
  { method: str('Method name, e.g. "GetProjectContents".'), rpc: str('Or the raw rpc id, e.g. "Zzl0ze".'), inner: arr('JSPB payload array.', {}), raw: bool('Include the raw response text.') },
  async (a) => text(await page('flow.rpc', a, 90000)));

tool('flow_generate_api', 'Retired: the new Flow refuses API generation from an extension. Use flow_generate (you press Generate).',
  { prompt: str('Ignored.') }, async (a) => text(await page('flow.generate_api', a, 20000)));

tool('flow_trpc', 'Retired: Flow no longer has tRPC (moved to flow.google.com). Use flow_rpc.',
  { procedure: str('Ignored.') }, async (a) => text(await page('flow.trpc', a, 20000)));

tool('flow_api', 'Make an arbitrary request from the Flow page with its cookies (not to the generation backend).',
  { url: str('Absolute URL.'), method: str('Default GET.'), json: { type: 'object', description: 'JSON body.', additionalProperties: true }, headers: { type: 'object', description: 'Extra headers.', additionalProperties: true } },
  async (a) => text(await page('flow.api', a, 180000)),
  { required: ['url'] });

// ------------------------------------------------------------------ export

export const tools = T;
export const toolMap = new Map(T.map((t) => [t.name, t]));
