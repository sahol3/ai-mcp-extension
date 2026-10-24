/*
 * ai-mcp — ChatGPT site module (MAIN world, chatgpt.com / chat.openai.com)
 *
 * Two ways in, used together rather than as alternatives:
 *
 *   The DOM drives everything a person can click. This is the only path that survives
 *   the sentinel proof-of-work OpenAI puts in front of /backend-api/conversation — an
 *   external client cannot mint the token, and neither can we, but the page already did.
 *
 *   The captured network stream supplies the *answer*. Reading the reply out of the
 *   rendered DOM means reading markdown that has already been converted to HTML and
 *   converting it back, which loses code fences, tables and math. The SSE frames carry
 *   the original markdown, so when the stream is available it wins, and the DOM text is
 *   returned alongside as a cross-check.
 *
 * Everything read-only (conversation lists, models, memories, GPTs) goes through
 * /backend-api directly, reusing the bearer token from a request the page already made.
 */
(() => {
  'use strict';

  const A = window.__AIMCP__;
  if (!A) { console.error('[ai-mcp] core missing — chatgpt module cannot load'); return; }
  const { $, $$, pick, describe, visible, clickEl, typeInto, pressKey, sleep, waitFor, waitStable, findByText, openMenu, closeMenu } = A.util;
  const H = A.H;
  const SITE_VERSION = 2;

  // -------------------------------------------------------------- selectors

  /*
   * Ordered by specificity. `pick` walks the list and reports which entry matched, so when
   * OpenAI renames a testid the diagnosis is one `chatgpt_probe` call rather than a
   * debugging session. Never collapse these to a single selector.
   */
  const SEL = {
    composer: [
      '#prompt-textarea',
      // Sep 2026 rebuild (StyleX classes): the composer is a plain textarea.
      'textarea#mobile-composer-prompt',
      'textarea[name="prompt"]',
      'textarea[aria-label*="Chat with ChatGPT"]',
      'div.ProseMirror[contenteditable="true"]',
      '[data-testid="composer-text-input"]',
      'textarea[name="prompt-textarea"]',
      'form [contenteditable="true"]',
    ],
    send: [
      '#composer-submit-button',
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'form button[type="submit"]',
    ],
    stop: [
      '[data-testid="stop-button"]',
      '#composer-submit-button[aria-label*="Stop"]',
      'button[aria-label*="Stop streaming"]',
      'button[aria-label*="Stop"]',
    ],
    // Oct 2026 rebuild: turns are `[data-talvt-turn-state]`, messages are search units keyed
    // "<turn>:<n>:<role>", and data-message-author-role is gone. Both generations are listed.
    turn: ['[data-testid^="conversation-turn-"]', 'article[data-testid^="conversation-turn"]', 'article[data-turn]', '[data-talvt-turn-state]'],
    assistantMessage: ['[data-message-author-role="assistant"]', '[data-chatgpt-search-unit-key$=":assistant"]'],
    userMessage: ['[data-message-author-role="user"]', '[data-chatgpt-search-unit-key$=":user"]'],
    markdown: ['.markdown', '[data-message-author-role="assistant"] .markdown', '[data-markdown-text-style="assistant-message"]'],
    thread: ['main [role="presentation"]', 'main .flex.flex-col.text-sm', 'main'],
    newChat: ['[data-testid="create-new-chat-button"]', 'a[href="/"][data-discover]', 'button[aria-label*="New chat"]', 'a[aria-label*="New chat"]'],
    sidebarLinks: ['nav a[href^="/c/"]', 'a[href^="/c/"]'],
    modelSwitcher: [
      '[data-testid="model-switcher-dropdown-button"]',
      'button[aria-label*="Model selector"]',
      'button[aria-label*="model"]',
      '#radix-\\:r1\\:',
    ],
    menuItem: ['[role="menuitem"]', '[role="option"]', '[data-testid^="model-switcher-"]'],
    regenerate: ['[data-testid="regenerate-thread-button"]', 'button[aria-label*="Regenerate"]', 'button[aria-label*="Try again"]'],
    copyButton: ['[data-testid="copy-turn-action-button"]', 'button[aria-label="Copy"]'],
    editButton: ['[data-testid="edit-turn-action-button"]', 'button[aria-label*="Edit message"]'],
    voiceButton: ['[data-testid="composer-speech-button"]'],
    fileInput: ['input[type="file"]'],
    attachButton: ['[data-testid="composer-plus-btn"]', 'button[aria-label*="Attach"]', 'button[aria-label*="Add photos"]'],
    composerTools: ['[data-testid^="composer-button-"]', '[data-testid="composer-plus-btn"]'],
    scrollToBottom: ['[data-testid="scroll-to-bottom-button"]', 'button[aria-label*="Scroll to bottom"]'],
    loginWall: ['[data-testid="login-button"]', 'a[href*="/auth/login"]', 'button[data-testid="signup-button"]'],
    canvas: ['#canvas-container', '[data-testid="canvas"]', 'section[aria-label*="Canvas"]'],
  };

  const origin = () => location.origin;

  // ------------------------------------------------------------------ auth

  /*
   * /backend-api needs a bearer token. /api/auth/session hands one out, but harvesting it
   * from a request the page already made is strictly better: it also carries the account
   * header that team and enterprise workspaces require, and it is guaranteed to be the
   * exact credential this session is using.
   */
  let cachedAuth = null;

  function harvestAuth() {
    const recs = A.net.match({ url: '/backend-api/' }).slice().reverse();
    for (const r of recs) {
      const h = {};
      for (const [k, v] of Object.entries(r.req_headers || {})) {
        const key = String(k).toLowerCase();
        if (key === 'authorization' && /^Bearer /i.test(String(v))) h.Authorization = v;
        if (key === 'chatgpt-account-id') h['ChatGPT-Account-Id'] = v;
        if (key === 'oai-device-id') h['OAI-Device-Id'] = v;
        if (key === 'oai-language') h['OAI-Language'] = v;
      }
      if (h.Authorization) return { ...h, source: 'captured:' + r.id };
    }
    return null;
  }

  async function authHeaders({ refresh = false } = {}) {
    if (!refresh && cachedAuth?.Authorization) return cachedAuth;
    const harvested = harvestAuth();
    if (harvested) { cachedAuth = harvested; return cachedAuth; }

    const res = await A.net.origFetch(origin() + '/api/auth/session', { credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!body?.accessToken) {
      throw new Error(
        'chatgpt_not_signed_in — /api/auth/session returned no accessToken. Sign in to ChatGPT ' +
        'in this browser, then retry.'
      );
    }
    cachedAuth = { Authorization: 'Bearer ' + body.accessToken, source: 'session-endpoint' };
    // Account header, when the workspace needs one.
    const acct = harvestAuth();
    if (acct?.['ChatGPT-Account-Id']) cachedAuth['ChatGPT-Account-Id'] = acct['ChatGPT-Account-Id'];
    return cachedAuth;
  }

  /** Authenticated call to ChatGPT's own backend, from inside the page. */
  async function api(path, { method = 'GET', json, headers = {}, raw = false, retryAuth = true } = {}) {
    const auth = await authHeaders();
    const { source, ...authH } = auth;
    const url = /^https?:/.test(path) ? path : origin() + path;
    const init = {
      method,
      credentials: 'include',
      headers: { Accept: '*/*', ...authH, ...headers, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    };
    const res = await A.net.origFetch(url, init);
    const text = await res.text();
    if (res.status === 401 && retryAuth) {
      /*
       * Mint a genuinely new token. Clearing the cache alone sent us back to harvestAuth(),
       * which reads the capture buffer — still full of requests carrying the token that just
       * expired — so the retry reused it and failed identically.
       */
      cachedAuth = null;
      const fresh = await A.net.origFetch(origin() + '/api/auth/session', { credentials: 'include' })
        .then((r) => r.json()).catch(() => null);
      if (fresh?.accessToken) {
        cachedAuth = { Authorization: 'Bearer ' + fresh.accessToken, source: 'session-endpoint(refreshed)' };
        const acct = harvestAuth();
        if (acct?.['ChatGPT-Account-Id']) cachedAuth['ChatGPT-Account-Id'] = acct['ChatGPT-Account-Id'];
      }
      return await api(path, { method, json, headers, raw, retryAuth: false });
    }
    if (!res.ok) {
      throw new Error(`chatgpt_api_${res.status} ${method} ${path}: ${text.slice(0, 400)}`);
    }
    if (raw) return { status: res.status, text };
    try { return JSON.parse(text); } catch { return { _text: text.slice(0, 20000) }; }
  }

  // ------------------------------------------------------------- readiness

  /*
   * The Sep 2026 rebuild shows a working composer to signed-out visitors, with plain "Log in" /
   * "Sign up for free" buttons and none of the old test ids — so "composer present" no longer
   * implies signed in, and the old check reported such a tab as no_composer.
   */
  function signedOutUi() {
    return !!pick(SEL.loginWall, { requireVisible: true }).el
      || $$('button,a').filter(visible).some((b) => /^(log in|sign up( for free)?)$/i.test((b.innerText || '').trim()));
  }
  function loggedOut() {
    if (/\/auth\/(login|signup)/.test(location.pathname)) return true;
    return signedOutUi();
  }

  function ready() {
    const composer = pick(SEL.composer, { requireVisible: false });
    if (loggedOut()) return { ready: false, state: 'signed_out', composer_selector: composer.selector, hint: 'Sign in to ChatGPT in this browser (the bridge needs the account for models, history and files).' };
    if (composer.el) return { ready: true, state: 'app', composer_selector: composer.selector, path: location.pathname };
    if (loggedOut()) return { ready: false, state: 'signed_out', hint: 'Sign in to ChatGPT in this browser tab.' };
    /*
     * OpenAI's edge serves a bare text error page under load ("upstream connect error …
     * reset reason: overflow"). Reporting that as "no composer" sends you looking for a
     * renamed selector; it is a server outage and the fix is to reload the tab.
     */
    const body = (document.body?.innerText || '').slice(0, 300);
    if (/upstream connect error|reset reason:|502 Bad Gateway|Service Unavailable|Please try again later/i.test(body)) {
      return { ready: false, state: 'upstream_error', detail: body.trim().slice(0, 160), hint: 'ChatGPT itself returned an error page. Reload the tab (ai_reload_tab) and retry.' };
    }
    if (document.visibilityState === 'hidden' && document.readyState !== 'complete') {
      return { ready: false, state: 'loading_hidden', hint: 'Tab is in the background and still loading; call ai_focus_tab once.' };
    }
    return { ready: false, state: document.readyState === 'complete' ? 'no_composer' : 'loading' };
  }

  // -------------------------------------------------------- stream decoding

  /**
   * Turn ChatGPT's SSE frames into the assistant's markdown.
   *
   * The wire format is a delta protocol: an `add` frame establishes a message shell, then
   * a long tail of `{p, o, v}` operations append string fragments into
   * `/message/content/parts/N`. Reasoning traces, tool calls and the visible answer all
   * share the same stream, so appends are only taken while the message currently being
   * built is the one with `content_type: "text"` addressed to `all` — otherwise a model
   * that thinks out loud returns its scratchpad as the answer.
   */
  function decodeStream(events) {
    let text = '';
    let active = false;
    let lastPath = '';
    const meta = {};

    const noteMeta = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.conversation_id) meta.conversation_id = o.conversation_id;
      if (o.message?.id) meta.message_id = o.message.id;
      if (o.message?.metadata?.model_slug) meta.model_slug = o.message.metadata.model_slug;
      if (o.message?.metadata?.finish_details?.type) meta.finish = o.message.metadata.finish_details.type;
      if (o.error) meta.error = typeof o.error === 'string' ? o.error : JSON.stringify(o.error).slice(0, 300);
    };

    /** Visible-answer text of a message, or null when this is not the visible answer. */
    const answerOf = (m) => {
      if (!m || m.author?.role !== 'assistant') return null;
      const ct = m.content?.content_type;
      if (ct && ct !== 'text' && ct !== 'multimodal_text') return null;
      if (m.recipient && m.recipient !== 'all') return null;
      return (m.content?.parts || []).filter((p) => typeof p === 'string').join('');
    };

    for (const ev of events) {
      const d = ev.data;
      if (!d || typeof d !== 'object') continue;
      noteMeta(d);
      noteMeta(d.v);

      const msg = d.message ?? (d.v && typeof d.v === 'object' && !Array.isArray(d.v) ? d.v.message : null);
      if (msg) {
        const answer = answerOf(msg);
        if (answer !== null) { text = answer; active = true; }
        else active = false;          // reasoning or a tool call has taken over the stream
        continue;
      }

      const applyOp = (op) => {
        if (!op || typeof op !== 'object') return;
        const p = op.p ?? lastPath;
        if (typeof op.v === 'string') {
          if (active && (p === '' || /\/parts\/\d+$/.test(p))) text += op.v;
          if (op.p != null) lastPath = op.p;
        } else if (op.p != null) {
          lastPath = op.p;
        }
      };

      if (Array.isArray(d.v)) d.v.forEach(applyOp);
      else applyOp(d);
    }
    return { text, ...meta };
  }

  /** Latest conversation POST, decoded. */
  function streamRecords(sinceId) {
    return A.net.match({ url: '/backend-(?:api|anon)/(?:f/)?conversation(?:$|\\?)', method: 'POST', ...(sinceId ? { since_id: sinceId } : {}) });
  }

  // ----------------------------------------------------------------- DOM reads

  function turnElements() {
    const found = pick(SEL.turn, { all: true, requireVisible: false });
    return found.els;
  }

  /*
   * Messages, across both markup generations. Up to Sep 2026 each message carried
   * data-message-author-role / data-message-id. The Oct 2026 rebuild dropped those: a message
   * is now the element with data-chatgpt-search-unit-key="<turn>:<n>:<role>", its ids sit in
   * data-chatgpt-search-message-ids, and the answer text lives in the markdown root
   * [data-markdown-text-style="assistant-message"]. Reading only the old attribute made every
   * thread look empty, and chatgpt_ask timed out on answers that had fully arrived.
   */
  const UNIT_KEY = 'data-chatgpt-search-unit-key';
  const roleOf = (el) => el.getAttribute('data-message-author-role')
    || (el.getAttribute(UNIT_KEY) || '').split(':').pop() || null;

  function messageElements() {
    const legacy = $$('[data-message-author-role]').filter((e) => e.isConnected);
    if (legacy.length) return legacy;
    return $$(`[${UNIT_KEY}]`).filter((e) => e.isConnected && /:(user|assistant|system|tool)$/.test(e.getAttribute(UNIT_KEY) || ''));
  }

  const roleEls = (role) => messageElements().filter((e) => roleOf(e) === role);

  const messageIdOf = (el) => el?.getAttribute('data-message-id')
    || (el?.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).filter(Boolean)[0]
    || el?.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id')
    || null;

  /** The message's own text, without the action buttons around it. */
  const textOf = (el) => {
    if (!el) return '';
    const body = el.querySelector('[data-markdown-text-style="assistant-message"], .markdown')
      || el.querySelector('[data-user-message-bubble] .whitespace-pre-wrap, [data-user-message-bubble]')
      || el;
    return (body.innerText || '').trim();
  };

  function shapeMessage(el, i) {
    const role = roleOf(el);
    const turn = el.closest('[data-testid^="conversation-turn-"], article, [data-talvt-turn-state]');
    return {
      index: i,
      role,
      message_id: messageIdOf(el),
      model: el.getAttribute('data-message-model-slug') || null,
      text: textOf(el),
      turn_testid: turn?.getAttribute('data-testid') || turn?.getAttribute('data-talvt-turn-state') || null,
      code_blocks: codeBlocksIn(el),
      images: $$('img', el).map((im) => ({ src: im.src, alt: im.alt || null })).filter((x) => !/^data:image\/svg/.test(x.src)),
      links: $$('a[href]', el).slice(0, 40).map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 120) })),
    };
  }

  const lastAssistantEl = () => { const m = roleEls('assistant'); return m[m.length - 1] ?? null; };
  const assistantCount = () => roleEls('assistant').length;
  const STREAMING_TURN = /stream|pend|progress|generat|running|thinking/i;
  const isStreaming = () => !!pick(SEL.stop, { requireVisible: true }).el
    || $$('[data-talvt-turn-state]').some((e) => STREAMING_TURN.test(e.getAttribute('data-talvt-turn-state') || ''));
  const conversationId = () => (location.pathname.match(/\/c\/([0-9a-f-]{36})/i) ?? [])[1] ?? null;

  // ------------------------------------------------------------- interaction

  async function setComposer(text) {
    const found = pick(SEL.composer);
    if (!found.el) throw new Error('composer_not_found — is a conversation open? Try chatgpt_new_chat first.');
    const r = await typeInto(found.el, text);
    if (!r.ok) throw new Error(`composer_write_failed (tried ${r.attempts.map((a) => a.strategy).join(', ')}) — got "${String(r.text).slice(0, 80)}"`);
    return { ...r, selector: found.selector };
  }

  async function clickSend() {
    // The send button only enables once the editor has told React it has content, so a
    // send fired the same tick as the keystroke hits a disabled button and does nothing.
    const btn = await waitFor(() => {
      const f = pick(SEL.send, { requireVisible: true });
      if (!f.el) return null;
      if (f.el.disabled || f.el.getAttribute('aria-disabled') === 'true') return null;
      return f;
    }, { timeout: 8000, interval: 120, label: 'send_button_enabled' }).catch(() => null);

    if (btn) { clickEl(btn.el); return { via: 'button', selector: btn.selector }; }

    // Fallback: Enter in the composer. Works, but is the path most likely to be swallowed
    // by an autocomplete popover, so it is second.
    const composer = pick(SEL.composer);
    if (!composer.el) throw new Error('cannot_send — neither the send button nor the composer is present');
    const had = A.util.editorText(composer.el).trim();
    composer.el.focus();
    pressKey(composer.el, 'Enter');
    /*
     * Verify the prompt actually left the composer. Returning {via:'enter'} unverified was
     * the head of a silent-wrong-answer chain: while a previous generation is still
     * streaming ChatGPT ignores Enter, nothing is sent, and the caller then settles on the
     * PREVIOUS assistant message and reports it as the new answer.
     */
    const accepted = await waitFor(
      () => (A.util.editorText(composer.el).trim() !== had || isStreaming() ? true : null),
      { timeout: 6000, interval: 200, label: 'send_accepted' },
    ).catch(() => false);
    if (!accepted) {
      throw new Error('send_not_accepted — the prompt is still in the composer. ChatGPT ignores Enter while a previous response is streaming; call chatgpt_stop first.');
    }
    return { via: 'enter', selector: composer.selector };
  }

  /**
   * Wait for a reply to finish.
   *
   * Three signals, because each one alone lies: the stop button vanishes slightly before
   * the final tokens render, the DOM keeps growing after the stream closes, and the
   * network record completes while React is still flushing. Completion is "the stream
   * record is done AND the rendered text has stopped changing", with the DOM alone as the
   * fallback when the request was never captured.
   */
  async function waitForReply({ sinceId, baselineCount, baselineText = null, timeout_ms = 300000, quiet_ms = 1200, lean = false } = {}) {
    const started = Date.now();

    /*
     * 1. The thread must actually change. Accepting "streaming is happening" here meant a
     * still-running previous generation satisfied the check instantly, and everything after
     * it described the previous answer.
     */
    await waitFor(() => {
      if (assistantCount() > baselineCount) return true;
      if (baselineText != null && (lastAssistantEl()?.innerText ?? '') !== baselineText) return true;
      // A conversation request made after the send is a network fact; a selector that no
      // longer matches the rebuilt markup must not be able to veto it.
      if (sinceId && streamRecords(sinceId).length) return true;
      return null;
    }, { timeout: Math.min(timeout_ms, 90000), interval: 200, label: 'reply_to_start' });

    // 2. Streaming stops and the text settles.
    const stable = await waitStable(() => {
      const el = lastAssistantEl();
      const t = el ? el.innerText : '';
      // While the stop button is up the answer is definitionally still moving; returning a
      // changing sentinel keeps waitStable from settling early during a long pause between
      // tool calls.
      return isStreaming() ? t + ' ' + Date.now() : t;
    }, { quiet: quiet_ms, timeout: timeout_ms - (Date.now() - started), interval: 250 });

    // 3. Give the captured stream a moment to close, then decode it.
    const recs = streamRecords(sinceId);
    const rec = recs[recs.length - 1] ?? null;
    if (rec && !rec.done) {
      await waitFor(() => rec.done, { timeout: 15000, interval: 200, label: 'stream_close' }).catch(() => {});
    }

    const domText = textOf(lastAssistantEl());
    let stream = null;
    if (rec) {
      const decoded = A.net.decode(rec);
      if (decoded.format === 'sse') stream = decodeStream(decoded.events);
    }

    const fromStream = !!stream?.text?.trim();
    const text = fromStream ? stream.text : domText;
    /*
     * The rendered text is only worth returning when it disagrees with the stream. Normally
     * it is the same answer a second time — and when the two DO differ that is a real
     * signal, so it is carried then and only then.
     */
    const disagrees = fromStream && domText && Math.abs(domText.length - text.length) > Math.max(40, text.length * 0.15);
    return {
      text,
      text_source: fromStream ? 'stream' : 'dom',
      ...(!lean || disagrees ? { dom_text: domText } : {}),
      ...(disagrees ? { dom_disagrees: true } : {}),
      conversation_id: stream?.conversation_id ?? conversationId(),
      message_id: stream?.message_id ?? messageIdOf(lastAssistantEl()),
      model_slug: stream?.model_slug ?? lastAssistantEl()?.getAttribute('data-message-model-slug') ?? null,
      finish: stream?.finish ?? null,
      stream_error: stream?.error ?? null,
      stream_request_id: rec?.id ?? null,
      still_streaming: isStreaming(),
      settled: stable.stable,
      ...(stable.timed_out ? { timed_out: true } : {}),
      elapsed_ms: Date.now() - started,
    };
  }

  // ---------------------------------------------------------------- handlers

  H['chatgpt.status'] = async () => {
    const out = {
      site: 'chatgpt',
      url: location.href,
      conversation_id: conversationId(),
      ready: ready(),
      streaming: isStreaming(),
      assistant_messages: assistantCount(),
      composer: describe(pick(SEL.composer, { requireVisible: false }).el),
      model_button: describe(pick(SEL.modelSwitcher).el),
    };
    try {
      const auth = await authHeaders();
      out.auth = { ok: true, source: auth.source, account_header: !!auth['ChatGPT-Account-Id'] };
      const acct = await api('/backend-api/accounts/check/v4-2023-04-27').catch(() => null);
      const def = acct?.accounts?.default ?? Object.values(acct?.accounts ?? {})[0];
      out.account = def
        ? {
            id: def.account?.account_id ?? null,
            plan: def.account?.plan_type ?? null,
            name: def.account?.name ?? null,
            structure: def.account?.structure ?? null,
            features: (def.features ?? []).slice(0, 40),
          }
        : null;
    } catch (e) {
      out.auth = { ok: false, error: String(e?.message || e) };
    }
    return out;
  };

  H['chatgpt.probe'] = async () => H['sys.probe']();

  /* ------------------------------ prompting ------------------------------ */

  H['chatgpt.ask'] = async (p = {}) => {
    if (!p.prompt) throw new Error('prompt_required');
    const baselineCount = assistantCount();
    const baselineText = lastAssistantEl()?.innerText ?? '';
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;

    if (p.model) await H['chatgpt.set_model']({ model: p.model });
    if (p.tools?.length) for (const t of p.tools) await H['chatgpt.toggle_tool']({ tool: t, on: true }).catch(() => {});
    if (p.attachments?.length) for (const a of p.attachments) await H['chatgpt.attach']({ ...a });

    const wrote = await setComposer(String(p.prompt));
    await sleep(p.settle_ms ?? 150);
    const sent = await clickSend();

    if (p.wait === false) {
      return { ok: true, sent, wrote: { strategy: wrote.strategy }, waited: false, conversation_id: conversationId() };
    }
    const reply = await waitForReply({
      sinceId, baselineCount, baselineText,
      timeout_ms: p.timeout_ms ?? 300000,
      quiet_ms: p.quiet_ms ?? 1200,
      lean: p.lean === true,
    });
    return { ok: true, sent, wrote: { strategy: wrote.strategy }, ...reply };
  };

  H['chatgpt.send'] = async (p = {}) => {
    const wrote = await setComposer(String(p.prompt ?? ''));
    if (p.send === false) return { ok: true, typed_only: true, wrote };
    await sleep(120);
    const sent = await clickSend();
    return { ok: true, wrote: { strategy: wrote.strategy }, sent };
  };

  H['chatgpt.wait_reply'] = async (p = {}) =>
    await waitForReply({
      sinceId: p.since_request_id ?? null,
      baselineCount: p.baseline_count ?? Math.max(0, assistantCount() - 1),
      timeout_ms: p.timeout_ms ?? 300000,
      quiet_ms: p.quiet_ms ?? 1200,
    });

  H['chatgpt.stop'] = async () => {
    const f = pick(SEL.stop);
    if (!f.el) return { ok: false, reason: 'not_streaming' };
    clickEl(f.el);
    await sleep(300);
    return { ok: true, still_streaming: isStreaming() };
  };

  H['chatgpt.regenerate'] = async (p = {}) => {
    const baselineCount = assistantCount();
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;
    const baselineText = lastAssistantEl()?.innerText ?? '';
    let f = pick(SEL.regenerate);
    if (!f.el) {
      // The control lives behind the last turn's hover toolbar on current builds.
      const last = lastAssistantEl()?.closest('[data-testid^="conversation-turn-"], article, [data-talvt-turn-state]');
      if (last) { last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await sleep(200); }
      f = pick(SEL.regenerate);
    }
    if (!f.el) {
      const byText = findByText('Regenerate');
      if (!byText) throw new Error('regenerate_button_not_found');
      clickEl(byText);
    } else {
      clickEl(f.el);
    }
    await sleep(400);
    if (p.wait === false) return { ok: true, waited: false };
    // baselineCount stays truthful; the text-changed condition detects the fork.
    return { ok: true, ...(await waitForReply({ sinceId, baselineCount, baselineText, timeout_ms: p.timeout_ms ?? 300000 })) };
  };

  H['chatgpt.continue'] = async (p = {}) => {
    const btn = findByText('Continue generating') || findByText('Continue');
    if (!btn) throw new Error('continue_button_not_found');
    const baselineCount = assistantCount();
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;
    clickEl(btn);
    if (p.wait === false) return { ok: true, waited: false };
    return { ok: true, ...(await waitForReply({ sinceId, baselineCount: baselineCount - 1, timeout_ms: p.timeout_ms ?? 300000 })) };
  };

  /* ------------------------------- reading ------------------------------- */

  H['chatgpt.messages'] = async (p = {}) => {
    const els = messageElements();
    const items = els.map(shapeMessage);
    const limited = p.count ? items.slice(-Number(p.count)) : items;
    return {
      conversation_id: conversationId(),
      url: location.href,
      total: items.length,
      returned: limited.length,
      streaming: isStreaming(),
      messages: p.include_code === false ? limited.map(({ code_blocks, ...m }) => m) : limited,
    };
  };

  H['chatgpt.last_reply'] = async () => {
    const el = lastAssistantEl();
    if (!el) return { found: false, conversation_id: conversationId() };
    const recs = streamRecords(null);
    const rec = recs[recs.length - 1] ?? null;
    let stream = null;
    if (rec) {
      const decoded = A.net.decode(rec);
      if (decoded.format === 'sse') {
        const s = decodeStream(decoded.events);
        /*
         * The capture buffer survives client-side navigation, so after switching
         * conversations the newest stream record belongs to the PREVIOUS one — returning
         * its answer while the DOM shows this one's.
         */
        const cur = conversationId();
        if (!cur || !s.conversation_id || s.conversation_id === cur) stream = s;
      }
    }
    const domText = (el.innerText || '').trim();
    return {
      found: true,
      conversation_id: conversationId(),
      streaming: isStreaming(),
      text: stream?.text?.trim() ? stream.text : domText,
      text_source: stream?.text?.trim() ? 'stream' : 'dom',
      dom_text: domText,
      message: shapeMessage(el, -1),
    };
  };

  /*
   * ChatGPT renders code blocks as full CodeMirror editors, not `<pre><code>`. A `pre`-only
   * scan therefore returns nothing on exactly the answers you most want the code from —
   * silently, because "no code blocks" is a plausible result. Both shapes are read, and the
   * language chip and Copy/Edit affordances that sit inside the block are stripped off.
   */
  function codeBlocksIn(scope) {
    const out = [];
    const seen = new Set();
    const push = (language, code, source) => {
      const clean = String(code ?? '').replace(/^(?:Copy|Edit|Copy code|复制)\s*\n/, '').replace(/\n+$/, '');
      if (!clean.trim() || seen.has(clean)) return;
      seen.add(clean);
      out.push({ index: out.length, language: language || null, code: clean, source });
    };
    for (const cm of $$('.cm-editor', scope)) {
      const lang = cm.closest('pre, div')?.querySelector('.cm-language, [class*="language"]')?.innerText?.trim()
        ?? (cm.className.match(/language-([\w+#.-]+)/) ?? [])[1] ?? null;
      push(lang, $('.cm-content', cm)?.innerText ?? cm.innerText, 'codemirror');
    }
    for (const pre of $$('pre', scope)) {
      if (pre.querySelector('.cm-editor')) continue;      // already taken above
      const code = pre.querySelector('code');
      push((code?.className.match(/language-([\w+#.-]+)/) ?? [])[1] ?? null, code?.innerText ?? pre.innerText, 'pre');
    }
    return out;
  }

  /** Fenced blocks out of raw markdown — the authoritative source when we have the stream. */
  function fencedBlocks(md) {
    const out = [];
    const re = /```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(String(md || '')))) {
      const code = m[2].replace(/\n+$/, '');
      if (code.trim()) out.push({ index: out.length, language: m[1] || null, code, source: 'stream' });
    }
    return out;
  }

  /*
   * The stream is preferred over the DOM here for the same reason it is preferred for the
   * answer: it carries the markdown that produced the render. Scraping the DOM is also
   * genuinely racy — ChatGPT leaves an empty assistant node in place at times, so the "last
   * assistant message" can contain nothing at all a moment after the answer completed.
   */
  H['chatgpt.code_blocks'] = async (p = {}) => {
    if (p.from_dom !== true) {
      const recs = streamRecords(null);
      const rec = recs[recs.length - 1];
      if (rec) {
        const decoded = A.net.decode(rec);
        if (decoded.format === 'sse') {
          const blocks = fencedBlocks(decodeStream(decoded.events).text);
          if (blocks.length) return { count: blocks.length, source: 'stream', blocks };
        }
      }
    }
    const scope = p.last_only === false ? document : (lastAssistantEl() ?? document);
    let blocks = codeBlocksIn(scope);
    // An empty placeholder turn is common; widen rather than report nothing.
    if (!blocks.length && scope !== document) blocks = codeBlocksIn(document);
    return { count: blocks.length, source: 'dom', blocks };
  };

  H['chatgpt.canvas'] = async (p = {}) => {
    const cid = p.conversation_id ?? conversationId();
    if (cid) {
      const docs = await api(`/backend-api/conversation/${cid}/textdocs`).catch((e) => ({ error: String(e.message) }));
      if (!docs?.error) return { source: 'api', conversation_id: cid, textdocs: docs };
    }
    const el = pick(SEL.canvas).el;
    return {
      source: 'dom',
      open: !!el,
      text: el ? (el.innerText || '').slice(0, 200000) : null,
    };
  };

  /* ---------------------------- conversations ---------------------------- */

  H['chatgpt.conversations'] = async (p = {}) => {
    const q = new URLSearchParams({
      offset: String(p.offset ?? 0),
      limit: String(Math.min(p.limit ?? 28, 100)),
      order: p.order ?? 'updated',
      ...(p.archived ? { is_archived: 'true' } : {}),
    });
    const r = await api('/backend-api/conversations?' + q);
    return {
      total: r.total,
      returned: r.items?.length ?? 0,
      offset: p.offset ?? 0,
      items: (r.items ?? []).map((c) => ({
        id: c.id, title: c.title, create_time: c.create_time, update_time: c.update_time,
        is_archived: c.is_archived, is_starred: c.is_starred ?? null,
        gizmo_id: c.gizmo_id ?? null, workspace_id: c.workspace_id ?? null,
        url: origin() + '/c/' + c.id,
      })),
    };
  };

  H['chatgpt.search_conversations'] = async (p = {}) => {
    if (!p.query) throw new Error('query_required');
    const r = await api('/backend-api/conversations/search?query=' + encodeURIComponent(p.query));
    return { query: p.query, items: r.items ?? r ?? [] };
  };

  H['chatgpt.conversation'] = async (p = {}) => {
    const id = p.conversation_id ?? conversationId();
    if (!id) throw new Error('conversation_id_required — no conversation is open in the tab either');
    const c = await api('/backend-api/conversation/' + id);

    /*
     * The mapping is a tree, not a list: every edit and regeneration forks it. Walking the
     * parent chain back from current_node is the only way to get the branch the user is
     * actually looking at — reading the mapping in insertion order returns abandoned
     * branches interleaved with live ones.
     */
    const chain = [];
    let node = c.current_node;
    const seen = new Set();
    while (node && c.mapping?.[node] && !seen.has(node)) {
      seen.add(node);
      const m = c.mapping[node].message;
      if (m && m.author?.role !== 'system') {
        const parts = (m.content?.parts ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
        chain.push({
          id: m.id,
          role: m.author?.role,
          recipient: m.recipient ?? null,
          content_type: m.content?.content_type ?? null,
          model: m.metadata?.model_slug ?? null,
          create_time: m.create_time ?? null,
          text: parts.join('\n'),
        });
      }
      node = c.mapping[node].parent;
    }
    chain.reverse();

    const visible = p.include_tool_messages ? chain : chain.filter((m) => (m.role === 'user' || m.role === 'assistant') && (!m.recipient || m.recipient === 'all') && m.content_type !== 'thoughts');
    return {
      id,
      title: c.title,
      create_time: c.create_time,
      update_time: c.update_time,
      current_node: c.current_node,
      default_model_slug: c.default_model_slug ?? null,
      gizmo_id: c.gizmo_id ?? null,
      is_archived: c.is_archived ?? null,
      total_nodes: Object.keys(c.mapping ?? {}).length,
      messages: p.count ? visible.slice(-Number(p.count)) : visible,
      url: origin() + '/c/' + id,
    };
  };

  H['chatgpt.open_conversation'] = async (p = {}) => {
    if (!p.conversation_id) throw new Error('conversation_id_required');
    const href = '/c/' + p.conversation_id;
    // A sidebar link is a client-side route change, which keeps this page world (and its
    // captured network history) alive. A full navigation throws all of that away, so it is
    // only the fallback — and it is the caller's job, via ext.navigate, because a page that
    // navigates cannot answer the request that told it to.
    const link = $$('a[href^="/c/"]').find((a) => a.getAttribute('href') === href);
    if (link) {
      clickEl(link);
      await waitFor(() => conversationId() === p.conversation_id, { timeout: 15000, interval: 200, label: 'route_change' });
      await sleep(500);
      return { ok: true, via: 'sidebar_link', conversation_id: conversationId() };
    }
    return { ok: false, needs_navigation: true, url: origin() + href, hint: 'Not in the loaded sidebar; navigate the tab to this URL.' };
  };

  H['chatgpt.new_chat'] = async (p = {}) => {
    const f = pick(SEL.newChat);
    if (f.el) {
      clickEl(f.el);
      await waitFor(() => conversationId() === null, { timeout: 10000, interval: 150, label: 'new_chat' }).catch(() => {});
      await sleep(400);
      return { ok: true, via: f.selector, conversation_id: conversationId() };
    }
    return { ok: false, needs_navigation: true, url: origin() + '/', hint: 'New-chat control not found; navigate the tab to the root URL.' };
  };

  H['chatgpt.rename'] = async (p = {}) => {
    const id = p.conversation_id ?? conversationId();
    if (!id || !p.title) throw new Error('conversation_id_and_title_required');
    return { ok: true, result: await api('/backend-api/conversation/' + id, { method: 'PATCH', json: { title: String(p.title) } }) };
  };

  H['chatgpt.archive'] = async (p = {}) => {
    const id = p.conversation_id ?? conversationId();
    if (!id) throw new Error('conversation_id_required');
    return { ok: true, archived: p.archived !== false, result: await api('/backend-api/conversation/' + id, { method: 'PATCH', json: { is_archived: p.archived !== false } }) };
  };

  H['chatgpt.delete'] = async (p = {}) => {
    const id = p.conversation_id ?? conversationId();
    if (!id) throw new Error('conversation_id_required');
    // OpenAI has no hard delete here — is_visible:false is what the UI's Delete does.
    return { ok: true, result: await api('/backend-api/conversation/' + id, { method: 'PATCH', json: { is_visible: false } }) };
  };

  H['chatgpt.share'] = async (p = {}) => {
    const id = p.conversation_id ?? conversationId();
    if (!id) throw new Error('conversation_id_required');
    const node = p.current_node_id ?? (await api('/backend-api/conversation/' + id)).current_node;
    const created = await api('/backend-api/share/create', {
      method: 'POST',
      json: { conversation_id: id, current_node_id: node, is_anonymous: p.anonymous !== false },
    });
    if (p.publish === false) return { ok: true, ...created };
    const published = await api('/backend-api/share/' + created.share_id, {
      method: 'PATCH',
      json: { share_id: created.share_id, highlighted_message_id: node, title: p.title ?? created.title, is_public: true, is_visible: true, is_anonymous: p.anonymous !== false },
    });
    return { ok: true, share_id: created.share_id, share_url: created.share_url ?? published.share_url, published };
  };

  H['chatgpt.feedback'] = async (p = {}) => {
    const id = p.conversation_id ?? conversationId();
    const mid = p.message_id ?? messageIdOf(lastAssistantEl());
    if (!id || !mid) throw new Error('conversation_id_and_message_id_required');
    return await api('/backend-api/conversation/message_feedback', {
      method: 'POST',
      json: { conversation_id: id, message_id: mid, rating: p.rating === 'down' ? 'thumbsDown' : 'thumbsUp', ...(p.text ? { text: p.text } : {}), ...(p.tags ? { tags: p.tags } : {}) },
    });
  };

  /* ------------------------------- models -------------------------------- */

  H['chatgpt.models'] = async () => {
    const r = await api('/backend-api/models?history_and_training_disabled=false');
    return {
      models: (r.models ?? []).map((m) => ({
        slug: m.slug, title: m.title, description: m.description,
        max_tokens: m.max_tokens ?? null, tags: m.tags ?? [],
        capabilities: m.capabilities ? Object.keys(m.capabilities) : [],
      })),
      categories: r.categories ?? null,
      current_ui_model: pick(SEL.modelSwitcher).el?.innerText?.trim() ?? null,
    };
  };

  H['chatgpt.set_model'] = async (p = {}) => {
    if (!p.model) throw new Error('model_required');
    const btn = await waitPicker(SEL.modelSwitcher, 'model_switcher');
    const before = (btn.el.innerText || '').trim();
    const menu = await openMenu(btn.el, SEL.menuItem);

    const want = String(p.model).toLowerCase();
    const label = (e) => (e.innerText || '').trim().split('\n')[0];
    let items = menu.els;
    let target = items.find((e) => label(e).toLowerCase() === want)
      ?? items.find((e) => (e.getAttribute('data-testid') || '').toLowerCase().includes(want))
      ?? items.find((e) => (e.innerText || '').toLowerCase().includes(want));

    // Newer builds hide the older models behind a submenu.
    if (!target) {
      const more = items.find((e) => /legacy|more models|other models/i.test(e.innerText || ''));
      if (more) {
        const sub = await openMenu(more, SEL.menuItem, { timeout: 6000 });
        items = sub.els;
        target = items.find((e) => (e.innerText || '').toLowerCase().includes(want));
      }
    }
    if (!target) {
      await closeMenu();
      throw new Error(`model_not_in_menu: "${p.model}". Options: ${items.map(label).filter(Boolean).join(' | ') || '(menu did not open)'}`);
    }
    clickEl(target);
    const after = await waitFor(() => {
      const cur = (pick(SEL.modelSwitcher).el?.innerText || '').trim();
      return cur && cur !== before ? cur : null;
    }, { timeout: 8000, interval: 200, label: 'model_label_change' }).catch(() => (pick(SEL.modelSwitcher).el?.innerText || '').trim());
    return { ok: true, before, after, changed: before !== after };
  };

  const waitPicker = async (sel, label, ms = 10000) =>
    await waitFor(() => { const f = pick(sel); return f.el ? f : null; }, { timeout: ms, interval: 250, label })
      .catch(() => { throw new Error(`${label}_not_found — the control has not rendered. ai_probe shows what is on the page.`); });

  H['chatgpt.model_options'] = async () => {
    /*
     * The switcher is not universal — it is absent on some plans and layouts. The question
     * being asked ("which models can I use?") still has an answer, so fall back to the
     * account's own model list rather than throwing, which sent callers hunting for a
     * renamed selector for a control that is simply not part of this account's UI.
     */
    const probe = pick(SEL.modelSwitcher);
    if (!probe.el) {
      const models = await api('/backend-api/models?history_and_training_disabled=false').catch(() => null);
      return {
        source: 'api',
        note: 'no model switcher in this UI — listing the account models from /backend-api/models instead',
        options: (models?.models ?? []).map((m) => ({ name: m.title || m.slug, slug: m.slug, description: m.description })),
      };
    }
    const btn = await waitPicker(SEL.modelSwitcher, 'model_switcher');
    const menu = await openMenu(btn.el, SEL.menuItem);
    const options = menu.els.map((e) => ({ name: (e.innerText || '').trim().split('\n')[0], testid: e.getAttribute('data-testid'), ...describe(e) }));
    await closeMenu();
    /*
     * Cross-check what the menu actually contained. `[role="menuitem"]` matches ANY open
     * menu, and a loose modelSwitcher fallback can land on a message-action button — which
     * returned "Try again / Think longer / Search the web" labelled as the model list. An
     * answer that looks right and is wrong is worse than an honest miss, so the options are
     * validated against the account's real model list before being presented as models.
     */
    const known = await api('/backend-api/models?history_and_training_disabled=false').catch(() => null);
    const slugs = (known?.models ?? []).map((m) => ({ slug: m.slug, title: m.title || '' }));
    const looksLikeModels = !slugs.length || options.some((o) =>
      slugs.some((m) => {
        const n = String(o.name || '').toLowerCase();
        return n && (n === m.title.toLowerCase() || n.includes(m.slug.toLowerCase()) || (m.title && n.includes(m.title.toLowerCase())));
      }));

    if (!looksLikeModels) {
      return {
        source: 'api',
        note: 'the control matched by the model-switcher selector opened a menu that is not a model list ('
          + options.map((o) => o.name).filter(Boolean).slice(0, 6).join(' | ')
          + ') — reporting the account models from /backend-api/models instead. Run chatgpt_probe to see what the selector hit.',
        matched_selector: menu.selector,
        options: slugs.map((m) => ({ name: m.title || m.slug, slug: m.slug })),
      };
    }
    return { source: 'ui', current: (btn.el.innerText || '').trim(), matched_selector: menu.selector, options };
  };

  /* -------------------------- composer tools ----------------------------- */

  H['chatgpt.tool_options'] = async () => {
    const inline = pick(SEL.composerTools, { all: true }).els.map(describe);
    const plus = pick(SEL.attachButton);
    if (!plus.el) {
      return { menu_items: [], inline_buttons: inline, file_inputs: $$('input[type="file"]').length, note: 'no composer tools button found; inline buttons are the whole surface' };
    }
    const menu = await openMenu(plus.el, SEL.menuItem, { timeout: 6000 });
    const items = menu.els.map((e) => ({ name: (e.innerText || '').trim().split('\n')[0], testid: e.getAttribute('data-testid'), ...describe(e) }));
    await closeMenu();
    return {
      button: describe(plus.el),
      matched_selector: menu.selector,
      menu_items: items,
      inline_buttons: inline,
      file_inputs: $$('input[type="file"]').length,
    };
  };

  H['chatgpt.toggle_tool'] = async (p = {}) => {
    if (!p.tool) throw new Error('tool_required — e.g. "search", "deep research", "create image", "study", "agent", "canvas"');
    const want = String(p.tool).toLowerCase();
    // Already an inline pill? Toggling it is a direct click.
    const inline = pick(SEL.composerTools, { all: true }).els
      .find((e) => (e.innerText || e.getAttribute('aria-label') || '').toLowerCase().includes(want));
    if (inline) { clickEl(inline); await sleep(300); return { ok: true, via: 'inline', button: describe(inline) }; }

    const plus = pick(SEL.attachButton);
    if (!plus.el) throw new Error('composer_tools_button_not_found');
    const menu = await openMenu(plus.el, SEL.menuItem, { timeout: 6000 });
    let items = menu.els;
    let target = items.find((e) => (e.innerText || '').toLowerCase().includes(want));
    if (!target) {
      const more = items.find((e) => /more|tools/i.test(e.innerText || ''));
      if (more) { const sub = await openMenu(more, SEL.menuItem, { timeout: 6000 }); items = sub.els; target = items.find((e) => (e.innerText || '').toLowerCase().includes(want)); }
    }
    if (!target) {
      await closeMenu();
      throw new Error(`tool_not_found: "${p.tool}". Menu offers: ${items.map((e) => (e.innerText || '').trim().split('\n')[0]).filter(Boolean).join(' | ') || '(menu did not open)'}`);
    }
    clickEl(target);
    await sleep(500);
    return { ok: true, via: 'menu', selected: describe(target) };
  };

  /* ------------------------------ attachments ---------------------------- */

  /*
   * Files go in through the hidden <input type=file>, not by dropping on the composer.
   * Assigning a DataTransfer's FileList to input.files and firing `change` is the one path
   * React's uploader listens to; a synthetic `drop` event is not trusted and is ignored.
   */
  H['chatgpt.attach'] = async (p = {}) => {
    if (!p.base64 && !p.text) throw new Error('base64_or_text_required');
    const name = String(p.filename || (p.text ? 'note.txt' : 'upload.bin'));
    const mime = String(p.mimetype || (p.text ? 'text/plain' : 'application/octet-stream'));

    let file;
    if (p.text != null) {
      file = new File([new Blob([String(p.text)], { type: mime })], name, { type: mime });
    } else {
      const bin = atob(String(p.base64));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      file = new File([bytes], name, { type: mime });
    }

    let input = pick(SEL.fileInput, { requireVisible: false }).el;
    if (!input) {
      const plus = pick(SEL.attachButton);
      if (plus.el) { clickEl(plus.el); await sleep(500); }
      input = pick(SEL.fileInput, { requireVisible: false }).el;
      pressKey(document.body, 'Escape');
    }
    if (!input) throw new Error('file_input_not_found');

    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    if (p.wait === false) return { ok: true, filename: name, bytes: file.size, waited: false };
    const done = await waitUploadComplete({ sinceId, timeout_ms: p.timeout_ms ?? 180000 });
    return { ok: done.ok, filename: name, bytes: file.size, ...done };
  };

  /**
   * Wait until an attachment has actually been uploaded, not merely selected.
   *
   * The chip in the composer appears the instant the file is chosen — before a single byte
   * has left the machine. Sending on that signal races the upload, and ChatGPT either
   * answers about a file it does not have or drops the attachment silently. So the
   * authoritative signal is the network: ChatGPT registers the file, PUTs it to a signed
   * URL, then POSTs `…/uploaded` to confirm. Any of those still in flight means not done.
   *
   * The send button is the corroborating UI signal — ChatGPT disables it while an upload is
   * pending — and it is what covers the case where the flow changes shape.
   */
  async function waitUploadComplete({ sinceId, timeout_ms = 180000 } = {}) {
    const started = Date.now();
    const uploadRecs = () =>
      A.net.match({ url: '/backend-api/files|oaiusercontent|blob\\.core\\.windows\\.net|uploads', ...(sinceId ? { since_id: sinceId } : {}) });

    const kicked = await waitFor(() => (uploadRecs().length ? true : null),
      { timeout: Math.min(timeout_ms, 30000), interval: 250, label: 'upload_start' }).catch(() => false);

    /*
     * Scoped to the composer and excluding buttons: the old selector's [aria-label*="file"]
     * also matched ChatGPT's own attach button ("Add photos and files"), so the "is anything
     * actually attached" guard was permanently satisfied.
     */
    const chip = () => {
      const form = pick(SEL.composer).el?.closest('form') ?? document;
      // ChatGPT renders each attachment as a `group/file-tile` div with no data-testid at all,
      // so the older attachment/file-preview selectors matched nothing. Both are kept because
      // neither name is documented and either can come back.
      return $$('[class*="file-tile"], [data-testid*="attachment"], [class*="attachment"], [data-testid*="file-preview"]', form)
        .filter((e) => visible(e) && e.tagName !== 'BUTTON' && !e.closest('button'));
    };

    /*
     * The request that means "the server has the bytes".
     *
     * ChatGPT renamed this from `…/uploaded` to `…/process_upload_stream`; the old name is
     * still matched because nothing here is a published contract.
     */
    const CONFIRM = /\/(?:uploaded|process_upload_stream)\b/;
    const confirmedRec = () => uploadRecs().find((r) => CONFIRM.test(r.url) && r.status >= 200 && r.status < 300);

    const settled = await waitFor(() => {
      if (uploadRecs().some((r) => !r.done)) return null;          // bytes still moving
      const send = pick(SEL.send, { requireVisible: true });
      if (send.el && (send.el.disabled || send.el.getAttribute('aria-disabled') === 'true')) return null;
      /*
       * The network is authoritative and the chip only corroborates it. The chip used to be
       * able to *veto* a completed upload, so when ChatGPT renamed the tile class every
       * upload — including ones the server had already accepted — spent the full timeout and
       * was then reported as a failure.
       */
      if (confirmedRec()) return true;
      if (!chip().length) return null;                              // nothing attached at all
      return true;
    }, { timeout: timeout_ms - (Date.now() - started), interval: 350, label: 'upload_settle' }).catch(() => false);

    const recs = uploadRecs();
    const confirmed = confirmedRec();
    const failed = recs.filter((r) => r.status != null && r.status >= 400);

    return {
      // `kicked` is required: with no upload request captured there is no evidence any bytes
      // moved, and "a chip is present" is not evidence.
      ok: !!settled && !failed.length && !!kicked,
      confirmed_by: confirmed ? 'network:upload_confirmed' : kicked ? 'network:requests_settled' : 'ui_only',
      settled: !!settled,
      attachments: chip().map(describe),
      upload_requests: recs.map((r) => ({ id: r.id, url: r.url.slice(0, 160), method: r.method, status: r.status, done: r.done, bytes: r.bytes })),
      ...(failed.length ? { failed_requests: failed.map((r) => ({ url: r.url.slice(0, 160), status: r.status })) } : {}),
      elapsed_ms: Date.now() - started,
    };
  }

  /* ------------------------- account & settings -------------------------- */

  H['chatgpt.custom_instructions'] = async (p = {}) => {
    if (p.set) {
      return {
        ok: true,
        result: await api('/backend-api/user_system_messages', {
          method: 'POST',
          json: {
            about_user_message: p.about_user ?? '',
            about_model_message: p.about_model ?? '',
            enabled: p.enabled !== false,
          },
        }),
      };
    }
    return await api('/backend-api/user_system_messages');
  };

  H['chatgpt.memories'] = async (p = {}) => {
    if (p.delete_id) return { ok: true, result: await api('/backend-api/memories/' + p.delete_id, { method: 'DELETE' }) };
    if (p.clear) return { ok: true, result: await api('/backend-api/memories', { method: 'DELETE' }) };
    return await api('/backend-api/memories');
  };

  H['chatgpt.settings'] = async () => ({
    beta_features: await api('/backend-api/settings/beta_features').catch((e) => ({ error: String(e.message) })),
    account: await api('/backend-api/accounts/check/v4-2023-04-27').catch((e) => ({ error: String(e.message) })),
  });

  H['chatgpt.projects'] = async (p = {}) => {
    if (p.project_id) {
      return {
        project: await api('/backend-api/gizmos/' + p.project_id).catch((e) => ({ error: String(e.message) })),
        conversations: await api(`/backend-api/gizmos/${p.project_id}/conversations?limit=${p.limit ?? 25}`).catch((e) => ({ error: String(e.message) })),
      };
    }
    const r = await api('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=' + (p.limit ?? 5)).catch(() => null);
    return r ?? await api('/backend-api/gizmos/bootstrap');
  };

  H['chatgpt.gpts'] = async (p = {}) => {
    if (p.gizmo_id) return await api('/backend-api/gizmos/' + p.gizmo_id);
    if (p.query) return await api('/backend-api/gizmos/search?query=' + encodeURIComponent(p.query) + '&cursor=');
    return await api('/backend-api/gizmos/bootstrap');
  };

  /** Unrestricted authenticated access to ChatGPT's own backend, for anything above missing. */
  H['chatgpt.api'] = async (p = {}) => {
    if (!p.path) throw new Error('path_required — e.g. "/backend-api/models"');
    const r = await api(String(p.path), { method: p.method ?? 'GET', json: p.json, headers: p.headers ?? {}, raw: true });
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch {}
    return { status: r.status, json: parsed, text: parsed ? undefined : r.text.slice(0, p.max ?? 100000) };
  };

  // ---------------------------------------------------------------- selftest

  async function selftest() {
    const out = [];
    const t = (name, cond, detail) => out.push({ name, pass: !!cond, ...(detail !== undefined && !cond ? { detail } : {}) });

    t('chatgpt_module_registered', A.site?.id === 'chatgpt');
    t('chatgpt_handlers_present', ['chatgpt.ask', 'chatgpt.conversations', 'chatgpt.messages', 'chatgpt.models'].every((k) => typeof H[k] === 'function'));
    t('chatgpt_selectors_are_lists', Object.values(SEL).every((v) => Array.isArray(v) && v.length > 0));
    t('chatgpt_composer_has_fallbacks', SEL.composer.length >= 3);
    t('conversationId_parses_a_c_path', /\/c\/([0-9a-f-]{36})/i.exec('/c/2f4a1b6c-1111-4222-8333-444455556666')?.[1] === '2f4a1b6c-1111-4222-8333-444455556666');

    // The delta protocol, which is where a silent wrong answer would come from.
    const frames = (arr) => arr.map((data) => ({ event: null, data }));
    const add = { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, recipient: 'all', metadata: { model_slug: 'gpt-5' } }, conversation_id: 'c1' };

    let d = decodeStream(frames([add, { p: '/message/content/parts/0', o: 'append', v: 'Hello' }, { v: ' world' }]));
    t('stream_appends_deltas', d.text === 'Hello world', d);
    t('stream_reads_conversation_id', d.conversation_id === 'c1', d);
    t('stream_reads_message_id', d.message_id === 'm1', d);
    t('stream_reads_model_slug', d.model_slug === 'gpt-5', d);

    d = decodeStream(frames([{ v: add, o: 'add', p: '' }, { p: '/message/content/parts/0', o: 'append', v: 'Wrapped' }]));
    t('stream_handles_wrapped_add_frames', d.text === 'Wrapped', d);

    const thoughts = { message: { id: 'm0', author: { role: 'assistant' }, content: { content_type: 'thoughts', parts: ['secret reasoning'] }, recipient: 'all' } };
    d = decodeStream(frames([thoughts, { p: '/message/content/parts/0', o: 'append', v: 'MORE REASONING' }, add, { p: '/message/content/parts/0', o: 'append', v: 'Answer' }]));
    t('stream_excludes_reasoning_traces', d.text === 'Answer', d);

    const toolCall = { message: { id: 'mt', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['{"q":"x"}'] }, recipient: 'browser' } };
    d = decodeStream(frames([toolCall, { p: '/message/content/parts/0', o: 'append', v: 'TOOL ARGS' }, add, { p: '/message/content/parts/0', o: 'append', v: 'Final' }]));
    t('stream_excludes_tool_calls', d.text === 'Final', d);

    d = decodeStream(frames([add, { o: 'patch', p: '', v: [{ p: '/message/content/parts/0', o: 'append', v: 'A' }, { p: '/message/content/parts/0', o: 'append', v: 'B' }] }]));
    t('stream_applies_batched_patches', d.text === 'AB', d);

    const complete = { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Complete answer'] }, recipient: 'all' } };
    d = decodeStream(frames([add, { p: '/message/content/parts/0', o: 'append', v: 'partial' }, complete]));
    t('stream_final_full_frame_wins', d.text === 'Complete answer', d);

    t('stream_survives_done_sentinel', decodeStream(frames([add, { v: 'x', p: '/message/content/parts/0' }, '[DONE]'])).text === 'x');
    t('stream_of_nothing_is_empty_not_null', decodeStream([]).text === '');

    const errored = decodeStream(frames([{ error: { code: 'rate_limited', message: 'slow down' } }]));
    t('stream_surfaces_errors', typeof errored.error === 'string' && errored.error.includes('rate_limited'), errored);

    // A live page should have exactly one composer if we are signed in; on the login wall
    // ready() must say so rather than reporting a generic failure.
    const r = ready();
    t('ready_reports_a_known_state', ['app', 'signed_out', 'loading', 'loading_hidden', 'no_composer'].includes(r.state), r);
    t('ready_true_implies_composer', !r.ready || !!pick(SEL.composer, { requireVisible: false }).el, r);

    return out;
  }

  // ------------------------------------------------------------------ export

  A.site = {
    id: 'chatgpt',
    version: SITE_VERSION,
    selectors: SEL,
    ready,
    selftest,
    status: async () => ({
      conversation_id: conversationId(),
      streaming: isStreaming(),
      messages: messageElements().length,
      signed_out: loggedOut(),
    }),
  };

  A.log(`chatgpt module v${SITE_VERSION} installed`);
})();
