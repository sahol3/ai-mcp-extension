/*
 * ai-mcp — background service worker (MV3)
 *
 * Owns the WebSocket to the local daemon, and routes each incoming request to the right
 * tab. It lives here rather than in a content script because requests from the worker are
 * attributed to the extension origin, which sidesteps Private Network Access restrictions
 * on reaching 127.0.0.1 from a public page — a content script making the same request is
 * blocked outright.
 *
 * Routing is by method namespace: `gemini.*` goes to the Gemini tab, `flow.*` to Flow,
 * `chatgpt.*` to ChatGPT, `ext.*` is answered here, and the site-agnostic namespaces
 * (`sys.*`, `dom.*`, `net.*`) take an explicit `site` parameter — falling back to the only
 * connected tab when there is exactly one, because that is unambiguous.
 *
 * Staying alive: MV3 workers idle out after 30s. Three independent things reset the timer —
 * the content script's 15s port heartbeat, the daemon's 20s WebSocket ping, and a 30s alarm
 * that can cold-start the worker even when both of the others are gone. Any one of them
 * alone is unreliable.
 */

const DEFAULTS = { enabled: true, port: 8791, host: '127.0.0.1', token: '' };

const SITES = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    matches: ['https://gemini.google.com/*'],
    files: ['page/core.js', 'page/gemini.js'],
  },
  flow: {
    id: 'flow',
    label: 'Google Flow',
    // Flow moved to its own origin in Sep 2026: labs.google/fx/tools/flow now 308s here.
    url: 'https://flow.google.com/',
    matches: ['https://flow.google.com/*', 'https://labs.google/*'],
    files: ['page/core.js', 'page/flow.js'],
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    files: ['page/core.js', 'page/chatgpt.js'],
  },
};

const ALL_MATCHES = Object.values(SITES).flatMap((s) => s.matches);

/** Which site a URL belongs to, or null. */
function siteOf(url = '') {
  if (/^https:\/\/gemini\.google\.com\//.test(url)) return 'gemini';
  if (/^https:\/\/(?:flow\.google\.com|labs\.google)\//.test(url)) return 'flow';
  if (/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(url)) return 'chatgpt';
  return null;
}

let ws = null;
let wsState = 'disconnected';
let backoff = 1000;
let reconnectTimer = null;
let cfg = { ...DEFAULTS };

/** tabId -> { port, tabId, url, site, hello } — newest insertion wins per site. */
const pagePorts = new Map();

// ------------------------------------------------------------------- config

async function loadConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  cfg = { ...DEFAULTS, ...stored };
  return cfg;
}

// -------------------------------------------------------------------- state

/*
 * The tab a site's calls should go to when several are open: the one ext.open/ext.navigate
 * last pointed at. Without this, "newest port wins" sent calls to whichever tab happened to
 * reconnect last after an extension reload, and ai_open_site(new_tab) answered its readiness
 * wait from the OLD tab before the new one had attached.
 */
const preferredTab = {};
const savePreferred = () => chrome.storage.session?.set({ preferredTab }).catch(() => {});
chrome.storage.session?.get('preferredTab').then((v) => Object.assign(preferredTab, v?.preferredTab || {}), () => {});

/** The preferred tab's port for a site, else the most recently attached one. */
function portFor(site) {
  if (site && preferredTab[site] != null) {
    const pref = pagePorts.get(preferredTab[site]);
    if (pref && pref.site === site) return pref;
  }
  let chosen = null;
  for (const entry of pagePorts.values()) {
    if (site && entry.site !== site) continue;
    chosen = entry;
  }
  return chosen;
}

/** A preferred tab that exists but has not attached its port yet (still loading). */
async function pendingPreferred(site) {
  const id = preferredTab[site];
  if (id == null || pagePorts.has(id)) return null;
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab || siteOf(tab.pendingUrl || tab.url) !== site) { delete preferredTab[site]; return null; }
  return id;
}

function connectedSites() {
  const out = {};
  for (const entry of pagePorts.values()) {
    out[entry.site] = { tabId: entry.tabId, url: entry.url, ready: !!entry.hello?.ready, hello: entry.hello ?? null };
  }
  return out;
}

function setBadge() {
  const sites = connectedSites();
  const total = Object.keys(sites).length;
  const ready = Object.values(sites).filter((s) => s.ready).length;
  let text = '', color = '#6b7280';
  if (!cfg.enabled) { text = 'off'; color = '#6b7280'; }
  else if (wsState !== 'connected') { text = '!'; color = '#ef4444'; }
  else if (total === 0) { text = '0'; color = '#f97316'; }
  else if (ready === total) { text = String(ready); color = '#22c55e'; }
  else { text = `${ready}/${total}`; color = '#eab308'; }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function status() {
  return {
    enabled: cfg.enabled,
    ws: wsState,
    endpoint: `ws://${cfg.host}:${cfg.port}`,
    sites: connectedSites(),
    known_sites: Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, { label: v.label, url: v.url }])),
  };
}

