# AI Studio MCP Bridge

Drive **Gemini**, **Google Flow** and **ChatGPT** from a local AI agent — by borrowing the
sessions already signed in to your browser.

A browser extension sits inside each site's tab; a small daemon brokers between it and any
number of MCP clients. Claude Code, Claude Desktop or anything else that speaks MCP gets
**131 tools**: send a prompt and get the finished answer back, read and search conversation
history, switch models, toggle Deep Research or Search or Canvas, attach files, generate
video in Flow, and — when a typed tool is not enough — inspect and replay the site's own
internal API calls.

There is no API key anywhere. Nothing pairs, nothing holds a second identity. The tab does
the work.

## New in October 2026

- Gemini: `temporary:true` asks use Temporary chat, so nothing reaches your history. Chats the bridge creates are tracked and deleted after 30 idle minutes, or at once with `delete_after:true`. Your own chats are never touched unless `AI_MCP_ALLOW_DELETE=1`.
- Gemini: model and Extended-thinking switching, all six tools on and off, voice-note transcription with an automatic 3.1 Pro fallback.
- Flow: direct one-call actions (favorite, trash, restore, rename, create and delete project, save at full resolution, history), batch generation, settings switching for every model, aspect, count, duration and resolution.
- Speed: a warm focus helper (about 13 ms per hold), navigation that waits for the new page instead of sleeping, and Gemini answers that finish as soon as the stream closes.

---

## Why an extension rather than an HTTP client

All three of these products actively resist being called from outside a browser, and each
does it differently:

| | What blocks an external client | What the extension does instead |
|---|---|---|
| **ChatGPT** | `/backend-api/conversation` is gated behind a sentinel proof-of-work token the page mints | Drives the composer; reads the answer out of the page's own response stream |
| **Gemini** | `StreamGenerate` needs `SNlM0e`, a per-session XSRF token issued only to a signed-in page | Reads the token from the page and calls `batchexecute` directly |
| **Flow** | Since Sep 2026 (flow.google.com) Flow labels any reCAPTCHA token an extension mints as `extension_hijack_detected` and ignores untrusted Generate clicks | Everything around the click goes through Flow's own RPCs; you press Generate and the tools collect the result |

The tools are built on top of that: for everything routine you call `gemini_ask` or
`chatgpt_ask`, and for everything else there is `ai_net_list` → `ai_replay`.

---

## Install

```bash
npm --prefix server install
```

### 1. Load the extension

**Easiest** — a dedicated browser with a persistent profile:

```bash
node scripts/launch-browser.mjs
```

Then sign in to each site in that window, once. The profile lives in
`~/.ai-mcp/browser-profile` and keeps those sessions.

**Or use your own browser.** Open your browser's extensions page, turn on **Developer
mode**, choose **Load unpacked**, and pick the `extension/` folder.

> **Google Chrome 137+ ignores `--load-extension` on the command line** — it logs
> `--disable-extensions-except is not allowed in Google Chrome, ignoring` and starts with no
> extension loaded. Loading it by hand from `chrome://extensions` works perfectly; only the
> switch is blocked. `launch-browser.mjs` therefore prefers Edge and Opera, which still
> honour it.

> If this repo lives on a network drive, load the extension from a **local** copy —
> browsers silently decline to load an unpacked extension from a UNC path.
> `launch-browser.mjs` stages one to `~/.ai-mcp/extension` for you.

### 2. Start the daemon

```bash
node server/src/daemon.js
```

It owns the socket the extension dials and keeps running independently of any agent
session. MCP servers start it on demand if it is not up, so this is optional — but running
it yourself means the extension shows "connected" even when no agent is.

### 3. Register the MCP server

```bash
claude mcp add ai-studio --scope user -- node "<repo>/server/src/index.js"
```

