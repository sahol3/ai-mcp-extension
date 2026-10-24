#!/usr/bin/env node
/*
 * Mirror the whole bridge onto local disk, so nothing it needs at runtime lives on a
 * network drive.
 *
 * This exists because the failure actually happened: the repo sits on a mapped drive to
 * another machine, that machine slept, and the MCP server vanished mid-session — tools
 * gone, no diagnosis possible, because the diagnostics were on the same drive. The browser
 * extension had already been moved local for a different reason (browsers refuse to load an
 * unpacked extension from a UNC path); this does the same for the server.
 *
 * Layout under ~/.ai-mcp:
 *   chrome-extension/   the unpacked extension the browser loads
 *   server/src/         the MCP server + daemon
 *   server/node_modules installed once, here, and left alone
 *
 * Run it after editing the repo, then reload the extension. The repo stays the source of
 * truth; this is a deployment step, not a fork.
 *
 * Usage: node scripts/sync-local.mjs [--no-install]
 */
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(homedir(), '.ai-mcp');
const EXT_DEST = join(HOME, 'chrome-extension');
const SRV_DEST = join(HOME, 'server');
const noInstall = process.argv.includes('--no-install');

if (!existsSync(join(ROOT, 'extension', 'manifest.json'))) {
  console.error(`No extension at ${ROOT} — is the repo reachable? (a mapped drive that has gone away looks exactly like this)`);
  process.exit(2);
}

mkdirSync(HOME, { recursive: true });

// ---- extension -----------------------------------------------------------
// Replace contents, not the directory: a browser that has registered this path must never
// see it disappear, or it disables the extension.
mkdirSync(EXT_DEST, { recursive: true });
for (const entry of ['page', 'background', 'content', 'popup', 'icons', 'manifest.json']) {
  rmSync(join(EXT_DEST, entry), { recursive: true, force: true });
}
cpSync(join(ROOT, 'extension'), EXT_DEST, { recursive: true });

// ---- server --------------------------------------------------------------
mkdirSync(join(SRV_DEST, 'src'), { recursive: true });
rmSync(join(SRV_DEST, 'src'), { recursive: true, force: true });
cpSync(join(ROOT, 'server', 'src'), join(SRV_DEST, 'src'), { recursive: true });
cpSync(join(ROOT, 'server', 'package.json'), join(SRV_DEST, 'package.json'));

let installed = existsSync(join(SRV_DEST, 'node_modules', '@modelcontextprotocol'));
if (!installed && !noInstall) {
  console.log('Installing server dependencies locally (once)...');
  try {
    // execSync, not execFileSync: Node refuses to spawn a .cmd without a shell since the
    // 2024 argument-injection fix (bare EINVAL, no explanation), and passing an argv array
    // with shell:true then trips a deprecation warning. One command string avoids both.
    execSync('npm install --no-audit --no-fund', {
      cwd: SRV_DEST, stdio: 'inherit',
      // npm resolves its cache relative to cwd on some setups; keep it off the network drive.
      env: { ...process.env, npm_config_cache: join(HOME, '.npm-cache') },
    });
    installed = existsSync(join(SRV_DEST, 'node_modules', '@modelcontextprotocol'));
  } catch (e) {
    console.error('npm install failed: ' + e.message);
  }
}

const core = readFileSync(join(EXT_DEST, 'page', 'core.js'), 'utf8');
const version = /const CORE_VERSION = (\d+)/.exec(core)?.[1] ?? '?';
const manifest = JSON.parse(readFileSync(join(EXT_DEST, 'manifest.json'), 'utf8'));

// A stamp so a stale mirror is obvious rather than mysterious.
writeFileSync(join(HOME, 'MIRROR.json'), JSON.stringify({
  synced_at: new Date().toISOString(), from: ROOT, core_version: Number(version), extension_version: manifest.version,
}, null, 2));

console.log(
  `Mirrored ${manifest.name} v${manifest.version} (bridge core v${version})\n` +
  `  from:      ${ROOT}\n` +
  `  extension: ${EXT_DEST}\n` +
  `  server:    ${join(SRV_DEST, 'src', 'index.js')}  ${installed ? '(deps present)' : '(DEPS MISSING — run npm install there)'}\n\n` +
  'Point the MCP client at the LOCAL server so it survives the drive going away:\n' +
  `  claude mcp remove ai-studio --scope user\n` +
  `  claude mcp add ai-studio --scope user -- node "${join(SRV_DEST, 'src', 'index.js')}"\n\n` +
  'Then reload the extension in the browser (chrome://extensions reload arrow, or ai_reload_extension).'
);