// ---------------------------------------------------------------- websocket

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; } catch {}
  }
  return false;
}

function connectWS() {
  clearTimeout(reconnectTimer);
  if (!cfg.enabled) { wsState = 'disabled'; setBadge(); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const url = `ws://${cfg.host}:${cfg.port}/?role=extension${cfg.token ? '&token=' + encodeURIComponent(cfg.token) : ''}`;
  wsState = 'connecting';
  setBadge();

  let sock;
  try { sock = new WebSocket(url); } catch { scheduleReconnect(); return; }
  ws = sock;

  /*
   * Every handler checks that `sock` is still the current socket. Without that, a
   * superseded socket closing (the daemon closes the old one when a newer extension
   * connects) nulls out the live connection and starts an endless reconnect storm.
   */
  sock.onopen = () => {
    if (ws !== sock) return;
    wsState = 'connected';
    backoff = 1000;
    setBadge();
    wsSend({ kind: 'hello', role: 'extension', status: status() });
  };

  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerFrame(msg);
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    wsState = 'disconnected';
    setBadge();
    scheduleReconnect();
  };

  sock.onerror = () => { try { sock.close(); } catch {} };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!cfg.enabled) return;
  backoff = Math.min(backoff * 1.6, 15000);
  reconnectTimer = setTimeout(connectWS, backoff);
}

// ------------------------------------------------------------- (re)injection

/*
 * Manifest content scripts only run on navigation. Reloading the extension (or installing
 * it while the sites are already open) leaves those tabs with a severed context: no bridge
 * in the page and no port back here. Re-injecting only the relay restores the port — which
 * makes the tab *look* connected while every page call fails — so both worlds are restored,
 * in the same order the manifest declares them.
 */
async function ensureInjected(tabId, url, { force = false } = {}) {
  const site = siteOf(url);
  if (!site) return { tabId, ok: false, error: 'not_a_known_site', url };
  const spec = SITES[site];

  let state = { core: false, site: false, version: null };
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => ({
        core: !!window.__AIMCP__,
        site: window.__AIMCP__?.site?.id ?? null,
        version: window.__AIMCP__?.core_version ?? null,
        epoch: window.__AIMCP_EPOCH__ ?? null,
      }),
    });
    state = probe?.result ?? state;
  } catch (e) {
    return { tabId, site, ok: false, error: String(e?.message || e) };
  }

  // Relay first: the page bridge announces itself the moment it boots, and that
  // announcement is dropped on the floor when nothing is listening yet.
  let hasRelay = false;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__AIMCP_RELAY__ });
    hasRelay = !!r?.result;
  } catch {}
  let relayError = null;
  if (!hasRelay) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/relay.js'] })
      .catch((e) => { relayError = String(e?.message || e); });
  }

  // The page world outlives an extension reload, so a bridge that is present may well be
  // the OLD build. `force` is set whenever this worker has just started, i.e. right after
  // a reload or update — which is exactly when the stale copy needs replacing.
  const needsBridge = force || !state.core || state.site !== site;
  let injectError = null;
  if (needsBridge) {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: spec.files })
      .catch((e) => { injectError = String(e?.message || e); });
  }

  return {
    tabId, site, url,
    ok: !injectError && !relayError,
    injected: needsBridge ? spec.files : [],
    relay_injected: !hasRelay,
    was: state,
    ...(injectError ? { inject_error: injectError } : {}),
    ...(relayError ? { relay_error: relayError } : {}),
  };
}

async function ensureAllTabs(opts = {}) {
  const tabs = await chrome.tabs.query({ url: ALL_MATCHES }).catch(() => []);
  const out = [];
  for (const t of tabs) out.push(await ensureInjected(t.id, t.url, opts));
  return out;
}

/**
 * The one tab a site's calls act on.
 *
 * Page calls go to whichever tab owns the relay port; every ext.* handler used to take
 * `tabs[0]` instead. With two tabs of the same site open, `chatgpt.ask` typed into one and
 * `ext.trusted_input` / `ai_screenshot` / `ai_reload_tab` acted on the other.
 */
async function resolveTab(site) {
  const port = portFor(site);
  if (port) {
    const tab = await chrome.tabs.get(port.tabId).catch(() => null);
    if (tab) return tab;
  }
  return (await tabsForSite(site))[0] ?? null;
}

async function tabsForSite(site) {
  const spec = SITES[site];
  if (!spec) throw new Error(`unknown_site: ${site} — known sites are ${Object.keys(SITES).join(', ')}`);
  return await chrome.tabs.query({ url: spec.matches });
}

