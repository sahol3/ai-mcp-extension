import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';

const DATA_DIR = resolve(process.env.AI_MCP_DATA_DIR || join(homedir(), '.ai-mcp'));
mkdirSync(DATA_DIR, { recursive: true });

const bool = (v, dflt) => {
  if (v === undefined || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v));
};
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

let fileCfg = {};
const cfgPath = join(DATA_DIR, 'config.json');
if (existsSync(cfgPath)) {
  try {
    fileCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`[ai-mcp] ignoring malformed ${cfgPath}: ${e.message}\n`);
  }
}

const pick = (envKey, fileKey, dflt) =>
  process.env[envKey] !== undefined ? process.env[envKey] : fileCfg[fileKey] !== undefined ? fileCfg[fileKey] : dflt;

export const config = {
  dataDir: DATA_DIR,
  mediaDir: join(DATA_DIR, 'media'),
  profileDir: join(DATA_DIR, 'browser-profile'),
  logPath: join(DATA_DIR, 'audit.log'),
  daemonLogPath: join(DATA_DIR, 'daemon.log'),
  configPath: cfgPath,

  // 8788 belongs to the WhatsApp bridge on this machine; these are deliberately different
  // so both can run at once.
  host: String(pick('AI_MCP_HOST', 'host', '127.0.0.1')),
  port: num(pick('AI_MCP_PORT', 'port', 8791), 8791),
  token: String(pick('AI_MCP_TOKEN', 'token', '') || ''),

  timeoutMs: num(pick('AI_MCP_TIMEOUT_MS', 'timeoutMs', 90000), 90000),
  // Answers can take minutes: Deep Research on Gemini, o-series reasoning on ChatGPT, and
  // any Veo generation on Flow. A short default here reads as "the bridge is broken".
  askTimeoutMs: num(pick('AI_MCP_ASK_TIMEOUT_MS', 'askTimeoutMs', 600000), 600000),
  generateTimeoutMs: num(pick('AI_MCP_GENERATE_TIMEOUT_MS', 'generateTimeoutMs', 1200000), 1200000),

  // Start the shared daemon on demand when nobody else has. Turn off if you manage it
  // yourself and want a missing daemon to be a hard error.
  autoSpawn: bool(pick('AI_MCP_AUTOSPAWN', 'autoSpawn', true), true),

  // Safety rails. None of these block ordinary use; they stop runaway loops.
  readOnly: bool(pick('AI_MCP_READ_ONLY', 'readOnly', false), false),
  allowEval: bool(pick('AI_MCP_ALLOW_EVAL', 'allowEval', true), true),
  allowDelete: bool(pick('AI_MCP_ALLOW_DELETE', 'allowDelete', false), false),
  // Gemini conversations the bridge created (gemini-ledger.json) are deleted once idle this
  // long, so agent work does not pile up in the operator's personal history. 0 disables.
  // Deleting a conversation the bridge did NOT create still needs allowDelete.
  geminiAutoDeleteMinutes: num(pick('AI_MCP_GEMINI_AUTODELETE_MIN', 'geminiAutoDeleteMinutes', 30), 30),
  maxPromptsPerMinute: num(pick('AI_MCP_MAX_PROMPTS_PER_MIN', 'maxPromptsPerMinute', 20), 20),
  maxPromptsPerHour: num(pick('AI_MCP_MAX_PROMPTS_PER_HOUR', 'maxPromptsPerHour', 300), 300),
  // Flow generations cost real credits, so they get their own, much tighter budget.
  maxGenerationsPerHour: num(pick('AI_MCP_MAX_GENERATIONS_PER_HOUR', 'maxGenerationsPerHour', 40), 40),
  enabledSites: list(pick('AI_MCP_SITES', 'sites', 'gemini,flow,chatgpt')),
  audit: bool(pick('AI_MCP_AUDIT', 'audit', true), true),

  // Payload shaping
  inlineImageMaxBytes: num(pick('AI_MCP_INLINE_IMAGE_MAX', 'inlineImageMaxBytes', 1_500_000), 1_500_000),
  eventBufferSize: num(pick('AI_MCP_EVENT_BUFFER', 'eventBufferSize', 3000), 3000),
  maxTextChars: num(pick('AI_MCP_MAX_TEXT_CHARS', 'maxTextChars', 400_000), 400_000),
};

mkdirSync(config.mediaDir, { recursive: true });
