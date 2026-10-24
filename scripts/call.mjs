#!/usr/bin/env node
/*
 * Call one bridge method against the running daemon and print the result.
 *
 * The fastest way to poke at a live page without standing up an MCP client:
 *
 *   node scripts/call.mjs ext.status
 *   node scripts/call.mjs sys.status '{"site":"gemini"}'
 *   node scripts/call.mjs gemini.ask '{"prompt":"say PONG"}'
 *   node scripts/call.mjs net.list '{"site":"chatgpt","url":"backend-api","limit":5}'
 *
 * Run it from PowerShell, not the Bash tool: that sandbox severs outbound loopback
 * WebSockets a few milliseconds after they connect, which reads exactly like a dead daemon.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const HOST = process.env.AI_MCP_HOST || '127.0.0.1';
const PORT = Number(process.env.AI_MCP_PORT || 8791);
const TOKEN = process.env.AI_MCP_TOKEN || '';

const method = process.argv[2];
if (!method) {
  console.error('usage: node scripts/call.mjs <method> [json-params] [timeout-ms]');
  process.exit(2);
}
let params = {};
if (process.argv[3]) {
  // `@path.json` reads the params from a file — PowerShell 5.1 strips the quotes out of an
  // inline JSON argument, which makes anything with code in it impossible to pass.
  const raw = process.argv[3].startsWith('@')
    ? readFileSync(process.argv[3].slice(1), 'utf8').replace(/^﻿/, '')
    : process.argv[3];
  try { params = JSON.parse(raw); }
  catch (e) { console.error('params must be JSON: ' + e.message); process.exit(2); }
}
const timeout = Number(process.argv[4] || 120000);

const ws = new WebSocket(`ws://${HOST}:${PORT}/?role=client${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}`);
const id = randomUUID();
const chunks = [];
let total = null;

const done = (code) => { try { ws.close(); } catch {} process.exit(code); };
const timer = setTimeout(() => { console.error(`timeout after ${timeout}ms calling ${method}`); done(1); }, timeout);

ws.on('open', () => ws.send(JSON.stringify({ kind: 'req', id, method, params })));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === 'notice') return;
  if (msg.kind !== 'res' || msg.id !== id) return;

  let body = msg.body;
  if (msg.total != null && msg.total > 1) {
    total ??= msg.total;
    chunks[msg.seq] = msg.body;
    if (chunks.filter((c) => c != null).length < total) return;
    body = chunks.join('');
  }
  clearTimeout(timer);
  const parsed = JSON.parse(body);
  if (msg.ok) { console.log(JSON.stringify(parsed.data, null, 2)); done(0); }
  else { console.error('ERROR: ' + (parsed.error?.message || 'unknown')); done(1); }
});

ws.on('error', (e) => {
  console.error(
    `Cannot reach the daemon on ws://${HOST}:${PORT} (${e.message}).\n` +
    'Start it with:  node server/src/daemon.js'
  );
  done(1);
});
