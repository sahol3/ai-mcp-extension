/*
 * ai-mcp — Gemini site module (MAIN world, gemini.google.com)
 *
 * Gemini is an Angular app with no public object graph, and its transport is Google's BoQ
 * layer: `batchexecute` for everything structural and `StreamGenerate` for the answer,
 * both speaking XSSI-guarded, length-prefixed arrays rather than JSON documents. Two
 * consequences shape this module.
 *
 *   The answer is read from the DOM, not the wire. StreamGenerate's payload is a deeply
 *   nested positional array whose indices move between releases — reading text out of it
 *   is exactly the kind of thing that keeps working while quietly returning the wrong
 *   field. The rendered response is unambiguous, so it is converted back to markdown here
 *   (which the DOM does preserve: code fences, lists, tables and links all survive) and
 *   the raw stream record is returned alongside for anything that needs it.
 *
 *   Structural calls go through batchexecute properly. The tokens that make one work —
 *   `at` (SNlM0e), `bl`, `f.sid` — are read from WIZ_global_data, and when Google moves
 *   those keys, harvested from a request the page itself has already made.
 *
 * Selectors are all taken from a live gemini.google.com build (2026-08), with fallbacks.
 */
(() => {
  'use strict';

  const A = window.__AIMCP__;
  if (!A) { console.error('[ai-mcp] core missing — gemini module cannot load'); return; }
  const { $, $$, pick, describe, visible, clickEl, typeInto, pressKey, sleep, waitFor, waitStable, findByText, el, openMenu, closeMenu, editorText } = A.util;
  const H = A.H;
  const SITE_VERSION = 1;

  // -------------------------------------------------------------- selectors

  const SEL = {
    composer: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      '[aria-label="Enter a prompt for Gemini"]',
      '[data-test-id="textarea-inner"] [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    send: [
      'button[aria-label="Send message"]',
      'button.send-button',
      '[data-test-id="send-button"]',
      'button[aria-label*="Send"]',
    ],
    stop: [
      'button[aria-label="Stop response"]',
      'button[aria-label*="Stop"]',
      '[data-test-id="stop-button"]',
    ],
    userTurn: ['user-query', '[data-test-id="user-query"]', '.user-query-container'],
    modelTurn: ['model-response', '[data-test-id="model-response"]', '.model-response-container'],
    responseText: ['message-content .markdown', 'message-content', '.model-response-text', '.markdown'],
    queryText: ['.query-text', 'user-query-content .query-text', '.user-query-bubble-with-background'],
    history: ['#chat-history', 'infinite-scroller', 'chat-window-content', '[data-test-id="chat-history-container"]'],
    modelPicker: [
      'button[data-test-id="bard-mode-menu-button"]',
      'bard-mode-switcher button',
      'button[aria-label*="mode picker"]',
      'button[aria-label*="model"]',
    ],
    // `gem-menu-item` and the hashed `bard-mode-option-*` ids are what the 2026-08 build
    // actually renders; the generic role/mat selectors stay as fallbacks.
    menuItem: ['gem-menu-item[role="menuitem"]', '[data-test-id^="bard-mode-option-"]', '[role="menuitem"]', 'button[mat-menu-item]', '.mat-mdc-menu-item', '[role="option"]'],
    toolsButton: [
      'button[aria-label="Upload and tools"]',
      'button[aria-label="Upload & tools"]',
      'button[aria-label*="Upload and tools"]',
      'toolbox-drawer button',
      'button[aria-label*="tools"]',
      'button[aria-label*="Open upload"]',
    ],
    newChat: [
      '[data-test-id="new-chat-button"]',
      'a[href="/app"][aria-label*="New chat"]',
      'expanded-button[data-test-id="new-chat-button"] button',
      'button[aria-label*="New chat"]',
      'a[aria-label*="New chat"]',
    ],
    sidebarToggle: ['[data-test-id="side-nav-menu-button"]', 'button[aria-label="Open sidebar"]', 'button[aria-label*="sidebar"]', 'side-nav-sparkle-button button'],
    conversationItem: ['[data-test-id="conversation"]', '.conversation-items-container .conversation', 'conversation-items-container .conversation'],
    conversationTitle: ['.conversation-title', '[data-test-id="conversation-title"]'],
    conversationActions: ['[data-test-id="actions-menu-button"]', 'button[aria-label*="Options"]', '.conversation-actions-menu-button'],
    gemItem: ['gem-nav-list-item', '[data-test-id="bot-list-item"]', 'bot-list-item'],
    fileInput: ['input[type="file"]'],
    signIn: ['[data-test-id="mavatar-sign-in-icon-button"]', '[data-test-id="signed-out-disclaimer"]'],
    responseFooter: ['response-footer', '.response-footer'],
    shareButton: ['[data-test-id="share-and-export-menu-button"]', 'share-button button', 'button[aria-label*="Share"]'],
    thumbsUp: ['[data-test-id="thumb-up-button"]', 'button[aria-label*="Good response"]'],
    thumbsDown: ['[data-test-id="thumb-down-button"]', 'button[aria-label*="Bad response"]'],
    copyButton: ['[data-test-id="copy-button"]', 'button[aria-label*="Copy"]'],
    sources: ['sources-list', '[data-test-id="sources-list"]', '.source-list'],
    canvasPanel: ['extended-response-panel', 'immersive-panel', '[data-test-id="immersive-panel"]'],
    micButton: ['speech-dictation-mic-button button', 'button[aria-label*="Dictate"]'],
  };

  // ---------------------------------------------------------- BoQ plumbing

  /**
   * The three tokens a batchexecute call needs.
   *
   * WIZ_global_data is the page's own bootstrap blob; SNlM0e is the XSRF token, cfb2h the
   * build label and FdrFJe the session id. Those key names are obfuscated and Google does
   * rotate them, so anything missing is recovered from a request the app has already made —
   * which is authoritative by construction and costs nothing, because every one of those
   * requests is already in the capture buffer.
   */
  const LANG = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

  function wizTokens() {
    const w = window.WIZ_global_data || {};
    const out = {
      at: w.SNlM0e || null,
      bl: w.cfb2h || null,
      fsid: w.FdrFJe || null,
      hl: null,
      source: 'WIZ_global_data',
    };

    /*
     * A captured request is the authority on hl. The obfuscated WIZ key for it moves
     * between builds — on the 2026-08 build the field that used to hold it contains
     * "/_/BardChatUi" — and a bad hl is accepted by the server, which then answers in the
     * wrong language rather than failing. Anything that is not a language tag is discarded.
     */
    const recs = A.net.match({ url: 'batchexecute' }).slice().reverse();
    for (const r of recs) {
      try {
        const u = new URL(r.url, location.href);
        out.bl ||= u.searchParams.get('bl');
        out.fsid ||= u.searchParams.get('f.sid');
        const hl = u.searchParams.get('hl');
        if (!out.hl && hl && LANG.test(hl)) out.hl = hl;
      } catch {}
      if (!out.at && r.req_body) {
        const m = /(?:^|&)at=([^&]+)/.exec(r.req_body);
        if (m) out.at = decodeURIComponent(m[1]);
      }
      if (out.at && out.bl && out.fsid && out.hl) { out.source = 'WIZ_global_data + captured:' + r.id; break; }
    }

    const declared = document.documentElement.lang;
    out.hl ||= LANG.test(declared || '') ? declared : 'en-US';
    return out;
  }

  /** `[["wrb.fr","<rpcid>","<json string>",…]]` frames -> { rpcid: parsed }. */
  function parseBatchExecute(text) {
    const frames = A.net.parseGoogleChunks(text);
    const out = {};
    const raw = [];
    for (const frame of frames) {
      if (!Array.isArray(frame)) continue;
      for (const row of frame) {
        if (!Array.isArray(row) || row[0] !== 'wrb.fr') continue;
        const rpcid = row[1] ?? '_';
        raw.push({ rpcid, payload: row[2] });
        if (typeof row[2] === 'string') {
          try { out[rpcid] = JSON.parse(row[2]); } catch { out[rpcid] = row[2]; }
        } else {
          out[rpcid] = row[2];
        }
      }
    }
    return { results: out, frames: frames.length, rows: raw.length };
  }

  async function batchExecute(rpcid, payload, opts = {}) {
    const tok = wizTokens();
    if (!tok.at) {
      throw new Error(
        'gemini_no_xsrf_token — SNlM0e is only issued to a signed-in session, and no captured ' +
        'batchexecute request was available to harvest it from. Sign in, let the app load, then retry.'
      );
    }
    const u = new URL('/_/BardChatUi/data/batchexecute', location.origin);
    u.searchParams.set('rpcids', rpcid);
    u.searchParams.set('source-path', location.pathname);
    if (tok.bl) u.searchParams.set('bl', tok.bl);
    if (tok.fsid) u.searchParams.set('f.sid', tok.fsid);
    u.searchParams.set('hl', tok.hl);
    u.searchParams.set('_reqid', String(Math.floor(Math.random() * 900000) + 100000));
    u.searchParams.set('rt', 'c');

    const inner = typeof payload === 'string' ? payload : JSON.stringify(payload ?? []);
    const freq = JSON.stringify([[[rpcid, inner, null, opts.index ?? 'generic']]]);
    const body = new URLSearchParams({ 'f.req': freq, at: tok.at });

    const res = await A.net.origFetch(u.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(),
    });
    const text = await res.text();
    const parsed = parseBatchExecute(text);
    return {
      status: res.status,
      rpcid,
      token_source: tok.source,
      ...parsed,
      result: parsed.results[rpcid] ?? null,
      ...(opts.raw ? { raw: text.slice(0, 200000) } : {}),
    };
  }

  // -------------------------------------------------- HTML -> markdown

  /*
   * Gemini renders markdown to HTML and keeps no copy of the source, so the only way to
   * hand an agent something it can use verbatim — code that still has its fences, tables
   * that still have their columns — is to convert back. innerText would flatten all of it.
   */
  function mdFromHtml(root) {
    if (!root) return '';
    const out = [];

    const inline = (node) => {
      if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      /*
       * Inline citation chips (2026-09 build: <sup><sources-carousel-inline><source-inline-chip>)
       * are UI, not answer text. Rendered, a transcript came back as "…at 4:30.^ WAV" — the
       * chip citing the uploaded file. Citations stay available through gemini_sources.
       */
      if (/^(sources-carousel-inline|source-inline-chip|source-footnote|sources-list)$/.test(tag)) return '';
      if (tag === 'sup' && node.querySelector('sources-carousel-inline, source-inline-chip')) return '';
      const kids = () => [...node.childNodes].map(inline).join('');
      switch (tag) {
        case 'br': return '\n';
        case 'strong': case 'b': return '**' + kids().trim() + '**';
        case 'em': case 'i': return '*' + kids().trim() + '*';
        case 'del': case 's': return '~~' + kids().trim() + '~~';
        case 'code': return '`' + (node.textContent || '') + '`';
        case 'a': {
          const href = node.getAttribute('href');
          const text = kids().trim();
          return href && href !== text ? `[${text}](${href})` : text;
        }
        case 'img': return `![${node.alt || ''}](${node.src || ''})`;
        case 'sup': return '^' + kids();
        case 'sub': return '_' + kids();
        default: return kids();
      }
    };

    const block = (node, depth = 0, listPrefix = null) => {
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, ' ');
        if (t.trim()) out.push(t.trim());
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (/^(script|style|button|mat-icon|svg|sources-carousel-inline|source-inline-chip|source-footnote|sources-list)$/.test(tag)) return;
      if (node.getAttribute?.('aria-hidden') === 'true') return;

      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          out.push('#'.repeat(Number(tag[1])) + ' ' + inline(node).trim());
          return;
        case 'p':
          { const t = inline(node).trim(); if (t) out.push(t); }
          return;
        case 'pre': {
          const codeEl = node.querySelector('code');
          const lang = (codeEl?.className || node.className || '').match(/language-([\w+#.-]+)/)?.[1] ?? '';
          // Gemini's code-block component prints a language chip and a Copy button as
          // siblings of the code; textContent would fold both into the snippet.
          const code = (codeEl?.textContent ?? node.textContent ?? '').replace(/\n+$/, '');
          out.push('```' + lang + '\n' + code + '\n```');
          return;
        }
        case 'blockquote':
          out.push(inline(node).trim().split('\n').map((l) => '> ' + l).join('\n'));
          return;
        case 'ul': case 'ol': {
          let i = 1;
          for (const li of [...node.children].filter((c) => c.tagName?.toLowerCase() === 'li')) {
            const marker = tag === 'ol' ? `${i++}. ` : '- ';
            const nested = [...li.children].filter((c) => /^(ul|ol|pre|table)$/i.test(c.tagName));
            const own = [...li.childNodes].filter((c) => !nested.includes(c)).map(inline).join('').trim();
            out.push('  '.repeat(depth) + marker + own);
            for (const n of nested) block(n, depth + 1);
          }
          return;
        }
        case 'table': {
          const rows = [...node.querySelectorAll('tr')];
          if (!rows.length) return;
          const cells = (tr) => [...tr.children].map((td) => inline(td).trim().replace(/\|/g, '\\|'));
          const head = cells(rows[0]);
          out.push('| ' + head.join(' | ') + ' |');
          out.push('| ' + head.map(() => '---').join(' | ') + ' |');
          for (const tr of rows.slice(1)) out.push('| ' + cells(tr).join(' | ') + ' |');
          return;
        }
        case 'hr': out.push('---'); return;
        case 'code-block': case 'source-footnote': case 'sources-list':
          for (const c of node.childNodes) block(c, depth);
          return;
        default:
          for (const c of node.childNodes) block(c, depth);
      }
    };

    block(root);
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ------------------------------------------------------------- readiness

  /**
   * Signed in iff the page holds an XSRF token.
   *
   * `SNlM0e` is issued only to a signed-in render, which makes it the authoritative
   * signal. The sign-in button was the first thing tried and is not reliable: it only
   * renders in some layouts, so a signed-out session reports itself as signed in — and the
   * live suite then sends prompts that quietly go nowhere. The DOM check is kept as
   * corroboration for the window before any request has been captured.
   */
  const signedOut = () => {
    const tok = window.WIZ_global_data?.SNlM0e;
    if (typeof tok === 'string' && tok.length > 10) return false;
    if (pick(SEL.signIn, { requireVisible: true }).el) return true;
    return !A.net.match({ url: 'batchexecute' }).some((r) => /(?:^|&)at=[^&]{10,}/.test(r.req_body || ''));
  };

  function ready() {
    const composer = pick(SEL.composer, { requireVisible: false });
    if (composer.el) {
      return {
        ready: true,
        state: signedOut() ? 'app_signed_out' : 'app',
        signed_in: !signedOut(),
        composer_selector: composer.selector,
        path: location.pathname,
      };
    }
    if (document.visibilityState === 'hidden' && document.readyState !== 'complete') {
      return { ready: false, state: 'loading_hidden', hint: 'Tab is hidden and still loading; call ai_focus_tab once.' };
    }
    return { ready: false, state: document.readyState === 'complete' ? 'no_composer' : 'loading' };
  }

  // ---------------------------------------------------------------- reading

  const modelTurns = () => pick(SEL.modelTurn, { all: true, requireVisible: false }).els;
  const userTurns = () => pick(SEL.userTurn, { all: true, requireVisible: false }).els;
  const lastModelTurn = () => { const t = modelTurns(); return t[t.length - 1] ?? null; };
  const isStreaming = () => !!pick(SEL.stop, { requireVisible: true }).el;
  const conversationId = () => (location.pathname.match(/\/app\/([a-z0-9]{6,})/i) ?? [])[1] ?? null;

  function responseBody(turn) {
    if (!turn) return null;
    return pick(SEL.responseText, { root: turn, requireVisible: false }).el ?? turn;
  }

  function shapeTurn(el, role, i) {
    const body = role === 'model' ? responseBody(el) : (pick(SEL.queryText, { root: el, requireVisible: false }).el ?? el);
    return {
      index: i,
      role,
      text: (body?.innerText ?? '').trim(),
      markdown: role === 'model' ? mdFromHtml(body) : (body?.innerText ?? '').trim(),
      images: $$('img', el).map((im) => ({ src: im.src, alt: im.alt || null }))
        .filter((x) => x.src && !/^data:image\/svg/.test(x.src) && !/googleusercontent\.com\/a\//.test(x.src)),
      sources: pick(SEL.sources, { root: el, requireVisible: false }).el
        ? $$('a[href]', pick(SEL.sources, { root: el, requireVisible: false }).el).map((a) => ({ href: a.href, text: (a.innerText || '').trim() }))
        : [],
      code_blocks: $$('pre, code-block', el).map((pre) => ({
        language: (pre.querySelector('code')?.className || '').match(/language-([\w+#.-]+)/)?.[1] ?? null,
        code: (pre.querySelector('code')?.textContent ?? pre.textContent ?? '').trim(),
      })),
    };
  }

  /** User and model turns interleaved in document order. */
  function allTurns() {
    const nodes = [...userTurns().map((e) => ({ el: e, role: 'user' })), ...modelTurns().map((e) => ({ el: e, role: 'model' }))];
    nodes.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return nodes.map((n, i) => shapeTurn(n.el, n.role, i));
  }

  // ------------------------------------------------------------ interaction

  async function setComposer(text) {
    const found = pick(SEL.composer);
    if (!found.el) throw new Error('composer_not_found — is gemini.google.com/app loaded?');
    const r = await typeInto(found.el, text);
    if (!r.ok) throw new Error(`composer_write_failed (tried ${r.attempts.map((a) => a.strategy).join(', ')}) — got "${String(r.text).slice(0, 80)}"`);
    return { ...r, selector: found.selector };
  }

  /**
   * Send the composed prompt.
   *
   * Enter first, deliberately — the opposite of ChatGPT. Gemini's send button ignores an
   * untrusted click: it is present, visible and enabled, `clickEl` reports success, and
   * nothing happens. Measured directly, a synthetic Enter on the Quill editor sends
   * immediately while clicking the button leaves the text sitting in the composer, which is
   * the worst kind of failure — the call looks like it worked and the answer never comes.
   * The button stays as a fallback in case a future build reverses this.
   */
  async function clickSend() {
    const composer = pick(SEL.composer);
    if (composer.el) {
      /*
       * Wait for Gemini to acknowledge the text before trying to send it.
       *
       * The send button is only rendered once Angular has taken the input into its own
       * model, which makes it the one trustworthy "ready to send" signal. Firing Enter
       * ~200ms after typing is too early: the keypress is swallowed, the prompt sits in the
       * composer, and the call then waits out its whole timeout for an answer that was
       * never requested. (The same Enter works perfectly on text that has been sitting for
       * a while, which is exactly what a missing settle looks like.)
       */
      await waitFor(() => (pick(SEL.send, { requireVisible: true }).el ? true : null),
        { timeout: 10000, interval: 150, label: 'composer_registered' }).catch(() => null);

      const had = A.util.editorText(composer.el).trim();
      composer.el.focus();
      pressKey(composer.el, 'Enter');
      // Gemini clears the composer the moment it accepts the prompt; that is the signal.
      const accepted = await waitFor(
        () => (A.util.editorText(composer.el).trim() !== had || isStreaming() ? true : null),
        { timeout: 6000, interval: 80, label: 'send_accepted' },
      ).catch(() => false);
      if (accepted) return { via: 'enter', selector: composer.selector };
    }

    const btn = await waitFor(() => {
      const f = pick(SEL.send, { requireVisible: true });
      if (!f.el || f.el.disabled || f.el.getAttribute('aria-disabled') === 'true') return null;
      return f;
    }, { timeout: 6000, interval: 150, label: 'send_button' }).catch(() => null);
    if (btn) { clickEl(btn.el); return { via: 'button', selector: btn.selector }; }

    throw new Error('cannot_send — Enter was not accepted and no send button is available');
  }

  async function waitForReply({ baselineCount, baselineText = null, sinceId, timeout_ms = 600000, quiet_ms = 1500, lean = false } = {}) {
    const started = Date.now();

    /*
     * "A reply has started" is decided by the conversation changing, never by the stop
     * button. Gemini leaves a stale "Stop response" button visible after an interrupted
     * run, and keying off it meant this returned instantly and then read the PREVIOUS
     * answer — a confidently wrong result, which is worse than any timeout. A new model
     * turn covers a fresh prompt; the last turn's text changing covers regenerate, where
     * the count stays the same.
     */
    const startedReply = () => modelTurns().length > baselineCount
      || (baselineText != null && (responseBody(lastModelTurn())?.innerText ?? '') !== baselineText);
    const inflight = () => A.net.match({ url: 'StreamGenerate', ...(sinceId ? { since_id: sinceId } : {}) }).some((r) => !r.done);

    /*
     * Network first. Once the tab is handed back to the background (the focus hold ends right
     * after a trusted send), Gemini stops painting: the stop button stays up over no turn at all,
     * while the finished answer is already in the StreamGenerate response. Measured: a one-line
     * answer sat unrendered for minutes. So a completed stream ends the wait, DOM or not.
     */
    const netAnswer = () => {
      const recs = A.net.match({ url: 'StreamGenerate', ...(sinceId ? { since_id: sinceId } : {}) });
      const r = recs[recs.length - 1];
      if (!r?.done || r.status !== 200 || !r.text) return null;
      const g = parseGenerate(r.text);
      return g.text ? { g, rec: r } : null;
    };
    const fromNetwork = (hit) => ({
      markdown: hit.g.text,
      ...(lean ? {} : { text: hit.g.text }),
      from: 'network',
      conversation_id: hit.g.conversation_id ?? conversationId(),
      response_id: hit.g.response_id ?? null,
      candidate_id: hit.g.candidate_id ?? null,
      stream_request_id: hit.rec.id,
      still_streaming: false,
      settled: true,
      elapsed_ms: Date.now() - started,
    });

    let began = await waitFor(() => (startedReply() || netAnswer() ? true : null),
      { timeout: Math.min(timeout_ms, 120000), interval: 80, label: 'reply_to_start' }).catch(() => false);
    const early = netAnswer();
    if (early) return fromNetwork(early);
    if (!began && (inflight() || isStreaming())) {
      /*
       * Slow is not wedged. 3.1 Pro, Extended thinking and Deep Research can think for minutes
       * with the stop button up and no turn or text rendered (a hidden tab renders even less),
       * while their StreamGenerate request is alive. Measured 2026-09-30: a one-line Pro
       * answer took ~4 minutes and was misreported as a wedged tab at the 2-minute mark.
       */
      began = await waitFor(() => (startedReply() || netAnswer() || !(inflight() || isStreaming()) ? true : null),
        { timeout: Math.max(0, timeout_ms - (Date.now() - started)), interval: 150, label: 'reply_to_start' }).catch(() => false);
      const late = netAnswer();
      if (late) return fromNetwork(late);
    }
    if (!began || !startedReply()) {
      const netText = (() => {
        const recs = A.net.match({ url: 'StreamGenerate', ...(sinceId ? { since_id: sinceId } : {}) });
        const r = recs[recs.length - 1];
        return r?.done && r.text ? parseGenerate(r.text).text : '';
      })();
      if (netText) return { markdown: netText, ...(lean ? {} : { text: netText }), from: 'network', conversation_id: conversationId(), settled: true, elapsed_ms: Date.now() - started };
      /*
       * Wedged = the stop button is up over an empty turn AND no request is running. Gemini
       * does not clear that on its own; the tab needs reloading, or the call needs via:"api".
       */
      const empty = (responseBody(lastModelTurn())?.innerText ?? '').trim().length === 0;
      if (isStreaming() && empty && !inflight()) {
        throw new Error(
          'gemini_tab_wedged — a model turn is showing the stop button but has received no text, no request is '
          + 'running, and Gemini does not clear that state on its own. Retry with via:"api", or reload the tab '
          + '(ai_reload_tab site:"gemini").'
        );
      }
      throw new Error(`timeout_waiting_for_reply_to_start after ${Date.now() - started}ms`);
    }

    /*
     * The stop button is a hint, not an oracle.
     *
     * While it is up the answer is usually still moving — Deep Research pauses for minutes
     * between sections — so it suppresses settling by making the polled value change. But
     * Gemini also leaves a stale "Stop response" button behind after a run is interrupted,
     * and treating that as authoritative meant waiting for the full timeout and then
     * returning the *previous* answer: a confidently wrong result, which is the failure this
     * whole design exists to avoid. So its veto expires: once the rendered text has held
     * still for `stuck_after`, the answer is taken as finished and the anomaly is reported.
     */
    /*
     * SPEED: once this send's StreamGenerate request has completed and the stop button is gone,
     * the answer is final — only the paint has to catch up, so ~250 ms of stillness is enough.
     * The full quiet_ms (1.5 s) is kept for the case the network cannot vouch for (no record
     * captured, or the stream still open). Measured before: every answer paid ~1.5-2 s here.
     */
    const stuckAfter = Math.max(quiet_ms * 4, 20000);
    const streamDone = () => {
      const recs = A.net.match({ url: 'StreamGenerate', ...(sinceId ? { since_id: sinceId } : {}) });
      const r = recs[recs.length - 1];
      return !!(r && r.done && r.status === 200);
    };
    let lastSeen = null;
    let lastChange = Date.now();
    let stopStuck = false;
    let settledOk = false;
    const deadline = started + timeout_ms;
    while (Date.now() < deadline) {
      const t = responseBody(lastModelTurn())?.innerText ?? '';
      if (t !== lastSeen) { lastSeen = t; lastChange = Date.now(); }
      const held = Date.now() - lastChange;
      const streaming = isStreaming();
      const netDone = streamDone();
      /*
       * The completed stream IS the answer, as markdown source (the API route has always
       * returned exactly this). Reading the DOM instead waited for paint and could catch
       * Gemini mid-repaint — a transcript came back duplicated ("…marmalade Bridge test. The
       * code word is marmalade 742."). So a completed stream ends the wait immediately.
       */
      if (netDone) { const hit = netAnswer(); if (hit) return fromNetwork(hit); }
      if (streaming && held >= stuckAfter) stopStuck = true;
      const need = netDone && !streaming ? 250 : quiet_ms;
      if ((!streaming || stopStuck) && held >= need && t.trim()) { settledOk = true; break; }
      await sleep(netDone ? 60 : 200);
    }
    const stable = { stable: settledOk, timed_out: !settledOk };

    const turn = lastModelTurn();
    const body = responseBody(turn);
    const recs = A.net.match({ url: 'StreamGenerate', ...(sinceId ? { since_id: sinceId } : {}) });
    const rec = recs[recs.length - 1] ?? null;

    // The identifiers Gemini threads through its own URLs are recognisable on sight, which
    // makes a regex over the raw stream far more durable than indexing into its arrays.
    const ids = {};
    if (rec?.text) {
      ids.conversation_id = (rec.text.match(/"(c_[0-9a-f]{8,})"/) ?? [])[1] ?? null;
      ids.response_id = (rec.text.match(/"(r_[0-9a-f]{8,})"/) ?? [])[1] ?? null;
      ids.candidate_id = (rec.text.match(/"(rc_[0-9a-f]{8,})"/) ?? [])[1] ?? null;
    }

    /*
     * `lean` omits everything that repeats the answer. The full shape carries it four times
     * over — as text, as markdown, and again inside `turn` — which for a long reply is the
     * dominant cost of the whole call, paid on the bridge and again by whatever reads it.
     */
    // A hidden tab can hold a finished answer in the network long before it paints it.
    let markdown = mdFromHtml(body);
    let from = 'dom';
    if (!String(markdown || '').trim() && rec?.done && rec.text) {
      const g = parseGenerate(rec.text);
      if (g.text) { markdown = g.text; from = 'network'; }
    }
    return {
      ...(lean ? {} : { text: from === 'network' ? markdown : (body?.innerText ?? '').trim() }),
      markdown,
      ...(from === 'network' ? { from } : {}),
      ...(lean ? {} : { turn: turn ? shapeTurn(turn, 'model', modelTurns().length - 1) : null }),
      conversation_id: ids.conversation_id ?? conversationId(),
      response_id: ids.response_id ?? null,
      candidate_id: ids.candidate_id ?? null,
      stream_request_id: rec?.id ?? null,
      still_streaming: isStreaming(),
      ...(stopStuck ? { stop_button_stuck: true } : {}),
      settled: stable.stable,
      ...(stable.timed_out ? { timed_out: true } : {}),
      elapsed_ms: Date.now() - started,
    };
  }

  // ---------------------------------------------------------------- handlers

  H['gemini.status'] = async () => {
    const tok = wizTokens();
    return {
      site: 'gemini',
      url: location.href,
      conversation_id: conversationId(),
      ready: ready(),
      signed_in: !signedOut(),
      streaming: isStreaming(),
      turns: { user: userTurns().length, model: modelTurns().length },
      model: (pick(SEL.modelPicker).el?.innerText ?? '').trim() || null,
      model_button_label: pick(SEL.modelPicker).el?.getAttribute('aria-label') ?? null,
      tokens: { at: tok.at ? tok.at.slice(0, 6) + '…' : null, bl: tok.bl, f_sid: tok.fsid, hl: tok.hl, source: tok.source },
      captured_rpcids: [...new Set(A.net.match({ url: 'batchexecute' }).map((r) => { try { return new URL(r.url, location.href).searchParams.get('rpcids'); } catch { return null; } }).filter(Boolean))],
    };
  };

  H['gemini.probe'] = async () => H['sys.probe']();

  /* ------------------------------ prompting ------------------------------ */

  H['gemini.ask'] = async (p = {}) => {
    if (!p.prompt) throw new Error('prompt_required');

    /*
     * Route choice. The UI path cannot send from Gemini's zero state at all — measured, every
     * synthetic route is ignored there — so when a StreamGenerate template has been captured
     * the API path is preferred: it works from any state, needs no focus, and is far faster.
     * The UI path remains the default for the first send of a session (nothing to replay yet)
     * and whenever the caller wants the answer rendered in the tab they are watching.
     */
    const via = p.via ?? 'auto';
    const template = latestStreamGenerate();
    const zeroState = modelTurns().length === 0 && !conversationId();

    /*
     * The tab can also get *wedged*: Gemini leaves "Stop response" visible over a model turn
     * that never receives any text, and clicking Stop does not clear it. In that state the UI
     * path waits for a reply that will never start and fails on a bare timeout. It is not
     * something the bridge can fix from the outside — but it is detectable, and the API path
     * is unaffected by it because it does not go through the composer at all.
     */
    const wedged = isStreaming() && (responseBody(lastModelTurn())?.innerText ?? '').trim().length === 0;

    /*
     * The other broken shape: the URL names a conversation but Gemini rendered none of it —
     * no turns, no model picker, nothing to type into that will behave. It happens after a
     * conversation has been left in a bad state, and it survives a reload, so the composer
     * path cannot recover on its own. Not streaming, so `wedged` above does not see it.
     */
    const unrendered = !!conversationId() && modelTurns().length === 0 && !isStreaming();

    /*
     * The API path sends the prompt text and nothing else: a file sitting in the composer, or a
     * tool switched on in the UI, is silently dropped. That is exactly how voice-note
     * transcription failed on every fresh chat ("Failed Transcription Request": the audio was
     * attached in the composer, the zero state routed to the API, Gemini got a bare
     * "transcribe this"). So anything the composer is holding forces the UI path.
     */
    // A temporary chat counts too: an API send from its template would create a SAVED chat.
    const composerLoaded = attachmentChips().length > 0 || !!p.tools?.length || activeTools().length > 0 || isTemporary();
    if (composerLoaded && via === 'api') {
      return { ok: false, error: 'api_route_drops_attachments', hint: 'Files or tools are loaded in the composer; the API route would send the text alone. Use via:"ui".' };
    }

    if (via === 'api' || (via === 'auto' && template && !composerLoaded && (zeroState || p.new_chat || wedged || unrendered))) {
      const r = await H['gemini.send_api']({
        prompt: p.prompt,
        timeout_ms: p.timeout_ms ?? 600000,
        new_chat: p.new_chat ?? zeroState,
        conversation_id: p.conversation_id,
        response_id: p.response_id,
        candidate_id: p.candidate_id,
      });
      if (r.ok) return { ok: true, sent: { via: 'api' }, markdown: r.text, ...r };
      if (via === 'api') return r;
      // A new chat must not quietly land in the current conversation: hand it back to the
      // server, which opens a real new chat and sends there with a trusted Enter.
      if (p.new_chat || zeroState) return { ok: false, error: 'zero_state_needs_trusted_send', api_error: r.error ?? 'api_send_failed' };
      // fall through to the UI path with the reason recorded
      p.__api_error = r.error ?? 'api_send_failed';
    }

    // new_chat that the API route did not take must never fall into the open conversation
    // (observed: it went into a temporary chat left open). The server opens a real new chat.
    if (p.new_chat && !zeroState && p.trusted_send !== false) {
      return { ok: false, error: 'zero_state_needs_trusted_send', reason: 'new_chat_requested' };
    }
    if (zeroState && p.trusted_send !== false) {
      // Synthetic sends are refused here; only a real (debugger-level) Enter on a focused tab
      // gets through, and that needs the server's OS-focus hold. gemini_ask does it.
      return { ok: false, error: 'zero_state_needs_trusted_send', hint: 'Call gemini_ask (it types, focuses the tab and sends a trusted Enter), not gemini.ask directly.' };
    }

    const baselineCount = modelTurns().length;
    const baselineText = responseBody(lastModelTurn())?.innerText ?? '';
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;

    if (p.model || p.thinking != null) await H['gemini.set_model']({ model: p.model, thinking: p.thinking });
    if (p.tools?.length) for (const t of p.tools) await H['gemini.toggle_tool']({ tool: t }).catch(() => {});
    if (p.attachments?.length) for (const a of p.attachments) await H['gemini.attach']({ ...a });

    const wrote = await setComposer(String(p.prompt));
    await sleep(p.settle_ms ?? 60);
    const sent = await clickSend();

    if (p.wait === false) return { ok: true, sent, wrote: { strategy: wrote.strategy }, waited: false };
    const reply = await waitForReply({
      baselineCount, baselineText, sinceId,
      timeout_ms: p.timeout_ms ?? 600000,
      quiet_ms: p.quiet_ms ?? 1500,
      lean: p.lean === true,
    });
    /*
     * Snapshot the request this send just produced. It is the template every later API send
     * replays, and it has to be taken AFTER the send — before it, there is nothing to save,
     * which is why persisting on the way in captured nothing.
     */
    latestStreamGenerate();

    return { ok: true, sent, wrote: { strategy: wrote.strategy }, ...(p.__api_error ? { api_fallback_reason: p.__api_error } : {}), ...reply };
  };

  H['gemini.send'] = async (p = {}) => {
    const wrote = await setComposer(String(p.prompt ?? ''));
    if (p.send === false) return { ok: true, typed_only: true, wrote };
    await sleep(50);
    return { ok: true, wrote: { strategy: wrote.strategy }, sent: await clickSend() };
  };

  H['gemini.wait_reply'] = async (p = {}) => {
    const reply = await waitForReply({
      baselineCount: p.baseline_count ?? Math.max(0, modelTurns().length - 1),
      sinceId: p.since_request_id ?? null,
      timeout_ms: p.timeout_ms ?? 600000,
      quiet_ms: p.quiet_ms ?? 1500,
      lean: p.lean === true,
    });
    latestStreamGenerate(); // a UI send is the freshest template, for this exact mode
    return { ok: true, ...reply, conversation_id: conversationId() };
  };

  /*
   * Temporary chat (2026-09 build): from the empty /app state, button[aria-label="Temporary chat"]
   * switches it on; the button then disappears and a visible `span.info-text` "Temporary Chat"
   * appears. Verified 2026-10-01: a send in that mode came back with NO conversation id, the URL
   * stayed /app, and the chat never appeared in the history list — nothing to clean up.
   */
  function isTemporary() {
    // Before the first send only the switch's own `temp-chat-on` class and the composer
    // placeholder ("Ask questions in a temporary chat") show it; the label comes after.
    if ($$('.temp-chat-on').length) return true;
    if ($$('.ql-editor[data-placeholder]').some((e) => /temporary/i.test(e.getAttribute('data-placeholder') || ''))) return true;
    return $$('span.info-text').filter(visible).some((e) => /temporary chat/i.test(e.textContent || ''));
  }

  H['gemini.temporary_chat'] = async (p = {}) => {
    if (p.enable === false) return { ok: true, temporary: isTemporary(), hint: 'Leave a temporary chat with gemini_new_chat.' };
    if (isTemporary()) return { ok: true, temporary: true, already: true };
    if (conversationId() || modelTurns().length) {
      return { ok: false, error: 'not_in_new_chat', hint: 'Temporary chat can only be switched on from an empty new chat (gemini_new_chat first).' };
    }
    const btn = $$('button[aria-label="Temporary chat"]').find(visible);
    if (!btn) return { ok: false, error: 'temporary_chat_button_not_found' };
    clickEl(btn);
    const on = await waitFor(() => (isTemporary() ? true : null), { timeout: 5000, interval: 100, label: 'temporary_chat' }).catch(() => false);
    return { ok: !!on, temporary: !!on };
  };

  /*
   * Conversation list and delete, over batchexecute (no sidebar, no menus, works hidden).
   *   MaZiqc [pageSize, null, [0, null, 1]] -> [null, cursor, [["c_<id>", title, …, [secs, nanos], …], …]]
   *   GzXR5e ["c_<id>"]                     -> []   (verified 2026-10-01 on a throwaway chat)
   * The UI route for delete opens a menu that renders nothing unless the tab is focused.
   */
  async function listConversationsApi(pageSize = 100) {
    const r = await batchExecute('MaZiqc', [pageSize, null, [0, null, 1]]);
    const rows = Array.isArray(r.result?.[2]) ? r.result[2] : [];
    return rows.filter((x) => Array.isArray(x) && typeof x[0] === 'string').map((x) => ({
      conversation_id: x[0].replace(/^c_/, ''),
      title: typeof x[1] === 'string' ? x[1] : null,
      updated: Array.isArray(x[5]) && typeof x[5][0] === 'number' ? new Date(x[5][0] * 1000).toISOString() : null,
    }));
  }

  H['gemini.list_conversations_api'] = async (p = {}) => ({ conversations: await listConversationsApi(p.limit ?? 100) });

  H['gemini.delete_conversations'] = async (p = {}) => {
    const ids = [...new Set((p.ids ?? []).map((x) => String(x).replace(/^c_/, '')).filter(Boolean))];
    if (!ids.length) throw new Error('ids_required');
    const before = new Set((await listConversationsApi(100).catch(() => [])).map((c) => c.conversation_id));
    const results = [];
    for (const id of ids) {
      const r = await batchExecute('GzXR5e', ['c_' + id]).catch((e) => ({ status: 0, error: String(e.message) }));
      results.push({ conversation_id: id, status: r.status, ok: r.status === 200 && !r.error, listed_before: before.has(id) });
    }
    // The history list lags a delete by a second or two; re-read briefly before calling it failed.
    let after = new Set();
    for (let i = 0; i < 6; i++) {
      after = new Set((await listConversationsApi(100).catch(() => [])).map((c) => c.conversation_id));
      if (!results.some((x) => x.ok && x.listed_before && after.has(x.conversation_id))) break;
      await sleep(500);
    }
    for (const x of results) {
      x.gone = !after.has(x.conversation_id);
      x.verified = x.listed_before ? x.gone : null; // only a chat that was listed can be proven gone
      if (x.listed_before && !x.gone) x.ok = false;
    }
    return { deleted: results.filter((x) => x.ok).length, results, was_open: ids.includes(conversationId() ?? '') };
  };

  /** Model turns + whether the composer holds files, for a caller that sends on its own. */
  H['gemini.composer_state'] = async () => ({
    conversation_id: conversationId(),
    temporary: isTemporary(),
    zero_state: modelTurns().length === 0 && userTurns().length === 0 && !conversationId(),
    model_turns: modelTurns().length,
    attachments: attachmentChips().length,
    active_tools: activeTools(),
    streaming: isStreaming(),
    composer_text: (editorText(pick(SEL.composer).el) || '').slice(0, 200),
    since_id: A.net.records.length ? A.net.records[A.net.records.length - 1].id : null,
    mode: currentMode(),
  });

  H['gemini.stop'] = async () => {
    const f = pick(SEL.stop);
    if (!f.el) return { ok: false, reason: 'not_streaming' };
    clickEl(f.el);
    await sleep(300);
    return { ok: true, still_streaming: isStreaming() };
  };

  H['gemini.regenerate'] = async (p = {}) => {
    const baselineCount = modelTurns().length;
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;
    const baselineText = responseBody(lastModelTurn())?.innerText ?? '';
    const btn = findByText('Regenerate') || findByText('Regenerate draft') || pick(['button[aria-label*="Regenerate"]']).el;
    if (!btn) throw new Error('regenerate_control_not_found');
    clickEl(btn);
    await sleep(400);
    if (p.wait === false) return { ok: true, waited: false };
    return { ok: true, ...(await waitForReply({ baselineCount, baselineText, sinceId, timeout_ms: p.timeout_ms ?? 600000 })) };
  };

  /** Shorter / Longer / Simpler / More casual / More professional. */
  H['gemini.modify_response'] = async (p = {}) => {
    if (!p.style) throw new Error('style_required — one of: shorter, longer, simpler, casual, professional');
    const modify = findByText('Modify response') || pick(['button[aria-label*="Modify"]']).el;
    if (modify) { clickEl(modify); await sleep(400); }
    const target = findByText(String(p.style), '[role="menuitem"],button');
    if (!target) throw new Error(`modify_option_not_found: ${p.style}`);
    const baselineCount = modelTurns().length;
    const baselineText = responseBody(lastModelTurn())?.innerText ?? '';
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;
    clickEl(target);
    if (p.wait === false) return { ok: true, waited: false };
    // baselineCount unmodified: `count - 1` made the start check true on the first poll, so
    // this returned the pre-modification answer as the new one.
    return { ok: true, ...(await waitForReply({ baselineCount, baselineText, sinceId, timeout_ms: p.timeout_ms ?? 300000 })) };
  };

  /* ------------------------------- reading ------------------------------- */

  H['gemini.messages'] = async (p = {}) => {
    const turns = allTurns();
    const limited = p.count ? turns.slice(-Number(p.count)) : turns;
    return {
      conversation_id: conversationId(),
      url: location.href,
      total: turns.length,
      returned: limited.length,
      streaming: isStreaming(),
      turns: p.markdown === false ? limited.map(({ markdown, ...t }) => t) : limited,
      /*
       * An empty tab right after a successful ask is confusing enough to be worth explaining:
       * the API path answers without rendering anything, so there is genuinely nothing here
       * to read. This lists what the tab shows, which is not the same as what was asked.
       */
      ...(turns.length === 0 && window.__AIMCP_GEMINI_LAST__?.text
        ? { note: 'this tab has rendered no turns, but an answer was returned through the API path — read it with gemini_last_reply' }
        : {}),
    };
  };

  H['gemini.last_reply'] = async () => {
    const turn = lastModelTurn();
    if (!turn) {
      // Nothing rendered. An API send is the usual reason, and its answer is still the most
      // recent reply in this conversation even though the tab never drew it.
      const cached = window.__AIMCP_GEMINI_LAST__;
      if (cached && cached.text) {
        return {
          found: true,
          source: 'api',
          note: 'this answer came from the API path, so it was never rendered in the tab',
          streaming: false,
          age_ms: Date.now() - cached.at,
          ...cached,
        };
      }
      return { found: false, conversation_id: conversationId() };
    }
    const body = responseBody(turn);
    return {
      found: true,
      conversation_id: conversationId(),
      streaming: isStreaming(),
      text: (body?.innerText ?? '').trim(),
      markdown: mdFromHtml(body),
      turn: shapeTurn(turn, 'model', modelTurns().length - 1),
    };
  };

  H['gemini.sources'] = async () => {
    const turn = lastModelTurn();
    const box = turn ? pick(SEL.sources, { root: turn, requireVisible: false }).el : null;
    if (!box) return { found: false, sources: [] };
    return {
      found: true,
      sources: $$('a[href]', box).map((a) => ({ href: a.href, title: (a.innerText || '').trim(), domain: (() => { try { return new URL(a.href).hostname; } catch { return null; } })() })),
    };
  };

  H['gemini.images'] = async (p = {}) => {
    const scope = p.last_only === false ? document : (lastModelTurn() ?? document);
    return {
      images: $$('img', scope)
        .map((im) => ({ src: im.src, alt: im.alt || null, width: im.naturalWidth, height: im.naturalHeight }))
        .filter((x) => x.src && !/^data:image\/svg/.test(x.src) && x.width > 64),
    };
  };

  H['gemini.canvas'] = async () => {
    const panel = pick(SEL.canvasPanel).el;
    if (!panel) return { open: false };
    return { open: true, text: (panel.innerText || '').slice(0, 200000), markdown: mdFromHtml(panel) };
  };

  /* ---------------------------- conversations ---------------------------- */

  async function ensureSidebar() {
    if (pick(SEL.conversationItem, { all: true }).els.length) return { already_open: true };
    const toggle = pick(SEL.sidebarToggle);
    if (!toggle.el) return { already_open: false, toggled: false };
    clickEl(toggle.el);
    await sleep(700);
    return { already_open: false, toggled: true };
  }

  H['gemini.conversations'] = async (p = {}) => {
    const side = await ensureSidebar();
    if (p.scroll !== false) {
      // The list is virtualised; without scrolling it, only the first screenful exists.
      const scroller = $('infinite-scroller') ?? $('[data-test-id="chat-history-container"]');
      if (scroller) {
        for (let i = 0; i < (p.scroll_pages ?? 3); i++) { scroller.scrollTop = scroller.scrollHeight; await sleep(400); }
      }
    }
    const items = pick(SEL.conversationItem, { all: true, requireVisible: false }).els;
    return {
      sidebar: side,
      total: items.length,
      conversations: items.slice(0, p.limit ?? 100).map((el, i) => ({
        index: i,
        title: (pick(SEL.conversationTitle, { root: el, requireVisible: false }).el?.innerText ?? el.innerText ?? '').trim().split('\n')[0],
        selected: el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true',
        jslog: el.getAttribute('jslog')?.slice(0, 120) ?? null,
      })),
      current_conversation_id: conversationId(),
    };
  };

  H['gemini.open_conversation'] = async (p = {}) => {
    await ensureSidebar();
    const items = pick(SEL.conversationItem, { all: true, requireVisible: false }).els;
    let target = null;
    if (p.index != null) target = items[Number(p.index)];
    else if (p.title) {
      const want = String(p.title).toLowerCase();
      target = items.find((el) => (el.innerText || '').toLowerCase().includes(want));
    }
    if (!target) {
      if (p.conversation_id) return { ok: false, needs_navigation: true, url: location.origin + '/app/' + p.conversation_id };
      throw new Error(`conversation_not_found (${items.length} in the loaded sidebar) — pass index, title, or conversation_id`);
    }
    const before = conversationId();
    clickEl(target);
    await waitFor(() => conversationId() !== before, { timeout: 15000, interval: 100, label: 'conversation_switch' }).catch(() => {});
    await sleep(200);
    return { ok: true, conversation_id: conversationId(), title: (target.innerText || '').trim().split('\n')[0] };
  };

  /*
   * Verified, not assumed. The old version clicked and reported ok after 900ms; in a hidden tab
   * the router often had not moved, so the "new" chat was the old conversation (observed: same
   * id, 4 turns). The zero state is the proof; failing that, the caller navigates to /app.
   */
  H['gemini.new_chat'] = async (p = {}) => {
    // Empty means no turns of either kind and nothing streaming: a send whose reply never painted
    // leaves a user turn and a stop button at /app, which is not a fresh chat.
    const isZero = () => !conversationId() && modelTurns().length === 0 && userTurns().length === 0 && !isStreaming();
    // "Fresh" includes no tool left switched on from before (seen: Deep research survived).
    // A normal new chat must not inherit Temporary mode; /app from scratch leaves it.
    const tempLeftOver = () => isTemporary() && !p.temporary;
    if (isZero() && !tempLeftOver()) {
      const cleared = activeTools().length ? await clearTools() : true;
      if (cleared) return { ok: true, conversation_id: null, turns: 0, already: true };
    }
    const btn = tempLeftOver() ? null : (pick(SEL.newChat).el ?? findByText('New chat'));
    if (btn) {
      clickEl(btn);
      // The router moves at once when it moves at all; past 1.5 s navigation is the faster route.
      const ok = await waitFor(() => (isZero() ? true : null), { timeout: 1500, interval: 50, label: 'zero_state' }).catch(() => false);
      if (ok && !tempLeftOver()) return { ok: true, conversation_id: null, turns: 0, via: 'button' };
    }
    return { ok: false, needs_navigation: true, url: location.origin + '/app', reason: btn ? 'button_did_not_reach_zero_state' : 'no_new_chat_button' };
  };

  H['gemini.conversation_action'] = async (p = {}) => {
    if (!p.action) throw new Error('action_required — one of: rename, delete, pin');
    /*
     * A target is mandatory. Without one, ''.includes('') matched every conversation and the
     * handler took the first — so {action:"delete"} destroyed the most recent conversation
     * the caller never named.
     */
    if (p.index == null && !p.title) {
      throw new Error('index_or_title_required — refusing to guess which conversation to ' + p.action + '. Call gemini_conversations first.');
    }
    await ensureSidebar();
    const items = pick(SEL.conversationItem, { all: true, requireVisible: false }).els;
    const el = p.index != null ? items[Number(p.index)] : items.find((x) => (x.innerText || '').toLowerCase().includes(String(p.title ?? '').toLowerCase()));
    if (!el) throw new Error('conversation_not_found');
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(250);
    const menuBtn = pick(SEL.conversationActions, { root: el, requireVisible: false }).el ?? $$('button', el).pop();
    if (!menuBtn) throw new Error('conversation_menu_button_not_found');
    clickEl(menuBtn);
    await sleep(450);
    const item = findByText(String(p.action), '[role="menuitem"],button');
    if (!item) {
      const opts = pick(SEL.menuItem, { all: true }).els.map((e) => (e.innerText || '').trim()).filter(Boolean);
      pressKey(document.body, 'Escape');
      throw new Error(`action_not_in_menu: ${p.action}. Menu offers: ${opts.join(' | ')}`);
    }
    clickEl(item);
    await sleep(500);

    if (p.action === 'rename' && p.new_title) {
      const input = pick(['input[matinput]', 'input[type="text"]', 'textarea'], { requireVisible: true });
      if (input.el) {
        await typeInto(input.el, String(p.new_title));
        await sleep(200);
        const save = findByText('Save') || findByText('Rename') || findByText('Done');
        if (save) clickEl(save);
        await sleep(400);
      }
    }
    if (p.action === 'delete' && p.confirm !== false) {
      const confirm = findByText('Delete', 'button') || findByText('Confirm', 'button');
      if (confirm) { clickEl(confirm); await sleep(600); }
    }
    return { ok: true, action: p.action };
  };

  /* ------------------------------- models -------------------------------- */

  const modeName = (e) => (e.innerText || '').trim().split('\n')[0];

  const waitPicker = async (sel, label, ms = 10000) =>
    await waitFor(() => { const f = pick(sel); return f.el ? f : null; }, { timeout: ms, interval: 250, label })
      .catch(() => { throw new Error(`${label}_not_found — the control has not rendered. ai_probe shows what is on the page.`); });

  /*
   * Modes, as the 2026-09 build presents them: a menu of models ("3.5 Flash-Lite", "3.8 Flash",
   * "3.1 Pro"), each with a `bard-mode-option-<id>` test id, plus "Extended thinking", which
   * is NOT a model — it is a toggle layered on whichever model is selected (the picker then
   * reads "Flash\nExtended"). The id is what StreamGenerate carries in the
   * x-goog-ext-525001261-jspb header (slot 4), and Extended thinking shows there as slot
   * 15 = 2 instead of 1 (observed 2026-09-30). Both are remembered so the API route can send
   * in the mode the UI shows rather than in whatever mode its template was captured.
   */
  const MODES_KEY = '__aimcp_gemini_modes';
  const isThinkingItem = (e) => /extended thinking/i.test(e.innerText || '');

  function rememberModes(items) {
    const map = {};
    for (const e of items) {
      const id = (e.getAttribute('data-test-id') || '').replace(/^bard-mode-option-/, '');
      if (id && !isThinkingItem(e)) map[modeName(e)] = id;
    }
    if (Object.keys(map).length) { try { sessionStorage.setItem(MODES_KEY, JSON.stringify(map)); } catch {} }
    return map;
  }
  function modesMap() { try { return JSON.parse(sessionStorage.getItem(MODES_KEY) || '{}'); } catch { return {}; } }

  function currentMode() {
    const label = (pick(SEL.modelPicker).el?.innerText || '').trim();
    const [short = '', ...rest] = label.split('\n').map((s) => s.trim());
    const thinking = rest.some((r) => /extended/i.test(r));
    const s = short.toLowerCase();
    const entry = Object.entries(modesMap()).find(([name]) => name.toLowerCase() === s || name.toLowerCase().endsWith(' ' + s));
    return { label, model: entry?.[0] ?? (short || null), id: entry?.[1] ?? null, thinking };
  }

  H['gemini.models'] = async () => {
    const btn = await waitPicker(SEL.modelPicker, 'model_picker');
    const menu = await openMenu(btn.el, SEL.menuItem);
    rememberModes(menu.els);
    const options = menu.els.map((e) => ({
      name: modeName(e),
      kind: isThinkingItem(e) ? 'toggle' : 'model',
      id: (e.getAttribute('data-test-id') || '').replace(/^bard-mode-option-/, '') || null,
      description: (e.innerText || '').trim().split('\n').slice(1).join(' ') || null,
      selected: e.classList.contains('selected') || e.getAttribute('aria-selected') === 'true',
    }));
    await closeMenu();
    const cur = currentMode();
    return {
      current: cur.model,
      thinking: cur.thinking,
      current_label: btn.el.getAttribute('aria-label'),
      options,
      hint: 'gemini_set_model {model:"3.1 Pro", thinking:true} picks a model and turns Extended thinking on or off.',
    };
  };

  H['gemini.set_model'] = async (p = {}) => {
    // Back-compat: {model:"Extended thinking"} used to be how thinking was turned on.
    let wantModel = p.model != null && !/^extended( thinking)?$/i.test(String(p.model)) ? String(p.model) : null;
    const wantThinking = p.thinking != null ? !!p.thinking : (p.model != null && !wantModel ? true : null);
    if (!wantModel && wantThinking == null) throw new Error('model_or_thinking_required');

    // Right after an answer the picker can still be locked; a switch clicked then is dropped
    // (observed: "3.8 Flash" requested straight after a Pro answer, picker stayed on Pro).
    await waitFor(() => (!isStreaming() ? true : null), { timeout: 30000, interval: 100, label: 'idle_before_model_switch' }).catch(() => null);
    const btn = await waitPicker(SEL.modelPicker, 'model_picker');
    const before = currentMode();
    const readLabel = () => (pick(SEL.modelPicker).el?.innerText || '').trim();

    for (let attempt = 0; wantModel && attempt < 2; attempt++) {
      if (attempt > 0) {
        if ((currentMode().model || '').toLowerCase() === wantModel.toLowerCase()) break;
        await sleep(1200);
      }
      const menu = await openMenu(pick(SEL.modelPicker).el ?? btn.el, SEL.menuItem);
      rememberModes(menu.els);
      const models = menu.els.filter((e) => !isThinkingItem(e));
      const want = wantModel.toLowerCase();
      const target = models.find((e) => modeName(e).toLowerCase() === want)
        ?? models.find((e) => modeName(e).toLowerCase().endsWith(' ' + want))
        ?? models.find((e) => modeName(e).toLowerCase().startsWith(want))
        ?? models.find((e) => (e.innerText || '').toLowerCase().includes(want));
      if (!target) {
        const names = models.map(modeName).filter(Boolean);
        await closeMenu();
        throw new Error(`model_not_in_menu: "${p.model}". Models: ${names.join(' | ')} (+ thinking:true for Extended thinking)`);
      }
      const labelBefore = readLabel();
      // Read the name BEFORE clicking: once the menu closes the item is detached, and a
      // detached element's innerText has no line breaks ("3.5 Flash-LiteFastest answers").
      wantModel = modeName(target);
      if (target.classList.contains('selected')) await closeMenu();
      else {
        clickEl(target);
        // The label is what the app itself updates when the switch has taken, so wait for it
        // rather than assuming a fixed settle — background tabs make fixed settles a lottery.
        await waitFor(() => (readLabel() && readLabel() !== labelBefore ? true : null), { timeout: 8000, interval: 60, label: 'model_label_change' }).catch(() => null);
      }
    }

    if (wantThinking != null && currentMode().thinking !== wantThinking) {
      const menu = await openMenu(pick(SEL.modelPicker).el, SEL.menuItem);
      const toggle = menu.els.find(isThinkingItem);
      if (!toggle) { await closeMenu(); throw new Error('extended_thinking_not_offered — this account/model shows no "Extended thinking" item'); }
      const labelBefore = readLabel();
      clickEl(toggle);
      await waitFor(() => (readLabel() !== labelBefore ? true : null), { timeout: 8000, interval: 60, label: 'thinking_toggle' }).catch(() => null);
    }

    const after = currentMode();
    const modelOk = !wantModel || (after.model || '').toLowerCase() === wantModel.toLowerCase();
    const thinkingOk = wantThinking == null || after.thinking === wantThinking;
    if (!modelOk || !thinkingOk) {
      throw new Error(`model_switch_did_not_stick: wanted ${wantModel ?? '(same model)'}${wantThinking != null ? ` thinking=${wantThinking}` : ''}, picker shows "${after.label.replace(/\n/g, ' + ')}"`);
    }
    return { ok: true, before: { model: before.model, thinking: before.thinking }, after: { model: after.model, thinking: after.thinking, id: after.id }, changed: before.label !== after.label };
  };

  /* -------------------------------- tools -------------------------------- */

  /*
   * 2026-09 layout: "Upload & tools" opens a list with Upload files / Add from Drive, plus a
   * drawer of `role="menuitemcheckbox"` tools (Create image, Create video, Create music) and a
   * "More tools" button (`data-test-id="more-tools-button"`) that opens the rest (Deep
   * Research, Canvas, …). The old lookup only read `role="menuitem"` and so found no tools at
   * all. Everything here needs the tab genuinely visible — the server wraps it in a focus hold.
   */
  const TOOL_ALIASES = { image: 'create image', images: 'create image', 'create images': 'create image', video: 'create video', music: 'create music', research: 'deep research' };
  const toolLabel = (e) => (e.innerText || e.getAttribute('aria-label') || '').trim().split('\n')[0].trim();
  const overlayTools = () => $$('.cdk-overlay-container [role="menuitemcheckbox"], .cdk-overlay-container [role="menuitemradio"], .cdk-overlay-container [role="menuitem"], toolbox-drawer button, toolbox-drawer-item button')
    .filter(visible).filter((e) => !/^(upload files|add from drive|more tools)$/i.test(toolLabel(e)));

  async function openToolsMenu() {
    const btn = pick(SEL.toolsButton);
    if (!btn.el) throw new Error('tools_button_not_found');
    if (!$$('.cdk-overlay-container [role="menuitemcheckbox"]').filter(visible).length) {
      await openMenu(btn.el, ['.cdk-overlay-container [role="menuitemcheckbox"]', '.cdk-overlay-container [role="menuitem"]'], { timeout: 6000 });
    }
    return btn.el;
  }
  async function openMoreTools() {
    const more = $$('[data-test-id="more-tools-button"], .cdk-overlay-container button').filter(visible).find((e) => /more tools/i.test(toolLabel(e)));
    if (!more) return false;
    const before = overlayTools().length;
    clickEl(more);
    await waitFor(() => (overlayTools().length > before ? true : null), { timeout: 5000, interval: 60, label: 'more_tools' }).catch(() => null);
    return true;
  }

  H['gemini.tool_options'] = async () => {
    await openToolsMenu();
    const drawer = overlayTools().map((e) => ({ name: toolLabel(e), checked: e.getAttribute('aria-checked') === 'true' }));
    const hadMore = await openMoreTools();
    const all = overlayTools().map((e) => ({ name: toolLabel(e), checked: e.getAttribute('aria-checked') === 'true' }));
    const more = all.filter((x) => !drawer.some((d) => d.name === x.name));
    await closeMenu();
    await closeMenu();
    return { tools: drawer, more_tools: hadMore ? more : [], upload: ['Upload files', 'Add from Drive'], file_inputs: $$('input[type="file"]').length };
  };

  H['gemini.toggle_tool'] = async (p = {}) => {
    if (!p.tool) throw new Error('tool_required — e.g. "Create image", "Create video", "Create music", "Deep Research", "Canvas"');
    let want = String(p.tool).toLowerCase().trim();
    want = TOOL_ALIASES[want] ?? want;
    const enable = p.enable !== false;
    const find = () => overlayTools().find((e) => toolLabel(e).toLowerCase() === want)
      ?? overlayTools().find((e) => toolLabel(e).toLowerCase().includes(want));
    await openToolsMenu();
    let target = find();
    if (!target && await openMoreTools()) target = find();
    if (!target) {
      const offered = [...new Set(overlayTools().map(toolLabel))].filter(Boolean);
      await closeMenu(); await closeMenu();
      throw new Error(`tool_not_found: "${p.tool}". Offered: ${offered.join(' | ') || '(menu empty — the tab was not visible)'}`);
    }
    const name = toolLabel(target);
    const chipOn = () => activeTools().some((t) => chipMatches(name, t));
    if (chipOn() === enable) {
      await closeMenu(); await closeMenu();
      return { ok: true, tool: name, enabled: enable, already: true };
    }
    clickEl(target);
    // The composer chip ("Deselect <tool>") is the app's own record of what is on.
    const stuck = await waitFor(() => (chipOn() === enable ? true : null), { timeout: 6000, interval: 60, label: 'tool_state' }).catch(() => false);
    await closeMenu();
    return { ok: !!stuck, tool: name, enabled: enable, active_tools: activeTools(), ...(stuck ? {} : { warning: 'clicked, but the composer shows no matching tool chip' }) };
  };

  /*
   * Chips use short names: "Create image" -> "Images", "Guided learning" -> "Learn" (observed
   * 2026-09-30). Only one tool is active at a time; switching one on replaces the other.
   */
  function chipMatches(toolName, chip) {
    const n = (s) => String(s).toLowerCase().replace(/^create\s+/, '').replace(/s$/, '').trim();
    const a = n(toolName);
    const b = n(chip);
    return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  }

  /** Tools switched on for the next prompt, read off the composer's "Deselect <tool>" chips. */
  function activeTools() {
    return $$('input-area-v2 button[aria-label^="Deselect "], .input-area button[aria-label^="Deselect "]')
      .filter(visible).map((b) => b.getAttribute('aria-label').replace(/^Deselect\s+/, '').trim());
  }
  async function clearTools() {
    for (const b of $$('input-area-v2 button[aria-label^="Deselect "], .input-area button[aria-label^="Deselect "]').filter(visible)) {
      clickEl(b);
      await sleep(250);
    }
    return activeTools().length === 0;
  }

  H['gemini.tool_options_legacy'] = async () => {
    // The drawer is often already on the page, with no menu to open at all — report what is
    // there before touching anything, so a present toolbar is never mistaken for an absent one.
    const drawerBefore = $$('toolbox-drawer button, toolbox-drawer-item button, .toolbox-drawer-button').filter(visible).map(describe);
    const btn = pick(SEL.toolsButton);
    if (!btn.el) return { menu_items: [], drawer_buttons: drawerBefore, note: 'no upload/tools button found; the drawer buttons above are the whole surface' };

    const menu = await openMenu(btn.el, [...SEL.menuItem, '.cdk-overlay-container button'], { timeout: 6000 });
    const items = menu.els.map(describe);
    const drawerAfter = $$('toolbox-drawer button, toolbox-drawer-item button, .toolbox-drawer-button').filter(visible).map(describe);
    await closeMenu();
    return {
      button: describe(btn.el),
      matched_selector: menu.selector,
      menu_items: items,
      drawer_buttons: drawerAfter.length ? drawerAfter : drawerBefore,
      file_inputs: $$('input[type="file"]').length,
    };
  };

  H['gemini.toggle_tool_legacy'] = async (p = {}) => {
    if (!p.tool) throw new Error('tool_required — e.g. "Deep Research", "Canvas", "Video", "Create images", "Guided Learning"');
    const want = String(p.tool).toLowerCase();
    const inline = $$('toolbox-drawer button, toolbox-drawer-item button, .toolbox-drawer-button').filter(visible)
      .find((e) => (e.innerText || e.getAttribute('aria-label') || '').toLowerCase().includes(want));
    if (inline) { clickEl(inline); await sleep(400); return { ok: true, via: 'drawer', button: describe(inline) }; }

    const btn = pick(SEL.toolsButton);
    if (!btn.el) throw new Error('tools_button_not_found');
    const menu = await openMenu(btn.el, [...SEL.menuItem, '.cdk-overlay-container button'], { timeout: 6000 });
    const target = menu.els.find((e) => (e.innerText || '').toLowerCase().includes(want));
    if (!target) {
      await closeMenu();
      throw new Error(`tool_not_found: "${p.tool}". Menu offers: ${menu.els.map((e) => (e.innerText || '').trim().split('\n')[0]).filter(Boolean).join(' | ') || '(menu did not open)'}`);
    }
    clickEl(target);
    await sleep(600);
    return { ok: true, via: 'menu', selected: describe(target) };
  };

  H['gemini.gems'] = async (p = {}) => {
    await ensureSidebar();
    const items = pick(SEL.gemItem, { all: true, requireVisible: false }).els;
    if (p.select) {
      const want = String(p.select).toLowerCase();
      const target = items.find((e) => (e.innerText || '').toLowerCase().includes(want));
      if (!target) throw new Error(`gem_not_found: "${p.select}". Available: ${items.map((e) => (e.innerText || '').trim().split('\n')[0]).join(' | ')}`);
      clickEl(target);
      await sleep(900);
      return { ok: true, selected: (target.innerText || '').trim().split('\n')[0], conversation_id: conversationId() };
    }
    return { total: items.length, gems: items.map((e, i) => ({ index: i, name: (e.innerText || '').trim().split('\n')[0], selected: e.classList.contains('selected') })) };
  };

  /* ------------------------------ attachments ---------------------------- */

  /** Cheap net-record baseline for `gemini.wait_attach_settle`, with no DOM side effects — used ahead of `ext.set_file_input`, which does its own atomic reveal. */
  H['gemini.net_snapshot'] = () => ({ since_id: A.net.records.length ? A.net.records[A.net.records.length - 1].id : null });

  /*
   * Recent builds (observed from boq_assistant-bard-web-server_20260821.03_p0) accept a
   * synthetic `input.files` + `change` dispatch without error, but the app's own handler
   * never fires from it — no upload request, no chip. Same isTrusted hazard as the Enter-key
   * case in `gemini.ask`. `gemini_attach` drives the file through `ext.set_file_input`
   * (chrome.debugger's DOM.setFileInputFiles, a genuinely trusted input, with its own atomic
   * reveal-then-inject sequence — the two steps can't be split across a round trip, since
   * Angular tears the input back down within a second or two of it mounting). This handler
   * is kept for `gemini.attach`, the legacy DataTransfer fallback, and for diagnostics.
   *
   * Revealing it is two clicks deep, not one. `input[type="file"]` does not exist in the DOM
   * at all until "Upload & tools" is opened AND its "Upload files" item is clicked — the
   * earlier version of this code only did the first click, which opens the menu but leaves
   * the input unmounted, so every attach failed with file_input_not_found regardless of what
   * else was true. Separately, the menu's own items depend on this component tree having
   * been through Angular's initial bootstrap while the tab was genuinely OS-visible; a tab
   * that has only ever loaded hidden opens `.cdk-overlay-container` with nothing in it no
   * matter how long you wait or how many times you click — the caller is expected to force
   * real visibility (see server-side `winfocus`) before a first attach on a freshly loaded
   * page, and to reload the tab under that visibility if the menu still comes up empty.
   */
  H['gemini.ensure_file_input'] = async () => {
    let input = pick(SEL.fileInput, { requireVisible: false }).el;
    if (!input) {
      const tools = pick(SEL.toolsButton);
      if (!tools.el) throw new Error('tools_button_not_found');
      const menu = await openMenu(tools.el, [...SEL.menuItem, '.cdk-overlay-container button'], { timeout: 6000 });
      const uploadItem = menu.els.find((e) => e.getAttribute('data-test-id') === 'local-images-files-uploader-button')
        ?? menu.els.find((e) => /upload files/i.test((e.innerText || e.getAttribute('aria-label') || '')));
      if (!uploadItem) {
        await closeMenu();
        const offered = menu.els.map((e) => (e.innerText || '').trim().split('\n')[0]).filter(Boolean).join(' | ');
        throw new Error(
          `upload_menu_item_not_found — menu offered: ${offered || '(empty — the tab likely bootstrapped hidden; force real OS focus and reload it)'}`
        );
      }
      clickEl(uploadItem);
      input = await waitFor(() => pick(SEL.fileInput, { requireVisible: false }).el,
        { timeout: 4000, interval: 150, label: 'file_input_mount' }).catch(() => null);
      pressKey(document.body, 'Escape');
    }
    if (!input) throw new Error('file_input_not_found');
    return { ok: true, since_id: A.net.records.length ? A.net.records[A.net.records.length - 1].id : null };
  };

  H['gemini.wait_attach_settle'] = async (p = {}) => {
    const sinceId = p.since_id ?? null;

    /*
     * Same hazard as ChatGPT: the preview tile renders on selection, before any bytes have
     * moved. Gemini pushes uploads through Google's resumable-upload endpoints, so an
     * in-flight request there means not done — and the send button stays unavailable until
     * it is, which is the corroborating UI signal.
     */
    const started = Date.now();
    const uploadRecs = () => A.net.match({ url: 'upload|/_/BardChatUi/data/(?:batch)?upload|push\\.clients6', ...(sinceId ? { since_id: sinceId } : {}) });
    const chip = () => $$('uploader-file-preview, [data-test-id="file-preview"], .file-preview, [aria-label*="Remove file"]').filter(visible);

    const kicked = await waitFor(() => (uploadRecs().length ? true : null),
      { timeout: 20000, interval: 100, label: 'upload_start' }).catch(() => false);

    const settled = await waitFor(() => {
      if (uploadRecs().some((r) => !r.done)) return null;
      if (!chip().length) return null;
      return true;
    }, { timeout: (p.timeout_ms ?? 180000) - (Date.now() - started), interval: 120, label: 'upload_settle' }).catch(() => false);

    const recs = uploadRecs();
    const failed = recs.filter((r) => r.status != null && r.status >= 400);
    return {
      ok: !!settled && !failed.length,
      confirmed_by: kicked ? 'network:requests_settled' : 'ui_only',
      attachments: chip().map(describe),
      upload_requests: recs.map((r) => ({ id: r.id, url: r.url.slice(0, 160), method: r.method, status: r.status, done: r.done })),
      ...(failed.length ? { failed_requests: failed.map((r) => ({ url: r.url.slice(0, 160), status: r.status })) } : {}),
      elapsed_ms: Date.now() - started,
    };
  };

  /** Legacy path: synthetic DataTransfer + change. Kept as a fallback for builds/sites where the trusted-input route is unavailable (e.g. debugger permission denied). */
  H['gemini.attach'] = async (p = {}) => {
    if (!p.base64 && !p.text) throw new Error('base64_or_text_required');
    const name = String(p.filename || (p.text ? 'note.txt' : 'upload.bin'));
    const mime = String(p.mimetype || (p.text ? 'text/plain' : 'application/octet-stream'));
    let file;
    if (p.text != null) file = new File([new Blob([String(p.text)], { type: mime })], name, { type: mime });
    else {
      const bin = atob(String(p.base64));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      file = new File([bytes], name, { type: mime });
    }

    const ensured = await H['gemini.ensure_file_input']();
    const input = pick(SEL.fileInput, { requireVisible: false }).el;
    if (!input) throw new Error('file_input_not_found');

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    if (p.wait === false) return { ok: true, filename: name, bytes: file.size, waited: false };

    const settle = await H['gemini.wait_attach_settle']({ since_id: ensured.since_id, timeout_ms: p.timeout_ms });
    return { ...settle, filename: name, bytes: file.size };
  };

  /* --------------------------- share & feedback -------------------------- */

  H['gemini.share'] = async (p = {}) => {
    const btn = pick(SEL.shareButton);
    if (!btn.el) throw new Error('share_button_not_found');
    clickEl(btn.el);
    await sleep(600);
    const items = pick(SEL.menuItem, { all: true }).els;
    if (!p.action) return { menu: items.map(describe) };
    const target = items.find((e) => (e.innerText || '').toLowerCase().includes(String(p.action).toLowerCase()));
    if (!target) {
      pressKey(document.body, 'Escape');
      throw new Error(`share_action_not_found: ${p.action}. Menu offers: ${items.map((e) => (e.innerText || '').trim()).join(' | ')}`);
    }
    clickEl(target);
    await sleep(1200);
    const link = $$('input[readonly], .share-link, [data-test-id="share-link"]').map((e) => e.value || e.innerText).filter(Boolean)[0] ?? null;
    return { ok: true, action: p.action, link };
  };

  H['gemini.feedback'] = async (p = {}) => {
    const turn = lastModelTurn();
    if (!turn) throw new Error('no_model_response');
    const f = pick(p.rating === 'down' ? SEL.thumbsDown : SEL.thumbsUp, { root: turn, requireVisible: false });
    if (!f.el) throw new Error('feedback_button_not_found');
    clickEl(f.el);
    await sleep(400);
    return { ok: true, rating: p.rating === 'down' ? 'down' : 'up' };
  };

  /* --------------------------- escape hatches ---------------------------- */

  /* ------------------------- StreamGenerate (API send) ------------------- */

  /**
   * Frames out of a StreamGenerate response.
   *
   * The documented shape is `<len>\n<json>` repeated, but sources disagree on whether the
   * length counts the newline, and being off by one silently yields zero frames. So the
   * length is treated as a hint and the payload is confirmed by balanced-bracket scanning —
   * which is also what recovers a truncated final frame while a response is still streaming.
   */
  function splitFrames(text) {
    let s = String(text || '').replace(/^\)\]\}'\n?/, '');
    const frames = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && s[i] !== '[' && s[i] !== '{') i++;   // skip the length line
      if (i >= s.length) break;
      const open = s[i];
      const close = open === '[' ? ']' : '}';
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = i; j < s.length; j++) {
        const ch = s[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end < 0) break;                                          // still streaming
      try { frames.push(JSON.parse(s.slice(i, end + 1))); } catch {}
      i = end + 1;
    }
    return frames;
  }

  /**
   * Pull the answer and the continuation ids out of a StreamGenerate body.
   *
   * The candidate text arrives as **cumulative snapshots, not deltas** — concatenating them
   * produces the answer repeated with growing prefixes, which reads as a plausible (and
   * completely wrong) reply. The longest snapshot is the answer.
   */
  function parseGenerate(text) {
    let answer = '', cid = null, rid = null, rcid = null, error = null, model = null;
    for (const frame of splitFrames(text)) {
      if (!Array.isArray(frame)) continue;
      for (const row of frame) {
        if (!Array.isArray(row) || row[0] !== 'wrb.fr') continue;
        try { error ??= row[5]?.[2]?.[0]?.[1]?.[0] ?? null; } catch {}
        let body;
        try { body = typeof row[2] === 'string' ? JSON.parse(row[2]) : row[2]; } catch { continue; }
        if (!body) continue;
        if (Array.isArray(body[1])) { cid = body[1][0] ?? cid; rid = body[1][1] ?? rid; }
        if (typeof body[42] === 'string') model = body[42];
        const cands = body[4];
        if (Array.isArray(cands)) {
          for (const c of cands) {
            if (!Array.isArray(c)) continue;
            rcid = c[0] ?? rcid;
            const t = c[1]?.[0];
            if (typeof t === 'string' && t.length > answer.length) answer = t;
          }
        }
      }
    }
    // The markdown source carries Gemini's citation markers ("[cite: 1]", "[cite_start]"); the
    // rendered page turns them into chips. Neither belongs in an answer (a transcript came back
    // "…at 4:30.[cite: 2]").
    const clean = answer ? answer.replace(/\[cite_start\]/g, '').replace(/\s?\[cite:\s*[\d,\s]+\]/g, '').replace(/[ \t]{2,}/g, ' ') : answer;
    return { text: clean, conversation_id: cid, response_id: rid, candidate_id: rcid, model, error };
  }

  /*
   * The template outlives navigation.
   *
   * A page load clears the capture buffer, and the zero state — the one place the UI cannot
   * send from, and therefore the place the API path matters most — is only ever reached BY
   * navigating. Without this, the template was guaranteed to be missing exactly when it was
   * needed. sessionStorage is the right scope: same origin, same tab, gone when the tab is.
   */
  // v2 (2026-10-01): earlier stores may hold templates captured inside Temporary chats.
  const TPL_KEY = '__aimcp_streamgenerate_template_v2';
  const TPL_BY_MODE_KEY = '__aimcp_streamgenerate_by_mode_v2';
  const MODE_HEADER = 'x-goog-ext-525001261-jspb';

  /** Files waiting in the composer (not the ones already sent in earlier turns). */
  function attachmentChips() {
    return $$('uploader-file-preview, [data-test-id="file-preview"], .file-preview, [aria-label*="Remove file"]')
      .filter(visible).filter((e) => !e.closest('user-query, model-response'));
  }

  const headerOf = (headers, name) => {
    const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === name);
    return k ? { key: k, value: headers[k] } : null;
  };
  /** "<model id>|<thinking level>" from a StreamGenerate request's mode header. */
  function modeKeyOfHeaders(headers) {
    const h = headerOf(headers, MODE_HEADER);
    if (!h) return null;
    try { const a = JSON.parse(h.value); return `${a[4] ?? ''}|${a[15] ?? ''}`; } catch { return null; }
  }
  const modeKeyOf = (mode) => (mode?.id ? `${mode.id}|${mode.thinking ? 2 : 1}` : null);

  function templatesByMode() { try { return JSON.parse(sessionStorage.getItem(TPL_BY_MODE_KEY) || '{}'); } catch { return {}; } }

  function latestStreamGenerate() {
    const r = A.net.match({ url: 'StreamGenerate', method: 'POST' });
    // A request made inside a Temporary chat is not a template: replayed, it could make an API
    // "new chat" temporary too. Its reply is recognisable — a temporary chat never gets a
    // conversation id (verified 2026-10-01) — so the newest request whose reply carried one wins.
    const isTempRecord = (rec) => rec?.done && rec.text && !/"c_[0-9a-f]{8,}"/.test(rec.text);
    let live = null;
    for (let i = r.length - 1; i >= 0; i--) { if (!isTempRecord(r[i]) && !(isTemporary() && i === r.length - 1)) { live = r[i]; break; } }
    if (live?.req_body) {
      const saved = { url: live.url, headers: live.req_headers, body: live.req_body, saved_at: Date.now() };
      try {
        sessionStorage.setItem(TPL_KEY, JSON.stringify(saved));
        const key = modeKeyOfHeaders(live.req_headers);
        if (key) sessionStorage.setItem(TPL_BY_MODE_KEY, JSON.stringify({ ...templatesByMode(), [key]: saved }));
      } catch {}
      return live;
    }
    try {
      const t = JSON.parse(sessionStorage.getItem(TPL_KEY) || 'null');
      if (t?.body) {
        return { id: 'session-template', url: t.url, req_headers: t.headers, req_body: t.body, template_age_ms: Date.now() - t.saved_at };
      }
    } catch {}
    return null;
  }

  /**
   * Send a prompt straight to StreamGenerate, reusing a captured request as the template.
   *
   * This exists because Gemini's *zero-state* composer cannot be driven at all: measured
   * against the live app, a synthetic Enter, a native .click() on the send button, a full
   * pointer sequence and a form submit all leave the prompt sitting in the box. Inside an
   * existing conversation the same synthetic Enter works fine — the zero state is gated on
   * genuine user activation, which page script cannot forge and which a background tab
   * cannot receive even through the debugger.
   *
   * A template is required rather than optional because `f.req[3]` carries a large opaque
   * anti-abuse token that is issued to the page and cannot be constructed. Everything else —
   * prompt, conversation ids, language — is rewritten.
   */
  H['gemini.send_api'] = async (p = {}) => {
    if (!p.prompt) throw new Error('prompt_required');

    /*
     * Send in the mode the picker shows. A template captured in that exact mode (model id +
     * thinking level) is used whole; otherwise the newest template gets its model id patched
     * and the result says so. The model id patch is safe — it is the documented selector —
     * but thinking also moves fields in the body, so a thinking mismatch is reported rather
     * than faked.
     */
    let mode = currentMode();
    if (!mode.id && pick(SEL.modelPicker).el) { await H['gemini.models']().catch(() => null); mode = currentMode(); }
    const wantKey = modeKeyOf(mode);
    const byMode = templatesByMode();
    let modeMatch = 'none';
    let src = null;
    if (p.request_id) src = A.net.records.find((r) => r.id === p.request_id);
    else if (wantKey && byMode[wantKey]?.body) {
      const t = byMode[wantKey];
      src = { id: 'mode-template', url: t.url, req_headers: t.headers, req_body: t.body, template_age_ms: Date.now() - t.saved_at };
      modeMatch = 'template';
    } else src = latestStreamGenerate();
    if (!src?.req_body) {
      return {
        ok: false,
        error: 'no_template_request',
        hint: 'Send one prompt through the UI from inside an existing conversation first (gemini_ask does this), ' +
          'then this can reuse that request from any state — including the zero state it cannot otherwise escape.',
      };
    }

    const params = new URLSearchParams(src.req_body);
    let outer, inner;
    try {
      outer = JSON.parse(params.get('f.req'));
      inner = JSON.parse(outer[1]);
    } catch (e) {
      throw new Error('template_unparseable: ' + e.message);
    }

    inner[0] = [String(p.prompt), 0, null, null, null, null, 0];
    // Slot 2 is the continuation triple. Empty strings start a new conversation; nulls do not.
    // Slot 71 carries the conversation AGAIN on the 2026-09 build (["c_<id>", …, token]); a
    // genuine new-chat send has it null (captured 2026-09-30). Left as the template's, it
    // continued the template's conversation, so every "new chat" landed in an old thread.
    if (p.new_chat) {
      inner[2] = ['', '', '', null, null, null, null, null, null, ''];
      if (inner.length > 71) inner[71] = null;
    } else if (p.conversation_id) {
      const cid = String(p.conversation_id).replace(/^c_/, '');
      inner[2] = [cid, String(p.response_id ?? ''), String(p.candidate_id ?? ''), null, null, null, null, null, null, ''];
      if (Array.isArray(inner[71])) inner[71] = ['c_' + cid, null, null, null, null, null, null, ''];
    }
    if (p.inner_patch && typeof p.inner_patch === 'object') {
      for (const [k, v] of Object.entries(p.inner_patch)) inner[Number(k)] = v;
    }
    outer[1] = JSON.stringify(inner);

    const u = new URL(src.url, location.href);
    u.searchParams.set('_reqid', String(Math.floor(Math.random() * 900000) + 100000));

    const FORBIDDEN = new Set(['host', 'content-length', 'connection', 'cookie', 'origin', 'referer', 'user-agent', 'accept-encoding']);
    const headers = {};
    for (const [k, v] of Object.entries(src.req_headers || {})) {
      if (!FORBIDDEN.has(String(k).toLowerCase())) headers[k] = v;
    }
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=utf-8';
    let thinkingApplied = null;
    if (modeMatch !== 'template' && mode.id) {
      const h = headerOf(headers, MODE_HEADER);
      if (h) {
        try {
          const arr = JSON.parse(h.value);
          const tplThinking = arr[15] === 2;
          thinkingApplied = tplThinking === mode.thinking;
          if (!thinkingApplied && !p.allow_mode_mismatch) {
            // Thinking also changes body fields; a guessed patch hung the server once. Decline
            // and let the caller take the UI route, which sends in exactly the mode shown.
            return { ok: false, error: 'no_template_for_mode', mode: { model: mode.model, thinking: mode.thinking, template_thinking: tplThinking } };
          }
          if (arr[4] !== mode.id) { arr[4] = mode.id; modeMatch = 'patched_model_id'; } else modeMatch = 'template_same_model';
          headers[h.key] = JSON.stringify(arr);
        } catch {}
      }
    }
    if (p.headers) Object.assign(headers, p.headers);

    const started = Date.now();
    /*
     * Bounded. A request the server does not like can be held open with nothing streamed —
     * observed 2026-09-30 with a model id patched onto a thinking-mode template: gemini_ask sat
     * for its whole 4-minute budget. An abort turns that into an error the caller can route
     * around (the UI path) instead of a silent stall.
     */
    const ctl = new AbortController();
    const limit = Number(p.timeout_ms ?? 150000);
    const firstByte = Number(p.first_byte_ms ?? 45000);
    const timer = setTimeout(() => ctl.abort(), limit);
    const fbTimer = setTimeout(() => ctl.abort(), firstByte);
    let res;
    let text = '';
    try {
      res = await A.net.origFetch(u.toString(), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: new URLSearchParams({ 'f.req': JSON.stringify(outer), at: params.get('at') ?? '' }).toString(),
        signal: ctl.signal,
      });
      clearTimeout(fbTimer);
      text = await res.text();
    } catch (e) {
      clearTimeout(timer); clearTimeout(fbTimer);
      return { ok: false, error: ctl.signal.aborted ? `api_send_timeout after ${Date.now() - started}ms` : `api_send_failed: ${e?.message || e}`, mode: { model: mode.model, thinking: mode.thinking, match: modeMatch } };
    }
    clearTimeout(timer);
    const parsed = parseGenerate(text);

    const out = {
      ok: res.ok && !parsed.error && !!parsed.text,
      status: res.status,
      /*
       * The API path returns only once the full response has been read, so it is settled by
       * construction. Reported explicitly so `settled` means the same thing on both paths —
       * a caller should not have to know which one ran.
       */
      settled: res.ok && !parsed.error && !!parsed.text,
      still_streaming: false,
      template_id: src.id,
      mode: { model: mode.model, thinking: mode.thinking, id: mode.id, match: modeMatch, ...(thinkingApplied === false ? { thinking_not_applied: true } : {}) },
      elapsed_ms: Date.now() - started,
      ...parsed,
      ...(p.raw ? { raw: text.slice(0, 60000) } : {}),
      ...(!parsed.text && res.ok ? { note: 'no candidate text — the field layout may have moved; re-run with raw:true' } : {}),
    };

    /*
     * Remember what this path produced.
     *
     * An API send never renders into the tab, so after one the DOM holds no answer and
     * gemini.last_reply would report "nothing here" immediately after gemini.ask returned a
     * perfectly good one. Two tools over the same conversation disagreeing is worse than
     * either being empty, so the answer is cached and last_reply falls back to it.
     */
    if (out.ok) {
      window.__AIMCP_GEMINI_LAST__ = {
        text: parsed.text,
        markdown: parsed.text,
        conversation_id: parsed.conversation_id ?? null,
        response_id: parsed.response_id ?? null,
        candidate_id: parsed.candidate_id ?? null,
        model: parsed.model ?? null,
        at: Date.now(),
      };
    }
    return out;
  };

  H['gemini.rpc'] = async (p = {}) => {
    if (!p.rpcid) {
      return {
        error: 'rpcid_required',
        hint: 'Perform the action once in the UI, then call ai_net_list with url:"batchexecute" to see which rpcid it used and what payload it sent.',
        captured: [...new Set(A.net.match({ url: 'batchexecute' }).map((r) => { try { return new URL(r.url, location.href).searchParams.get('rpcids'); } catch { return null; } }).filter(Boolean))],
      };
    }
    return await batchExecute(String(p.rpcid), p.payload ?? [], { raw: !!p.raw, index: p.index });
  };

  H['gemini.tokens'] = async () => {
    const tok = wizTokens();
    return { ...tok, at: tok.at ? tok.at.slice(0, 8) + '…(' + tok.at.length + ' chars)' : null, at_present: !!tok.at };
  };

  // ---------------------------------------------------------------- selftest

  async function selftest() {
    const out = [];
    const t = (name, cond, detail) => out.push({ name, pass: !!cond, ...(detail !== undefined && !cond ? { detail } : {}) });

    t('gemini_module_registered', A.site?.id === 'gemini');
    t('gemini_handlers_present', ['gemini.ask', 'gemini.messages', 'gemini.conversations', 'gemini.rpc'].every((k) => typeof H[k] === 'function'));
    t('gemini_selectors_are_lists', Object.values(SEL).every((v) => Array.isArray(v) && v.length > 0));
    t('composer_selector_matches_live_build', SEL.composer.includes('rich-textarea .ql-editor[contenteditable="true"]'));
    t('send_selector_matches_live_build', SEL.send.includes('button[aria-label="Send message"]'));

    // batchexecute envelope parsing — the piece that would silently return nothing.
    const inner = JSON.stringify([['hello', 42]]);
    const row = JSON.stringify([['wrb.fr', 'abcDEF', inner]]);
    const wire = ")]}'\n" + row.length + '\n' + row;
    const parsed = parseBatchExecute(wire);
    t('batchexecute_extracts_rpcid', 'abcDEF' in parsed.results, parsed);
    t('batchexecute_parses_inner_json', parsed.results.abcDEF?.[0]?.[0] === 'hello', parsed);
    t('batchexecute_counts_rows', parsed.rows === 1, parsed);

    const multi = (() => {
      const a = JSON.stringify([['wrb.fr', 'one', '[1]']]);
      const b = JSON.stringify([['wrb.fr', 'two', '[2]']]);
      return ")]}'\n" + a.length + '\n' + a + b.length + '\n' + b;
    })();
    const both = parseBatchExecute(multi);
    t('batchexecute_reads_multiple_frames', both.results.one?.[0] === 1 && both.results.two?.[0] === 2, both);
    t('batchexecute_ignores_non_wrb_rows', parseBatchExecute(")]}'\n" + JSON.stringify([['di', 12]]).length + '\n' + JSON.stringify([['di', 12]])).rows === 0);
    t('batchexecute_on_garbage_is_empty', parseBatchExecute('nonsense').rows === 0);

    // markdown reconstruction — the thing standing between an agent and unusable code.
    // Built node by node: this page enforces Trusted Types, which rejects innerHTML *and*
    // DOMParser.parseFromString, so createElement is the only sink available here.
    const host = el('div', { style: 'position:fixed;left:-10000px;top:0' },
      el('h2', {}, 'Title'),
      el('p', {}, 'Some ', el('strong', {}, 'bold'), ' and ', el('em', {}, 'italic'), ' and ', el('code', {}, 'inline'), '.'),
      el('pre', {}, el('code', { class: 'language-python' }, 'print("hi")')),
      el('ul', {}, el('li', {}, 'one'), el('li', {}, 'two')),
      el('ol', {}, el('li', {}, 'first'), el('li', {}, 'second')),
      el('p', {}, el('a', { href: 'https://example.com' }, 'link')),
      el('table', {},
        el('tr', {}, el('th', {}, 'A'), el('th', {}, 'B')),
        el('tr', {}, el('td', {}, '1'), el('td', {}, '2'))),
      el('blockquote', {}, 'quoted'),
    );
    document.body.appendChild(host);
    try {
      const md = mdFromHtml(host);
      t('md_heading', md.includes('## Title'), md);
      t('md_bold', md.includes('**bold**'), md);
      t('md_italic', md.includes('*italic*'), md);
      t('md_inline_code', md.includes('`inline`'), md);
      t('md_fenced_code_with_language', md.includes('```python\nprint("hi")\n```'), md);
      t('md_unordered_list', md.includes('- one') && md.includes('- two'), md);
      t('md_ordered_list', md.includes('1. first') && md.includes('2. second'), md);
      t('md_link', md.includes('[link](https://example.com)'), md);
      t('md_table_header_rule', md.includes('| A | B |') && md.includes('| --- | --- |'), md);
      t('md_table_body', md.includes('| 1 | 2 |'), md);
      t('md_blockquote', md.includes('> quoted'), md);
      t('md_drops_nothing_important', !md.includes('undefined'), md);

      t('tool_chip_short_names', chipMatches('Create image', 'Images') && chipMatches('Guided learning', 'Learn') && chipMatches('Canvas', 'Canvas') && chipMatches('Create video', 'Videos') && !chipMatches('Canvas', 'Images'));

      // Inline citation chips are UI: a transcript must not end in "^ WAV".
      const citeHost = el('div', {}, el('p', {}, 'at 4:30.',
        el('sup', {}, el('sources-carousel-inline', {}, el('source-inline-chip', {}, el('span', { class: 'source-title' }, 'WAV'))))));
      const citeMd = mdFromHtml(citeHost);
      t('md_drops_inline_citation_chip', citeMd.trim() === 'at 4:30.', citeMd);
      t('md_keeps_plain_superscript', mdFromHtml(el('p', {}, 'x', el('sup', {}, '2'))).includes('x^2'));

      // A code block must not absorb the chrome Gemini renders around it.
      const codeHost = el('div', {},
        el('pre', {},
          el('div', { class: 'header' }, 'python', el('button', {}, 'Copy')),
          el('code', { class: 'language-python' }, 'x = 1')));
      const codeMd = mdFromHtml(codeHost);
      t('md_code_excludes_copy_button', codeMd.includes('x = 1') && !codeMd.includes('Copy'), codeMd);
    } finally {
      host.remove();
    }

    t('conversation_id_parses_app_path', /\/app\/([a-z0-9]{6,})/i.exec('/app/c4b1f2e9aa77')?.[1] === 'c4b1f2e9aa77');

    // hl reaches the server as a language, never as whatever an obfuscated WIZ key happens
    // to hold — a wrong value is accepted and answered in the wrong language.
    const tok = wizTokens();
    t('hl_is_a_language_tag', LANG.test(tok.hl), tok.hl);
    t('language_regex_rejects_a_path', !LANG.test('/_/BardChatUi'));
    t('language_regex_accepts_region_tags', LANG.test('en-US') && LANG.test('pt-BR') && LANG.test('en'));
    t('bl_looks_like_a_build_label', tok.bl == null || /boq_/.test(tok.bl), tok.bl);

    // The signed-in claim and the token must agree, in both directions. A false "signed in"
    // sends prompts that quietly go nowhere.
    t('signed_in_agrees_with_the_token', signedOut() === !tok.at, { signed_out: signedOut(), has_token: !!tok.at });
    t('signed_in_is_not_read_from_a_button_alone', SEL.signIn.length > 0 && typeof signedOut() === 'boolean');
    const r = ready();
    t('ready_reports_a_known_state', ['app', 'app_signed_out', 'loading', 'loading_hidden', 'no_composer'].includes(r.state), r);

    return out;
  }

  // ------------------------------------------------------------------ export

  A.site = {
    id: 'gemini',
    version: SITE_VERSION,
    selectors: SEL,
    ready,
    selftest,
    status: async () => ({
      conversation_id: conversationId(),
      streaming: isStreaming(),
      turns: modelTurns().length,
      signed_in: !signedOut(),
    }),
  };

  A.log(`gemini module v${SITE_VERSION} installed`);
})();
