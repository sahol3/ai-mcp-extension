# Gemini Web `StreamGenerate` wire protocol

Research notes for driving `gemini.google.com` from **inside the page** (extension content
script / injected script), bypassing the UI.

- **Compiled:** 2026-08-13
- **Target build (observed live):** `boq_assistant-bard-web-server_20260807.01_p1`
- **Status:** research only — nothing here has been executed against the live endpoint by
  the author of this document.

## Confidence legend

Every claim below carries one of these tags. **Do not treat (C) as fact.**

| Tag | Meaning |
|---|---|
| **(A)** | Corroborated by 2+ *independent* implementations |
| **(B)** | Single source |
| **(C)** | Inference / my reasoning, not directly observed in any source |
| **(!)** | **Sources actively disagree** — read the note before implementing |

## Sources read (raw source, in full)

| # | Project | Lang | Files read | Last touched | Independent? |
|---|---|---|---|---|---|
| S1 | [`HanaokaYuzu/Gemini-API`](https://github.com/HanaokaYuzu/Gemini-API) | Python | `constants.py`, `client.py`, `utils/parsing.py` | **2026-04-13** | yes |
| S2 | [`n0madic/go-gemini-web2api`](https://github.com/n0madic/go-gemini-web2api) | Go | `pkg/gemini/client.go`, `models.go` | 2026-06-01 | **NO — self-described port of S1** |
| S3 | [`xtekky/gpt4free`](https://github.com/xtekky/gpt4free) | Python | `Provider/needs_auth/Gemini.py`, `gemini_utils.py` | **2026-08-06** | yes |
| S4 | [`Sophomoresty/gemini-web2api`](https://github.com/Sophomoresty/gemini-web2api) | Python + **JS** | `gemini_web2api/gemini.py`, `models.py`, `cloudflare/worker.js` | **2026-08-11** | yes |

> **Important caveat on S2.** Its own comments say "ported from HanaokaYuzu's
> `compute_capacity`" and it reproduces S1's field layout exactly. **S1+S2 agreeing is one
> data point, not two.** Where I write (A) for a field, it means at least two of
> {S1/S2 as one unit, S3, S4} agree.
>
> **Recency matters more than usual here.** S1 (and therefore S2) has not been touched since
> **April 2026** — four months before your build. S3 (Aug 6) and S4 (Aug 11) bracket your
> build date of Aug 7. Where old and new sources conflict, **prefer S3/S4**.

---

## 0. TL;DR for the implementer

```
POST https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
     ?bl=<build label>&hl=en&_reqid=<int>&rt=c[&f.sid=<sid>]

Content-Type: application/x-www-form-urlencoded;charset=utf-8
X-Same-Domain: 1

f.req=<urlenc( JSON.stringify([null, JSON.stringify(inner)]) )>&at=<urlenc(SNlM0e)>
```

`inner` is a **sparse array of ~100 slots**, almost all `null`. The prompt lives at
`inner[0][0]`; conversation continuation lives at `inner[2]`; the model lives at `inner[79]`
(new) and/or an HTTP header (old).

---

## 1. The `f.req` payload

### 1.1 Outer envelope — **(A)**, all four sources, byte-identical

```js
outer = [null, JSON.stringify(inner)]         // inner is DOUBLE-ENCODED as a string
body  = "f.req=" + encodeURIComponent(JSON.stringify(outer))
      + "&at="   + encodeURIComponent(xsrfToken)
```

Note this is **not** the `batchexecute` envelope. `batchexecute` uses
`[[[rpcid, payload, null, "generic"]]]`; `StreamGenerate` uses the bare `[null, "<json>"]`
form with **no rpcid**. **(A)** — S1 and S3 both build both shapes, and they differ exactly
this way.

### 1.2 Inner array — field map

Union of all four sources. "Set by" lists which sources populate the slot.

| Idx | Value | Set by | Confidence | Meaning |
|---|---|---|---|---|
| **0** | `[prompt, 0, null, fileRefs\|null, null, null, 0]` | S1 S2 S3 S4 | **(A)** | **The prompt.** `prompt` is a plain string at `inner[0][0]`. |
| **1** | `["en"]` | S1 S2 S3 S4 | **(A)** | Language, matches the `hl` query param. |
| **2** | `[cid, rid, rcid, null,null,null,null,null,null, ""]` | S1 S3 (S2/S4 send empties) | **(A)** | **Conversation continuation.** See §1.3. |
| 3 | `"!" + 2600 random urlsafe chars` | S1 only | (B) | Deep-research only. Omit. |
| 4 | `uuid4().hex` | S1 only | (B) | Deep-research only. Omit. |
| **6** | `[1]` **or** `[0]` | all | **(!)** | S1/S2/S3 → `[1]`; S4 → `[0]`. See §1.4. |
| **7** | `1` | S1 S2 S3 S4 | **(A)** | **Streaming flag.** S1 names it `STREAMING_FLAG_INDEX`. |
| 9 | `tools` | S3 only | (B) | Tool/extension list. Omit. |
| **10** | `1` | S1 S2 S3 S4 | **(A)** | Streaming/output flag. |
| **11** | `0` | S1 S2 S3 S4 | **(A)** | S4 comments: safety filter level (0=basic,1=strict,2=strictest) — **(B)** for that meaning. |
| **17** | `[[n]]` | all | **(!)** | S1/S2: constant `[[0]]`. S3: `[[turn_index]]`. S4: `[[think_mode]]`. See §1.4. |
| **18** | `0` | S1 S2 S3 S4 | **(A)** | S4: "expanded thinking flag". |
| 19 | `gem_id` | S1 only | (B) | Gem (custom bot) id. Omit unless targeting a Gem. |
| **27** | `1` | S1 S2 S3 S4 | **(A)** | Unknown constant. |
| 31 | `2` | S4 (`pro-enhanced` only) | (B) | Experimental. Omit. |
| **30** | `[4]` | S1 S2 S3 S4 | **(A)** | Output format. Mirrors the `[4]` inside the jspb model header. |
| **41** | `[1]` **or** `[2]` | all | **(!)** | Chat persistence. See §1.4 — **this one has real user-visible consequences.** |
| 45 | `1` | S1 S4 | (A) | **Temporary chat** flag (S1 names it `TEMPORARY_CHAT_FLAG_INDEX`). Only with `41=[1]`. |
| 49 | `1` | S1 only | (B) | Deep research. Omit. |
| **53** | `0` | S1 S2 S3 S4 | **(A)** | Unknown constant. |
| 54, 55 | `[[[[[1]]]]]`, `[[1]]` | S1 only | (B) | Deep research. Omit. |
| **59** | `"<UUID v4>"` | S1 S2 S3 S4 | **(A)** | **Per-request UUID. Must equal the `x-goog-ext-525005358-jspb` header value.** S1/S2 uppercase it; S3 uppercases; S4 does not. Case appears not to matter — **(C)**. |
| **61** | `[]` | S1 S2 S3 S4 | **(A)** | **Must serialize as `[]`, not `null`** — S2 comments this explicitly. |
| **68** | `2` **or** `1` | all | **(!)** | S1/S2/S3 → `2`; S4 → `1`. See §1.4. |
| **79** | `<int mode>` | S3 S4 | **(A)** | **Model selection (new scheme).** See §2.2. S4 calls it "最关键的字段" (the single most critical field). Absent from S1/S2 (their arrays are only 69 long). |
| 80 | `2` if expanded thinking else `1` | S3 | (B) | S4 uses `3` for `pro-enhanced`. Conflicting semantics — omit. |
| 91 | `0` | S3 only | (B) | Unknown. |
| 96 | `1` on first turn, `0` on follow-ups | S3 only | (B) | First-turn marker. |

**Array length — (!)**: S1/S2 allocate **69**, S3 **97**, S4 **102**. Since the highest index
any recent source sets is 96, allocating **~102 and letting the tail be `null`** is the safe
choice — **(C)**, but low-risk: trailing nulls are how this protobuf-over-JSON encoding
represents unset fields, so an over-long array of nulls should be semantically identical to a
short one. The *reverse* (a 69-slot array) makes `inner[79]` unrepresentable, which is why the
old sources have to select the model via header instead.

### 1.3 Conversation continuation — `inner[2]` — **(A)**

`inner[2]` is a 10-element metadata array:

```js
inner[2] = [conversationId, responseId, candidateId, null,null,null,null,null,null, contextString]
//            c_<hex>          r_<hex>      rc_<hex>                                    usually ""
```

- Slot 0 = `cid` (`c_…`), slot 1 = `rid` (`r_…`), slot 2 = `rcid` (`rc_…`). **(A)** — S1
  exposes exactly these as `ChatSession.cid/.rid/.rcid` properties backed by
  `__metadata[0]/[1]/[2]`; S3 independently builds
  `[conversation.conversation_id, conversation.response_id, conversation.choice_id, …]`.
- **New conversation:** send `["", "", "", null×6, ""]` — empty strings, **not** nulls.
  **(A)**, all four sources (S1's `DEFAULT_METADATA`, S2/S4 hardcode it).
- Slot 9 is a "context" string that S1 round-trips from response field `[25]` — **(B)**.
  Sending `""` is what every source does for a fresh chat.

The `c_` / `r_` / `rc_` prefixes are only ever produced by the server; you echo them back
verbatim.

### 1.4 The four real disagreements

These are the fields where you can silently get wrong behaviour. Ranked by risk:

1. **`inner[41]` (+ `inner[45]`) — chat persistence. Highest risk.**
   - S4: `[41]=[2]` for a **normal, persisted** chat; `[41]=[1]` **and** `[45]=1` for a
     **temporary** chat.
   - S1: always `[41]=[1]`, and adds `[45]=1` only when the caller asks for a temporary chat.
   - **Inference (C):** S4's mapping is self-consistent and newer, and it implies S1's default
     (`[41]=[1]`, no `[45]`) is a stale/ambiguous encoding. If your bridge should behave like
     the visible UI (conversation appears in the sidebar), **`[41]=[2]`** is the better bet.
     If the chat unexpectedly does *not* persist, this is the field to flip first.
2. **`inner[17]` — meaning genuinely unknown.** Three sources, three different stories
   (`[[0]]` constant / `[[turn_index]]` / `[[think_mode]]`). S4's reading is the best-evidenced
   because S4 says it was derived by reading the Gemini frontend bundle
   (`028-6eb337387583.js`) rather than by black-box guessing — **(B)**. Note all three agree on
   the *shape* `[[int]]`, and `[[0]]` is a valid value under every interpretation, so
   **`[[0]]` is the safe default** for a first turn — **(C)**.
3. **`inner[68]` — `2` (S1/S2/S3) vs `1` (S4).** No source explains it. Majority + the fact
   that S3 is nearly as recent as S4 favours **`2`** — **(C)**.
4. **`inner[6]` — `[1]` (S1/S2/S3) vs `[0]` (S4).** S4 comments it as "continuous
   conversation flag". Under that reading `[0]` = new chat and `[1]` = continuing, which would
   make S1/S3 wrong for fresh chats — or S4 wrong for continuations. Unresolved. Majority
   favours **`[1]`** — **(C)**. If continuation misbehaves, try `[0]` on turn 1.

---

## 2. Model selection

### 2.1 The `x-goog-ext-525001261-jspb` header — **(A)**

Format, identical in S1, S2 and S3 (S3's `build_model_headers` constructs it programmatically):

```
[1,null,null,null,"<MODEL_ID_HEX>",null,null,0,[4],null,null,<CAPACITY>]
```

and when `capacity_field == 13`, an extra `null` is inserted before the capacity:

```
[1,null,null,null,"<MODEL_ID_HEX>",null,null,0,[4],null,null,null,<CAPACITY>]
```

**(A)** — S2's `selectionHeader()` and S3's `build_model_headers()` implement this identically
and independently.

Companion headers, always sent alongside — **(A)** (S1, S2, S3):

```
x-goog-ext-73010989-jspb: [0]
x-goog-ext-73010990-jspb: [0]
x-goog-ext-525005358-jspb: ["<the same UUID as inner[59]>",1]
```

The generic/no-model variant used on the model-listing RPC — **(A)** (S2, S3):

```
x-goog-ext-525001261-jspb: [1,null,null,null,null,null,null,null,[4]]
```

**Known model ids (hex).** Corroborated by S1's `Model` enum and S3's `KNOWN_MODEL_IDS`
independently — **(A)** — but these are **April 2026 vintage** and *may be stale for your
build*:

| Hex model id | Family | Slug (S1) |
|---|---|---|
| `9d8ca3786ebdfbea` | pro | `gemini-3-pro` |
| `fbb127bbb056c959` | flash | `gemini-3-flash` |
| `5bf011840784117a` | thinking | `gemini-3-flash-thinking` |
| `e6fa609c3fa255c0` | pro (plus/advanced) | `gemini-3-pro-plus` / `-advanced` |
| `56fdd199312815e2` | flash (plus/advanced) | `gemini-3-flash-plus` / `-advanced` |
| `e051ce1aa80aa576` | thinking (plus/advanced) | `gemini-3-flash-thinking-plus` / `-advanced` |

Capacity tail: `1` = basic, `2` = advanced, `4` = plus (S1's enum) — **(B)**. S3 computes it
from account flags instead — **(B)**:

```python
if 21 in tier_flags:               return 1, 13
if 22 in tier_flags:               return 2, 13
if 115 in capability_flags:        return 4, 12
if 16 in tier_flags or 106 in capability_flags: return 3, 12
if 8 in tier_flags or (106 not in capability_flags and 19 in capability_flags): return 2, 12
return 1, 12
```

**Do not hardcode the hex ids.** They are account- and build-specific. §5 gives the discovery
call.

### 2.2 `inner[79]` — the newer scheme — **(A)** (S3 + S4)

Both August-2026 sources select the model with a small integer in the body. S4 states the enum
was lifted from the frontend bundle's `MODE_CATEGORY` — **(B)** for the names, **(A)** for the
mechanism:

| `inner[79]` | MODE_CATEGORY | S4 slug | S3 slug |
|---|---|---|---|
| 1 | `FAST` | `gemini-3.6-flash` | `gemini-3.6-flash` |
| 2 | `THINKING` | `gemini-3.5-flash-thinking` | — |
| 3 | `PRO` | `gemini-3.1-pro` | `gemini-3.1-pro` |
| 4 | `AUTO` | `gemini-auto` | — |
| 5 | `FAST_DYNAMIC_THINKING` | `gemini-3.5-flash-thinking-lite` | — |
| 6 | `FLASH_LITE` | `gemini-flash-lite` | `gemini-3.5-flash-lite` |

**Critical interaction — (B), S3, and it is the kind of failure you asked to avoid:**

> "Request field 79 selects the model. **Pro additionally needs the account-specific model
> header or Google silently routes it to Flash.**"

S3 sends the jspb model header **only** for the `pro` family and omits it otherwise. It also
detects the silent downgrade by reading the **routed model name back out of response field
`[42]`** and comparing — see §3.5. **If you care about getting Pro, you must both set
`inner[79]=3` and send the header, then verify via `[42]`.**

**Recommendation (C):** set `inner[79]`, and additionally send the jspb headers when you have
a discovered model id. The two mechanisms coexist in S3 without conflict.

---

## 3. Response format

### 3.1 Envelope — **(A)**, all four sources

1. Body starts with the XSSI guard `)]}'` — strip 4 chars, then `lstrip()` whitespace.
2. Then a sequence of length-prefixed frames: `<decimal length>\n<json>\n`.
3. Each frame's JSON is an **array of rows**; flatten (`extend`) rather than append.

### 3.2 The length prefix — **(A)** (S1 and S3 implement identically), and subtle

- The length counts **UTF-16 code units**, i.e. JavaScript `String.length`. S1's comment says
  so explicitly; S3 reimplements the same `_utf16_char_count` helper.
- **The count starts immediately after the digits**, so the `\n` following the number **is
  included** in the count. Both implementations compute `start = match.start() + len(digits)`.
- Consequence for us: **in JS this is trivially easy** — no surrogate-pair arithmetic needed,
  because `String.prototype.length` is already UTF-16 units — **(C)**, but a direct
  consequence of the above.
- If fewer units than the declared length have arrived, **keep the bytes in the buffer** and
  wait for more; do not attempt a partial parse.

### 3.3 Row shape — **(A)**, all four sources

```js
row = ["wrb.fr", <rpcid|null>, "<inner JSON as a string>", ...]
```

Filter on `row[0] === "wrb.fr"`, then `JSON.parse(row[2])`. S4 and S2 additionally require
`line.length >= 200` as a cheap noise filter — that's a heuristic, not protocol — **(B)**.

### 3.4 Index paths into the parsed inner body

Let `body = JSON.parse(row[2])`.

| Path | Meaning | Confidence |
|---|---|---|
| `body[1][0]` | **new `cid`** (`c_…`) | **(A)** — S1 (`m_data[0]`), S3 (`response_part[1][0]`) |
| `body[1][1]` | **new `rid`** (`r_…`) | **(A)** — S1, S3 |
| `body[4]` | **candidates array** | **(A)** — all four |
| `body[4][i][0]` | **`rcid`** (`rc_…`) of candidate *i* | **(A)** — S1 (`candidate[0]`), S3 (`response_part[4][0][0]`) |
| `body[4][i][1][0]` | **answer text** (cumulative snapshot) | **(A)** — all four (S2/S3/S4 iterate all strings in `[1]`; S1 takes `[1][0]`) |
| `body[4][i][37][0][0]` | thinking / reasoning text | **(A)** — S1, S3 |
| `body[4][i][8][0] === 2` | this candidate is **complete** | (B) — S1 |
| `body[4][i][22][0]` | text override when `[1][0]` is a `card_content` URL | (B) — S1 |
| `body[4][i][12][1]` | web images | (B) — S1 |
| `body[4][i][12][7][0]` | generated images | (B) — S1, partially S3 |
| `body[42]` | **actually-routed model name** (string) | (B) — S3; use it to detect silent Pro→Flash downgrade |
| `body[25]` | context string → goes to `inner[2][9]` next turn | (B) — S1 |
| `body[2]["11"]` | generated chat title | (B) — S3 |
| `body[27][0][0][3]` | `[seconds, nanos]` timestamp | (B) — S1 |

**Error path is on the *row*, not the body** — **(A)** (S1 and S3 both):

```js
errorCode = row[5][2][0][1][0]      // note: index 5 of the wrb.fr ROW
```

S3 additionally regex-scans the raw text for `BardErrorInfo\s*\[(\d+)\]` — **(A)** (S3 + S4).

### 3.5 Streaming semantics — **(A)**

**Frames carry cumulative snapshots of the full answer, not deltas.** S2's comment: Gemini
streams cumulative snapshots, so the longest candidate is the complete answer — "more robust
than picking the last non-empty one". S4 does the same longest-wins scan. S1 computes deltas
by diffing against the previous snapshot.

So: **do not concatenate** frames. Either take the longest snapshot seen (simple, correct for
non-streaming use) or diff successive snapshots if you want token-by-token output. Text can
also *shrink or change mid-string* between frames (markdown escape flicker around code
blocks) — S1 has an entire `SequenceMatcher`-based routine for this — **(B)**.

---

## 4. Headers and params

### 4.1 Query params

| Param | Value | Required? | Confidence |
|---|---|---|---|
| `bl` | `boq_assistant-bard-web-server_YYYYMMDD.NN_pN` | **yes** | **(A)** all four |
| `rt` | `c` | **yes** — selects the chunked framed format | **(A)** all four |
| `_reqid` | integer | **yes** | **(A)** all four |
| `hl` | `en` / `en-US` | yes in practice | **(A)** all four |
| `f.sid` | 19-digit session id | **optional** | **(A)** — S1 and S3 send it *if known*; S2 and S4 never send it and work |
| `source-path` | `/app` | **not sent** on StreamGenerate | **(A)** — all four send it only on `batchexecute` |

`_reqid` conventions differ and evidently don't matter — S1 picks a random 5-digit and adds
**100000** per request; S3 uses `randint(100000, 999999)`; S2/S4 use `unixtime % 1000000`.
The real web client increments by 100000 — **(C)**; any of these is accepted.

### 4.2 Headers

| Header | Value | Confidence |
|---|---|---|
| `Content-Type` | `application/x-www-form-urlencoded;charset=utf-8` | **(A)** all four |
| `X-Same-Domain` | `1` | **(A)** S1, S2, S4 (S3 has it in its base header set) |
| `Origin` | `https://gemini.google.com` | **(A)** — set automatically by the browser in-page |
| `Referer` | `https://gemini.google.com/app` (or `/u/N/app`) | **(A)** — automatic in-page |
| `x-goog-ext-525001261-jspb` | model selection, §2.1 | **(A)** |
| `x-goog-ext-73010989-jspb` | `[0]` | **(A)** |
| `x-goog-ext-73010990-jspb` | `[0]` | **(A)** |
| `x-goog-ext-525005358-jspb` | `["<inner[59] UUID>",1]` | **(A)** S1, S2, S3 |
| `X-Goog-AuthUser` | account index, only when using a `/u/N` prefix | **(A)** S2, S3, S4 |
| `Authorization: SAPISIDHASH …` | **DO NOT SET IN-PAGE** | **(C)** |

**Multi-account note — (A)** (S2, S3, S4): when the user is on a secondary Google account the
whole path is prefixed: `https://gemini.google.com/u/1/_/BardChatUi/data/…`. Read the prefix
off `location.pathname` rather than assuming the root.

**On `Authorization`** — S2/S3/S4 all compute a `SAPISIDHASH` because they are *external*
clients reconstructing what the browser does. **Running inside the page you must not do this**:
same-origin `fetch` with `credentials: 'include'` supplies cookies, and the real web client
does not send an `Authorization` header on same-origin StreamGenerate calls. **(C)** — flagged
because copying it from the reference clients is an easy and confusing mistake.

---

## 5. Discovering the model list at runtime (recommended)

Rather than hardcoding hex ids that go stale, fetch the account's model registry — **(A)**,
S2 and S3 implement this identically:

```
POST /_/BardChatUi/data/batchexecute?rpcids=otAQ7b&source-path=/app&bl=<bl>&hl=en&_reqid=<n>&rt=c
headers: x-goog-ext-525001261-jspb: [1,null,null,null,null,null,null,null,[4]]
         x-goog-ext-73010989-jspb: [0]
body:    f.req=[[["otAQ7b","[]",null,"generic"]]]&at=<SNlM0e>
```

Parse the `wrb.fr` payload — **(B)** (S3's `parse_account_models`):

- `body[14]` → account status code (1000 = OK, 1016 = unauthenticated, …)
- `body[15]` → list of models; per model: `[0]`=hex id, `[1]`=display name, `[2]`=description
- `body[16]` → tier flags, `body[17]` → capability flags → feed into the capacity table in §2.1

**The single most reliable calibration method, though — (C):** you are *inside the page*.
Monkey-patch `window.fetch` / `XMLHttpRequest.prototype.send` once, send one prompt through
the real UI, and capture the exact `f.req` and headers the live bundle produces. That gives
ground truth for **this** build in one shot and removes every (!) and (C) above. Given how
fast this protocol churns, I'd do that before trusting any field marked (B) or (C) here.

---

## 6. Failure modes

| Symptom | Cause | Confidence |
|---|---|---|
| **HTTP 400** with `xsrf` in the body | **Wrong/expired `at` (SNlM0e).** Re-read `WIZ_global_data.SNlM0e`. S3 treats this as retryable-after-refresh; S4's README says "refresh Gemini Web, update `xsrf_token`, and make sure `auth_user` matches the `/u/<index>/` part of the URL". | **(A)** S3 (`_is_xsrf_error`: `status == 400 and "xsrf" in str(error).lower()`) + S4 README |
| **HTTP 405** "The request method POST is inappropriate for the URL …" | **Stale `bl` build label.** S4: "405: BL 版本过期，请更新 geminiBl". Independently reported as a live bug on S1's tracker (issue #274) with no fix — consistent with S1's `bl` having gone stale. | **(A)** S4 comment + S1 issue #274 |
| **HTTP 403** | Missing/invalid cookies (not applicable in-page unless signed out). | (B) S4 |
| **HTTP 429** | Rate limited; honour `Retry-After`. Much more aggressive for anonymous sessions. | **(A)** S3 (retryable set) + S4 |
| HTTP 408/425/500/502/503/504 | Transient; retry. | (B) S3 (`RETRYABLE_STATUS_CODES`) |
| **HTTP 200 but no extractable text** | S2 names this `ErrEmptyResponse` and attributes it to the prompt exceeding the web endpoint's size limit. | (B) S2 |
| **Answer comes back from the wrong model** | **Silent Pro→Flash downgrade** when `inner[79]=3` is sent without a valid account-specific model header. Detect via `body[42]`. | (B) S3 |
| Malformed/short `inner` array | Error code **1052** — "model header invalid **or the request structure is outdated**". S1's message explicitly tells users to update the library. **This is what a stale field layout looks like.** | **(A)** S1 + S3 |

### In-band error codes (`row[5][2][0][1][0]`, or `BardErrorInfo [nnnn]`)

**(A)** — S1's `ErrorCode` enum and S3's `GEMINI_ERROR_MESSAGES` agree on every value:

| Code | Meaning |
|---|---|
| 1013 | Temporary generation error — retry (S1: "disappears soon after") |
| 1037 | Usage limit exceeded for that model |
| 1050 | Model inconsistent with the conversation history (**you switched models mid-chat**) |
| 1052 | Model header invalid / request structure outdated |
| 1060 | IP temporarily blocked |

### Account status codes (from the `otAQ7b` RPC, `body[14]`) — **(B)**, S1's `AccountStatus`

1000 available · 1014 temporarily unavailable · 1016 unauthenticated (cookies expired) ·
1021 rejected · 1033 untrusted · 1040/1042 ToS pending/out of date · 1054/1057 guardian ·
1060 region not supported.

---

## 7. Reference implementation

Written for execution **inside** `gemini.google.com`. Defaults follow the most recent sources
(S3/S4) with the majority reading on each disputed field; every disputed field is exposed as an
option so you can flip it without editing the builder.

```js
// ---------------------------------------------------------------------------
// Page-derived constants. WIZ_global_data is set by the Gemini bundle itself.
// ---------------------------------------------------------------------------
function geminiPageContext() {
  const w = window.WIZ_global_data || {};
  const m = location.pathname.match(/^\/u\/(\d+)\//);
  return {
    at:        w.SNlM0e,                 // XSRF token -> "at" form field   (A)
    bl:        w.cfb2h,                  // build label -> "bl" query param (A)
    sid:       w.FdrFJe,                 // session id  -> "f.sid"          (A, optional)
    authUser:  m ? m[1] : null,          // multi-account path prefix       (A)
    prefix:    m ? `/u/${m[1]}` : '',
  };
}

const MODE = { FAST: 1, THINKING: 2, PRO: 3, AUTO: 4, FAST_DYNAMIC: 5, FLASH_LITE: 6 };

function uuid4() {
  return (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      })).toUpperCase();
}

/**
 * Build the urlencoded form body for StreamGenerate.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.conversationId]  c_<hex>   -> inner[2][0]
 * @param {string} [opts.responseId]      r_<hex>   -> inner[2][1]
 * @param {string} [opts.candidateId]     rc_<hex>  -> inner[2][2]
 * @param {string} [opts.contextString]             -> inner[2][9]
 * @param {string} [opts.at]              XSRF token; defaults to WIZ_global_data.SNlM0e
 * @param {number} [opts.mode]            inner[79], see MODE
 * @param {number} [opts.thinkLevel]      inner[17] payload, default 0
 * @param {string} [opts.language]        default 'en'
 * @param {boolean}[opts.temporary]       true -> inner[41]=[1], inner[45]=1
 * @param {object} [opts.overrides]       {index: value} escape hatch for disputed fields
 * @returns {{body: string, reqUuid: string}} reqUuid MUST go in x-goog-ext-525005358-jspb
 */
function buildStreamGenerateBody(prompt, opts = {}) {
  const {
    conversationId = '', responseId = '', candidateId = '', contextString = '',
    at = geminiPageContext().at,
    mode = MODE.FAST,
    thinkLevel = 0,
    language = 'en',
    temporary = false,
    overrides = null,
  } = opts;

  if (!prompt) throw new Error('prompt is required');
  if (!at) throw new Error('missing XSRF token (SNlM0e)');

  const reqUuid = uuid4();
  const inner = new Array(102).fill(null);

  // --- prompt -------------------------------------------------------- (A)
  // [text, 0, null, fileRefs, null, null, 0]
  inner[0]  = [prompt, 0, null, null, null, null, 0];
  inner[1]  = [language];                                             // (A)

  // --- conversation continuation ------------------------------------- (A)
  // Empty strings (NOT nulls) start a new conversation.
  inner[2]  = [conversationId, responseId, candidateId,
               null, null, null, null, null, null, contextString];

  inner[6]  = [1];   // (!) S4 uses [0]. Majority = [1].
  inner[7]  = 1;     // (A) streaming flag
  inner[10] = 1;     // (A)
  inner[11] = 0;     // (A)
  inner[17] = [[thinkLevel]];  // (!) meaning disputed; shape [[int]] agreed. 0 is safe.
  inner[18] = 0;     // (A)
  inner[27] = 1;     // (A)
  inner[30] = [4];   // (A)

  // --- persistence ---------------------------------------------------- (!)
  // S4 (newest): [2] = persisted chat, [1]+[45]=1 = temporary chat.
  if (temporary) { inner[41] = [1]; inner[45] = 1; }
  else           { inner[41] = [2]; }

  inner[53] = 0;         // (A)
  inner[59] = reqUuid;   // (A) MUST match x-goog-ext-525005358-jspb
  inner[61] = [];        // (A) must be [] not null
  inner[68] = 2;         // (!) S4 uses 1. Majority = 2.
  inner[79] = mode;      // (A) model selection (S3+S4)

  if (overrides) for (const [i, v] of Object.entries(overrides)) inner[Number(i)] = v;

  // --- envelope ------------------------------------------------------- (A)
  // NOTE: JSON.stringify leaves array holes/undefined as null, and does NOT
  // HTML-escape < > & — which matches what the Go client goes out of its way
  // to achieve with MarshalNoEscape. No special handling needed in JS.
  const outer = [null, JSON.stringify(inner)];

  const form = new URLSearchParams();
  form.set('f.req', JSON.stringify(outer));
  form.set('at', at);
  return { body: form.toString(), reqUuid };
}

/** Query string + headers that go with the body above. */
function buildStreamGenerateRequest(prompt, opts = {}) {
  const ctx = geminiPageContext();
  const { body, reqUuid } = buildStreamGenerateBody(prompt, { at: ctx.at, ...opts });

  const qs = new URLSearchParams({
    bl: ctx.bl,
    hl: opts.language || 'en',
    _reqid: String(opts.reqId ?? (100000 + Math.floor(Math.random() * 899999))),
    rt: 'c',
  });
  if (ctx.sid) qs.set('f.sid', ctx.sid);   // optional (A)

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    'X-Same-Domain': '1',
    'x-goog-ext-525005358-jspb': `["${reqUuid}",1]`,   // (A) must match inner[59]
  };
  // Only when you have a *discovered* hex model id (see §5). Required for Pro,
  // otherwise Google silently downgrades to Flash. (B, S3)
  if (opts.modelIdHex) {
    const cap = opts.capacity ?? 1;
    const tail = opts.capacityField === 13 ? `null,${cap}` : `${cap}`;
    headers['x-goog-ext-525001261-jspb'] =
      `[1,null,null,null,"${opts.modelIdHex}",null,null,0,[4],null,null,${tail}]`;
    headers['x-goog-ext-73010989-jspb'] = '[0]';
    headers['x-goog-ext-73010990-jspb'] = '[0]';
  }
  if (ctx.authUser) headers['X-Goog-AuthUser'] = ctx.authUser;

  const url = `https://gemini.google.com${ctx.prefix}` +
    `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${qs}`;

  // Same-origin: cookies ride along. Do NOT add an Authorization/SAPISIDHASH header.
  return { url, init: { method: 'POST', headers, body, credentials: 'include' } };
}
```

### Response parser

```js
/**
 * Incremental frame splitter for Google's length-prefixed format.
 * Feed it the accumulated buffer; it returns parsed rows plus the leftover.
 *
 * Frame layout: <decimal length>\n<json>
 * The length counts UTF-16 code units AND INCLUDES the \n after the digits,
 * which is exactly what JS String.length gives us for free.   (A)
 */
function splitGoogleFrames(buffer) {
  const rows = [];
  let pos = 0;
  for (;;) {
    while (pos < buffer.length && /\s/.test(buffer[pos])) pos++;
    const m = /^(\d+)\n/.exec(buffer.slice(pos));
    if (!m) break;
    const declared = parseInt(m[1], 10);
    const start = pos + m[1].length;            // counting starts right after the digits
    if (buffer.length - start < declared) break; // incomplete frame -> wait for more
    const chunk = buffer.slice(start, start + declared).trim();
    pos = start + declared;
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk);
      Array.isArray(parsed) ? rows.push(...parsed) : rows.push(parsed);
    } catch { /* malformed frame: skip, keep going */ }
  }
  return { rows, rest: buffer.slice(pos) };
}

const GEMINI_ERRORS = {
  1013: 'temporary generation error (retry)',
  1037: 'usage limit exceeded',
  1050: 'model inconsistent with conversation history',
  1052: 'model header invalid or request structure outdated',
  1060: 'IP temporarily blocked',
};

/**
 * Parse a complete StreamGenerate response body.
 * For streaming, call splitGoogleFrames() incrementally and run the per-row
 * logic below on each row as it arrives.
 *
 * Text arrives as CUMULATIVE SNAPSHOTS, not deltas -> take the longest.  (A)
 */
function parseStreamGenerateResponse(text) {
  let buf = text.startsWith(")]}'") ? text.slice(4) : text;
  buf = buf.replace(/^\s+/, '');

  const { rows } = splitGoogleFrames(buf);

  const out = {
    text: '', thoughts: '',
    conversationId: null, responseId: null, candidateId: null,
    routedModel: null, complete: false, error: null,
  };

  for (const row of rows) {
    if (!Array.isArray(row) || row[0] !== 'wrb.fr') continue;

    // Error lives on the ROW at [5][2][0][1][0], not in the inner body.   (A)
    const code = row?.[5]?.[2]?.[0]?.[1]?.[0];
    if (typeof code === 'number') {
      out.error = { code, message: GEMINI_ERRORS[code] || `unknown error ${code}` };
      continue;
    }

    if (typeof row[2] !== 'string') continue;
    let body;
    try { body = JSON.parse(row[2]); } catch { continue; }
    if (!Array.isArray(body)) continue;

    // Conversation ids.                                                   (A)
    if (Array.isArray(body[1])) {
      if (body[1][0]) out.conversationId = body[1][0];   // c_<hex>
      if (body[1][1]) out.responseId     = body[1][1];   // r_<hex>
    }
    if (typeof body[42] === 'string') out.routedModel = body[42];  // (B) downgrade check

    const candidates = body[4];
    if (!Array.isArray(candidates)) continue;

    for (const cand of candidates) {
      if (!Array.isArray(cand)) continue;
      if (cand[0]) out.candidateId = cand[0];                       // rc_<hex>  (A)

      const snapshot = cand?.[1]?.[0];                              // text      (A)
      if (typeof snapshot === 'string' && snapshot.length > out.text.length) {
        out.text = snapshot;
      }
      const th = cand?.[37]?.[0]?.[0];                              // thoughts  (A)
      if (typeof th === 'string' && th.length > out.thoughts.length) out.thoughts = th;

      if (cand?.[8]?.[0] === 2) out.complete = true;                // (B)
    }
  }

  // Fallback: some builds surface errors only as a raw marker.            (A)
  if (!out.error) {
    const m = /BardErrorInfo\s*\[(\d+)\]/.exec(text);
    if (m) {
      const c = parseInt(m[1], 10);
      out.error = { code: c, message: GEMINI_ERRORS[c] || `unknown error ${c}` };
    }
  }

  // Strip googleusercontent artifacts the UI would otherwise render.      (A)
  out.text = out.text
    .replace(/http:\/\/googleusercontent\.com\/\w+\/\d+\n*/g, '')
    .trim();

  return out;
}
```

**Round-tripping a conversation:** feed `out.conversationId` / `out.responseId` /
`out.candidateId` straight back into `buildStreamGenerateBody`'s `conversationId` /
`responseId` / `candidateId`. Keep the **same model** across turns or you'll get error 1050
— **(A)**.

---

## 8. Things I could not establish

- Whether `inner[68]`, `inner[27]`, `inner[53]`, `inner[6]` mean anything at all. No source
  explains them; all four just copy observed constants.
- Whether the array length itself is validated server-side. Untested by any source.
- Whether `inner[59]`'s case (upper vs lower) matters. Sources differ; none comments on it.
- The exact `inner[17]` semantics — three mutually exclusive claims (§1.4).
- Whether the hex model ids in §2.1 are still valid on build `20260807.01`. They are April
  vintage and S3 keeps them only as a *fallback* map, preferring runtime discovery.

**Before shipping, capture one real request from the live page (§5). It resolves every open
question above in a single observation, and this protocol has demonstrably changed at least
twice between April and August 2026.**
