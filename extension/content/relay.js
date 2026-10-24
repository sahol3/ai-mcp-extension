/*
 * ai-mcp — content relay (ISOLATED world)
 *
 * Pumps frames between the page bridge (MAIN world, via window.postMessage) and the
 * background service worker (via a long-lived chrome.runtime Port).
 *
 * Deliberately dumb. It holds no knowledge of Gemini, Flow or ChatGPT — logic here would
 * be logic in the wrong world, because this context cannot touch the page's JavaScript.
 * Its one job besides pumping is keeping the port open: that traffic is what resets the
 * MV3 service worker's idle timer, and re-opening after a disconnect is what revives the
 * worker if Chrome tears it down anyway.
 */
(() => {
  'use strict';

  if (window.__AIMCP_RELAY__) return;
  window.__AIMCP_RELAY__ = true;

  let port = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      port = chrome.runtime.connect({ name: 'aimcp-page' });
    } catch {
      // The extension was reloaded and this context is orphaned. Retrying is harmless;
      // a fresh relay is injected into the tab moments later either way.
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.kind === 'pong') return;
      window.postMessage(Object.assign({ __aimcp: true }, msg), '*');
    });

    port.onDisconnect.addListener(() => {
      port = null;
      scheduleReconnect();
    });

    safePost({ kind: 'attach', url: location.href });

    // The page bridge announces itself once, at boot. This relay is torn down and rebuilt
    // on every extension reload while the page world survives, so that announcement is
    // long gone by now — the worker would report "no engine" forever even though the
    // bridge is sitting there answering. Ask it to introduce itself again.
    window.postMessage({ __aimcp: true, kind: 'hello_request' }, '*');

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => safePost({ kind: 'ping' }), 15000);
  }

  function scheduleReconnect() {
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  }

  function safePost(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch {
      port = null;
      scheduleReconnect();
      return false;
    }
  }

  // MAIN world -> service worker
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__aimcp !== true) return;
    // tick_ctl asks the service worker to drive an unthrottled clock for the page, which
    // needs one on sites whose CSP blocks blob workers.
    if (d.kind !== 'res' && d.kind !== 'evt' && d.kind !== 'hello' && d.kind !== 'tick_ctl') return;
    const { __aimcp, ...rest } = d;
    safePost(rest);
  });

  window.addEventListener('pagehide', () => {
    try { port?.disconnect(); } catch {}
  });

  connect();
})();