// -------------------------------------------------------- request handling

/** Methods answered by the worker itself rather than by a page. */
const LOCAL = {
  'ext.status': async () => ({
    ...status(),
    screenshots_enabled: await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false),
  }),

  'ext.tabs': async () => {
    const tabs = await chrome.tabs.query({ url: ALL_MATCHES });
    return {
      tabs: tabs.map((t) => ({
        id: t.id, site: siteOf(t.url), url: t.url, title: t.title,
        active: t.active, windowId: t.windowId, discarded: t.discarded, status: t.status,
        connected: pagePorts.has(t.id),
      })),
    };
  },

  'ext.open': async (p = {}) => {
    const site = String(p.site || '');
    const spec = SITES[site];
    if (!spec) throw new Error(`unknown_site: ${site} — known sites are ${Object.keys(SITES).join(', ')}`);
    const existing = await tabsForSite(site);
    if (p.tab_id != null) {
      const tab = existing.find((t) => t.id === Number(p.tab_id));
      if (!tab) throw new Error(`no_such_${site}_tab: ${p.tab_id} — have ${existing.map((t) => t.id).join(', ') || 'none'}`);
      if (p.url && tab.url !== p.url) await chrome.tabs.update(tab.id, { url: p.url });
      if (p.focus !== false) await chrome.tabs.update(tab.id, { active: true });
      preferredTab[site] = tab.id; savePreferred();
      return { opened: false, tabId: tab.id, url: p.url || tab.url, preferred: true };
    }
    if (existing.length && !p.new_tab) {
      const current = portFor(site);
      const tab = existing.find((t) => t.id === current?.tabId) ?? existing[0];
      if (p.url && tab.url !== p.url) await chrome.tabs.update(tab.id, { url: p.url });
      if (p.focus !== false) await chrome.tabs.update(tab.id, { active: true });
      preferredTab[site] = tab.id; savePreferred();
      return { opened: false, tabId: tab.id, url: p.url || tab.url };
    }
    const t = await chrome.tabs.create({ url: p.url || spec.url, active: p.focus !== false });
    preferredTab[site] = t.id; savePreferred();
    return { opened: true, tabId: t.id, url: t.pendingUrl || t.url };
  },

  'ext.navigate': async (p = {}) => {
    const entry = portFor(p.site) ?? (await tabsForSite(p.site))[0];
    if (!entry) throw new Error(`no_tab_for_site: ${p.site}`);
    const tabId = entry.tabId ?? entry.id;
    if (!p.url) throw new Error('url_required');
    preferredTab[p.site] = tabId; savePreferred();
    const old = pagePorts.get(tabId);
    const started = Date.now();
    await chrome.tabs.update(tabId, { url: String(p.url) });
    /*
     * Return when the NEW page's bridge has attached and said hello, not before. Callers used
     * to sleep 1.5-2.5 s here and still risked their next call being answered by the page
     * that was being navigated away from.
     */
    let fresh = false;
    if (p.wait !== false) {
      const until = started + Number(p.timeout_ms ?? 30000);
      while (Date.now() < until) {
        const cur = pagePorts.get(tabId);
        if (cur && cur !== old && cur.hello) { fresh = true; break; }
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    return { ok: true, tabId, url: p.url, bridge_attached: fresh, ms: Date.now() - started };
  },

  /*
   * Bring a site's tab to the foreground. Some of these apps throttle or refuse to
   * bootstrap while hidden, and a media generation left running in a background tab can
   * stall — so this exists for the same reason its WhatsApp counterpart does.
   */
  /*
   * Bring a site's tab genuinely to the front, and report whether that actually happened.
   *
   * "Actually" matters: a minimized window ignores {focused:true}, and the old version
   * reported ok while the page stayed hidden — which then made trusted input silently
   * useless, because CDP mouse events need a compositor the tab is not running and key
   * events go to a window that does not have focus. So the window is un-minimized first and
   * the result carries the page's own visibilityState rather than an assumption.
   */
  'ext.focus': async (p = {}) => {
    const tab = await resolveTab(p.site);
    if (!tab) throw new Error(`no_tab_for_site: ${p.site} — call ext.open first`);
    const previous = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id ?? null;

    let win = null;
    try { win = await chrome.windows.get(tab.windowId); } catch {}
    if (win && win.state === 'minimized') {
      try { await chrome.windows.update(tab.windowId, { state: 'normal' }); } catch {}
    }
    await chrome.tabs.update(tab.id, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    await new Promise((r) => setTimeout(r, p.settle_ms ?? 1200));

    let visibility = null;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => document.visibilityState });
      visibility = r?.result ?? null;
    } catch {}
    let stateAfter = null;
    try { stateAfter = (await chrome.windows.get(tab.windowId)).state; } catch {}

    if (p.restore && previous != null && previous !== tab.id) {
      try { await chrome.tabs.update(previous, { active: true }); } catch {}
    }
    return {
      ok: visibility === 'visible',
      tabId: tab.id,
      windowId: tab.windowId,
      previous_tab_id: previous !== tab.id ? previous : null,
      visibility,
      window_state: stateAfter,
      window_state_before: win?.state ?? null,
      restored_previous: !!p.restore,
      ...(visibility !== 'visible' ? {
        warning: 'the tab is still not visible — another application probably holds focus. ' +
          'Trusted input (ext.trusted_input) will not reach it in this state.',
      } : {}),
    };
  },

  /** Make one specific tab active again — used to hand the operator's tab back after a focus hold. */
  'ext.activate': async (p = {}) => {
    if (p.tab_id == null) throw new Error('tab_id_required');
    const tab = await chrome.tabs.update(Number(p.tab_id), { active: true }).catch(() => null);
    return { ok: !!tab, tabId: p.tab_id };
  },

  'ext.reinject': async (p = {}) => ({ results: await ensureAllTabs({ force: p.force !== false }) }),

  /*
   * Reload the extension itself. Browsers cache an unpacked extension's resources, so
   * edits to the content scripts are NOT picked up by reloading the *page* — only by
   * reloading the extension. This is what makes iterating on the bridge possible without
   * clicking Reload by hand. The worker dies immediately, so the caller gets no reply;
   * it reconnects on its own a moment later.
   */
  'ext.reload_extension': async () => {
    setTimeout(() => chrome.runtime.reload(), 250);
    return { ok: true, note: 'extension reloading; the socket will drop and come back within a few seconds' };
  },

  'ext.reload_tab': async (p = {}) => {
    const tab = await resolveTab(p.site);
    if (!tab) throw new Error(`no_tab_for_site: ${p.site}`);
    const old = pagePorts.get(tab.id);
    const started = Date.now();
    await chrome.tabs.reload(tab.id, { bypassCache: !!p.bypass_cache });
    // Same as ext.navigate: return once the reloaded page's bridge has said hello.
    let fresh = false;
    if (p.wait !== false) {
      const until = started + Number(p.timeout_ms ?? 30000);
      while (Date.now() < until) {
        const cur = pagePorts.get(tab.id);
        if (cur && cur !== old && cur.hello) { fresh = true; break; }
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    return { ok: true, tabId: tab.id, bridge_attached: fresh, ms: Date.now() - started };
  },

  'ext.close_tab': async (p = {}) => {
    if (p.tab_id != null) { await chrome.tabs.remove(Number(p.tab_id)); return { ok: true, closed: [p.tab_id] }; }
    const tabs = await tabsForSite(p.site);
    const ids = tabs.map((t) => t.id);
    if (ids.length) await chrome.tabs.remove(ids);
    return { ok: true, closed: ids };
  },

  /*
   * Genuinely trusted input, via the DevTools protocol.
   *
   * Some controls refuse synthetic events. Gemini's is the clear case: a dispatched Enter
   * on its composer IS handled — the app responds by clicking its own send button — but the
   * resulting click carries isTrusted:false and the send never happens. No amount of event
   * shaping fixes that, because the check is on the browser's own trust bit, and page script
   * cannot forge it. chrome.debugger dispatches through the browser's input pipeline, so the
   * events are indistinguishable from a person typing.
   *
   * Attach and detach around each burst rather than holding the session: an attached
   * debugger shows an infobar on the tab, and leaving one up on the operator's own browser
   * would be rude. It also means a crash cannot strand the tab in a debugged state.
   */
  'ext.trusted_input': async (p = {}) => {
    const tab = await resolveTab(p.site);
    if (!tab) throw new Error(`no_tab_for_site: ${p.site}`);
    const target = { tabId: tab.id };

    const KEYS = {
      Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r' },
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', text: '\t', unmodifiedText: '\t' },
      Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
      Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
      ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
      ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
    };
    const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
    const modifiers = Object.entries(MOD).reduce((m, [k, v]) => m + (p[k] ? v : 0), 0);

    let attached = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
    } catch (e) {
      // Already attached (another tool, or DevTools is open on this tab) is recoverable.
      if (!/already attached/i.test(String(e?.message || e))) {
        throw new Error(
          `debugger_attach_failed: ${e?.message || e} — trusted input needs the "debugger" permission ` +
          'and no other debugger session on this tab (close DevTools for it).'
        );
      }
    }

    try {
      if (p.text) {
        for (const ch of String(p.text)) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, modifiers });
        }
      }
      if (p.key) {
        const k = KEYS[p.key];
        if (!k) throw new Error(`unsupported_key: ${p.key} — known: ${Object.keys(KEYS).join(', ')}`);
        const { text, unmodifiedText, ...common } = k;
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text, unmodifiedText } : {}), modifiers,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common, modifiers });
      }
      if (p.click) {
        const { x, y } = p.click;
        for (const type of ['mousePressed', 'mouseReleased']) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type, x, y, button: 'left', clickCount: 1, modifiers,
          });
        }
      }
      return { ok: true, tabId: target.tabId, dispatched: { key: p.key ?? null, text: p.text ? String(p.text).length + ' chars' : null, click: p.click ?? null } };
    } finally {
      if (attached) { try { await chrome.debugger.detach(target); } catch {} }
    }
  },

  /*
   * Genuinely trusted file selection, via the DevTools protocol.
   *
   * The same isTrusted gate documented above for Enter also covers file inputs on recent
   * Gemini builds: assigning `input.files` via a synthetic DataTransfer and dispatching
   * `change` is accepted by the DOM but the app's own handler never fires — no upload
   * request, no chip, nothing. `DOM.setFileInputFiles` goes through the browser's real input
   * pipeline (the same primitive Playwright/Puppeteer use for `.setInputFiles()`), so the
   * resulting `input`/`change` events are trusted. It reads the file from disk on the
   * browser's side, so `path` must be a path the browser process can read — always true here
   * since server and browser are on the same machine.
   */
  /*
   * `input[type="file"]` is not a persistent, always-in-DOM node here — it mounts only after
   * "Upload & tools" is opened and its "Upload files" item is clicked, and Angular tears it
   * down again shortly after (on Escape, or on its own).
   *
   * Two hazards, two different fixes:
   *
   * 1. A `Runtime.evaluate` to reveal it followed by a *separate* `DOM.setFileInputFiles`
   *    call loses the race almost every time — by the time the second command runs, the
   *    element the first one found is already gone. Fix: the query that *finds* the input is
   *    the query whose objectId gets used for injection, in the very next command, with
   *    nothing in between that could give Angular a chance to unmount it.
   *
   * 2. Polling for the menu item / input to appear by `await new Promise(r =>
   *    setTimeout(r, …))` *inside* the evaluated page expression measured live at over 120
   *    SECONDS for a single ~1s wait — Chrome's intensive throttling of a backgrounded tab's
   *    timers applies to any code running on that page's own event loop, CDP-driven or not.
   *    Fix: every wait loops from *this* side (the service worker's own clock, which is never
   *    throttled the way a hidden tab is) and re-evaluates a cheap synchronous expression each
   *    time, rather than asking the page to wait on its own.
   */
  'ext.set_file_input': async (p = {}) => {
    const tab = await resolveTab(p.site);
    if (!tab) throw new Error(`no_tab_for_site: ${p.site}`);
    if (!p.path) throw new Error('path_required — DOM.setFileInputFiles reads from disk directly, base64 is not accepted here');
    const target = { tabId: tab.id };

    // A session left over from a prior call that threw before its own detach (or one Chrome
    // silently dropped on navigation) answers `attach` with "already attached" while every
    // subsequent sendCommand fails with "Debugger is not attached" — clear it first so this
    // call always starts from a known-clean session rather than inheriting a stale one.
    await chrome.debugger.detach(target).catch(() => {});

    let attached = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
    } catch (e) {
      throw new Error(
        `debugger_attach_failed: ${e?.message || e} — trusted file input needs the "debugger" permission ` +
        'and no other debugger session on this tab (close DevTools for it).'
      );
    }

    const evalOnPage = async (expression) => {
      const res = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: false });
      if (res?.exceptionDetails) throw new Error(`eval_failed: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
      return res?.result;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const CLICK_FN = `function(el) {
      var r = el.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function(type) {
        var Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
        try { el.dispatchEvent(new Ctor(type, type.indexOf('pointer') === 0 ? Object.assign({}, opts, { pointerId: 1, isPrimary: true }) : opts)); } catch (e) {}
      });
      el.click();
    }`;
    const UPLOAD_ITEM_EXPR = `(document.querySelector('[data-test-id="local-images-files-uploader-button"]')` +
      ` || Array.from(document.querySelectorAll('[role="menuitem"]')).find(function(e) { return /upload files/i.test(e.innerText || e.getAttribute('aria-label') || ''); }))`;

    try {
      let found = await evalOnPage(`document.querySelector('input[type="file"]')`);

      if (!found?.objectId) {
        // Right after a reload, `sys.ready` (composer exists) can resolve a beat before the
        // toolbar's own buttons have rendered — poll rather than assume it's already there.
        let btn = null;
        const btnDeadline = Date.now() + 6000;
        while (Date.now() < btnDeadline) {
          btn = await evalOnPage(`document.querySelector('button[aria-label="Upload & tools"]')`);
          if (btn?.objectId) break;
          await sleep(250);
        }
        if (!btn?.objectId) throw new Error('tools_button_not_found_via_cdp');
        await evalOnPage(`(${CLICK_FN})(document.querySelector('button[aria-label="Upload & tools"]'))`);

        let menuItemReady = false;
        const menuDeadline = Date.now() + 8000;
        while (Date.now() < menuDeadline) {
          const check = await evalOnPage(`!!${UPLOAD_ITEM_EXPR}`);
          if (check?.value) { menuItemReady = true; break; }
          await sleep(300);
        }
        if (!menuItemReady) {
          throw new Error(
            'file_input_not_found_via_cdp — "Upload & tools" opened with no "Upload files" item ' +
            '(the tab likely bootstrapped OS-hidden; reload it while genuinely focused, then retry).'
          );
        }

        await evalOnPage(`(${CLICK_FN})(${UPLOAD_ITEM_EXPR})`);

        const inputDeadline = Date.now() + 6000;
        while (Date.now() < inputDeadline) {
          found = await evalOnPage(`document.querySelector('input[type="file"]')`);
          if (found?.objectId) break;
          await sleep(250);
        }
      }

      if (!found?.objectId) {
        throw new Error('file_input_not_found_via_cdp — clicked "Upload files" but no input[type="file"] mounted.');
      }
      await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', { objectId: found.objectId, files: [p.path] });
      return { ok: true, path: p.path };
    } finally {
      if (attached) { try { await chrome.debugger.detach(target); } catch {} }
    }
  },

  'ext.screenshot': async (p = {}) => {
    // captureVisibleTab needs <all_urls> or activeTab — a site-scoped host permission is
    // not enough. Kept optional so a plain install stays narrow.
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    if (!granted) {
      throw new Error(
        'screenshot_permission_missing — Chrome requires broad capture permission. Open the ' +
        'extension popup and press "Enable screenshots" once (it asks for all-sites access, ' +
        'which Chrome only grants through a user click).'
      );
    }
    const tabs = p.site ? await tabsForSite(p.site) : await chrome.tabs.query({ url: ALL_MATCHES });
    if (!tabs.length) throw new Error(`no_tab_for_site: ${p.site ?? 'any'}`);
    const tab = tabs[0];
    let restore = null;
    if (!tab.active) {
      if (p.activate === false) throw new Error('tab_not_active — pass activate:true to focus it briefly');
      const [current] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      restore = current?.id ?? null;
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise((r) => setTimeout(r, p.settle_ms ?? 400));
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: p.format || 'png', quality: p.quality ?? 90 });
      const [meta, base64] = dataUrl.split(',', 2);
      return { mimetype: meta.slice(5).split(';')[0], base64, tabId: tab.id, url: tab.url };
    } finally {
      if (restore != null) { try { await chrome.tabs.update(restore, { active: true }); } catch {} }
    }
  },

  /*
   * Hand a URL to Chrome's own downloader. Generated video and image assets are served
   * from short-lived, credentialed URLs; fetching them through the page and shipping the
   * bytes over the bridge works but is slow and memory-hungry for a 20 MB clip, whereas
   * the browser can just save it.
   */
  /**
   * Reads a media URL from the service worker instead of the page.
   *
   * Generated media sits on CDNs that send no CORS headers, so `fetch` in page context fails
   * with an opaque "Failed to fetch" no matter how valid the session is. The worker is not
   * subject to CORS for origins in host_permissions, so this succeeds where the page cannot.
   */
  'ext.fetch_media': async (p = {}) => {
    if (!p.url) throw new Error('url_required');
    const url = String(p.url);
    const started = Date.now();
    const res = await fetch(url, { credentials: p.credentials ?? 'include' });
    if (!res.ok) throw new Error(`media_fetch_${res.status}: ${url.slice(0, 200)}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const max = p.max_bytes ?? 8 * 1024 * 1024;
    if (bytes.length > max) {
      throw new Error(
        `media_too_large: ${bytes.length} bytes exceeds the ${max}-byte inline limit. ` +
        'Use ai_download instead — it never moves the bytes across the bridge.'
      );
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return {
      url,
      mimetype: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
      bytes: bytes.length,
      base64: btoa(bin),
      fetch_ms: Date.now() - started,
      via: 'service_worker',
    };
  },

  'ext.download': async (p = {}) => {
    if (!p.url) throw new Error('url_required');
    const url = String(p.url);
    /*
     * `filename` on downloads.download() is only a suggestion — a Content-Disposition header
     * beats it, which is how Flow's CDN was landing every asset under its raw UUID. The
     * onDeterminingFilename listener below is the one hook that outranks the header, so the
     * name is registered there and the option is kept purely as the fallback.
     */
    if (p.filename) forcedNames.set(url, String(p.filename));
    const id = await chrome.downloads.download({
      url,
      ...(p.filename ? { filename: String(p.filename) } : {}),
      saveAs: false,
      conflictAction: p.conflict || 'uniquify',
    });
    if (p.wait === false) return { ok: true, download_id: id, state: 'started' };
    const deadline = Date.now() + (p.timeout_ms ?? 180000);
    for (;;) {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state === 'complete') {
        forcedNames.delete(url);
        return { ok: true, download_id: id, state: 'complete', path: item.filename, bytes: item.fileSize, mime: item.mime };
      }
      if (item && item.state === 'interrupted') {
        forcedNames.delete(url);
        throw new Error('download_interrupted: ' + (item.error || 'unknown'));
      }
      if (Date.now() > deadline) return { ok: false, download_id: id, state: item?.state ?? 'unknown', timed_out: true };
      await new Promise((r) => setTimeout(r, 500));
    }
  },
};

