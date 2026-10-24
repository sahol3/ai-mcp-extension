import { appendFileSync } from 'node:fs';
import { config } from './config.js';

/** Tools that change something — in a conversation, an account, or a project. */
export const WRITE_TOOLS = new Set([
  'gemini_ask', 'gemini_send', 'gemini_send_api', 'gemini_regenerate', 'gemini_modify_response', 'gemini_new_chat',
  'gemini_attach', 'gemini_set_model', 'gemini_use_tool', 'gemini_select_gem', 'gemini_share',
  'gemini_feedback', 'gemini_conversation_action', 'gemini_rpc', 'gemini_send_api',
  'gemini_delete_conversation', 'gemini_temporary_chat',
  'chatgpt_ask', 'chatgpt_send', 'chatgpt_regenerate', 'chatgpt_continue', 'chatgpt_new_chat',
  'chatgpt_attach', 'chatgpt_set_model', 'chatgpt_use_tool', 'chatgpt_rename', 'chatgpt_archive',
  'chatgpt_delete', 'chatgpt_share', 'chatgpt_feedback', 'chatgpt_custom_instructions',
  'chatgpt_memories', 'chatgpt_api',
  'flow_generate', 'flow_generate_api', 'flow_generate_image', 'flow_generate_video',
  'flow_upscale_image', 'flow_upload_image', 'flow_new_project', 'flow_open_project',
  'flow_set_option', 'flow_upload', 'flow_trpc', 'flow_api', 'flow_configure', 'flow_set_prompt', 'flow_rpc',
  'flow_create_project', 'flow_generate_batch', 'flow_save', 'flow_favorite', 'flow_delete_media', 'flow_restore', 'flow_rename', 'flow_delete_project',
  'ai_click', 'ai_type', 'ai_press_key', 'ai_scroll', 'ai_eval', 'ai_request', 'ai_replay', 'ai_fetch_media',
  'ai_open_site', 'ai_navigate', 'ai_reload_tab', 'ai_close_tab', 'ai_download', 'ai_reload_extension',
]);

/** The subset that actually consumes a model turn — the ones worth rate limiting. */
export const PROMPT_TOOLS = new Set([
  'gemini_ask', 'gemini_send', 'gemini_send_api', 'gemini_regenerate', 'gemini_modify_response',
  'chatgpt_ask', 'chatgpt_send', 'chatgpt_regenerate', 'chatgpt_continue',
]);

/**
 * Flow generations cost credits, so they get their own budget.
 *
 * `flow_upscale_image` is in here too: it is billed like a generation, not like a read.
 */
export const GENERATE_TOOLS = new Set([
  'flow_generate', 'flow_generate_api', 'flow_generate_image', 'flow_generate_video', 'flow_upscale_image',
]);

/** Irreversible from the agent's side. Off by default; the user opts in. */
export const DELETE_TOOLS = new Set(['chatgpt_delete', 'gemini_conversation_action', 'chatgpt_memories']);

/*
 * The gate is honest about its own limits: the generic escape hatches (chatgpt_api,
 * ai_replay, ai_request, gemini_rpc, flow_api) can all reproduce a delete by hand, so
 * AI_MCP_ALLOW_DELETE=0 constrains the typed tools, not the bridge as a whole. Use
 * AI_MCP_READ_ONLY=1 when that distinction matters.
 */

const minuteWindow = [];
const hourWindow = [];
const generateWindow = [];

function trim(arr, ms, now) {
  while (arr.length && now - arr[0] > ms) arr.shift();
}

export class PolicyError extends Error {}

/** Which site a tool belongs to, for the enabled-sites gate. */
export function siteOfTool(tool) {
  const m = /^(gemini|chatgpt|flow)_/.exec(tool);
  return m ? m[1] : null;
}

