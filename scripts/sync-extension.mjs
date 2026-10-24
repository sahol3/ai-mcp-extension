#!/usr/bin/env node
/*
 * Refresh the local copy of the extension that a browser has loaded by hand.
 *
 * Browsers will not load an unpacked extension from a mapped network drive, and this repo
 * lives on one — so a hand-installed extension has to point at a local directory. That
 * directory is `~/.ai-mcp/chrome-extension`, and this script is how it picks up source
 * changes.
 *
 * Deliberately NOT the same directory launch-browser.mjs stages to: that one is wiped and
 * rewritten on every launch, and deleting a directory a browser has registered makes the
 * browser disable the extension.
 *
 * After running this, reload the extension in the browser (chrome://extensions -> the
 * reload arrow, or ai_reload_extension if the bridge is still connected). Reloading the
 * *page* is not enough — browsers cache unpacked extension resources.
 */
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension');
const DEST = join(homedir(), '.ai-mcp', 'chrome-extension');

if (!existsSync(join(SRC, 'manifest.json'))) {
  console.error(`No manifest at ${SRC} — is this the right repo?`);
  process.exit(2);
}

mkdirSync(dirname(DEST), { recursive: true });
// Replace the contents rather than the directory itself, so the path a browser has
// registered never stops existing.
if (existsSync(DEST)) {
  for (const entry of ['page', 'background', 'content', 'popup', 'icons', 'manifest.json']) {
    rmSync(join(DEST, entry), { recursive: true, force: true });
  }
} else {
  mkdirSync(DEST, { recursive: true });
}
cpSync(SRC, DEST, { recursive: true });

const core = readFileSync(join(DEST, 'page', 'core.js'), 'utf8');
const version = /const CORE_VERSION = (\d+)/.exec(core)?.[1] ?? '?';
const manifest = JSON.parse(readFileSync(join(DEST, 'manifest.json'), 'utf8'));

console.log(
  `Synced ${manifest.name} v${manifest.version} (bridge core v${version})\n` +
  `  from: ${SRC}\n` +
  `  to:   ${DEST}\n\n` +
  'Load this folder from your browser\'s extensions page (Developer mode -> Load unpacked),\n' +
  'or press the reload arrow there if it is already loaded.'
);