/*
 * Download naming.
 *
 * Keyed by URL rather than download id because onDeterminingFilename can fire before
 * downloads.download() resolves, so the id is not reliably known yet.
 */
const forcedNames = new Map();

/** Extensions Chrome derives from a mime type that are wrong or useless on Windows. */
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

if (chrome.downloads?.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const want = forcedNames.get(item.url) || forcedNames.get(item.finalUrl);
    if (want) {
      forcedNames.delete(item.url);
      forcedNames.delete(item.finalUrl);
      suggest({ filename: want, conflictAction: 'uniquify' });
      return;
    }
    /*
     * Nothing was requested, so only the extension is corrected. Chrome hands JPEGs from a CDN
     * the ".jfif" extension, which most Windows tooling will not open — the bytes are fine, the
     * name is not.
     */
    const ext = MIME_EXT[String(item.mime || '').toLowerCase()];
    const current = /\.([a-z0-9]+)$/i.exec(item.filename || '');
    if (ext && (!current || current[1].toLowerCase() !== ext)) {
      const base = String(item.filename || 'download').replace(/\.[a-z0-9]+$/i, '');
      suggest({ filename: `${base}.${ext}`, conflictAction: 'uniquify' });
      return;
    }
    suggest();
  });
}

/** Which site a method belongs to, and whether it can be answered locally. */
function routeOf(method, params = {}) {
  if (LOCAL[method]) return { local: true };
  const ns = String(method).split('.')[0];
  if (SITES[ns]) return { site: ns };
  if (params.site) {
    if (!SITES[params.site]) return { error: `unknown_site: ${params.site}` };
    return { site: params.site };
  }
  // Site-agnostic namespaces with no site given: only unambiguous when one tab is up.
  const sites = Object.keys(connectedSites());
  if (sites.length === 1) return { site: sites[0], inferred: true };
  if (sites.length === 0) {
    return { error: `no_site_tab_connected — open one of ${Object.keys(SITES).join(', ')} and reload, or call ext.open` };
  }
  return { error: `ambiguous_site — ${sites.length} site tabs are connected (${sites.join(', ')}); pass site:"<name>" in the parameters` };
}

