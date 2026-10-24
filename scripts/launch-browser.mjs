#!/usr/bin/env node
/*
 * Launch a browser with the bridge extension loaded, using a persistent profile.
 *
 * Sign in to Gemini, Google Flow and ChatGPT in this window once; the profile lives in
 * ~/.ai-mcp/browser-profile and keeps those sessions across restarts.
 *
 * Two Windows-specific facts drive the design, both learned the hard way:
 *
 *   Branded Google Chrome (137+) refuses --load-extension outright — its own log says
 *   "--disable-extensions-except is not allowed in Google Chrome, ignoring" — and then
 *   starts normally with no extension, which is indistinguishable from a broken bridge.
 *   Edge and Opera still honour the switch, so they are tried first. Chrome is perfectly
 *   fine for *using* the bridge; the extension just has to be loaded by hand from
 *   chrome://extensions with Developer mode on.
 *
 *   The extension is staged onto local disk before loading, because a browser silently
 *   declines to load an unpacked extension from a mapped network drive.
 *
 * Usage: node scripts/launch-browser.mjs [--browser <path>] [--open gemini,chatgpt] [--fresh]
 */
import { spawn } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension');
const HOME = join(homedir(), '.ai-mcp');
const PROFILE = join(HOME, 'browser-profile');
const STAGED = join(HOME, 'extension');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };

const SITE_URLS = {
  gemini: 'https://gemini.google.com/app',
  flow: 'https://labs.google/fx/tools/flow',
  chatgpt: 'https://chatgpt.com/',
};

const CANDIDATES = [
  opt('browser'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  join(homedir(), 'AppData/Local/Programs/Opera GX/opera.exe'),
  join(homedir(), 'AppData/Local/Programs/Opera/opera.exe'),
  join(homedir(), 'AppData/Local/Programs/Opera Air/opera.exe'),
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter((p) => p && existsSync(p));

if (!CANDIDATES.length) {
  console.error(
    'No browser found that accepts --load-extension.\n' +
    'Install Microsoft Edge, or load the extension by hand:\n' +
    `  1. Open chrome://extensions  2. Turn on Developer mode  3. "Load unpacked" -> ${SRC}`
  );
  process.exit(2);
}

if (flag('fresh')) { rmSync(PROFILE, { recursive: true, force: true }); }
mkdirSync(HOME, { recursive: true });
rmSync(STAGED, { recursive: true, force: true });
cpSync(SRC, STAGED, { recursive: true });

const open = (opt('open') ?? 'gemini,flow,chatgpt').split(',').map((s) => s.trim()).filter(Boolean);
const urls = open.map((s) => SITE_URLS[s]).filter(Boolean);

const args = [
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${STAGED}`,
  `--load-extension=${STAGED}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  ...(urls.length ? urls : ['about:blank']),
];

for (const path of CANDIDATES) {
  try {
    // cwd is forced local: spawning with a UNC-backed working directory fails with a bare
    // `spawn UNKNOWN` that says nothing about the cause.
    const proc = spawn(path, args, { stdio: 'ignore', detached: true, cwd: tmpdir() });
    proc.unref();
    console.log(
      `Launched ${path}\n` +
      `  profile:   ${PROFILE}\n` +
      `  extension: ${STAGED}  (staged from ${SRC})\n` +
      `  opened:    ${open.join(', ')}\n\n` +
      'Sign in to each site once in this window. The profile keeps those sessions.\n' +
      'Then start the daemon if it is not already running:\n' +
      `  node "${join(ROOT, 'server', 'src', 'daemon.js')}"`
    );
    process.exit(0);
  } catch (e) {
    console.log(`  ..  ${path} would not start (${e.code}); trying the next candidate`);
  }
}
console.error('Every browser candidate failed to launch.');
process.exit(2);