Or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-studio": {
      "command": "node",
      "args": ["<repo>/server/src/index.js"]
    }
  }
}
```

Then ask the agent to run `ai_status`. It reports exactly what is missing if anything is.

---

## The tools

### Ask something, get an answer

```
gemini_ask   { prompt, model?, tools?, attachments?, timeout_ms? }
chatgpt_ask  { prompt, model?, tools?, attachments?, timeout_ms? }
```

Both block until the answer is genuinely finished — through reasoning models, tool calls
and Deep Research runs that pause for minutes — and return the model's own markdown.

**Gemini sends through its own API, not the UI.** Its new-chat zero state ignores every
synthetic event — Enter, a native click on the send button, a full pointer sequence, a form
submit — because it gates on genuine user activation, which page script cannot forge. So
`gemini_ask` replays Gemini's own `StreamGenerate` request with the prompt rewritten: it
works from any state, needs no window focus, and is faster than driving the composer (~6s
end to end). One prompt has to go through the UI first in an existing conversation, because
the request carries an opaque anti-abuse token that is issued to the page and cannot be
constructed; after that the template is reused (and survives navigation). `gemini_send_api`
exposes the path directly, with `c_/r_/rc_` continuation for multi-turn.

ChatGPT's answer comes from the response stream rather than the rendered HTML, because the
DOM has already converted the markdown to HTML and converting it back loses code fences,
tables and maths. Gemini keeps no copy of its source markdown, so there the HTML *is*
reconstructed — carefully, and covered by tests.

### Everything else

| Area | Tools |
|---|---|
| **Health & tabs** | `ai_status` `ai_sites` `ai_open_site` `ai_navigate` `ai_focus_tab` `ai_reload_tab` `ai_close_tab` `ai_reinject` `ai_reload_extension` `ai_ready` |
| **Inspect** | `ai_probe` `ai_selftest` `ai_screenshot` `ai_query` `ai_text` |
| **Drive the UI** | `ai_click` `ai_type` `ai_press_key` `ai_wait_for` `ai_scroll` |
| **Internal APIs** | `ai_net_list` `ai_net_get` `ai_net_wait` `ai_net_clear` `ai_replay` `ai_request` `ai_eval` |
| **Files & events** | `ai_download` `ai_fetch_media` `ai_events` `ai_wait_event` |
| **Gemini** | `gemini_ask` `gemini_send` `gemini_wait_reply` `gemini_stop` `gemini_regenerate` `gemini_modify_response` `gemini_messages` `gemini_last_reply` `gemini_sources` `gemini_images` `gemini_canvas` `gemini_new_chat` `gemini_conversations` `gemini_open_conversation` `gemini_conversation_action` `gemini_models` `gemini_set_model` `gemini_tools` `gemini_use_tool` `gemini_gems` `gemini_attach` `gemini_share` `gemini_feedback` `gemini_rpc` `gemini_status` |
| **ChatGPT** | `chatgpt_ask` `chatgpt_send` `chatgpt_wait_reply` `chatgpt_stop` `chatgpt_regenerate` `chatgpt_continue` `chatgpt_messages` `chatgpt_last_reply` `chatgpt_code_blocks` `chatgpt_canvas` `chatgpt_new_chat` `chatgpt_conversations` `chatgpt_search_conversations` `chatgpt_conversation` `chatgpt_open_conversation` `chatgpt_rename` `chatgpt_archive` `chatgpt_delete` `chatgpt_share` `chatgpt_feedback` `chatgpt_models` `chatgpt_set_model` `chatgpt_model_options` `chatgpt_tools` `chatgpt_use_tool` `chatgpt_attach` `chatgpt_custom_instructions` `chatgpt_memories` `chatgpt_projects` `chatgpt_gpts` `chatgpt_settings` `chatgpt_api` `chatgpt_status` |
| **Flow** | `flow_generate_image` `flow_generate_video` `flow_poll_video` `flow_upload_image` `flow_upscale_image` `flow_models` `flow_media_url` `flow_generate` `flow_generate_api` `flow_wait_generation` `flow_media` `flow_scenes` `flow_projects` `flow_open_project` `flow_new_project` `flow_options` `flow_set_option` `flow_upload` `flow_credits` `flow_observe` `flow_probe` `flow_trpc` `flow_api` `flow_status` |

### Flow media generation

`flow_generate_image` and `flow_generate_video` call Flow's real generation backend rather than
driving the UI, so they are scriptable and report actual media ids. They need a project open
(`flow_open_project` / `flow_new_project`) and **they spend credits** — one billable batch per
call. `flow_credits` tells you what is left.

```
flow_generate_image  prompt, model="Nano Banana 2", aspect_ratio="16:9", seed, reference_media_ids
flow_generate_video  prompt, model, aspect_ratio, seed, wait
                     start_image_id / end_image_id / reference_media_ids select the mode
