/*
 * ai-mcp — page bridge core (MAIN world)
 *
 * Runs inside gemini.google.com / labs.google / chatgpt.com at document_start, before any
 * of the page's own scripts. A per-site module (gemini.js, flow.js, chatgpt.js) loads
 * immediately after this file and registers its handlers into the table this file owns.
 *
 * Unlike the WhatsApp bridge, there is no WA-JS here — none of these three products ships
 * a stable public object graph. What they *do* have is a network layer we sit above and a
 * DOM we can drive. So the core provides three primitives and the site modules compose them:
 *
 *   1. NETWORK CAPTURE. fetch and XMLHttpRequest are wrapped before the app boots, so every
 *      request the page makes is recorded — URL, method, headers, body, and the response
 *      *as it streams*. That single hook is what makes the internal APIs legible without
 *      guessing at their contracts, and it is the only way to read a token-by-token answer
 *      while it is still arriving.
 *
 *   2. REPLAY. Any captured request can be re-issued from this context with a patched body.
 *      The page's cookies, bearer tokens, XSRF tokens and abuse-prevention headers are all
 *      already on it, which is precisely the part that external HTTP clients cannot
 *      reproduce (ChatGPT's sentinel proof-of-work, Flow's reCAPTCHA mint).
 *
 *   3. DOM DRIVING. Rich editors (ProseMirror on ChatGPT, Quill on Gemini) ignore naive
 *      value assignment; they only observe their own input events. typeInto() walks a
 *      ladder of insertion strategies and reports which one the page actually accepted.
 *
 * Transport: window.postMessage <-> content/relay.js (ISOLATED world). Large payloads are
 * chunked here so nothing giant crosses the extension messaging bus.
 */