async function handleServerFrame(msg) {
  if (msg.kind === 'ping') { wsSend({ kind: 'pong', t: Date.now() }); return; }
  if (msg.kind !== 'req') return;

  const fail = (message) =>
    wsSend({ kind: 'res', id: msg.id, ok: false, body: JSON.stringify({ error: { message } }) });

  if (LOCAL[msg.method]) {
    try {
      const data = await LOCAL[msg.method](msg.params || {});
      wsSend({ kind: 'res', id: msg.id, ok: true, body: JSON.stringify({ data }) });
    } catch (e) {
      fail(String(e?.message || e));
    }
    return;
  }

  const route = routeOf(msg.method, msg.params || {});
  if (route.error) { fail(route.error); return; }

  // An explicit tab wins; a preferred tab that is still loading is waited for, not skipped.
  let entry = null;
  if (msg.params?.tab_id != null) {
    entry = pagePorts.get(Number(msg.params.tab_id)) ?? null;
    if (!entry) { fail(`no_bridge_in_tab: ${msg.params.tab_id} (not a connected ${route.site} tab)`); return; }
  } else {
    const waitingOn = await pendingPreferred(route.site);
    if (waitingOn != null) {
      const until = Date.now() + 20000;
      while (!pagePorts.has(waitingOn) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    }
    entry = portFor(route.site);
  }
  if (!entry) {
    // A tab may exist but have lost its content scripts (extension reload). Try once to
    // put them back before declaring the site unreachable.
    const tabs = await tabsForSite(route.site).catch(() => []);
    if (tabs.length) {
      await ensureInjected(tabs[0].id, tabs[0].url, { force: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      entry = portFor(route.site);
    }
  }
  if (!entry) {
    fail(
      `no_${route.site}_tab — open ${SITES[route.site].url} in this browser (or call ext.open with site:"${route.site}"), ` +
      'then make sure the extension is enabled for it.'
    );
    return;
  }

  try {
    entry.port.postMessage({ kind: 'req', id: msg.id, method: msg.method, params: msg.params });
  } catch (e) {
    fail('page_unreachable: ' + String(e?.message || e));
  }
}

// ------------------------------------------------------------- port plumbing

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aimcp-page') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  const url = port.sender?.tab?.url || '';

  pagePorts.set(tabId, { port, tabId, url, site: siteOf(url), hello: null });
  setBadge();
  connectWS();

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    switch (msg.kind) {
      case 'ping':
        try { port.postMessage({ kind: 'pong' }); } catch {}
        return;
      case 'attach': {
        const e = pagePorts.get(tabId);
        if (e) { e.url = msg.url; e.site = siteOf(msg.url) ?? e.site; }
        setBadge();
        return;
      }
      case 'hello': {
        const e = pagePorts.get(tabId);
        if (e) {
          try { e.hello = JSON.parse(msg.body); } catch {}
          if (e.hello?.site) e.site = e.hello.site;
          if (e.hello?.url) e.url = e.hello.url;
        }
        setBadge();
        wsSend({ kind: 'status', status: status() });
        return;
      }
      /*
       * An unthrottled clock for the page.
       *
       * Chrome throttles a hidden tab's timers to once a second, and to roughly once a
       * minute after five minutes hidden — which turns every poll loop in the bridge into a
       * stall. A page can usually run its own Web Worker to escape that, but some sites'
       * CSP forbids blob workers (gemini.google.com does). This worker is a different
       * context with neither restriction, so it ticks on the page's behalf, and only while
       * the page says it is actually waiting on something.
       */
      case 'tick_ctl': {
        const e = pagePorts.get(tabId);
        if (!e) return;
        if (msg.on) {
          if (e.tick) return;
          e.tick = setInterval(() => {
            try { port.postMessage({ kind: 'tick' }); } catch { clearInterval(e.tick); e.tick = null; }
          }, 100);
        } else if (e.tick) {
          clearInterval(e.tick);
          e.tick = null;
        }
        return;
      }
      case 'res':
      case 'evt':
        wsSend(msg);
        return;
    }
  });

  port.onDisconnect.addListener(() => {
    const e = pagePorts.get(tabId);
    if (e?.tick) clearInterval(e.tick);
    pagePorts.delete(tabId);
    setBadge();
    // The daemon serves its cached copy of this status to every client. Without a push here it
    // kept advertising a closed (or discarded) tab as "ready" indefinitely.
    wsSend({ kind: 'status', status: status() });
  });
  // Same reason as the WhatsApp bridge: a discarded site tab drops its session state and any
  // in-flight answer, and memory pressure discards idle background tabs first.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
});