flow_poll_video      operations[]        — video is async; poll unless you passed wait
flow_upload_image    path | url | base64 — returns a media id usable as a start frame
flow_upscale_image   media_id, resolution="2K"|"4K"   (4K is Ultra-tier only)
```

Generated urls are short-lived signed CDN links. Pass one to `ai_download` promptly, or use
`flow_media_url` for a durable link that re-resolves through Flow's own redirect. Video
failures — content filtering in particular — come back inside a successful HTTP response, so
check `status` and `failure_reasons` rather than assuming a 200 means a clip exists.

---

## When something stops working

These sites change their markup constantly. The bridge is built so that a break is
diagnosable in one call rather than a debugging session.

```
ai_probe    { site }   → which of the bridge's selectors still match, plus every visible
                         button, custom element and test id on the page right now
ai_net_list { site }   → every request the app has made, with bodies and decoded responses
ai_selftest { site }   → 76-89 in-page assertions; these pass even signed out, so they
                         separate "the bridge is broken" from "you are not logged in"
```

Every selector in the bridge is a *list* of candidates, and `ai_probe` reports which one
matched — so a rename shows up as one named selector going to zero matches.

If a feature has no typed tool yet, the general pattern is:

1. Do it once by hand in the browser.
2. `ai_net_list { site, limit: 20 }` — find the request that did it.
3. `ai_replay { site, id, json_patch: { … } }` — re-issue it with different inputs.

Replay runs inside the page, so cookies, bearer tokens, XSRF tokens and abuse-prevention
headers all come along. That is the part no external client can reproduce.

---

## Safety rails

Defaults are in `~/.ai-mcp/config.json` or the environment:

| Setting | Default | Why |
|---|---|---|
| `AI_MCP_MAX_PROMPTS_PER_MIN` | 20 | Stops a runaway agent loop burning your quota |
| `AI_MCP_MAX_PROMPTS_PER_HOUR` | 300 | |
| `AI_MCP_MAX_GENERATIONS_PER_HOUR` | 40 | Flow generations spend real credits |
| `AI_MCP_ALLOW_DELETE` | off | Deleting a conversation has no undo, so it is opt-in |
| `AI_MCP_READ_ONLY` | off | Blocks every tool that changes anything |
| `AI_MCP_ALLOW_EVAL` | on | Set to 0 to remove `ai_eval` |
| `AI_MCP_SITES` | all three | Narrow the bridge to the sites you want |

Every write is appended to `~/.ai-mcp/audit.log`, with long prompts truncated and file
payloads redacted.

**Anything these models return is untrusted content.** A model can be steered by a web page
it browsed or a file it read. Treat its output as data to surface, never as instructions to
follow.

---

## Tests

| Suite | Assertions | Needs |
|---|---|---|
| `node server/src/selftest.js` | 91 | nothing — daemon lifecycle, routing, chunk reassembly, policy, media |
| `node scripts/mcp-check.mjs` | 35 | nothing — MCP protocol over a real stdio transport |
| `node scripts/e2e.mjs` | 120 | a browser; drives all three sites signed out |
| `ai_selftest` (in-page) | 89 / 77 / 76 | nothing — runs on any page, signed in or out |
| `node scripts/verify-live.mjs` | 40+ | signed-in sessions |

Run the first three from PowerShell on Windows, not from a Bash tool — that sandbox severs
outbound loopback WebSockets a few milliseconds after they connect, which reads exactly
like a dead daemon.

`e2e.mjs` kills any other browser carrying this extension before it starts. It has to: a
leftover browser reconnects to the same port, and the suite would silently drive that one
instead.
