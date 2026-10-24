#!/usr/bin/env node
/*
 * ai-mcp daemon — the always-on half of the bridge.
 *
 * Owns the WebSocket server that the browser extension dials, and brokers between it and
 * any number of MCP clients:
 *
 *   extension  <--ws(role=extension)-->  DAEMON  <--ws(role=client)-->  MCP server(s)
 *
 * Running the socket inside the MCP stdio process instead would mean the extension shows
 * "disconnected" whenever no agent session happens to be running, and a second agent would
 * hit EADDRINUSE. Splitting it out fixes both, and makes "start it once and forget" true.
 *
 * Start:  node src/daemon.js      (foreground, logs to stderr + ~/.ai-mcp/daemon.log)
 */
import { WebSocketServer } from 'ws';
import { appendFileSync } from 'node:fs';
import { config } from './config.js';

const started = new Date();
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  process.stderr.write(line);
  try { appendFileSync(config.daemonLogPath, line); } catch {}
}

let ext = null;                    // the extension socket
let extStatus = null;              // last status it reported
const clients = new Set();         // MCP server sockets
const routes = new Map();          // reqId -> { socket, seen:Set, total }
const events = [];                 // ring buffer
let seq = 0;
const waiters = new Set();

// ------------------------------------------------------------------ helpers

const send = (sock, obj) => {
  if (sock && sock.readyState === 1) {
    try { sock.send(JSON.stringify(obj)); } catch {}
  }
};

function status() {
  return {
    daemon: { pid: process.pid, started: started.toISOString(), uptime_s: Math.round(process.uptime()) },
    endpoint: `ws://${config.host}:${config.port}`,
    extension_connected: !!(ext && ext.readyState === 1),
    extension: extStatus,
    mcp_clients: clients.size,
    event_cursor: seq,
    events_buffered: events.length,
  };
}

function recordEvent(payload) {
  const rec = { seq: ++seq, at: new Date().toISOString(), event: payload.event, data: payload.data };
  events.push(rec);
  if (events.length > config.eventBufferSize) events.splice(0, events.length - config.eventBufferSize);
  for (const w of [...waiters]) {
    try { w(rec); } catch {}
  }
}

function queryEvents({ since = 0, types = null, contains = null, limit = 100 } = {}) {
  let out = events.filter((e) => e.seq > since);
  if (types?.length) out = out.filter((e) => types.includes(e.event));
  if (contains) out = out.filter((e) => JSON.stringify(e.data ?? '').includes(contains));
  /*
   * Page forward, not backward. Returning the NEWEST `limit` while advancing the cursor to
   * the head made everything in between permanently unreachable — the caller's next `since`
   * query started after events it had never seen.
   */
  const page = out.slice(0, limit);
  return {
    cursor: page.length ? page[page.length - 1].seq : since,
    count: page.length,
    remaining: Math.max(0, out.length - page.length),
    events: page,
  };
}

function eventMatcher(a = {}) {
  return (rec) => {
    if (a.types?.length && !a.types.includes(rec.event)) return false;
    if (a.contains && !JSON.stringify(rec.data ?? '').includes(a.contains)) return false;
    return true;
  };
}

function waitForEvent(match, timeoutMs, since) {
  const backlog = since == null ? [] : events.filter((e) => e.seq > since);
  const hit = backlog.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const done = (rec) => { clearTimeout(timer); waiters.delete(listener); resolve(rec); };
    const listener = (rec) => { if (match(rec)) done(rec); };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    waiters.add(listener);
  });
}

// ------------------------------------------------------------ local methods

const LOCAL = {
  'bridge.status': async () => status(),
  'bridge.events': async (p) => queryEvents(p),
  'bridge.wait_event': async (p = {}) => {
    const hit = await waitForEvent(eventMatcher(p), p.timeout_ms ?? 120000, p.since ?? null);
    return hit ? { matched: true, cursor: hit.seq, at: hit.at, event: hit.event, data: hit.data } : { matched: false, timed_out: true, cursor: seq };
  },
};

// ------------------------------------------------------------------- server

const wss = new WebSocketServer({ host: config.host, port: config.port, maxPayload: 256 * 1024 * 1024 });

wss.on('listening', () => log(`daemon listening on ws://${config.host}:${config.port} (pid ${process.pid})`));