// -------------------------------------------------------------- keep alive

chrome.alarms.create('aimcp-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'aimcp-keepalive') return;
  await loadConfig();
  if (!cfg.enabled) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
  else wsSend({ kind: 'ping', t: Date.now() });
  // Restore whatever a worker restart or extension reload tore out — bridge included,
  // not just the port. ensureInjected is a no-op when both are already present.
  await ensureAllTabs();
  setBadge();
});

// A fresh navigation gets the manifest content scripts; this covers everything else,
// including client-side route changes within these single-page apps.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!siteOf(tab.url || '')) return;
  ensureInjected(tabId, tab.url).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pagePorts.delete(tabId);
  for (const [site, id] of Object.entries(preferredTab)) if (id === tabId) { delete preferredTab[site]; savePreferred(); }
  setBadge();
  wsSend({ kind: 'status', status: status() });
});

// ------------------------------------------------------------------- wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'aimcp:status') { await loadConfig(); sendResponse(status()); return; }
    if (msg?.type === 'aimcp:set') {
      await chrome.storage.local.set(msg.values || {});
      await loadConfig();
      if (!cfg.enabled) { try { ws?.close(); } catch {} ws = null; wsState = 'disabled'; }
      else { try { ws?.close(); } catch {} ws = null; backoff = 500; connectWS(); }
      setBadge();
      sendResponse(status());
      return;
    }
    if (msg?.type === 'aimcp:open') { await LOCAL['ext.open']({ site: msg.site }); sendResponse({ ok: true }); return; }
    if (msg?.type === 'aimcp:reinject') { sendResponse({ results: await ensureAllTabs({ force: true }) }); return; }
    sendResponse({ error: 'unknown' });
  })();
  return true;
});

async function init() {
  await loadConfig();
  setBadge();
  connectWS();
  // Covers install/reload/update with the sites already open — the common case. force:true
  // because the page world kept the previous build's bridge alive across the reload.
  ensureAllTabs({ force: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
