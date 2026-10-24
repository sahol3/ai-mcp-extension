import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

/*
 * What the bridge itself created, per product.
 *
 * The operator uses the same Gemini and Flow accounts by hand, so agent work (transcription
 * chats, image runs, test projects) used to pile up in their personal history. Everything the
 * bridge creates is recorded here, and only what is recorded can be deleted without
 * AI_MCP_ALLOW_DELETE — cleanup can never reach something the operator made themselves.
 *
 * Plain JSON in the data dir, written atomically (tmp + rename) because several MCP server
 * processes can run at once and a torn write would lose the record of what is safe to delete.
 */
export const normId = (id) => (id ? String(id).replace(/^c_/, '').replace(/^projects\//, '').trim() || null : null);

function makeLedger(name) {
  const FILE = () => join(config.dataDir, `${name}-ledger.json`);
  const read = () => {
    try {
      const l = JSON.parse(readFileSync(FILE(), 'utf8'));
      return { items: l.items ?? l.conversations ?? {} };
    } catch {
      return { items: {} };
    }
  };
  const write = (l) => {
    const tmp = FILE() + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify({ items: l.items }, null, 1));
    renameSync(tmp, FILE());
  };
  return {
    all: () => read().items,
    record(id, meta = {}) {
      const n = normId(id);
      if (!n) return null;
      const l = read();
      const now = new Date().toISOString();
      const prev = l.items[n];
      l.items[n] = { created_at: prev?.created_at ?? now, ...prev, ...meta, last_used: now };
      write(l);
      return l.items[n];
    },
    touch(id) {
      const n = normId(id);
      const l = read();
      if (!n || !l.items[n]) return;
      l.items[n].last_used = new Date().toISOString();
      write(l);
    },
    has: (id) => { const n = normId(id); return !!(n && read().items[n]); },
    forget(ids) {
      const l = read();
      for (const id of ids) delete l.items[normId(id)];
      write(l);
    },
    /** Recorded items idle for at least `minutes`, oldest first; `keep` ones never qualify. */
    idle(minutes) {
      const cutoff = Date.now() - minutes * 60000;
      return Object.entries(read().items)
        .filter(([, v]) => !v.keep && Date.parse(v.last_used ?? v.created_at ?? 0) <= cutoff)
        .sort((a, b) => Date.parse(a[1].last_used) - Date.parse(b[1].last_used))
        .map(([id, v]) => ({ id, ...v }));
    },
  };
}

export const geminiLedger = makeLedger('gemini');
export const flowLedger = makeLedger('flow');

// Gemini-flavoured names used by tools.js.
export const readLedger = () => ({ conversations: geminiLedger.all() });
export const recordConversation = (id, meta) => geminiLedger.record(id, meta);
export const touchConversation = (id) => geminiLedger.touch(id);
export const isRecorded = (id) => geminiLedger.has(id);
export const forgetConversations = (ids) => geminiLedger.forget(ids);
export const idleConversations = (minutes) => geminiLedger.idle(minutes).map(({ id, ...v }) => ({ conversation_id: id, ...v }));
