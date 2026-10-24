import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';

export const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js');
const log = (...a) => process.stderr.write('[ai-mcp] ' + a.join(' ') + '\n');

/**
 * Client side of the bridge. Talks to the daemon that actually owns the extension socket,
 * and starts that daemon on demand if it is not already up — so an agent session never has
 * to care whether something else already launched it.
 */
export class Bridge {
  constructor() {
    this.ws = null;
    this.state = 'idle';
    this.pending = new Map();
    this.backoff = 500;
    this.reconnectTimer = null;
    this.spawnAttempted = false;
    this.lastNotice = null;
    this.cursor = 0;
  }

  get url() {
    return `ws://${config.host}:${config.port}/?role=client${config.token ? '&token=' + encodeURIComponent(config.token) : ''}`;
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  start() {
    this.#connect();
  }

  #connect() {
    clearTimeout(this.reconnectTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.state = 'connecting';
    let sock;
    try { sock = new WebSocket(this.url); } catch { this.#scheduleReconnect(); return; }
    this.ws = sock;

    sock.on('open', () => {
      this.state = 'connected';
      this.backoff = 500;
      this.spawnAttempted = false;
      log(`connected to daemon at ws://${config.host}:${config.port}`);
    });

    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind === 'notice') { this.lastNotice = msg; return; }
      if (msg.kind === 'res') this.#onResult(msg);
    });

    sock.on('close', () => {
      if (this.ws === sock) { this.ws = null; this.state = 'disconnected'; }
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('daemon_connection_lost'));
        this.pending.delete(id);
      }
      this.#scheduleReconnect();
    });

    sock.on('error', () => {
      // A refused connection is the normal "daemon not started yet" case, not a fault.
      if (config.autoSpawn && !this.spawnAttempted) {
        this.spawnAttempted = true;
        this.#spawnDaemon();
      }
      try { sock.close(); } catch {}
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.backoff = Math.min(this.backoff * 1.5, 5000);
    this.reconnectTimer = setTimeout(() => this.#connect(), this.backoff);
    this.reconnectTimer.unref?.();
  }

  /** Launch the daemon detached so it outlives this agent session. */
  #spawnDaemon() {
    try {
      log('daemon not running — starting it');
      // Do NOT pipe stderr into daemon.log: the daemon appends there itself, and
      // redirecting as well makes every line appear twice, which reads like duplicate
      // connections when you are debugging.
      const child = spawn(process.execPath, [DAEMON_PATH], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
        env: process.env,
      });
      child.unref();
    } catch (e) {
      log('failed to start daemon: ' + e.message);
    }
  }

  #onResult(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;

    let text = msg.body;
    if (msg.total != null && msg.total > 1) {
      p.chunks ??= new Array(msg.total).fill(null);
      p.chunks[msg.seq] = msg.body;
      if (p.chunks.some((c) => c === null)) return;
      text = p.chunks.join('');
    }

    this.pending.delete(msg.id);
    clearTimeout(p.timer);

    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { p.reject(new Error('bad_response_json: ' + e.message)); return; }
    if (msg.ok) p.resolve(parsed.data);
    else {
      const err = new Error(parsed.error?.message || 'unknown_error');
      err.detail = parsed.error;
      p.reject(err);
    }
  }

  /** Wait briefly for the daemon, starting it if needed. */
  async ready(timeoutMs = 12000) {
    if (this.connected) return true;
    this.#connect();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.connected;
  }

  /**
   * Transport-level failures (the daemon socket dropping mid-request) are transient and
   * retryable; a page-level error is not. Retry only the former, and only once, so a
   * momentary blip does not surface to the agent as a failed operation on the site.
   */
  async call(method, params = {}, timeoutMs = config.timeoutMs) {
    try {
      return await this.#callOnce(method, params, timeoutMs);
    } catch (e) {
      /*
       * Only `daemon_unreachable` is safe to retry: it means no socket existed, so the frame
       * demonstrably never left. `daemon_connection_lost` and `send_failed` can both happen
       * AFTER the browser received it — retrying then sends a second prompt, or spends a
       * second Veo generation.
       */
      const safeToRetry = /daemon_unreachable/.test(e?.message ?? '');
      if (!safeToRetry) throw e;
      log(`transient transport failure on ${method} (${e.message}) — reconnecting and retrying once`);
      await this.ready(8000);
      return await this.#callOnce(method, params, timeoutMs);
    }
  }

  async #callOnce(method, params = {}, timeoutMs = config.timeoutMs) {
    if (!this.connected && !(await this.ready())) {
      throw new Error(
        `daemon_unreachable — could not reach the ai-mcp daemon on ws://${config.host}:${config.port}. ` +
        `Start it with: node "${DAEMON_PATH}"  (check ${config.daemonLogPath} for why it exited)`
      );
    }
    const id = randomUUID();
    const frame = JSON.stringify({ kind: 'req', id, method, params });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms calling ${method}`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(frame);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('send_failed: ' + e.message));
      }
    });
  }

  // ------------------------------------------------------------- convenience

  async daemonStatus() {
    return await this.call('bridge.status', {}, 8000);
  }

  async getEvents(opts = {}) {
    const r = await this.call('bridge.events', opts, 15000);
    this.cursor = r.cursor ?? this.cursor;
    return r;
  }

  async waitEvent(opts = {}) {
    const timeout = opts.timeout_ms ?? 120000;
    const r = await this.call('bridge.wait_event', opts, timeout + 10000);
    this.cursor = r.cursor ?? this.cursor;
    return r;
  }
}

export const bridge = new Bridge();