(() => {
  'use strict';

  /*
   * The page world survives an extension reload; the isolated content script does not. A
   * plain "already installed, bail out" guard would therefore pin the FIRST build loaded
   * for the lifetime of the tab — you fix a bug, reload the extension, and the page keeps
   * running the old code while you debug a fix that was never loaded.
   *
   * So re-installation is allowed, and the previous copy retires itself by comparing the
   * epoch it captured at load against the current one.
   */
  const CORE_VERSION = 36;
  const epoch = (window.__AIMCP_EPOCH__ = (window.__AIMCP_EPOCH__ | 0) + 1);
  const isCurrent = () => window.__AIMCP_EPOCH__ === epoch;

  const CHUNK = 384 * 1024;          // chars per transport frame
  const NET_MAX_RECORDS = 600;
  const NET_MAX_TEXT = 4 * 1024 * 1024;   // per response
  const NET_MAX_REQ_BODY = 512 * 1024;

  const log = (...a) => console.debug('[ai-mcp]', ...a);

  /*
   * The pristine implementations, captured once per page and remembered on the window.
   *
   * Re-injection was stacking wrappers: each new bridge generation did
   * `window.fetch.bind(window)` on the ALREADY-WRAPPED fetch and wrapped it again, so after
   * a handful of extension reloads a single request was recorded a dozen times over and
   * every call ran through a dozen layers. Caught by a selftest that asserted one match for
   * a unique URL and got fifteen.
   */
  const PRISTINE = (window.__AIMCP_PRISTINE__ ??= {
    fetch: window.fetch.bind(window),
    xhrOpen: window.XMLHttpRequest.prototype.open,
    xhrSend: window.XMLHttpRequest.prototype.send,
    xhrSetHeader: window.XMLHttpRequest.prototype.setRequestHeader,
  });
  const origFetch = PRISTINE.fetch;
  const OrigXHR = window.XMLHttpRequest;

  /*
   * Declared up here, populated at the bottom. Response handlers and the message listener
   * both read API.site, and both can in principle fire before the bottom of this file is
   * reached — a `const` at the end would leave them in the temporal dead zone.
   */
  const API = (window.__AIMCP__ = {
    core_version: CORE_VERSION,
    epoch,
    isCurrent,
    site: null,          // set by the per-site module that loads immediately after
    emitNet: false,
  });

  // ---------------------------------------------------------------- transport

  function post(msg) {
    window.postMessage(Object.assign({ __aimcp: true }, msg), '*');
  }

  function reply(id, ok, payload) {
    let text;
    try {
      text = JSON.stringify(ok ? { data: payload } : { error: payload });
    } catch (e) {
      text = JSON.stringify({ error: { message: 'serialize_failed: ' + e.message } });
      ok = false;
    }
    if (text.length <= CHUNK) {
      post({ kind: 'res', id, ok, body: text });
      return;
    }
    const total = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < total; i++) {
      post({ kind: 'res', id, ok, seq: i, total, body: text.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
  }

  function emit(event, data) {
    if (!isCurrent()) return;
    let body;
    try {
      body = JSON.stringify({ event, data: plain(data, 4) });
    } catch {
      return;
    }
    if (body.length > CHUNK) body = JSON.stringify({ event, data: { _truncated: true } });
    post({ kind: 'evt', body });
  }

  function announce() {
    if (!isCurrent()) return;
    let ready = false, detail = null;
    try { const r = API.site?.ready?.(); ready = !!(r && r.ready); detail = r ?? null; } catch (e) { detail = { error: String(e?.message || e) }; }
    post({
      kind: 'hello',
      body: JSON.stringify({
        site: API.site?.id ?? null,
        core_version: CORE_VERSION,
        site_version: API.site?.version ?? null,
        url: location.href,
        ready,
        detail,
      }),
    });
  }

  // -------------------------------------------------------------- serializing

  /** Depth- and cycle-safe conversion of arbitrary page objects into plain JSON. */
  function plain(value, depth = 6, seen = new WeakSet()) {
    if (value === null || value === undefined) return value ?? null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (t === 'bigint') return String(value);
    if (t === 'function' || t === 'symbol') return undefined;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { message: value.message, name: value.name };
    if (value instanceof Node) return describe(value);

    if (depth <= 0) return '[depth]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    /*
     * `seen` tracks the current PATH, not everything visited — hence the delete on the way
     * out. Without it a plain DAG (the same object referenced from two fields) reported the
     * second reference as '[circular]' and silently lost the data.
     */
    let out;
    if (Array.isArray(value)) out = value.map((v) => plain(v, depth - 1, seen));
    else if (value instanceof Map) out = Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v, depth - 1, seen)]));
    else if (value instanceof Set) out = [...value].map((v) => plain(v, depth - 1, seen));
    else {
      out = {};
      for (const k of Object.keys(value)) {
        if (k.startsWith('__')) continue;
        let v;
        try { v = value[k]; } catch { continue; }        // lazy getters that throw
        const pv = plain(v, depth - 1, seen);
        if (pv !== undefined) out[k] = pv;
      }
    }
    seen.delete(value);
    return out;
  }

  // ------------------------------------------------------------ net capture

  /*
   * The capture buffer survives re-injection.
   *
   * Re-installing the bridge (ai_reinject, or an extension reload) builds a fresh module
   * scope, and a plain `const NET = []` threw away every request the page had made — so
   * reloading the extension to pick up a fix also destroyed the evidence you were about to
   * use it on. Parking the buffer on the page keeps it across bridge generations; only a
   * real navigation clears it, which is correct because that genuinely is a new page.
   */
  const NET = (window.__AIMCP_NET__ ??= []);
  let netSeq = Number(window.__AIMCP_NETSEQ__ ?? 0);
  // Shared with the hook, which is installed once and outlives every bridge generation —
  // so a `net.wait` registered by the current instance is still notified by it.
  const netWaiters = (window.__AIMCP_NETWAITERS__ ??= new Set());

  /*
   * Bodies and responses are captured for anything that could plausibly be an API call.
   * Images, fonts, media and analytics beacons are skipped — they are the overwhelming
   * majority of requests by count and none of them are ever interesting, and holding
   * their bytes would push the genuinely useful records out of the ring buffer.
   */
  const SKIP_URL = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|m4a|mp3|css)(?:$|\?)|(?:googlevideo|gstatic|googletagmanager|google-analytics|doubleclick|statsigapi|featuregates|sentry|datadoghq|cloudflareinsights)\.|\/generate_204|\/jserror|\/ces\/v1\//i;
  const SKIP_TYPE = /^(?:image|video|audio|font)\//i;

  /** Whether a response body is worth holding on to. */
  function shouldCaptureBody(url) {
    return !SKIP_URL.test(String(url));
  }

  /**
   * Whether the request gets a record at all.
   *
   * Writes always do, regardless of what the URL looks like. File uploads go to a signed
   * URL that ends in the file's own extension — `…/file-abc.png?se=…&sig=…` — so the
   * media skip-list swallowed the one request that proves an upload happened, leaving the
   * attach path with nothing to confirm against but a chip that appears before any bytes
   * have moved.
   */
  function shouldRecord(url, method) {
    if (method !== 'GET' && method !== 'HEAD') return true;
    return !SKIP_URL.test(String(url));
  }

  function headersToObject(h) {
    if (!h) return {};
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) return Object.fromEntries(h.entries());
      if (Array.isArray(h)) return Object.fromEntries(h);
      if (typeof h === 'object') return { ...h };
    } catch {}
    return {};
  }

  /** Best-effort textual form of a request body, without consuming anything the page needs. */
  async function bodyToText(body) {
    if (body == null) return null;
    try {
      if (typeof body === 'string') return body.slice(0, NET_MAX_REQ_BODY);
      if (body instanceof URLSearchParams) return body.toString().slice(0, NET_MAX_REQ_BODY);
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) {
          parts.push(`${k}=${typeof v === 'string' ? v.slice(0, 400) : `[file ${v?.name || ''} ${v?.size || 0}b]`}`);
        }
        return '[FormData] ' + parts.join('&').slice(0, NET_MAX_REQ_BODY);
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        if (body.size > NET_MAX_REQ_BODY) return `[Blob ${body.type} ${body.size}b]`;
        return await body.text();
      }
      if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}b]`;
      if (ArrayBuffer.isView(body)) return `[${body.constructor.name} ${body.byteLength}b]`;
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[ReadableStream]';
    } catch {}
    return '[unreadable]';
  }

  function newRecord(fields) {
    const rec = {
      // Read AND write the shared counter at increment time. Keeping a per-generation
      // copy let two generations hand out the same id after a re-injection, which made
      // net.get/since_id silently address the wrong request.
      id: 'n' + (window.__AIMCP_NETSEQ__ = (Number(window.__AIMCP_NETSEQ__) || 0) + 1),
      started: Date.now(),
      ended: null,
      url: '',
      path: '',
      method: 'GET',
      req_headers: {},
      req_body: null,
      status: null,
      content_type: null,
      res_headers: {},
      text: '',
      bytes: 0,
      truncated: false,
      done: false,
      error: null,
      via: 'fetch',
      ...fields,
    };
    try { rec.path = new URL(rec.url, location.href).pathname; } catch { rec.path = rec.url; }
    NET.push(rec);
    if (NET.length > NET_MAX_RECORDS) NET.splice(0, NET.length - NET_MAX_RECORDS);
    return rec;
  }

  function finishRecord(rec) {
    rec.done = true;
    rec.ended ??= Date.now();
    for (const w of [...netWaiters]) {
      try { w(rec); } catch {}
    }
    // Routed through the live generation: the hook is installed once and outlives every
    // re-injection, so calling this instance's emit() directly would go silent after the
    // first reload.
    const live = window.__AIMCP_EMIT__;
    // Opt-in: without this every request on three busy SPA tabs floods the daemon's ring
    // buffer and evicts the events a caller actually asked for.
    if (live && window.__AIMCP__?.emitNet && !SKIP_URL.test(rec.url)) {
      try { live('net.response', { id: rec.id, url: rec.url, method: rec.method, status: rec.status, bytes: rec.bytes }); } catch {}
    }
  }

  async function pumpResponse(res, rec) {
    try {
      const reader = res.body?.getReader?.();
      if (!reader) {
        rec.text = (await res.text().catch(() => '')).slice(0, NET_MAX_TEXT);
        rec.bytes = rec.text.length;
        finishRecord(rec);
        return;
      }
      const dec = new TextDecoder('utf-8');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rec.bytes += value.byteLength;
        if (rec.text.length < NET_MAX_TEXT) rec.text += dec.decode(value, { stream: true });
        else rec.truncated = true;
        rec.updated = Date.now();
      }
      rec.text += dec.decode();
    } catch (e) {
      rec.error = 'capture: ' + String(e?.message || e);
    }
    finishRecord(rec);
  }

  /*
   * Installed once per page, never per bridge generation — see PRISTINE above. The hook
   * closes over shared state (NET, netWaiters), so the copy installed by the first
   * generation keeps serving every later one correctly.
   */
  if (!window.__AIMCP_HOOKED__) {
  window.__AIMCP_HOOKED__ = true;

  window.fetch = function (input, init) {
    let url = '', method = 'GET', headers = {};
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        url = input.url;
        method = input.method;
        headers = headersToObject(input.headers);
      } else {
        url = String(input?.url ?? input ?? '');
      }
      if (init) {
        if (init.method) method = String(init.method);
        if (init.headers) headers = { ...headers, ...headersToObject(init.headers) };
      }
    } catch {}
    method = String(method || 'GET').toUpperCase();

    const promise = origFetch(input, init);
    if (!shouldRecord(url, method)) return promise;
    const keepBody = shouldCaptureBody(url);

    const rec = newRecord({ url, method, req_headers: headers, via: 'fetch' });

    // Reading the body must not delay the request, and must never consume the copy the
    // page handed us — hence clone() on a Request and a detached promise here.
    (async () => {
      try {
        if (init && init.body != null) rec.req_body = await bodyToText(init.body);
        else if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
          rec.req_body = (await input.clone().text().catch(() => null))?.slice(0, NET_MAX_REQ_BODY) ?? null;
        }
      } catch {}
    })();

    promise.then(
      (res) => {
        rec.status = res.status;
        rec.content_type = res.headers.get('content-type');
        try { rec.res_headers = Object.fromEntries(res.headers.entries()); } catch {}
        if (!keepBody || SKIP_TYPE.test(rec.content_type || '')) { rec.skipped_body = true; finishRecord(rec); return; }
        // clone() gives an independent stream; the page reads the original untouched.
        // Reconstructing a Response from tee() would drop res.url/redirected/type, which
        // some app code reads — clone is the only variant that changes nothing.
        let c;
        try { c = res.clone(); } catch (e) { rec.error = 'clone_failed: ' + e.message; finishRecord(rec); return; }
        pumpResponse(c, rec);
      },
      (err) => {
        rec.error = String(err?.message || err);
        finishRecord(rec);
      }
    );

    return promise;
  };

  /*
   * Google's clients still use XMLHttpRequest for batchexecute, so a fetch-only hook sees
   * roughly nothing on gemini.google.com.
   */
  const xhrOpen = PRISTINE.xhrOpen;
  const xhrSend = PRISTINE.xhrSend;
  const xhrSetHeader = PRISTINE.xhrSetHeader;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    try {
      this.__aimcp = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} };
    } catch {}
    return xhrOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.setRequestHeader = function (k, v) {
    try { if (this.__aimcp) this.__aimcp.headers[String(k).toLowerCase()] = String(v); } catch {}
    return xhrSetHeader.call(this, k, v);
  };

  OrigXHR.prototype.send = function (body) {
    const meta = this.__aimcp;
    if (!meta || !shouldRecord(meta.url, meta.method)) return xhrSend.call(this, body);
    const keepBody = shouldCaptureBody(meta.url);

    const rec = newRecord({ url: meta.url, method: meta.method, req_headers: meta.headers, via: 'xhr' });
    bodyToText(body).then((t) => { rec.req_body = t; }).catch(() => {});

    let lastLen = 0;
    const grab = () => {
      try {
        if (!keepBody) { rec.skipped_body = true; return; }
        // responseType 'text'/'' is the only case where partial text is readable.
        if (this.responseType && this.responseType !== 'text') return;
        const t = this.responseText || '';
        if (t.length === lastLen) return;
        lastLen = t.length;
        rec.text = t.length > NET_MAX_TEXT ? (rec.truncated = true, t.slice(0, NET_MAX_TEXT)) : t;
        rec.bytes = t.length;
        rec.updated = Date.now();
      } catch {}
    };

    this.addEventListener('progress', grab);
    this.addEventListener('readystatechange', () => { if (this.readyState >= 3) grab(); });
    this.addEventListener('load', () => {
      rec.status = this.status;
      try { rec.content_type = this.getResponseHeader('content-type'); } catch {}
      try {
        rec.res_headers = Object.fromEntries(
          String(this.getAllResponseHeaders() || '').trim().split(/\r?\n/).filter(Boolean)
            .map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; })
        );
      } catch {}
      grab();
      if (!rec.text && this.responseType && this.responseType !== 'text') rec.skipped_body = true;
      finishRecord(rec);
    });
    this.addEventListener('error', () => { rec.error = 'network_error'; rec.status = this.status || 0; finishRecord(rec); });
    this.addEventListener('abort', () => { rec.error = 'aborted'; finishRecord(rec); });
    this.addEventListener('timeout', () => { rec.error = 'timeout'; finishRecord(rec); });

    return xhrSend.call(this, body);
  };

  }   // end one-time hook installation

  // ------------------------------------------------------- response decoding

  /** Server-sent events: `event: x` / `data: {...}` blocks separated by blank lines. */
  function parseSSE(text, { parseJson = true, limit = 0 } = {}) {
    const out = [];
    for (const block of String(text || '').split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      let event = null;
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (!dataLines.length) continue;
      const raw = dataLines.join('\n');
      let data = raw;
      if (parseJson && raw !== '[DONE]' && /^[[{"]/.test(raw.trim())) {
        try { data = JSON.parse(raw); } catch {}
      }
      out.push({ event, data });
    }
    return limit > 0 ? out.slice(-limit) : out;
  }

  /**
   * Google's XSSI-guarded JSON. Bodies start with `)]}'` and, for streamed RPCs, arrive as
   * repeated `<byte-length>\n<json>` frames rather than one document.
   */
  /*
   * Two shapes broke the first version, both seen live on flow.google.com (2026-09-30):
   *   - batchexecute answers `)]}'\n\n<len>\n…` — a BLANK line before the first length. The
   *     blank line parsed as length 0, which fell into the "not length-prefixed" branch and
   *     returned no frames at all, so every RPC read back as empty.
   *   - `<len>` counts UTF-8 bytes on some endpoints, so a frame holding "🍌 Nano Banana"
   *     sliced by characters overshoots into the next header and fails to parse. Frames are
   *     single-line JSON, so the line itself is the fallback.
   */
  function parseGoogleChunks(text) {
    let s = String(text || '');
    s = s.replace(/^\)\]\}'/, '');
    const frames = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      const nl = s.indexOf('\n', i);
      const head = (nl < 0 ? s.slice(i) : s.slice(i, nl)).trim();
      const len = /^\d+$/.test(head) ? Number(head) : NaN;
      if (nl < 0 || !Number.isFinite(len) || len <= 0) {
        // Not length-prefixed after all — try the whole remainder as one document.
        const rest = s.slice(i).trim();
        if (rest) { try { frames.push(JSON.parse(rest)); } catch {} }
        break;
      }
      let next = nl + 1 + len;
      let parsed;
      try { parsed = JSON.parse(s.slice(nl + 1, next)); } catch {
        const eol = s.indexOf('\n', nl + 1);
        const end = eol < 0 ? s.length : eol;
        try { parsed = JSON.parse(s.slice(nl + 1, end)); next = end + 1; } catch {}
      }
      if (parsed !== undefined) frames.push(parsed);
      i = next;
    }
    if (!frames.length) {
      try { frames.push(JSON.parse(s)); } catch {}
    }
    return frames;
  }

  /** Decode a captured record's body into whatever structure it actually is. */
  function decodeRecord(rec, opts = {}) {
    const ct = String(rec.content_type || '');
    const text = rec.text || '';
    if (/text\/event-stream/i.test(ct) || /^(?:event|data):/m.test(text.slice(0, 200))) {
      return { format: 'sse', events: parseSSE(text, opts) };
    }
    if (text.startsWith(")]}'")) {
      return { format: 'google-chunked', frames: parseGoogleChunks(text) };
    }
    if (/application\/json/i.test(ct) || /^\s*[[{]/.test(text)) {
      try { return { format: 'json', json: JSON.parse(text) }; } catch {}
      // NDJSON is common for long-running Google operations.
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const parsed = [];
      for (const l of lines) { try { parsed.push(JSON.parse(l)); } catch {} }
      if (parsed.length) return { format: 'ndjson', items: parsed };
    }
    return { format: 'text', text };
  }

  function recordSummary(rec, { body = false, decode = false, max = 4000 } = {}) {
    const out = {
      id: rec.id,
      url: rec.url,
      path: rec.path,
      method: rec.method,
      status: rec.status,
      content_type: rec.content_type,
      started: new Date(rec.started).toISOString(),
      ms: (rec.ended ?? Date.now()) - rec.started,
      bytes: rec.bytes,
      done: rec.done,
      via: rec.via,
      ...(rec.error ? { error: rec.error } : {}),
      ...(rec.truncated ? { truncated: true } : {}),
    };
    if (body) {
      out.req_headers = rec.req_headers;
      out.req_body = rec.req_body;
      out.res_headers = rec.res_headers;
      out.text = (rec.text || '').slice(0, max);
    }
    if (decode) out.decoded = decodeRecord(rec);
    return out;
  }

  function matchRecords(match = {}) {
    let list = NET;
    if (match.id) list = list.filter((r) => r.id === match.id);
    if (match.url) { const re = new RegExp(match.url, 'i'); list = list.filter((r) => re.test(r.url)); }
    if (match.method) list = list.filter((r) => r.method === String(match.method).toUpperCase());
    if (match.status) list = list.filter((r) => r.status === Number(match.status));
    if (match.body_contains) list = list.filter((r) => String(r.req_body || '').includes(match.body_contains));
    if (match.text_contains) list = list.filter((r) => String(r.text || '').includes(match.text_contains));
    if (match.done != null) list = list.filter((r) => !!r.done === !!match.done);
    // Ids look like "n42" for captured traffic and "replay-42"/"req-42" for calls we made,
    // and all of them share one counter — so comparing the numeric tail orders them
    // correctly regardless of which prefix either side carries.
    if (match.since_id) {
      const seqOf = (id) => Number(String(id).replace(/^\D+/, '')) || 0;
      const n = seqOf(match.since_id);
      list = list.filter((r) => seqOf(r.id) > n);
    }
    return list;
  }

  /** Resolve as soon as a request matching `match` completes (or is already complete). */
  function waitForRequest(match, timeoutMs, { includeExisting = true } = {}) {
    if (includeExisting) {
      const hit = matchRecords({ ...match, done: true }).pop();
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve) => {
      const done = (rec) => { clearTimeout(timer); netWaiters.delete(listener); resolve(rec); };
      const listener = (rec) => { if (matchRecords({ ...match, id: rec.id }).length) done(rec); };
      const timer = setTimeout(() => done(null), timeoutMs);
      netWaiters.add(listener);
    });
  }

  // ------------------------------------------------------------ DOM toolkit

  const $ = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  }

  /**
   * Selectors on these products churn. Every lookup takes a *list* of candidates and
   * reports which one matched, so a broken tool is one `probe` call away from a diagnosis
   * rather than a debugging session.
   */
  function pick(candidates, { root = document, requireVisible = true, all = false, index = 0 } = {}) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const sel of list) {
      let found = $$(sel, root);
      if (requireVisible) found = found.filter(visible);
      if (!found.length) continue;
      if (all) return { els: found, selector: sel };
      const el = found[index < 0 ? found.length + index : index];
      if (el) return { el, selector: sel, count: found.length };
    }
    return all ? { els: [], selector: null } : { el: null, selector: null, count: 0 };
  }

  /*
   * Null and false fields are omitted. Most elements have no id, no test id, no aria label
   * and no role, and a probe returns dozens of these — carrying `"id":null` forty times is
   * pure cost to whatever reads it, and the absence of a key says the same thing.
   */
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const cls = el.className;
    const out = { tag: el.tagName.toLowerCase() };
    const put = (k, v) => { if (v !== null && v !== undefined && v !== '' && v !== false) out[k] = v; };
    put('id', el.id);
    put('testid', el.getAttribute('data-testid') || el.getAttribute('data-test-id'));
    put('aria', el.getAttribute('aria-label'));
    put('role', el.getAttribute('role'));
    put('text', (el.innerText || el.textContent || '').trim().slice(0, 160));
    put('class', (typeof cls === 'string' ? cls : cls?.baseVal || '').slice(0, 120));
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
    if (!visible(el)) out.hidden = true;
    return out;
  }

  /**
   * Click something exactly once.
   *
   * The pointer/mouse sequence matters because frameworks routinely act on `pointerdown`
   * and ignore a bare `.click()`. But the click itself must be delivered ONCE, and an
   * earlier version dispatched a synthetic `click` *and then* called `el.click()` — two
   * activations. On an ordinary button that is invisible; on a toggle it opens a menu and
   * immediately closes it again, so every dropdown in all three site modules read back as
   * empty and reported "no options" for a control that works perfectly by hand.
   *
   * So: the sequence stops short of `click`, and `el.click()` supplies it — that path also
   * performs the element's activation behaviour, which a dispatched event does not.
   */
  function clickEl(el) {
    if (!el) throw new Error('click_target_missing');
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, type.startsWith('pointer') ? { ...opts, pointerId: 1, isPrimary: true } : opts)); } catch {}
    }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  const editorText = (el) =>
    el == null ? '' : ('value' in el && typeof el.value === 'string' ? el.value : (el.innerText ?? el.textContent ?? ''));

  function selectAllIn(el) {
    try {
      if ('setSelectionRange' in el) { el.focus(); el.setSelectionRange(0, el.value.length); return; }
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  /**
   * Insert text into whatever editor this is, and verify it landed.
   *
   * ProseMirror (ChatGPT) and Quill (Gemini) both keep an internal document that the
   * visible DOM only reflects; writing textContent updates the pixels and nothing else, so
   * the app sends an empty prompt. Both *do* honour real input events, which is what
   * execCommand and a synthetic paste produce. The ladder exists because which one works
   * varies by editor and by browser version, and silently typing nothing is exactly the
   * kind of plausible-looking failure that is worth several hours if it is not detected here.
   */
  async function typeInto(el, text, { replace = true, verify = true, accept = null } = {}) {
    if (!el) throw new Error('editor_not_found');
    const target = el;
    const want = String(text ?? '');
    const attempts = [];

    target.scrollIntoView?.({ block: 'center' });
    target.focus?.();
    try { target.dispatchEvent(new FocusEvent('focus', { bubbles: true })); } catch {}
    await sleep(20);

    const clear = () => {
      if (!replace) return;
      try {
        if ('value' in target && typeof target.value === 'string') {
          setNativeValue(target, '');
        } else {
          selectAllIn(target);
          document.execCommand('delete', false);
        }
      } catch {}
    };

    /*
     * Text sitting in the DOM is necessary but not sufficient: a React-controlled
     * contenteditable can display an insertion its state never registered — Flow's create
     * bar does exactly this under execCommand: the pixels update, the app's submit stays
     * disabled. `accept` is the caller's functional check against the app's own state;
     * when it says no, the strategy that "worked" by text is treated as failed and the
     * ladder continues to the next one.
     */
    const landed = async (strategy) => {
      if (verify && editorText(target).trim() !== want.trim()) return false;
      if (accept && !(await accept())) { attempts.push({ strategy, rejected: 'accept_check' }); return false; }
      return true;
    };

    /*
     * 0 — Slate: drive the editor model directly through its own instance, reached via
     *     the React fiber. Flow's create bar is Slate, and it consumes neither
     *     execCommand's beforeinput nor a synthetic paste — the DOM paints, the model
     *     stays empty, and the app's submit never enables (verified live: model showed
     *     {"text":""} while the DOM displayed the inserted prompt). Writing through
     *     editor.insertText is exact and event-free; Slate then re-renders its own DOM,
     *     so the text check below reads Slate's output, not ours.
     */
    const slateHost = target.closest?.('[data-slate-editor="true"]');
    if (slateHost) {
      try {
        const ed = slateEditorOf(slateHost);
        if (ed) {
          if (replace) {
            ed.selection = { anchor: slateEdgePoint(ed, false), focus: slateEdgePoint(ed, true) };
            try { ed.deleteFragment(); } catch {}
          }
          if (!ed.selection) {
            const p0 = slateEdgePoint(ed, false);
            ed.selection = { anchor: p0, focus: p0 };
          }
          ed.insertText(want);
          ed.onChange?.();
          await sleep(80);
          attempts.push({ strategy: 'slateModel' });
          if (await landed('slateModel')) {
            return { ok: true, strategy: 'slateModel', attempts, text: editorText(target) };
          }
        } else {
          attempts.push({ strategy: 'slateModel', error: 'editor_instance_not_found' });
        }
      } catch (e) { attempts.push({ strategy: 'slateModel', error: String(e?.message || e) }); }
    }

    // 1 — execCommand: produces genuine beforeinput/input events in every Chromium build.
    try {
      clear();
      const ok = document.execCommand('insertText', false, want);
      attempts.push({ strategy: 'execCommand', returned: ok });
      if (await landed('execCommand')) {
        fireInput(target);
        return { ok: true, strategy: 'execCommand', attempts, text: editorText(target) };
      }
    } catch (e) { attempts.push({ strategy: 'execCommand', error: String(e?.message || e) }); }

    // 2 — synthetic paste: the path rich editors are most careful to support.
    try {
      clear();
      const dt = new DataTransfer();
      dt.setData('text/plain', want);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      await sleep(60);
      attempts.push({ strategy: 'paste' });
      if (await landed('paste')) {
        fireInput(target);
        return { ok: true, strategy: 'paste', attempts, text: editorText(target) };
      }
    } catch (e) { attempts.push({ strategy: 'paste', error: String(e?.message || e) }); }

    // 3 — native value setter: the React-controlled <textarea> case.
    if ('value' in target && typeof target.value === 'string') {
      try {
        setNativeValue(target, want);
        attempts.push({ strategy: 'nativeValue' });
        await sleep(30);
        if (await landed('nativeValue')) {
          return { ok: true, strategy: 'nativeValue', attempts, text: editorText(target) };
        }
      } catch (e) { attempts.push({ strategy: 'nativeValue', error: String(e?.message || e) }); }
    }

    /*
     * 4 — last resort: write the DOM directly and shout about it loudly enough that the
     *     caller can tell this went in without the editor's blessing.
     *
     *     Built with createElement rather than innerHTML: gemini.google.com enforces
     *     Trusted Types, under which any innerHTML assignment throws outright.
     */
    try {
      if (replace) target.replaceChildren();
      const p = document.createElement('p');
      p.textContent = want;
      target.appendChild(p);
      fireInput(target);
      attempts.push({ strategy: 'innerHTML' });
      await sleep(30);
      const got = editorText(target);
      const accepted = accept ? !!(await accept().catch(() => false)) : true;
      return {
        ok: got.trim() === want.trim() && accepted,
        strategy: 'innerHTML',
        attempts,
        text: got,
        warning: 'fell back to direct DOM write — the editor may not have registered the text',
      };
    } catch (e) { attempts.push({ strategy: 'innerHTML', error: String(e?.message || e) }); }

    return { ok: false, strategy: null, attempts, text: editorText(target) };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    fireInput(el);
  }

  /**
   * Slate keeps its document in a model the DOM only mirrors. The editor instance is not
   * exported anywhere, but React keeps it reachable: walk the fiber tree up from the
   * [data-slate-editor] node until a component's props carry `editor` with a children
   * array — that is the <Slate editor={…}> provider.
   */
  function slateEditorOf(host) {
    const fk = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? host[fk] : null;
    while (f) {
      const pr = f.memoizedProps || {};
      if (pr.editor && Array.isArray(pr.editor.children)) return pr.editor;
      f = f.return;
    }
    return null;
  }

  /** First (last) text point of a Slate document, computed by walking the model — the
   *  static Editor.start/end helpers are module-scope and unreachable from here. */
  function slateEdgePoint(ed, last) {
    const path = [];
    let n = { children: ed.children };
    while (Array.isArray(n.children) && n.children.length) {
      const i = last ? n.children.length - 1 : 0;
      path.push(i);
      n = n.children[i];
    }
    return { path, offset: last && typeof n.text === 'string' ? n.text.length : 0 };
  }

  function fireInput(el) {
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' })); } catch {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  }

  function pressKey(el, key, opts = {}) {
    const base = {
      key,
      code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
      keyCode: KEYCODES[key] ?? key.charCodeAt(0),
      which: KEYCODES[key] ?? key.charCodeAt(0),
      bubbles: true,
      cancelable: true,
      composed: true,
      ...opts,
    };
    const t = el || document.activeElement || document.body;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      if (type === 'keypress' && key.length !== 1) continue;
      try { t.dispatchEvent(new KeyboardEvent(type, base)); } catch {}
    }
    return true;
  }
  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };

  /**
   * Build a detached element tree. No HTML strings anywhere.
   *
   * gemini.google.com enforces Trusted Types, and it covers *every* HTML sink — not only
   * innerHTML but DOMParser.parseFromString too, both of which throw "This document
   * requires 'TrustedHTML' assignment". createElement and textContent are the only sinks
   * that are always available, so fixtures and fallbacks are built out of those.
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /*
   * sleep(), driven by a Web Worker rather than setTimeout.
   *
   * This is the single most important reliability fix in the bridge. Chrome throttles
   * timers in hidden tabs to once a second, and after five minutes hidden applies
   * *intensive* throttling: roughly one timer callback per minute. These tabs are hidden
   * essentially always — the operator is working in a different tab — so every poll loop
   * built on setTimeout silently degrades by a factor of sixty. Measured, that turned an
   * 8-second "wait for the menu" into 81 seconds, and made short waits expire before their
   * first poll.
   *
   * Workers are exempt from both throttles. One tiny worker ticks only while something is
   * waiting, and every sleep in the bridge resolves off it. If the worker cannot be created
   * (a CSP without worker-src, say) this falls back to setTimeout and sys.status reports
   * `timer: "throttled"`, so the degradation is visible rather than mysterious.
   */
  let ticker = null;               // Worker | false (unavailable) | null (untried)
  let tickerAlive = false;         // proven by an actual tick, not by the constructor
  let tickWaiters = [];
  let tickerRunning = false;

  function ensureTicker() {
    if (ticker !== null) return ticker;
    // Retire the previous generation's worker; re-injection would otherwise leave one
    // running per generation for the life of the tab.
    try { window.__AIMCP_TICKER__?.terminate?.(); } catch {}
    try {
      const src = 'let t=null;onmessage=(e)=>{if(e.data===1){if(!t)t=setInterval(()=>postMessage(0),60);}else{clearInterval(t);t=null;}};postMessage(0);';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(trustUrl(url));
      w.onmessage = () => { tickerAlive = true; flushTicks(); };
      // A blocked worker fails asynchronously: the constructor returns a Worker that never
      // runs. Without this the clock looks installed and every sleep hangs forever — which
      // is strictly worse than the throttling it was meant to fix.
      w.onerror = () => { ticker = false; tickerAlive = false; };
      ticker = w;
      window.__AIMCP_TICKER__ = w;
    } catch {
      ticker = false;
    }
    return ticker;
  }

  /**
   * Resolve after `ms`, using whichever clock answers first.
   *
   * The worker tick is the fast path and the only one that survives a throttled tab; the
   * setTimeout is a floor that guarantees the promise always settles. Arming both means the
   * worst case is the browser's own (slow) behaviour rather than a wait that never returns —
   * a hang here would strand every operation in the bridge.
   */
  /*
   * Second unthrottled clock, for pages that refuse the first.
   *
   * gemini.google.com's CSP blocks blob workers, so the in-page worker never runs there and
   * a 200ms sleep measured 658ms. The extension's service worker is a different context and
   * is not subject to the page's CSP or the tab's throttling, so it can tick for us. It is
   * only asked to while something is actually waiting.
   */
  let swTicking = false;
  function requestSwTick(on) {
    if (swTicking === on) return;
    swTicking = on;
    post({ kind: 'tick_ctl', on });
  }

  function flushTicks() {
    const now = Date.now();
    if (tickWaiters.length) {
      const due = [];
      tickWaiters = tickWaiters.filter((x) => (x.at <= now ? (due.push(x), false) : true));
      for (const d of due) d.resolve();
    }
    if (!tickWaiters.length) {
      requestSwTick(false);
      if (tickerRunning && ticker) { tickerRunning = false; try { ticker.postMessage(0); } catch {} }
    }
  }

  function sleep(ms) {
    const delay = Number(ms || 0);
    const w = ensureTicker();
    return new Promise((resolve) => {
      let settled = false;
      const entry = { at: Date.now() + delay, resolve: null };
      // Removing the entry on the way out matters: when neither unthrottled clock is
      // reachable, flushTicks never runs and every sleep left a dead closure behind — a
      // five-minute wait polling at 150ms leaked thousands.
      const fire = () => {
        if (settled) return;
        settled = true;
        const i = tickWaiters.indexOf(entry);
        if (i >= 0) tickWaiters.splice(i, 1);
        resolve();
      };
      entry.resolve = fire;
      setTimeout(fire, delay);                      // throttled floor: never hang
      tickWaiters.push(entry);
      if (w && !tickerRunning) { tickerRunning = true; try { w.postMessage(1); } catch { ticker = false; } }
      // Until a tick has actually been observed, assume the in-page worker is blocked and
      // ask the service worker as well. Costs one message per 100ms of genuine waiting.
      if (!tickerAlive) requestSwTick(true);
    });
  }

  /** True only once a tick has actually been observed. */
  function tickerHealthy() { return ticker !== false && tickerAlive; }

  /**
   * Open a menu and wait for its items, rather than clicking and sleeping.
   *
   * Fixed settles are structurally unreliable here: these tabs are almost always in the
   * background, where the browser clamps every timer to roughly one second. A `sleep(500)`
   * after a click silently becomes a second, an Angular or Radix menu that needs a couple
   * of frames can still be empty when it fires, and the caller reports "no options" for a
   * menu that opened perfectly a moment later. Waiting on the items themselves is immune to
   * the clamp, because the deadline is wall-clock while only the polling gets coarser.
   */
  async function openMenu(trigger, candidates, { timeout = 8000, root = document } = {}) {
    if (!trigger) throw new Error('menu_trigger_not_found');
    clickEl(trigger);
    const found = await waitFor(() => {
      const f = pick(candidates, { all: true, root });
      return f.els.length ? f : null;
    }, { timeout, interval: 120, label: 'menu_items' }).catch(() => null);
    return found ?? { els: [], selector: null };
  }

  /** Dismiss whatever menu is open, by both routes these apps listen on. */
  async function closeMenu() {
    pressKey(document.activeElement || document.body, 'Escape');
    try { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
    await sleep(120);
  }

  async function waitFor(fn, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try { last = await fn(); } catch (e) { last = undefined; }
      if (last) return last;
      if (Date.now() > deadline) throw new Error(`timeout_waiting_for_${label} after ${timeout}ms`);
      await sleep(interval);
    }
  }

  /**
   * Poll `get` until its value has not changed for `quiet` ms.
   *
   * This is how "the answer has finished streaming" is decided. A stop-button check alone
   * is not enough — it disappears before the last tokens land on some builds — and a
   * network-idle check alone misses the case where the DOM keeps rendering after the
   * stream closes. Callers combine both.
   */
  async function waitStable(get, { quiet = 1200, timeout = 300000, interval = 250, minLength = 0 } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    let lastChange = Date.now();
    let throws = 0;
    for (;;) {
      let cur;
      // A getter that throws every time used to look exactly like a value that never
      // changes, so this returned stable:true for something it had never once read.
      try { cur = await get(); throws = 0; } catch (e) { cur = last; if (++throws >= 5) return { value: last, stable: false, error: String(e?.message || e) }; }
      if (cur !== last) { last = cur; lastChange = Date.now(); }
      const len = typeof cur === 'string' ? cur.length : cur == null ? 0 : 1;
      if (len >= minLength && Date.now() - lastChange >= quiet) return { value: cur, stable: true, waited_ms: Date.now() - (deadline - timeout) };
      if (Date.now() > deadline) return { value: cur, stable: false, timed_out: true };
      await sleep(interval);
    }
  }

  // --------------------------------------------------------------- eval

  /*
   * Trusted Types.
   *
   * gemini.google.com sends `require-trusted-types-for 'script'`, under which every route
   * into the JavaScript engine is closed at once: `new Function` throws, `script.src`
   * demands a TrustedScriptURL and `script.textContent` demands a TrustedScript. What it
   * does *not* do is restrict policy names — so a policy can be minted here and used to
   * satisfy those sinks. Named per epoch because createPolicy refuses a duplicate name,
   * and the bridge is re-injected on every extension reload.
   */
  let ttPolicy = null;
  // Declared as a function so the unthrottled timer below — which is defined earlier in the
  // file — can use it; a `const` arrow would still be in the temporal dead zone there.
  function trustUrl(u) { const p = trustedPolicy(); return p ? p.createScriptURL(u) : u; }
  function trustScript(s) { const p = trustedPolicy(); return p ? p.createScript(s) : s; }
  function trustedPolicy() {
    if (ttPolicy !== null) return ttPolicy;
    if (typeof trustedTypes === 'undefined') return (ttPolicy = undefined);
    try {
      ttPolicy = trustedTypes.createPolicy(`aimcp-${epoch}`, {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    } catch {
      ttPolicy = undefined;   // an allowlisted-names CSP; fall back and report honestly
    }
    return ttPolicy;
  }
  /*
   * These pages ship a CSP without `unsafe-eval`, so `new Function` throws. Several
   * strategies are tried in order and the one that worked is reported — because when this
   * fails it is the difference between "the code is wrong" and "the page would not run it".
   */
  async function runCode(code, args = {}) {
    const errors = [];
    // 1 — plain Function. Works wherever CSP permits it, and is by far the cheapest.
    try {
      const fn = new Function('args', `"use strict"; return (async () => { ${code} })();`);
      return { via: 'function', value: plain(await fn(args), 6) };
    } catch (e) { errors.push({ via: 'function', error: String(e?.message || e) }); }

    // 2 — blob module. `script-src` frequently allows blob: even when it forbids eval.
    try {
      const key = '__aimcp_res_' + Math.random().toString(36).slice(2);
      const src = `const args = window.${key}_args; window.${key} = (async () => { ${code} })();`;
      window[key + '_args'] = args;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const s = document.createElement('script');
      s.type = 'module';
      s.src = trustUrl(url);
      (document.head || document.documentElement).appendChild(s);
      await new Promise((res, rej) => { s.onload = res; s.onerror = () => rej(new Error('blob script blocked')); setTimeout(rej, 5000, new Error('blob script timeout')); });
      const value = await window[key];
      s.remove(); URL.revokeObjectURL(url);
      delete window[key]; delete window[key + '_args'];
      return { via: 'blob-module', value: plain(value, 6) };
    } catch (e) { errors.push({ via: 'blob-module', error: String(e?.message || e) }); }

    // 3 — inline script reusing a nonce the page already issued to itself.
    try {
      const nonce = document.querySelector('script[nonce]')?.nonce || $('script[nonce]')?.getAttribute('nonce') || '';
      const key = '__aimcp_res_' + Math.random().toString(36).slice(2);
      window[key + '_args'] = args;
      const s = document.createElement('script');
      if (nonce) s.setAttribute('nonce', nonce);
      s.textContent = trustScript(`window.${key} = (async () => { const args = window.${key}_args; ${code} })();`);
      (document.head || document.documentElement).appendChild(s);
      const value = await window[key];
      s.remove(); delete window[key]; delete window[key + '_args'];
      return { via: 'inline-nonce', value: plain(value, 6) };
    } catch (e) { errors.push({ via: 'inline-nonce', error: String(e?.message || e) }); }

    throw new Error(
      'eval_blocked — every strategy failed on this page' +
      (trustedPolicy() ? '' : ' (no Trusted Types policy could be created, so the script sinks stay closed)') +
      ': ' + JSON.stringify(errors)
    );
  }

  // ------------------------------------------------------------ handler table

  const H = {};

  // ---- system -----------------------------------------------------------
  H['sys.status'] = async () => {
    let siteStatus = null;
    try { siteStatus = (await API.site?.status?.()) ?? null; } catch (e) { siteStatus = { error: String(e?.message || e) }; }
    let ready = null;
    try { ready = API.site?.ready?.() ?? null; } catch (e) { ready = { ready: false, error: String(e?.message || e) }; }
    return {
      site: API.site?.id ?? null,
      core_version: CORE_VERSION,
      site_version: API.site?.version ?? null,
      epoch,
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      // A hidden tab clamps setTimeout to ~1s, and to ~1/minute after five minutes hidden.
      // "worker" means the bridge is driving its own unthrottled clock; "throttled" means
      // it could not, and every wait in this tab is running at the browser's mercy.
      // Which unthrottled clock this page can use. The service-worker clock needs the
      // relay port, so it degrades to plain (throttled) setTimeout if that is gone.
      timer: tickerHealthy() ? 'worker' : 'service-worker',
      ready,
      net_records: NET.length,
      net_last_id: NET.length ? NET[NET.length - 1].id : null,
      site_status: siteStatus,
    };
  };

  H['sys.ready'] = async (p = {}) => {
    const r = await waitFor(() => { const s = API.site?.ready?.(); return s?.ready ? s : null; },
      { timeout: p.timeout_ms ?? 60000, interval: 300, label: 'site_ready' });
    return r;
  };

  H['sys.eval'] = async (p) => {
    if (!p?.code) throw new Error('code_required');
    return await runCode(String(p.code), p.args ?? {});
  };

  H['sys.probe'] = async () => {
    const sel = API.site?.selectors ?? {};
    const resolved = {};
    for (const [name, cands] of Object.entries(sel)) {
      const hit = pick(cands, { requireVisible: false, all: true });
      const visHit = pick(cands, { requireVisible: true, all: true });
      resolved[name] = {
        matched_selector: hit.selector,
        matches: hit.els.length,
        visible_matches: visHit.els.length,
        sample: hit.els.slice(0, 3).map(describe),
        candidates_tried: Array.isArray(cands) ? cands.length : 1,
      };
    }
    return {
      site: API.site?.id ?? null,
      url: location.href,
      selectors: resolved,
      custom_elements: [...new Set([...document.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()).filter((t) => t.includes('-')))].slice(0, 120),
      testids: [...new Set([...document.querySelectorAll('[data-testid],[data-test-id]')].map((e) => e.getAttribute('data-testid') || e.getAttribute('data-test-id')))].slice(0, 120),
      buttons: $$('button').filter(visible).slice(0, 60).map(describe),
    };
  };

  H['sys.selftest'] = async () => {
    const results = [];
    const t = (name, cond, detail) => results.push({ name, pass: !!cond, ...(detail !== undefined && !cond ? { detail } : {}) });

    t('core_installed', !!window.__AIMCP__);
    t('epoch_current', isCurrent());
    t('site_module_loaded', !!API.site, API.site);
    t('site_has_id', !!API.site?.id);
    t('site_has_ready_fn', typeof API.site?.ready === 'function');
    t('site_has_selectors', Object.keys(API.site?.selectors ?? {}).length > 0);
    t('fetch_hooked', window.fetch !== origFetch);
    t('fetch_hook_installed_once', window.__AIMCP_HOOKED__ === true);
    t('xhr_hooked', OrigXHR.prototype.send !== PRISTINE.xhrSend);

    // plain()
    const cyc = { a: 1 }; cyc.self = cyc;
    const flat = plain(cyc, 3);
    t('plain_handles_cycles', flat.self === '[circular]', flat);
    t('plain_drops_functions', plain({ f: () => 1, n: 2 }).f === undefined);
    t('plain_number_guard', plain({ x: NaN }).x === null);
    t('plain_depth_guard', plain({ a: { b: { c: { d: 1 } } } }, 2).a.b === '[depth]');
    const lazy = {}; Object.defineProperty(lazy, 'boom', { get() { throw new Error('nope'); }, enumerable: true });
    let lazyOk = true; try { plain(lazy, 2); } catch { lazyOk = false; }
    t('plain_survives_throwing_getter', lazyOk);

    // SSE decoding
    const sse = parseSSE('event: delta\ndata: {"v":"hi"}\n\ndata: [DONE]\n\n');
    t('sse_two_events', sse.length === 2, sse);
    t('sse_event_name', sse[0]?.event === 'delta');
    t('sse_json_parsed', sse[0]?.data?.v === 'hi');
    t('sse_done_sentinel', sse[1]?.data === '[DONE]');
    const sseMulti = parseSSE('data: line1\ndata: line2\n\n');
    t('sse_multiline_data', sseMulti[0]?.data === 'line1\nline2', sseMulti);

    // Google chunk decoding
    const inner = JSON.stringify([['wrb.fr', null, '[]']]);
    const chunked = ")]}'\n" + inner.length + '\n' + inner;
    const frames = parseGoogleChunks(chunked);
    t('google_chunked_parsed', frames.length === 1 && frames[0][0][0] === 'wrb.fr', frames);
    const plainGoogle = parseGoogleChunks(")]}'\n" + JSON.stringify({ a: 1 }));
    t('google_unprefixed_parsed', plainGoogle[0]?.a === 1, plainGoogle);
    t('google_garbage_is_empty', parseGoogleChunks('not json at all').length === 0);
    // batchexecute's real shape: blank line after the guard, then several frames.
    const second = JSON.stringify([['e', 4, null, null, 143]]);
    const multi = parseGoogleChunks(")]}'\n\n" + inner.length + '\n' + inner + '\n' + second.length + '\n' + second + '\n');
    t('google_blank_line_after_guard', multi.length === 2 && multi[0][0][0] === 'wrb.fr' && multi[1][0][0] === 'e', multi);
    // A byte-counted length on a frame with an emoji overshoots a character slice.
    const emoji = JSON.stringify([['wrb.fr', 'x', '["🍌 Nano Banana"]']]);
    const bytes = new TextEncoder().encode(emoji).length;
    const emo = parseGoogleChunks(")]}'\n\n" + bytes + '\n' + emoji + '\n' + second.length + '\n' + second + '\n');
    t('google_byte_length_frame_recovered', emo.length === 2 && emo[0][0][1] === 'x' && emo[1][0][0] === 'e', emo);

    // decodeRecord routing
    t('decode_routes_sse', decodeRecord({ content_type: 'text/event-stream', text: 'data: {"a":1}\n\n' }).format === 'sse');
    t('decode_routes_google', decodeRecord({ content_type: 'application/json', text: ")]}'\n{\"a\":1}" }).format === 'google-chunked');
    t('decode_routes_json', decodeRecord({ content_type: 'application/json', text: '{"a":1}' }).json?.a === 1);
    t('decode_routes_ndjson', decodeRecord({ content_type: 'application/json', text: '{"a":1}\n{"a":2}' }).items?.length === 2);
    t('decode_routes_text', decodeRecord({ content_type: 'text/html', text: '<p>x' }).format === 'text');

    // DOM toolkit against a synthetic subtree, so this passes on a login screen too.
    const host = el('div', { style: 'position:fixed;left:-10000px;top:0;width:200px;height:80px' },
      el('button', { 'data-testid': 'st-btn', 'aria-label': 'Go' }, 'Go'),
      el('div', { class: 'st-editor', contenteditable: 'true' }),
      el('textarea', { class: 'st-textarea' }),
      el('div', { class: 'st-hidden', style: 'display:none' }, 'hidden'),
    );
    document.body.appendChild(host);
    try {
      const btn = pick(['[data-testid="nope"]', '[data-testid="st-btn"]'], { root: host, requireVisible: false });
      t('pick_falls_through_to_second_candidate', btn.selector === '[data-testid="st-btn"]', btn.selector);
      t('pick_returns_null_when_nothing_matches', pick(['.absent'], { root: host, requireVisible: false }).el === null);
      t('describe_reads_testid', describe(btn.el)?.testid === 'st-btn');
      t('describe_reads_aria', describe(btn.el)?.aria === 'Go');
      t('visible_rejects_display_none', visible(host.querySelector('.st-hidden')) === false);

      let clicked = 0, sawPointerDown = false;
      btn.el.addEventListener('click', () => clicked++);
      btn.el.addEventListener('pointerdown', () => { sawPointerDown = true; });
      clickEl(btn.el);
      // Exactly once, not merely at least once: a second activation re-toggles anything
      // that toggles, which is how every dropdown in this bridge silently read as empty.
      t('clickEl_fires_click_exactly_once', clicked === 1, clicked);
      t('clickEl_fires_pointerdown', sawPointerDown);

      // And a toggle driven by clickEl must end up in the opposite state, not back where
      // it started — the property the single-click rule actually exists to protect.
      let toggled = 0;
      const toggle = el('button', {}, 'toggle');
      toggle.addEventListener('click', () => { toggled++; });
      host.appendChild(toggle);
      clickEl(toggle);
      t('clickEl_toggles_once', toggled === 1, toggled);

      const ta = host.querySelector('.st-textarea');
      let inputs = 0;
      ta.addEventListener('input', () => inputs++);
      setNativeValue(ta, 'hello');
      t('setNativeValue_sets_value', ta.value === 'hello', ta.value);
      t('setNativeValue_fires_input', inputs > 0);

      const ed = host.querySelector('.st-editor');
      const typed = await typeInto(ed, 'prompt text', { verify: true });
      t('typeInto_lands_text', editorText(ed).trim() === 'prompt text', { got: editorText(ed), typed });
      t('typeInto_reports_strategy', !!typed.strategy, typed);

      let keyed = null;
      ed.addEventListener('keydown', (e) => { keyed = e.key; });
      pressKey(ed, 'Enter');
      t('pressKey_dispatches_keydown', keyed === 'Enter', keyed);

      const stable = await waitStable(() => 'constant', { quiet: 120, interval: 40, timeout: 3000 });
      t('waitStable_settles', stable.stable === true && stable.value === 'constant', stable);

      let n = 0;
      const grew = await waitStable(() => (n < 3 ? String(n++) : '3'), { quiet: 150, interval: 40, timeout: 4000 });
      t('waitStable_waits_for_growth_to_stop', grew.value === '3', grew);

      /*
       * Generous deadlines on purpose. A background tab clamps every timer to ~1s, so a
       * three-iteration poll needs three seconds of headroom, not three hundred
       * milliseconds — and this suite runs almost exclusively in background tabs.
       */
      let tries = 0;
      const got = await waitFor(() => (++tries >= 3 ? 'yes' : null), { timeout: 20000, interval: 30 });
      t('waitFor_retries_until_truthy', got === 'yes' && tries >= 3, { got, tries });

      let threw = false;
      try { await waitFor(() => null, { timeout: 200, interval: 40, label: 'never' }); } catch { threw = true; }
      t('waitFor_throws_on_timeout', threw);
    } finally {
      host.remove();
    }

    /*
     * Network capture, proven end to end against the page's own origin. The path is
     * deliberately one the site will 404 — the assertion is about the record, not the
     * status — and deliberately *not* an image or a font, because those are on the skip
     * list and would produce no record at all.
     */
    const marker = 'aimcp-selftest-' + Date.now();
    const before = NET.length;
    let response = null;
    try { response = await window.fetch(`${location.origin}/${marker}`, { cache: 'no-store' }); } catch (e) { /* offline is fine */ }
    t('fetch_hook_returns_a_real_response', response == null || (typeof Response !== 'undefined' && response instanceof Response), String(response));
    /*
     * Look for the record itself, not for the buffer growing. NET is a ring buffer, so once
     * it is full a new record evicts an old one and the length never changes — which made
     * this fail on any long-lived tab while the hook was working perfectly.
     */
    t('fetch_hook_created_a_record', NET.some((r) => String(r.url).includes(marker)),
      { before, after: NET.length, capped: NET.length === before });

    const rec = NET.find((r) => r.url.includes(marker));
    t('fetch_hook_records_the_url', !!rec, NET.slice(-3).map((r) => r.url));
    t('record_captured_method', rec?.method === 'GET', rec?.method);
    const filtered = matchRecords({ url: marker });
    t('matchRecords_filters_by_url', filtered.length === 1, filtered.length);
    t('matchRecords_method_filter_excludes', matchRecords({ url: marker, method: 'POST' }).length === 0);
    t('matchRecords_since_id_excludes_older', rec ? matchRecords({ url: marker, since_id: rec.id }).length === 0 : false);
    t('net_summary_hides_body_by_default', rec ? recordSummary(rec).text === undefined : false);
    t('net_summary_includes_body_when_asked', rec ? typeof recordSummary(rec, { body: true }).text === 'string' : false);
    t('skip_list_ignores_image_bodies', shouldCaptureBody('https://x/foo.png') === false);
    t('skip_list_keeps_api_bodies', shouldCaptureBody('https://x/backend-api/conversation') === true);
    // An upload PUT goes to a signed URL ending in the file's own extension. Recording it
    // is the only authoritative proof that bytes actually moved.
    t('uploads_are_recorded_despite_the_media_skip_list', shouldRecord('https://blob.example/file-a.png?se=1&sig=x', 'PUT') === true);
    t('post_to_a_media_url_is_recorded', shouldRecord('https://x/thing.webp', 'POST') === true);
    t('plain_image_get_is_still_skipped', shouldRecord('https://x/foo.png', 'GET') === false);
    t('api_get_is_still_recorded', shouldRecord('https://x/backend-api/models', 'GET') === true);

    /*
     * Code execution, against whatever CSP this particular page ships. Which strategy wins
     * varies by site — and on a Trusted Types page all of them fail unless a policy was
     * minted first, so this assertion is what proves that path is live.
     */
    const evalRes = await runCode('return 1 + 1;').catch((e) => ({ error: String(e?.message || e) }));
    t('eval_runs_under_this_pages_csp', evalRes?.value === 2, evalRes);
    t('eval_reports_which_strategy_worked', ['function', 'blob-module', 'inline-nonce'].includes(evalRes?.via), evalRes);
    const evalArgs = await runCode('return args.x * 3;', { x: 7 }).catch((e) => ({ error: String(e?.message || e) }));
    t('eval_receives_arguments', evalArgs?.value === 21, evalArgs);
    t('trusted_types_handled', typeof trustedTypes === 'undefined' || !!trustedPolicy(), { tt: typeof trustedTypes !== 'undefined', policy: !!trustedPolicy() });

    /*
     * The unthrottled clock. Without it every wait in a background tab runs at roughly one
     * poll per minute, so this is not a nicety — it is the difference between the bridge
     * working and appearing to hang.
     */
    await sleep(10);   // give the worker a chance to prove itself before asserting
    const sleepProbe = Date.now();
    await sleep(200);
    const sleepTook = Date.now() - sleepProbe;
    t('sleep_is_not_throttled', sleepTook < 900, `a 200ms sleep took ${sleepTook}ms — no unthrottled clock reached this page`);
    const sleepStart = Date.now();
    await sleep(120);
    const slept = Date.now() - sleepStart;
    t('short_sleep_is_actually_short', slept < 900, `${slept}ms for a 120ms sleep — the timer is being throttled`);
    const many = Date.now();
    await Promise.all([sleep(50), sleep(80), sleep(110)]);
    t('concurrent_sleeps_share_one_clock', Date.now() - many < 900, Date.now() - many);

    // Site-provided assertions.
    let siteResults = [];
    try { siteResults = (await API.site?.selftest?.()) ?? []; } catch (e) { siteResults = [{ name: 'site_selftest_threw', pass: false, detail: String(e?.message || e) }]; }
    for (const r of siteResults) results.push(r);

    const failed = results.filter((r) => !r.pass);
    return { total: results.length, passed: results.length - failed.length, failed: failed.length, failures: failed, results };
  };

  // ---- DOM --------------------------------------------------------------
  H['dom.query'] = async (p) => {
    const els = $$(String(p.selector));
    return {
      selector: p.selector,
      count: els.length,
      items: els.slice(0, p.limit ?? 30).map((e) => ({
        ...describe(e),
        ...(p.html ? { html: e.outerHTML.slice(0, p.max_html ?? 4000) } : {}),
        ...(p.full_text ? { full_text: (e.innerText || '').slice(0, p.max_text ?? 20000) } : {}),
      })),
    };
  };

  H['dom.text'] = async (p) => {
    const root = p.selector ? $(String(p.selector)) : document.body;
    if (!root) throw new Error('selector_not_found: ' + p.selector);
    return { text: (root.innerText || '').slice(0, p.max ?? 200000) };
  };

  H['dom.click'] = async (p) => {
    const found = p.selector
      ? pick(Array.isArray(p.selector) ? p.selector : [p.selector], { requireVisible: p.require_visible !== false, index: p.index ?? 0 })
      : pick([], {});
    let el = found.el;
    if (!el && p.text) el = findByText(p.text, p.tag || 'button,a,[role="button"],[role="menuitem"]');
    if (!el) throw new Error('click_target_not_found: ' + JSON.stringify(p.selector ?? p.text));
    clickEl(el);
    if (p.settle_ms) await sleep(p.settle_ms);
    return { ok: true, clicked: describe(el), via_selector: found.selector ?? 'text' };
  };

  H['dom.type'] = async (p) => {
    const found = pick(Array.isArray(p.selector) ? p.selector : [p.selector], { index: p.index ?? 0 });
    if (!found.el) throw new Error('editor_not_found: ' + JSON.stringify(p.selector));
    const r = await typeInto(found.el, p.text ?? '', { replace: p.replace !== false });
    if (p.enter) { pressKey(found.el, 'Enter'); }
    return { ...r, selector: found.selector };
  };

  H['dom.key'] = async (p) => {
    const el = p.selector ? $(String(p.selector)) : document.activeElement;
    pressKey(el, String(p.key || 'Enter'), p.modifiers || {});
    return { ok: true, key: p.key, target: describe(el) };
  };

  H['dom.wait'] = async (p) => {
    const r = await waitFor(() => {
      const f = pick(Array.isArray(p.selector) ? p.selector : [p.selector], { requireVisible: p.require_visible !== false });
      if (!f.el) return null;
      if (p.text && !String(f.el.innerText || '').includes(p.text)) return null;
      return f;
    }, { timeout: p.timeout_ms ?? 30000, interval: p.interval_ms ?? 200, label: 'selector' });
    return { ok: true, matched: describe(r.el), selector: r.selector };
  };

  H['dom.scroll'] = async (p) => {
    const el = p.selector ? $(String(p.selector)) : document.scrollingElement;
    if (!el) throw new Error('scroll_target_not_found');
    if (p.to === 'top') el.scrollTop = 0;
    else if (p.to === 'bottom') el.scrollTop = el.scrollHeight;
    else el.scrollTop += Number(p.by ?? 500);
    await sleep(p.settle_ms ?? 250);
    return { ok: true, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  };

  function findByText(text, tagSel = 'button,a,[role="button"],[role="menuitem"],[role="option"]') {
    const want = String(text).toLowerCase().trim();
    const cands = $$(tagSel).filter(visible);
    return (
      cands.find((e) => (e.innerText || '').toLowerCase().trim() === want) ||
      cands.find((e) => (e.getAttribute('aria-label') || '').toLowerCase().trim() === want) ||
      cands.find((e) => (e.innerText || '').toLowerCase().includes(want)) ||
      cands.find((e) => (e.getAttribute('aria-label') || '').toLowerCase().includes(want)) ||
      null
    );
  }

  // ---- network ----------------------------------------------------------
  H['net.list'] = async (p = {}) => {
    const list = matchRecords(p.match ?? p ?? {});
    const limit = p.limit ?? 40;
    return {
      total_captured: NET.length,
      matched: list.length,
      last_id: NET.length ? NET[NET.length - 1].id : null,
      items: list.slice(-limit).map((r) => recordSummary(r, { body: !!p.body, decode: !!p.decode, max: p.max ?? 4000 })),
    };
  };

  H['net.get'] = async (p) => {
    // Ternary, not `??`: with `??`, an id that has been evicted from the ring buffer fell
    // through to "newest request of all" and was returned as though it were the one asked for.
    const rec = p.id ? NET.find((r) => r.id === p.id) : matchRecords(p.match ?? {}).pop();
    if (!rec) {
      throw new Error(p.id
        ? `no_such_request: ${p.id} — not in the capture buffer (it holds the last ${NET_MAX_RECORDS} requests, and a page navigation clears it)`
        : 'no_such_request: nothing matched ' + JSON.stringify(p.match ?? {}));
    }
    return recordSummary(rec, { body: true, decode: p.decode !== false, max: p.max ?? 200000 });
  };

  H['net.wait'] = async (p = {}) => {
    const rec = await waitForRequest(p.match ?? {}, p.timeout_ms ?? 120000, { includeExisting: p.include_existing !== false });
    if (!rec) return { matched: false, timed_out: true };
    return { matched: true, request: recordSummary(rec, { body: true, decode: p.decode !== false, max: p.max ?? 200000 }) };
  };

  H['net.clear'] = async () => { const n = NET.length; NET.length = 0; return { cleared: n }; };

  /*
   * Re-issue a captured request. This is the escape hatch that matters most: the page's
   * cookies, bearer token, XSRF token and abuse-prevention headers are all already on the
   * template, and those are exactly the parts that cannot be reconstructed from outside.
   */
  H['net.replay'] = async (p = {}) => {
    const src = p.id ? NET.find((r) => r.id === p.id) : matchRecords(p.match ?? {}).pop();
    if (!src && !p.url) throw new Error('no_template_request — pass id, match, or an explicit url');

    const method = String(p.method || src?.method || 'GET').toUpperCase();
    let url = p.url || src.url;
    if (p.query && typeof p.query === 'object') {
      const u = new URL(url, location.href);
      for (const [k, v] of Object.entries(p.query)) v == null ? u.searchParams.delete(k) : u.searchParams.set(k, String(v));
      url = u.toString();
    }

    let body = p.body != null ? p.body : src?.req_body ?? null;
    if (p.json_patch && typeof p.json_patch === 'object') {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { throw new Error('json_patch_needs_json_body: ' + e.message); }
      body = JSON.stringify(deepMerge(parsed, p.json_patch));
    }
    if (p.replace && typeof p.replace === 'object' && body) {
      for (const [from, to] of Object.entries(p.replace)) body = String(body).split(from).join(String(to));
    }

    // Headers the browser owns; sending them ourselves is either ignored or an error.
    const FORBIDDEN = new Set(['host', 'content-length', 'connection', 'cookie', 'origin', 'referer', 'user-agent', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'accept-encoding']);
    const headers = {};
    for (const [k, v] of Object.entries({ ...(p.inherit_headers === false ? {} : src?.req_headers ?? {}), ...(p.headers ?? {}) })) {
      if (!FORBIDDEN.has(String(k).toLowerCase())) headers[k] = v;
    }

    const rec = await issue({ url, method, headers, body, via: 'replay' });
    return {
      template_id: src?.id ?? null,
      ...recordSummary(rec, { body: true, decode: p.decode !== false, max: p.max ?? 200000 }),
    };
  };

  /*
   * Perform a request and file it in the capture buffer like any other.
   *
   * The original fetch is used so this does not recurse through our own hook, but the call
   * still has to end up in NET — otherwise a replay is invisible to net.list and net.get,
   * and you cannot inspect, re-replay or diff the thing you just did.
   */
  async function issue({ url, method, headers, body, via }) {
    const rec = newRecord({ url, method, req_headers: headers, req_body: typeof body === 'string' ? body : null, via });
    try {
      const res = await origFetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        credentials: 'include',
      });
      rec.status = res.status;
      rec.content_type = res.headers.get('content-type');
      try { rec.res_headers = Object.fromEntries(res.headers.entries()); } catch {}
      const text = await res.text();
      rec.text = text.length > NET_MAX_TEXT ? (rec.truncated = true, text.slice(0, NET_MAX_TEXT)) : text;
      rec.bytes = text.length;
    } catch (e) {
      rec.error = String(e?.message || e);
      finishRecord(rec);
      throw e;
    }
    finishRecord(rec);
    return rec;
  }

  function deepMerge(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else {
        target[k] = v;
      }
    }
    return target;
  }

  /** Same-origin (or page-context cross-origin) request with the page's credentials. */
  H['net.request'] = async (p = {}) => {
    if (!p.url) throw new Error('url_required');
    const method = String(p.method || 'GET').toUpperCase();
    const headers = { ...(p.headers ?? {}) };
    let body = p.body;
    if (p.json !== undefined) { body = JSON.stringify(p.json); headers['Content-Type'] ??= 'application/json'; }
    const rec = await issue({ url: String(p.url), method, headers, body, via: 'request' });
    return recordSummary(rec, { body: true, decode: p.decode !== false, max: p.max ?? 200000 });
  };

  /*
   * Pull media bytes out of the page.
   *
   * This exists alongside ext.download rather than replacing it, because the two cover
   * different failures. The browser's downloader is faster and streams to disk, but it
   * cannot fetch a `blob:` URL minted in a page's own context — and that is exactly what
   * Flow's video player hands you for a generated clip. It also cannot reach anything whose
   * authorisation lives in this page rather than in a cookie.
   *
   * Bytes are base64'd in 32 KB slices: String.fromCharCode.apply on a multi-megabyte
   * Uint8Array blows the argument limit and throws RangeError.
   */
  const MEDIA_MAX_INLINE = 24 * 1024 * 1024;

  H['net.fetch_media'] = async (p = {}) => {
    if (!p.url) throw new Error('url_required');
    const url = String(p.url);
    const started = Date.now();
    /*
     * A page-context fetch is bound by CORS, and the CDNs that serve generated media
     * (googleusercontent, oaiusercontent, flow-content) send no CORS headers — so a
     * perfectly authorised request fails here with a bare "Failed to fetch" that says
     * nothing about why. The service worker is exempt for hosts in host_permissions, but it
     * is not reachable from this world, so the caller is told where the working path is
     * rather than being left with the opaque error.
     */
    let res;
    try {
      res = await origFetch(url, { credentials: p.credentials ?? 'include' });
    } catch (e) {
      if (/^blob:/i.test(url)) throw e;   // page-only by definition; the worker cannot help
      throw new Error(
        `media_fetch_blocked: ${e.message} — this is a cross-origin CDN with no CORS headers, `
        + 'which page context cannot read. Use ai_fetch_media (it falls back to the extension '
        + 'worker automatically) or ai_download.'
      );
    }
    if (!res.ok) throw new Error(`media_fetch_${res.status}: ${url.slice(0, 200)}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const fetched = Date.now();

    const max = p.max_bytes ?? MEDIA_MAX_INLINE;
    if (bytes.length > max) {
      throw new Error(
        `media_too_large: ${bytes.length} bytes exceeds the ${max}-byte inline limit. ` +
        'Use ai_download instead — it hands the URL to the browser\'s own downloader and never moves the bytes across the bridge. ' +
        '(Raise max_bytes only if you specifically need the bytes in the response.)'
      );
    }

    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    const base64 = btoa(bin);

    return {
      url,
      mimetype: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
      bytes: bytes.length,
      base64,
      fetch_ms: fetched - started,
      encode_ms: Date.now() - fetched,
    };
  };

  H['net.events'] = async (p = {}) => {
    const rec = p.id ? NET.find((r) => r.id === p.id) : matchRecords(p.match ?? {}).pop();
    if (!rec) throw new Error('no_such_request');
    return { id: rec.id, done: rec.done, bytes: rec.bytes, ...decodeRecord(rec, { limit: p.limit ?? 0 }) };
  };

  H['net.config'] = async (p = {}) => {
    if (p.emit_events != null) API.emitNet = !!p.emit_events;
    return { emit_events: !!API.emitNet, records: NET.length, max_records: NET_MAX_RECORDS };
  };

  // ------------------------------------------------------------- dispatcher

  // Diagnostics must work before the app is ready — gating them behind readiness makes the
  // tools you need in order to debug a stuck page the ones you cannot call.
  const NO_WAIT = new Set([
    'sys.status', 'sys.ready', 'sys.eval', 'sys.probe', 'sys.selftest',
    'dom.query', 'dom.text', 'dom.click', 'dom.type', 'dom.key', 'dom.wait', 'dom.scroll',
    'net.list', 'net.get', 'net.wait', 'net.clear', 'net.replay', 'net.request', 'net.events', 'net.config',
    'net.fetch_media',
  ]);

  /*
   * The same principle applies to the site modules: a site's own status and probe calls are
   * exactly what you need when that site is NOT ready, so gating them behind readiness makes
   * a stuck page undiagnosable — you get a 60-second wait and a timeout instead of the
   * state that explains it.
   */
  const NO_WAIT_SUFFIX = /\.(?:status|probe|observe|tokens|credits)$/;

  async function dispatch(method, params) {
    const fn = H[method];
    if (!fn) {
      throw new Error(
        `unknown_method: ${method} — this tab is running the "${API.site?.id ?? 'unknown'}" bridge. ` +
        `Available: ${Object.keys(H).sort().join(', ')}`
      );
    }
    if (!NO_WAIT.has(method) && !NO_WAIT_SUFFIX.test(method)) {
      const timeout = params?.__ready_timeout_ms ?? 60000;
      await waitFor(() => { const s = API.site?.ready?.(); return s?.ready ? s : null; },
        { timeout, interval: 300, label: `${API.site?.id ?? 'site'}_ready` })
        .catch((e) => {
          const s = API.site?.ready?.() ?? {};
          throw new Error(`${API.site?.id ?? 'site'}_not_ready: ${e.message} (state=${JSON.stringify(s)})`);
        });
    }
    return await fn(params || {});
  }

  window.addEventListener('message', async (ev) => {
    if (!isCurrent()) return;                 // a newer bridge has taken over
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__aimcp !== true) return;

    if (d.kind === 'hello_request') { announce(); return; }
    if (d.kind === 'tick') { flushTicks(); return; }   // unthrottled clock from the worker
    if (d.kind !== 'req') return;

    try {
      const data = await dispatch(d.method, d.params);
      reply(d.id, true, data === undefined ? null : data);
    } catch (e) {
      reply(d.id, false, {
        message: String(e?.message || e),
        method: d.method,
        site: API.site?.id ?? null,
        stack: e?.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : undefined,
      });
    }
  });

  // ------------------------------------------------------------------ export

  Object.assign(API, {
    H,
    // Toolkit the site modules build on.
    util: {
      $, $$, pick, describe, visible, clickEl, typeInto, setNativeValue, fireInput, pressKey,
      sleep, waitFor, waitStable, plain, editorText, findByText, runCode, selectAllIn, deepMerge, el,
      openMenu, closeMenu,
    },
    net: {
      records: NET, match: matchRecords, wait: waitForRequest, summary: recordSummary,
      decode: decodeRecord, parseSSE, parseGoogleChunks, origFetch, newRecord,
    },
    emit,
    announce,
    log,
  });


  // The network hook is installed once per page and outlives this generation, so it
  // reaches the live emitter through the window rather than through this closure.
  window.__AIMCP_EMIT__ = emit;

  // Site modules load synchronously right after this file, so a microtask is enough.
  Promise.resolve().then(() => {
    announce();
    // Announce again once the app is actually usable, so the extension badge flips without
    // anyone having to poll for it.
    waitFor(() => { const s = API.site?.ready?.(); return s?.ready ? s : null; }, { timeout: 300000, interval: 1000, label: 'ready' })
      .then(() => isCurrent() && announce())
      .catch(() => {});
  });

  log(`core installed (v${CORE_VERSION}, epoch ${epoch}) on ${location.host}`);
})();