export function checkPolicy(tool, args = {}) {
  if (config.readOnly && WRITE_TOOLS.has(tool)) {
    throw new PolicyError(`read_only_mode: "${tool}" is blocked. Unset AI_MCP_READ_ONLY to allow writes.`);
  }
  if (tool === 'ai_eval' && !config.allowEval) {
    throw new PolicyError('eval_disabled: set AI_MCP_ALLOW_EVAL=1 to enable ai_eval.');
  }

  const site = siteOfTool(tool) ?? (typeof args.site === 'string' ? args.site : null);
  if (site && config.enabledSites.length && !config.enabledSites.includes(site)) {
    throw new PolicyError(
      `site_disabled: "${site}" is not in AI_MCP_SITES (currently ${config.enabledSites.join(', ')}).`
    );
  }

  if (DELETE_TOOLS.has(tool) && !config.allowDelete) {
    const destructive =
      tool === 'chatgpt_delete' ? true
      : tool === 'gemini_conversation_action' ? /delete/i.test(String(args.action ?? ''))
      : tool === 'chatgpt_memories' ? (!!args.clear || !!args.delete_id)   // reading memories is harmless
      : true;
    if (destructive) {
      throw new PolicyError(
        `delete_disabled: "${tool}" removes a conversation and there is no undo in these products. ` +
        'Set AI_MCP_ALLOW_DELETE=1 (or allowDelete:true in ~/.ai-mcp/config.json) to permit it.'
      );
    }
  }

  const now = Date.now();
  if (PROMPT_TOOLS.has(tool)) {
    trim(minuteWindow, 60_000, now);
    trim(hourWindow, 3_600_000, now);
    if (config.maxPromptsPerMinute > 0 && minuteWindow.length >= config.maxPromptsPerMinute) {
      throw new PolicyError(
        `rate_limited: ${config.maxPromptsPerMinute} prompts/minute reached. This guard exists to stop runaway ` +
        'agent loops; raise it with AI_MCP_MAX_PROMPTS_PER_MIN if intentional.'
      );
    }
    if (config.maxPromptsPerHour > 0 && hourWindow.length >= config.maxPromptsPerHour) {
      throw new PolicyError(`rate_limited: ${config.maxPromptsPerHour} prompts/hour reached (AI_MCP_MAX_PROMPTS_PER_HOUR).`);
    }
    minuteWindow.push(now);
    hourWindow.push(now);
  }

  if (GENERATE_TOOLS.has(tool)) {
    trim(generateWindow, 3_600_000, now);
    if (config.maxGenerationsPerHour > 0 && generateWindow.length >= config.maxGenerationsPerHour) {
      throw new PolicyError(
        `generation_rate_limited: ${config.maxGenerationsPerHour} Flow generations/hour reached. Each one spends ` +
        'real credits, which is why the ceiling is low. Raise it with AI_MCP_MAX_GENERATIONS_PER_HOUR.'
      );
    }
    generateWindow.push(now);
  }
}

export function audit(tool, args, outcome) {
  if (!config.audit || !WRITE_TOOLS.has(tool)) return;
  const redacted = { ...args };
  for (const k of ['base64', 'picture_base64', 'data_url', 'image_base64']) {
    if (redacted[k]) redacted[k] = `<${String(redacted[k]).length} chars>`;
  }
  if (typeof redacted.prompt === 'string' && redacted.prompt.length > 400) {
    redacted.prompt = redacted.prompt.slice(0, 400) + `…(${redacted.prompt.length} chars)`;
  }
  const line = JSON.stringify({ at: new Date().toISOString(), tool, args: redacted, outcome }) + '\n';
  try { appendFileSync(config.logPath, line); } catch {}
}

export function rateStatus() {
  const now = Date.now();
  trim(minuteWindow, 60_000, now);
  trim(hourWindow, 3_600_000, now);
  trim(generateWindow, 3_600_000, now);
  return {
    prompts_last_minute: minuteWindow.length,
    prompts_last_hour: hourWindow.length,
    generations_last_hour: generateWindow.length,
    limit_prompts_per_minute: config.maxPromptsPerMinute,
    limit_prompts_per_hour: config.maxPromptsPerHour,
    limit_generations_per_hour: config.maxGenerationsPerHour,
    read_only: config.readOnly,
    eval_enabled: config.allowEval,
    delete_enabled: config.allowDelete,
    enabled_sites: config.enabledSites,
  };
}