wss.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${config.port} already in use — another daemon is already running. Exiting.`);
    process.exit(3);
  }
  log('server error: ' + e.message);
});

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '/', 'http://x');
  const role = url.searchParams.get('role');
  log(`connection: role=${role} url=${req.url} origin=${req.headers.origin || '-'}`);

  /*
   * A WebSocket handshake is not subject to CORS, so any page the operator visits could
   * otherwise connect to 127.0.0.1 and drive the whole bridge — read conversation history,
   * send prompts, run ai_eval. Local tools (the MCP server, call.mjs) send no Origin at all;
   * the extension sends its own chrome-extension:// origin. Anything else is a web page.
   */
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\//.test(origin)) {
    log(`rejecting ${role}: disallowed origin ${origin}`);
    socket.close(4403, 'bad origin');
    return;
  }

  if (config.token && url.searchParams.get('token') !== config.token) {
    log(`rejecting ${role}: token mismatch (daemon expects a token, client sent "${url.searchParams.get('token') ?? ''}")`);
    socket.close(4401, 'bad token');
    return;
  }

  if (role === 'extension') {
    if (ext && ext.readyState === 1) {
      try { ext.close(4409, 'replaced'); } catch {}
    }
    ext = socket;
    log('extension connected');
    for (const c of clients) send(c, { kind: 'notice', event: 'extension_connected' });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.kind === 'evt') {
        let payload;
        try { payload = JSON.parse(msg.body); } catch { return; }
        recordEvent(payload);
        return;
      }
      if (msg.kind === 'hello' || msg.kind === 'status') { extStatus = msg.status || extStatus; return; }
      if (msg.kind === 'pong') return;

      if (msg.kind === 'res') {
        const route = routes.get(msg.id);
        if (!route) return;
        send(route.socket, msg);
        if (msg.total != null && msg.total > 1) {
          route.seen.add(msg.seq);
          if (route.seen.size >= msg.total) routes.delete(msg.id);
        } else {
          routes.delete(msg.id);
        }
      }
    });

    socket.on('close', (code, reason) => {
      const replaced = ext !== socket;
      if (ext === socket) { ext = null; extStatus = null; }
      log(`extension disconnected (code=${code} reason="${reason?.toString() || ''}"${replaced ? ' — superseded by a newer socket' : ''})`);
      for (const c of clients) send(c, { kind: 'notice', event: 'extension_disconnected' });
    });
    socket.on('error', (e) => log('extension socket error: ' + e.message));
    return;
  }

  if (role === 'client') {
    clients.add(socket);
    log(`mcp client connected (${clients.size} total)`);
    send(socket, { kind: 'notice', event: 'ready', status: status() });

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind !== 'req') return;

      const fail = (message) =>
        send(socket, { kind: 'res', id: msg.id, ok: false, body: JSON.stringify({ error: { message } }) });

      if (LOCAL[msg.method]) {
        try {
          const data = await LOCAL[msg.method](msg.params || {});
          send(socket, { kind: 'res', id: msg.id, ok: true, body: JSON.stringify({ data }) });
        } catch (e) {
          fail(String(e?.message || e));
        }
        return;
      }

      if (!ext || ext.readyState !== 1) {
        fail(
          'extension_not_connected — the daemon is running but the browser extension has not dialled in. ' +
          'Check that the browser is open, the "AI Studio MCP Bridge" extension is enabled, at least one of ' +
          'gemini.google.com / labs.google / chatgpt.com is open in a tab, and the popup switch is on.'
        );
        return;
      }

      routes.set(msg.id, { socket, seen: new Set(), total: null });
      send(ext, msg);
    });

    socket.on('close', () => {
      clients.delete(socket);
      for (const [id, r] of routes) if (r.socket === socket) routes.delete(id);
      log(`mcp client disconnected (${clients.size} left)`);
    });
    socket.on('error', () => {});
    return;
  }

  socket.close(4400, 'unknown role');
});

// Keep the extension's MV3 service worker alive; its idle timer resets on socket traffic.
const ping = setInterval(() => send(ext, { kind: 'ping', t: Date.now() }), 20000);
ping.unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`received ${sig}, shutting down`); wss.close(); process.exit(0); });
}
process.on('uncaughtException', (e) => log('uncaught: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => log('unhandled: ' + (e?.stack || e)));
