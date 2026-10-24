# Google Flow — reference implementation teardown + API surface notes

Target of study: `https://github.com/TMSSS05/google-flow-browser-mcp`
Studied at commit `0c8e80a` (branch `main`, HEAD at time of writing), 37 tracked files, 8 commits.
Method: full `git clone`, every source file read verbatim, plus `git grep` across **all** commits in history.

## Evidence key

- **(A)** = read directly from the TMSSS05 repo source. File + line cited.
- **(B)** = another named public source.
- **(C)** = my inference / analysis, not verified in code.

---

## 0. Headline answer

**(A) The repo is 100% DOM automation. It does not call Flow's HTTP APIs at all.**

Verified by grepping every commit in history for `aisandbox`, `trpc`, `_next/data`, `googleapis`,
`batchAsyncGenerate`, `SAPISID`, `Bearer`, `x-goog`, `api_key`, `fetch(`, `route(`,
`waitForResponse`, `on('response'`, `videoFx`, `superjson`. Total hits across all 8 commits:

| Hit | File | What it actually is |
|-----|------|---------------------|
| `fetch(...)` | `src/browser/connect.js:156` | `fetch("http://127.0.0.1:9222/json/version")` — CDP readiness probe, **not** a Flow API |
| `trpc` | `src/tools/generate-image.js:297` | `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<uuid>` — the **only** Flow HTTP call in the entire repo |
| `sendRequest` | `scripts/test-e2e.mjs` | JSON-RPC over stdio to its own MCP server |

There is **no** `aisandbox-pa.googleapis.com` call, **no** tRPC procedure call other than the media
redirect, **no** `_next/data` fetch, **no** network interception, **no** auth-token extraction,
**no** operation polling. Everything else is Playwright locators and `page.evaluate()`.

**(C) Verdict for your build:** this repo is useful as a *browser-harness* reference (anti-detection
Chrome launch, project-context state machine, credit-safety gating, job queue) and as a *catalogue of
observed Flow UI strings*. It is **not** a source for the Flow API surface. Do not expect to confirm
any of your observed endpoints from it — none of them appear.

> **→ If you only read one section, read §9.** A different public repo, `crisng95/flowkit`, *does*
> implement the Flow HTTP API end to end (submit → poll → retrieve, with reCAPTCHA and Bearer auth),
> and §9 documents it verbatim. Sections 1-8 below cover TMSSS05 for completeness.

---

## 1. Transport

### 1.1 What it drives — (A)

Playwright (`playwright ^1.51.0`, `package.json`) attached over **CDP** to a *separately spawned*
real Chrome process.

`src/browser/connect.js`:
- `connectToBrowser()` → `chromium.connectOverCDP("http://127.0.0.1:9222")`, reuses
  `browser.contexts()[0]` and `context.pages()[0]`.
- `launchChromeDirect()` (the one actually used) — the anti-detection path:
  1. `fs.cpSync(profileSource, tempDir + "/Profile 3", {recursive:true})` where
     `profileSource = $HOME/.config/google-chrome/Profile 3`; also copies `Local State`.
  2. `spawn(chromePath, args)` — **not** `chromium.launch()`. Args (verbatim,
     `src/browser/connect.js:138-146`):
     ```
     --remote-debugging-port=9222
     --user-data-dir=<tempDir>
     --profile-directory=Profile 3
     --no-first-run
     --no-default-browser-check
     --disable-blink-features=AutomationControlled
     --window-size=1920,1080
     [--headless=new]      # only if headless
     ```
  3. Polls `http://127.0.0.1:9222/json/version` up to 20× at 1 s.
  4. `chromium.connectOverCDP(cdpUrl)`, then logs `navigator.webdriver`.

**(A)** The stated reason (`src/browser/connect.js:97-101` comment,
`src/browser/launch-profile.js:42`, `summary.md:18`): spawning Chrome directly rather than through
Playwright's launcher keeps `navigator.webdriver === false`, which is what lets the Google OAuth
session survive. `src/browser/launch-profile.js:64-67` returns
`{authenticated:false, message:"OAuth blocked — Google detects automation. Use Chrome direct+CDP launch method."}`
when the page lands on `accounts.google.com`.

**(C)** This is the single most transferable idea in the repo — see §8.

`scripts/start-browser.sh` is the alternative manual path: launches Chrome against the *real*
`$HOME/.config/google-chrome` user-data-dir with `--profile-directory="Profile 3"
--remote-debugging-port=9222 --disable-extensions --disable-sync
--disable-background-networking --disable-component-update`.

### 1.2 The one HTTP endpoint it uses — (A)

```
GET https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<uuid>
```

`src/tools/generate-image.js:294-311`. Notes, all verbatim from source:

- The `<uuid>` is **not** obtained from an API. It is scraped out of `<img>` `src` attributes in the
  DOM (`generate-image.js:250-261`):
  ```js
  const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
  if (match && img.width > 100) uuids.push(match[1]);
  ```
  i.e. **Flow's own `<img src>` already points at this endpoint** — the repo just re-requests it.
- It is fetched by **navigating the page**: `await page.goto(url, {waitUntil:'load', timeout:15000})`,
  then `response.headers()['content-type']` and `await response.body()`.
- Success test: `contentType.startsWith('image/')`; extension chosen as
  `contentType === 'image/png' ? '.png' : '.jpg'`.
- Auth = ambient browser cookies. Nothing is added.

**(C) Two things to note if you copy this.** First, `page.goto()` on the media URL *navigates away
from the Flow SPA*, destroying app state; any subsequent DOM step has to re-navigate. Use
`page.request.get()` / `context.request.get()` (shares the cookie jar, no navigation) or an in-page
`fetch()` instead. Second, despite living under `/fx/api/trpc/`, this procedure is called with a bare
`?name=<uuid>` query string, **not** the superjson `?input={"json":...}` convention — so it is
either a non-tRPC route mounted on that prefix or a tRPC route with a custom input parser. Do not
generalise its calling convention to the other `/fx/api/trpc/*` procedures.

### 1.3 Your observed endpoints — status against this repo

| Endpoint you observed | Present in repo? |
|---|---|
| `labs.google/fx/api/trpc/project.searchUserProjects` | **No** — (A) not in any commit |
| `.../videoFx.getFlowAppConfig` | **No** |
| `.../videoFx.getUserSettings` | **No** |
| `.../general.fetchUserPreferences` | **No** |
| `.../general.fetchToolAvailability` | **No** |
| `.../general.fetchUserAcknowledgement` | **No** |
| `.../general.fetchUserLocale` | **No** |
| `.../general.submitBatchLog` | **No** |
| `.../media.getMediaUrlRedirect` | **Yes** — (A) `generate-image.js:297`, the only one |
| `aisandbox-pa.googleapis.com/v1/*` (all) | **No** — (A) zero occurrences of the host string in any commit |
| `labs.google/fx/_next/data/<buildhash>/...` | **No** |

**(C)** The absence is informative in one direction only: it tells you the author never needed the
API layer, not that your observed endpoints are wrong. Your own network capture is stronger evidence
than this repo for everything in §1.3.

---

## 2. tRPC calling convention

**(A) Not established by this repo.** The single tRPC-prefixed call it makes uses a plain
`?name=<uuid>` query string with no `batch`, no `input`, no superjson envelope
(`generate-image.js:297`). There is no POST/mutation anywhere in the codebase.

See §9 for what public sources say.

---

## 3. Authentication

**(A) There is none — deliberately.** The design is "borrow the human's logged-in Chrome profile and
never touch credentials":

- `README.md:44` — "All through your **own Google account** — no API keys, no third-party tokens."
- `README.md:313-315` / `summary.md:7` — "never asks for or stores passwords", "Never exports
  cookies, tokens, or session data", "never bypass captcha or anti-bot".
- Auth material = the copied `Profile 3` directory (cookies DB + `Local State`) handed to a real
  Chrome (`connect.js:117-130`).
- No `Authorization`, no `SAPISIDHASH`, no `x-goog-*`, no API key is constructed anywhere. Grep for
  `Bearer`/`SAPISID`/`x-goog`/`api_key` across all commits returns zero hits.

Account "verification" is cosmetic — `src/browser/account-check.js`:
- tries `page.$('[data-account-email], [aria-label*="gmail"], [data-test-id*="account"]')`
- tries `page.$('[role="button"][aria-haspopup], .account-chooser, [jsname*="account"]')`
- tries reading `document.getElementById('__NEXT_DATA__')` and pulling
  `parsed?.props?.pageProps?.user?.email`
- **falls through to `{verified:true, method:'assumed'}`** if none matched (`account-check.js:76`).

**(C)** The `__NEXT_DATA__` → `props.pageProps.user.email` path is the only genuinely useful auth
signal in the file, and even there the author reports it usually returns null. If you need identity,
read `__NEXT_DATA__` yourself and treat this file's fallback as a bug, not a pattern.

---

## 4. Generation flow, end to end

### 4.1 Project context — (A) `src/navigation/project-navigator.js`

State machine `ensureProjectInContext(page, {name, campaign, forceNew})`:

1. If `page.url().includes('/project/')` → **reuse**, return `{url, reused:true}`.
2. Else if `!forceNew` and `context.campaign` case-insensitively matches a `campaign` field in the
   local registry `config/flow.projects.json` → `page.goto(match.url, {waitUntil:'networkidle'})`,
   bump `last_used`, return.
   **(C) Note a real bug:** `createNewProject()` writes entries `{id, url, name, created_at,
   last_used, tasks}` — it **never persists `campaign`** (`project-navigator.js:218-225`), so the
   `p.campaign &&` guard at line 259-261 can never be true. Campaign reuse is dead code in this repo.
3. Else `createNewProject(page, name)`.

`createNewProject()`:
- Navigate to `flowUrl` if not there or if currently inside `/project/`.
- Click, first match wins:
  `button:has-text("Nouveau projet")`, `a:has-text("Nouveau projet")`,
  `[aria-label*="Nouveau projet"]`, `button:has-text("New project")`;
  fallback `[aria-label*="add"], button:has-text("add"), [class*="fab"]`.
- `waitForTimeout(4000)`.
- Optional name field: `input[placeholder*="Nom"|"nom"|"name"|"Name"]`, `[contenteditable="true"]`;
  confirm with `button:has-text("Créer"|"Confirmer"|"OK"|"Create")` or `[type="submit"]`.
- If URL still lacks `/project/`: `document.querySelectorAll('a[href*="/project/"]')[0]` and
  `window.location.href = href` (prefixed with `https://labs.google` if relative).

**(A)** URL shapes, from `summary.md:38`:
```
main:    https://labs.google/fx/fr/tools/flow
project: https://labs.google/fx/fr/tools/flow/project/{uuid}
```
and from `src/tools/discover-ui.js:36-44`:
```
https://labs.google/fx/tools/flow
https://labs.google/fx/tools/flow/characters
https://labs.google/fx/tools/flow/scenes
https://labs.google/fx/tools/flow/tools?tab=GALLERY
https://labs.google/fx/tools/flow/tools/grid-architect
https://labs.google/fx/tools/flow/tools/<tool-name-slugified>   # use-flow-tool.js:35
https://labs.google/flow/tv                                      # observed link, selectors.map.json
```

### 4.2 Submit — (A) `src/tools/generate-image.js`

Order of operations (image path, the only path that actually generates):

1. `ensureProjectInContext()`.
2. Config-level model validation against `imageModels` / `videoModels` maps; hard-refuses if the
   requested model appears in `videoModels` (`generate-image.js:66-78`).
3. Ratio validated against `ratios` list.
4. **Mode verification by reading the model-selector button text** (`generate-image.js:91-100`):
   ```js
   Array.from(document.querySelectorAll('button')).find(b => {
     const t = b.textContent || '';
     return (t.includes('Nano') || t.includes('Banana') || t.includes('Omni') ||
             t.includes('Veo')  || t.includes('Imagen')) && b.offsetParent !== null;
   })
   ```
   If the resulting text contains `Omni Flash` / `Veo` / `Omni` → **throw**, refuse to generate.
   The inline comment at `generate-image.js:88-90` is a direct claim about the UI:
   *"No 'Image/Video' mode tabs exist — the generation mode is determined by which model is
   selected."* This **contradicts** the older `switchToImageMode()` in
   `project-navigator.js:388-474`, which drives `button[role="tab"][id*="trigger-IMAGE"]` with
   `aria-selected`. Commit `c3ec929` is titled *"fix: replace broken switchToImageMode with
   model-verification safety check"*. **(C)** So: Flow's tab-based mode switcher existed and then
   either changed or was never reliable; the tab selector `button[role="tab"][id*="trigger-IMAGE"]`
   is still the most specific selector in the repo and worth testing against the live app before
   you discard it.
5. Prompt input, first visible match of:
   `[contenteditable="true"]:visible` → `textarea:visible` → `[contenteditable="true"]` → `textarea`.
   Filled via `click()` → `fill('')` → `type(prompt, {delay:15})` (video path uses `delay:20`).
6. If `auto_confirm !== true` → **stop**, return `status:"ready_for_confirmation"`. No credits.
7. Generate button: `button:has-text("arrow_forward"), button:has-text("Generate")`
   (the pre-check at line 119-121 also accepts `button:has-text("Créer")`).
   **(C)** `arrow_forward` is a Material-Symbols ligature rendered as button text — that is how the
   author targets the submit arrow. Cheap and effective; worth stealing as a fallback.
8. Click.

### 4.3 Polling — (A) this is DOM polling, not operation polling

There is **no** operation ID, **no** status endpoint, **no** long-poll. Two loops:

**Loop 1 — agent-confirmation window** (`generate-image.js:222-237`), 5 s default
(`agentResponseTimeoutMs`): every 500 ms read `document.body.innerText`; if it contains `Accepter`
or `Approve`, click `button` filtered by `/Accepter|Approve/` and set `flowMode='agent'`. Otherwise
`flowMode='direct'`.
**(C)** This is Flow's in-app "agent" asking permission before it acts — a real UI state you will hit.

**Loop 2 — completion** (`generate-image.js:247-281`), 120 s default (`generationTimeoutMs`),
2 s interval:
```js
document.querySelectorAll('img')
  .filter(img => /media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/.test(img.src) && img.width > 100)
```
Break on first non-empty result. Secondary break: a visible
`text=Télécharger, text=download, [aria-label*="download"]`.
If the loop exits empty → `ErrorCodes.DOWNLOAD_FAILED`,
*"Generation completed but no images were detected in the DOM."*

**(C)** This is the weakest part of the design and the part you should **not** copy. It cannot
distinguish "still rendering" from "failed", it will happily latch onto a pre-existing image already
in the project gallery (there is no baseline snapshot taken before the click), and 120 s is far below
Veo video latency.

**(A) Config/code mismatch, verified by grep over `src/`:**

| Key | In example config | Read by code |
|---|---|---|
| `generationPollIntervalMs` (5000) | yes | **no** |
| `maxPollAttempts` (120) | yes | **no** |
| `downloadWaitMs` (30000) | yes | **no** |
| `browserMode` ("direct-cdp") | yes | **no** |
| `chromeProfile` ("Profile 3") | yes | **no** — path is hardcoded |
| `chromeUserDataDir` | yes | **no** — path is hardcoded |
| `locale` ("fr") | yes | **no** |
| `generationTimeoutMs` (120000 default) | **no** | yes (`generate-image.js:244`) |
| `agentResponseTimeoutMs` (5000 default) | **no** | yes (`generate-image.js:223`) |
| `actionDelayMs`, `jobTimeoutMs`, `flowHome` | yes | yes |

So the polling/timeout knobs the README advertises are inert, and the two knobs that matter are
undocumented. `chromeProfile`/`chromeUserDataDir` are marked "✅ **REQUIRED**" in `README.md:273-275`
but the code always uses `$HOME/.config/google-chrome/Profile 3` and `/opt/google/chrome/chrome`
(`launch-profile.js:9,19`, `connect.js:49,106`). Do not trust this README as a spec.

### 4.4 Media URL shape — (A)

The only media URL form the repo knows is
`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<uuid>` where `<uuid>` matches
`[a-f0-9-]+`. It appears as the `src` of `<img>` elements in the Flow gallery. The response is a
redirect resolving to actual image bytes (`content-type: image/png` or `image/jpeg`).

**(C)** No video URL shape is documented anywhere in the repo, because the repo never completes a
video generation. `file-manager.js:20` hardcodes `ext = type === 'image' ? 'png' : 'mp4'`, which is
the author's assumption, not an observation.

### 4.5 Video — (A) never actually submitted

`src/tools/generate-video.js:165-167`:
```js
// Video generation is paid — setup only, no click
logger.info('Video generation setup complete — not clicking generate (paid feature)');
```
It fills the prompt, tries the model/ratio/duration/quantity buttons, screenshots, and returns
`status:"ready_for_confirmation"`. **There is no video download path, no video polling, no video
URL handling anywhere in the repo.** Same for `grid-architect.js` (setup only).

**(C)** So for your primary use case — actually generating Veo video and retrieving the file — this
repo provides *zero* verified coverage. Treat its video section as a UI map only.

---

## 5. Models and parameters

### 5.1 Config-declared enums — (A) `config/flow.config.example.json`

```json
"imageModels": {
  "Nano Banana Pro": "nano-banana-pro",
  "Nano Banana 2":   "nano-banana-2",
  "Imagen 4":        "imagen-4"
},
"videoModels": {
  "Omni Flash":        "omni-flash",
  "Veo 3.1 - Lite":    "veo-3.1-lite",
  "Veo 3.1 - Fast":    "veo-3.1-fast",
  "Veo 3.1 - Quality": "veo-3.1-quality"
},
"ratios":      ["16:9", "4:3", "1:1", "3:4", "9:16"],
"videoRatios": ["9:16", "16:9"],
"durations":   ["4s", "6s", "8s", "10s"],
"quantities":  [1, 2, 3, 4],
"locale": "fr"
```

**Critical caveat (C):** the right-hand slugs (`veo-3.1-fast`, `nano-banana-2`, …) are **the author's
own invented identifiers**. They are never sent anywhere. Grep confirms the values are only ever used
as truthiness checks (`if (available[requested])`) and for `Object.keys()` error messages. The
*keys* (`"Veo 3.1 - Fast"`) are the load-bearing strings, because they are matched against **visible
button text** in the DOM. **Do not treat the slugs as API enum values.** They are not
`VIDEO_MODEL_VEO_3_1_FAST` or anything of the sort.

### 5.2 Model aliasing — (A) `generate-video.js:13-24`

```js
if (!requested || requested === 'auto')            return 'Veo 3.1 - Fast';
if (requested === 'quality' || 'premium')          return 'Veo 3.1 - Quality';
if (requested === 'fast'    || 'speed')            return 'Veo 3.1 - Fast';
if (requested === 'lite'    || 'test')             return 'Veo 3.1 - Lite';
if (requested === 'flash'   || 'simple')           return 'Omni Flash';
```
Image default (`generate-image.js:12-19`): `'Nano Banana 2'`.

**(A) Inconsistency worth knowing:** `src/index.js` tool schemas disagree with the config.
`flow_generate_video` advertises `model: "Omni Flash, Veo 2, Nano Banana 2"` default `"Omni Flash"`
(`index.js:100`) while the implementation only knows `Veo 3.1 - {Lite,Fast,Quality}` + `Omni Flash`.
`flow_generate_image` advertises `ratio` default `"1:1"` (`index.js:84`) while
`selectRatio()` defaults to `'16:9'` (`generate-image.js:25`). **(C)** The schemas are stale; trust
the implementation.

### 5.3 How parameters are actually applied — (A) all by button-label text match

| Parameter | Selector | File:line |
|---|---|---|
| model (video) | click `button:has-text("Omni"), button:has-text("Veo"), [class*="model"] button` then `text="<model>"`, else `Escape` | `generate-video.js:104-114` |
| ratio | `button:has-text("<ratio>")` e.g. `button:has-text("16:9")` | `generate-video.js:127` |
| duration | `button:has-text("<duration>")` e.g. `button:has-text("4s")` | `generate-video.js:141` |
| quantity | `button:has-text("x<n>")` e.g. `button:has-text("x2")`, clamped 1–4 | `generate-video.js:151` |
| engine / ratio / visual logic (Grid Architect) | `button:has-text("<value>")` | `grid-architect.js:49,60,71` |
| reference images | `input[type="file"]` → `setInputFiles(path)` | `grid-architect.js:115-117`, `create-character.js:68`, `create-scene.js:57`, `import-character.js` |

**(A) Not implemented at all**, despite appearing in tool schemas or job params: `seed` (never
mentioned anywhere in the repo), `reference_images` on image/video generation (declared in
`index.js:85,103` — the handlers read `args.references`/`args.reference_image` and only
`grid-architect`/`create-character`/`create-scene`/`import-character` ever call `setInputFiles`),
`ingredients` (captured into the job record at `generate-video.js:37` then never used),
`use_character` / `use_scene` (same — captured, never used), `brand` (declared `index.js:86`, never
read), `output_folder` (image path only).

**(C) There is no image-to-video, no first/last-frame, and no ingredients support in this repo.**
Anything you need there you are building from scratch.

### 5.4 Grid Architect — (A) `src/tools/grid-architect.js`

Params: `theme_prompt` (required), `shot_prompts[]`, `engine` (default `Nano Banana 2`),
`ratio` (default `16:9`), `visual_logic` (schema lists *"None, Colour Pop, Side by Side, etc."*,
`index.js:175`), `references[]`. Shot prompts are located by clicking `text="Shot <n>"` then typing
into `page.locator('textarea').first()` — **(C)** which is almost certainly wrong (it re-targets the
first textarea on the page every iteration, not the one belonging to that shot). Setup only, no
Generate click.

---

## 6. DOM selectors — complete inventory (A)

Everything the repo relies on. Locale is **French** by default (`flowUrl` ends `/fx/fr/tools/flow`,
`locale: "fr"`), so most text selectors are French with English fallbacks.

**Structural / semantic (the good ones):**
```
button[role="tab"][id*="trigger-IMAGE"]        # image-mode tab; aria-selected="true" when active
                                               # also aria-disabled="true" when unavailable
a[href*="/project/"]                           # project cards
input[type="file"]                             # every upload path
[contenteditable="true"]                       # the prompt box (primary)
textarea                                       # prompt fallback
#__NEXT_DATA__                                 # props.pageProps.user.email  (account-check.js)
img[src*="media.getMediaUrlRedirect?name="]    # generated images, filtered by img.width > 100
textarea[name="g-recaptcha-response"]          # observed on the Flow homepage (selectors.map.json)
```

**Text-based (fragile, locale-bound):**
```
button:has-text("Nouveau projet") | a:has-text("Nouveau projet") | [aria-label*="Nouveau projet"]
                                  | button:has-text("New project")
button:has-text("Créer"|"Confirmer"|"OK"|"Create") | [type="submit"]
button:has-text("arrow_forward")               # the submit arrow (Material Symbols ligature)
button:has-text("Generate")
button:has-text("Vidéo")                       # mode dropdown fallback
[role="menuitem"]:has-text("Image")
button:has-text("16:9") / ("4s") / ("x2")      # ratio / duration / quantity chips
button:has-text("Omni") | button:has-text("Veo") | [class*="model"] button
button filtered by /Accepter|Approve/          # in-app agent confirmation
button:has-text("Download"|"Télécharger") | [aria-label*="download"]
a|button:has-text("Grille"|"Grid") | text=Architect
button:has-text("New Character"|"Créer"|"Nouveau")
button:has-text("New Scene"|"Créer"|"Nouvelle scène")
input[placeholder*="Nom"|"nom"|"name"|"Name"]
[data-account-email] | [aria-label*="gmail"] | [data-test-id*="account"]
[role="button"][aria-haspopup] | .account-chooser | [jsname*="account"]
```

**Sidebar navigation** — `navigateToSidebar(page, section)`, sections
`"Personnages" | "Scènes" | "Outils" | "Corbeille"` (`summary.md:40`). Tries, in order:
```
[class*="sidebar"] button:has-text(S)  /  a:has-text(S)
nav button:has-text(S)                 /  a:has-text(S)
[class*="nav"] button:has-text(S)      /  a:has-text(S)
button:has-text(S)                     /  a:has-text(S)
```
Active section: `[class*="sidebar"] [class*="active"], [class*="sidebar"] [aria-current="page"],
nav [class*="active"]`.

**Real strings captured from the live French UI** (`config/selectors.map.json`, discovered
2026-05-30/31 — **(A)** these are genuine observations of Flow's DOM):
```
"add_2Nouveau projet"          (button, was visible:false — behind a menu)
"editModifier le projet"
"deleteSupprimer le projet"
"help_outlinedCentre d'aide FlowCentre d'aide Flow"
"more_vert"                    (tag: I  — an <i> icon element, not a button)
"PRO"
"closeFermerFermer"
"Try Omni now"
"Accéder à la bannière 1..6"
links: "Flow" -> /fx/fr/tools/flow ; "tvFlow TV" -> https://labs.google/flow/tv
inputs: name="g-recaptcha-response" (TEXTAREA, visible:false)
headings: H2 "Introducing Gemini Omni Flash"
```
**(C)** Note `dataTestId` is `null` on **every single captured element** — Flow ships no
`data-testid`/`data-test-id` hooks. Text and ARIA are all you get. Note also that the button text
comes back with the icon ligature *prepended* (`add_2Nouveau projet`, `editModifier le projet`),
which is why `has-text()` substring matching works but exact-match would fail.

`flow_discover_ui` (`src/tools/discover-ui.js`) is the repo's answer to selector drift: it navigates
a named page, walks the DOM for `button, [role="button"], [type="button"]`,
`input:not([type=hidden]), textarea, [contenteditable=true]`, `a[href]`, `select, [role=listbox]`,
`h1..h4`, plus a `TreeWalker` text sweep, and rewrites `config/selectors.map.json`.
**(C)** Good idea, weak execution — it stores a flat dump of button *labels*, not selectors, so
nothing downstream can consume it. Steal the concept, not the schema.

---

## 7. Documented limitations (A)

Directly from the repo:

| Limitation | Source |
|---|---|
| **Video generation is never executed** — "Does NOT click final Generate (paid feature — stops at ready-to-generate)" | `index.js:95`, `generate-video.js:165`, `README.md:237,317,380` |
| **Grid Architect likewise stops before Generate** | `summary.md:13`, `grid-architect.js:146` |
| **Images DO consume credits** — the `auto_confirm` flag exists purely to gate that | `index.js:77,83`, `generate-image.js:212` |
| **Google OAuth blocks Playwright-launched Chrome.** Landing on `accounts.google.com` ⇒ automation detected. Remedy documented: sign in manually once in `Profile 3`, then retry | `launch-profile.js:64-67`, `index.js:243-249` |
| **reCAPTCHA is present on the Flow page** (`textarea[name="g-recaptcha-response"]` observed) and the project's stated rule is to **stop cleanly, never bypass** | `selectors.map.json:137-144`, `summary.md:7`, `README.md:315` |
| **Single-job queue** — concurrent generation throws `JOB_IN_PROGRESS`; explicitly framed as abuse prevention | `job-queue.js:27-33`, `README.md:76` |
| **Headless is discouraged** — "not recommended, Google Flow needs visible browser" | `index.js:39` |
| **UI drift is expected** — dedicated `flow_discover_ui` remap tool + FAQ entry "Flow UI changed and tools don't work" | `README.md:364-367` |
| Error taxonomy incl. `GOOGLE_LIMIT_REACHED`, `MANUAL_VERIFICATION_REQUIRED`, `GENERATION_TIMEOUT`, `WRONG_GOOGLE_ACCOUNT` | `src/utils/errors.js:1-17` |
| Linux-only paths hardcoded: `/opt/google/chrome/chrome`, `$HOME/.config/google-chrome/Profile 3`, `/tmp/...` | `connect.js:49,106,117`, `launch-profile.js:9,19` |
| Author's own status: E2E test never completed — "Pending: Restart MCP server → E2E test" | `summary.md:33-34` |

**(A) Nothing about HTTP rate limits, 401s, token expiry, or region gating** — the repo never
touches the API layer, so it has nothing to say about any of that.

---

## 8. What is worth copying (C)

Ranked.

1. **`launchChromeDirect()` — spawn real Chrome yourself, then `connectOverCDP`.**
   `spawn(chromePath, [...])` + poll `/json/version` + `chromium.connectOverCDP()`, with
   `--disable-blink-features=AutomationControlled` and a **copied** profile dir so you never corrupt
   the user's live Chrome. This keeps `navigator.webdriver === false` and is what makes the Google
   session survive. This is the single highest-value idea in the repo and it is directly reusable.
2. **Copy the profile to a temp dir instead of attaching to the live one.** `fs.cpSync(profileSource,
   tempDir + '/Profile 3')` + `Local State`, cleaned up in `closeBrowser()`. Avoids the
   "Chrome is already running with this user-data-dir" failure mode entirely.
3. **Two-phase credit gate.** `auto_confirm:false` returns `status:"ready_for_confirmation"` with a
   screenshot and *nothing* is spent; only an explicit second call clicks Generate. Correct default
   for a paid generative surface.
4. **Pre-flight mode assertion.** Before clicking Generate, read back what the UI *actually* has
   selected and refuse if it disagrees with intent. Cheap, and it prevents the expensive class of
   error (accidentally spending video credits from an image call).
5. **`button:has-text("arrow_forward")`** — targeting Material Symbols ligature text as button
   labels. Genuinely useful trick against a UI with no test IDs.
6. **Single-job queue with typed error codes.** Prevents runaway parallel generation.

**Do not copy:** the DOM-scrape completion poll (§4.3), the `page.goto()` media download (§1.2),
the campaign-matching registry (broken, §4.1), the `flow_discover_ui` output schema (§6), the
config-file slugs mistaken for API enums (§5.1), or the hardcoded Linux paths.

---

## 9. Flow API surface from other public sources

> Nothing in this section comes from the TMSSS05 repo. Primary source is a second repo that *does*
> implement the HTTP layer, cross-checked against an independent network capture.

### 9.0 Sources

| Tag | Source |
|---|---|
| **(B-FK)** | `https://github.com/crisng95/flowkit` — a Python agent + Chrome MV3 extension that drives the real Flow API. Cloned at `main`. This is the load-bearing source; file+line cited per claim. |
| **(B-KS)** | Keysight, *"Google Labs – Flow AI with Veo3: A Network Traffic Analysis"*, `https://www.keysight.com/blogs/en/tech/nwvs/2025/08/04/google-flow-ai-har-analysis` — independent HAR capture. Used as corroboration. |
| **(B-IFX)** | `https://github.com/rohitaryal/imageFX-api` — ImageFX (sibling Labs tool), for the auth-token mechanism. |
| **(B-CL)** | `https://github.com/ainewsto/comfyui-labs-google` — ImageFX/Whisk ComfyUI nodes, corroborates auth + `/v1:runImageFx`. |

**This flatly contradicts the TMSSS05 approach.** flowkit does *not* touch the DOM for generation at
all — it makes authenticated JSON calls. If your goal is reliable video generation, flowkit is the
architecture to study, not TMSSS05.

### 9.1 Hosts and base

**(B-FK)** `agent/config.py:19-21`
```python
GOOGLE_FLOW_API      = "https://aisandbox-pa.googleapis.com"
GOOGLE_API_KEY       = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
RECAPTCHA_SITE_KEY   = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"
```
Both are **public web-client constants** shipped in Flow's own front-end (a browser API key and a
reCAPTCHA Enterprise *site* key — neither is a secret, and both can rotate). The API key goes in the
query string of every `aisandbox-pa` call: `_build_url()` at `flow_client.py:371-375` appends
`?key=<GOOGLE_API_KEY>` (or `&key=` if the path already has a query).

### 9.2 Endpoint table — (B-FK) `agent/config.py:42-53`, verbatim

Base `https://aisandbox-pa.googleapis.com`, every call `?key=<API_KEY>`.

| Op | Method + path | reCAPTCHA action |
|---|---|---|
| Generate images | `POST /v1/projects/{project_id}/flowMedia:batchGenerateImages` | `IMAGE_GENERATION` |
| Video from start frame (i2v) | `POST /v1/video:batchAsyncGenerateVideoStartImage` | `VIDEO_GENERATION` |
| Video from start+end frame | `POST /v1/video:batchAsyncGenerateVideoStartAndEndImage` | `VIDEO_GENERATION` |
| Video from reference images (r2v) | `POST /v1/video:batchAsyncGenerateVideoReferenceImages` | `VIDEO_GENERATION` |
| Upscale video | `POST /v1/video:batchAsyncGenerateVideoUpsampleVideo` | `VIDEO_GENERATION` |
| Upscale image | `POST /v1/flow/upsampleImage` | `IMAGE_GENERATION` |
| Upload image | `POST /v1/flow/uploadImage` | none |
| **Poll video status** | `POST /v1/video:batchCheckAsyncVideoGenerationStatus` | none |
| Credits + tier | `GET /v1/credits` | none |
| Fetch media | `GET /v1/media/{media_id}?key=…&clientContext.tool=PINHOLE` | none |

**(B-KS)** independently confirms `POST /v1/video:batchAsyncGenerateVideoText` — the **pure
text-to-video** variant (no start image). flowkit never calls it because it always generates an
image first, so its payload is corroborated only at field level (see 9.4). **(C)** By analogy with
the four siblings, it takes the same envelope minus `startImage`/`endImage`/`referenceImages`.

**(B-FK)** `PLAN.md:37,40` lists two older/alternate spellings — `POST /v1:uploadImage` and
`GET /v1/media/{mediaId}` — while the shipped `config.py` uses `/v1/flow/uploadImage`. **(C)** The
`/v1/flow/` prefix is the newer one; PLAN.md is the earlier draft.

**(B-FK)** logging endpoints seen in the extension (`extension/background.js:722,727`):
`POST https://aisandbox-pa.googleapis.com/v1:batchLog` and
`POST https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents` — the latter matches your
observation exactly.

### 9.3 Authentication — **`Authorization: Bearer ya29.…`**

**(B-FK)** `extension/background.js:86-110`. The token is **not minted** — it is *sniffed* out of
Flow's own traffic:
```js
chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    const authHeader = details.requestHeaders.find(h => h.name?.toLowerCase() === 'authorization');
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;
    flowKey = value.replace(/^Bearer\s+/i, '').trim();
    ...
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders']);
```
and re-attached on outgoing calls: `fetchHeaders['authorization'] = `Bearer ${flowKey}``
(`background.js:373, 469, 716`). Requests also go out with `credentials: 'include'`
(`background.js:381`), so cookies ride along too.

**No SAPISIDHASH anywhere.** The `key=` query param is present in addition to the Bearer — both.

**(B-IFX)** gives the *cleaner* way to obtain the same token without webRequest sniffing:
`src/Account.ts:92` fetches `https://labs.google/fx/api/auth/session` (NextAuth) with the user's
cookies and reads `access_token`, `expires`, `user` off the JSON (`src/Account.ts:46-51,105`), then
sends `"Authorization": "Bearer " + this.token` (`src/Account.ts:82`).
**(B-CL)** `comfyui_imagefx.py:38,86` does the same, storing `access_token` from a saved session
blob and sending `"authorization": f"Bearer {self.access_token}"`.
**(C) Recommendation: use the `/fx/api/auth/session` route.** It is one authenticated GET, it gives
you an explicit `expires`, and it does not need the `webRequest` permission or a live in-flight
request to piggyback on.

**Extra headers (B-FK)** `agent/services/headers.py` — every `aisandbox-pa` request is sent with a
randomised browser-fingerprint header set:
```
accept: */*
accept-language: en-US,en;q=0.9
content-type: text/plain;charset=UTF-8      # note: NOT application/json
origin: https://labs.google
referer: https://labs.google/
priority: u=1, i
sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform
sec-fetch-dest: empty | sec-fetch-mode: cors | sec-fetch-site: cross-site
user-agent: <rotated>
x-browser-channel: stable
x-browser-copyright: Copyright 2025 Google LLC. All rights reserved.
x-browser-validation: <rotated pool>
x-browser-year: 2025
x-client-data: <rotated pool>
```
**(B-KS)** independently observed `Content-Type: text/plain; charset=UTF-8` on Flow API calls —
corroborates the counter-intuitive content type. **(C)** `text/plain` is Google's standard trick to
keep these as CORS *simple* requests and skip the preflight. Send JSON with that content type.

### 9.4 Request envelope — (B-FK) `flow_client.py`

Every generation body is `{clientContext, requests: [...]}`. `_client_context()`
(`flow_client.py:377-388`), verbatim:
```json
{
  "projectId": "<project id, string>",
  "recaptchaContext": {
    "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
    "token": "<reCAPTCHA Enterprise token>"
  },
  "sessionId": ";<epoch_millis>",
  "tool": "PINHOLE",
  "userPaygateTier": "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO"
}
```
`sessionId` really does have a **leading semicolon**: `f";{int(time.time() * 1000)}"`.
`tool` is the literal string `"PINHOLE"` — Flow's internal codename.
**(B-KS)** independently lists `clientContext`, `requests`, `aspectRatio`, `seed`,
`textInput.prompt`, `videoModelKey`, `metadata.sceneId` in the `batchAsyncGenerateVideoText` body.

**Video, start-frame** (`flow_client.py:522-540`):
```json
{
  "mediaGenerationContext": { "batchId": "<uuid4>" },
  "clientContext": { ...as above... },
  "useV2ModelConfig": true,
  "requests": [{
    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
    "seed": 1234,
    "textInput": { "structuredPrompt": { "parts": [ { "text": "<prompt>" } ] } },
    "videoModelKey": "veo_3_1_i2v_lite_low_priority",
    "startImage": { "mediaId": "<uuid>" },
    "metadata": { "sceneId": "<scene id>" }
  }]
}
```
Start+end adds `"endImage": {"mediaId": "<uuid>"}` (`flow_client.py:531-532`) and switches to
`batchAsyncGenerateVideoStartAndEndImage`.

**Note the prompt-shape discrepancy.** flowkit sends
`textInput.structuredPrompt.parts[].text`; **(B-KS)** observed `textInput.prompt` (a flat string).
`PLAN.md:132` (the earlier draft) also has `"textInput": {"prompt": "..."}`. **(C)** Both forms have
existed; `structuredPrompt.parts[]` is the newer one, matching the image path. Try structured first,
fall back to flat on a 400.

**Video, reference images (r2v)** (`flow_client.py:569-579`):
```json
"referenceImages": [ { "mediaId": "<uuid>", "imageUsageType": "IMAGE_USAGE_TYPE_ASSET" } ],
"metadata": {}
```

**Video upscale** (`flow_client.py:603-619`) — note its `clientContext` carries only `sessionId` +
`recaptchaContext`:
```json
{"aspectRatio": "...", "resolution": "VIDEO_RESOLUTION_4K", "seed": 12345,
 "metadata": {"sceneId": "..."}, "videoInput": {"mediaId": "<uuid>"},
 "videoModelKey": "veo_3_1_upsampler_4k"}
```

**Images** (`flow_client.py:426-448`):
```json
{
  "clientContext": {...}, "mediaGenerationContext": {"batchId": "<uuid4>"}, "useNewMedia": true,
  "requests": [{
    "clientContext": {...},
    "seed": 123456,
    "structuredPrompt": { "parts": [ { "text": "<prompt>" } ] },
    "imageAspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
    "imageModelName": "GEM_PIX_2",
    "imageInputs": [ { "name": "<media uuid>", "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE" } ]
  }]
}
```
`imageInputType` enum: `IMAGE_INPUT_TYPE_BASE_IMAGE` (the image being edited) |
`IMAGE_INPUT_TYPE_REFERENCE` (character/style refs). Order for edits is
`[base, ref, ref, …]` (`flow_client.py:473-478`).
**(C)** Note `PLAN.md:69` shows a flat `"prompt": "..."` for images too — same old/new split.

**Image upload** (`flow_client.py:681-691`):
```json
{"clientContext": {"projectId": "...", "tool": "PINHOLE"},
 "fileName": "image.jpg", "imageBytes": "<base64>", "isHidden": false,
 "isUserUploaded": true, "mimeType": "image/jpeg"}
```
Response → `media.name` is the mediaId (`flow_client.py:706-707`). `PLAN.md:117-124` documents an
older nested shape `{"mediaId": {"mediaId": "…"}}`.

### 9.5 Enums — (B-FK) verbatim

```
tool:              "PINHOLE"
userPaygateTier:   "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO"
applicationType:   "RECAPTCHA_APPLICATION_TYPE_WEB"
imageAspectRatio:  "IMAGE_ASPECT_RATIO_PORTRAIT" | "IMAGE_ASPECT_RATIO_LANDSCAPE"
aspectRatio:       "VIDEO_ASPECT_RATIO_PORTRAIT" | "VIDEO_ASPECT_RATIO_LANDSCAPE"
resolution:        "VIDEO_RESOLUTION_4K" | "VIDEO_RESOLUTION_1080P"
imageInputType:    "IMAGE_INPUT_TYPE_BASE_IMAGE" | "IMAGE_INPUT_TYPE_REFERENCE"
imageUsageType:    "IMAGE_USAGE_TYPE_ASSET"
status:            "MEDIA_GENERATION_STATUS_PENDING" | "MEDIA_GENERATION_STATUS_SUCCESSFUL"
                 | "MEDIA_GENERATION_STATUS_FAILED"
captchaAction:     "IMAGE_GENERATION" | "VIDEO_GENERATION"
```

**`imageModelName`** (`agent/models.json:36-39`) — the real wire values are codenames, **not**
marketing names:
```
"NANO_BANANA_PRO" -> "GEM_PIX_2"
"NANO_BANANA_2"   -> "NARWHAL"
```

**`videoModelKey`** — the shipped set (`agent/models.json:2-35`):
```
PAYGATE_TIER_TWO
  frame_2_video            (both ratios): veo_3_1_i2v_lite_low_priority
  start_end_frame_2_video  (both ratios): veo_3_1_i2v_lite_low_priority
  reference_frame_2_video  (both ratios): veo_3_1_r2v_fast_landscape_ultra_relaxed
PAYGATE_TIER_ONE
  frame_2_video           : veo_3_1_i2v_s_fast          / veo_3_1_i2v_s_fast_portrait
  start_end_frame_2_video : veo_3_1_i2v_s_fast_fl       / veo_3_1_i2v_s_fast_portrait_fl
  reference_frame_2_video : veo_3_1_r2v_fast            / veo_3_1_r2v_fast_portrait
upscale: veo_3_1_upsampler_4k | veo_3_1_upsampler_1080p
```
`PLAN.md:156-166` additionally documents the `_ultra` family:
`veo_3_1_i2v_s_fast_portrait_ultra`, `veo_3_1_i2v_s_fast_ultra`,
`veo_3_1_i2v_s_fast_portrait_ultra_fl`, `veo_3_1_i2v_s_fast_ultra_fl`,
`veo_3_0_r2v_fast_portrait_ultra`, `veo_3_0_r2v_fast_ultra`.
**Naming grammar (C):** `veo_<ver>_<i2v|r2v|t2v>_<size>_<speed>[_portrait][_ultra][_fl][_relaxed|_low_priority]`
— `fl` = first+last frame, `s` = small, `low_priority`/`relaxed` = 0-credit queue.

**(B-KS)** additionally observed, from `GET /fx/api/trpc/videoFx.getVideoModelConfig`:
model keys `veo_3_0_t2v_fast`, `veo_3_0_t2v_pro`; per-model `capabilities`, `videoLengthSeconds`,
`creditCost`, `generationTime`; capability enums `VIDEO_MODEL_CAPABILITY_TEXT`,
`VIDEO_MODEL_CAPABILITY_AUDIO`.
**(C) This is the endpoint you should call to enumerate models at runtime instead of hardcoding
keys** — the key set above will rot.

### 9.6 Submit → poll → retrieve

**Submit response, "operations" schema** (`agent/worker/_parsing.py:65-86`,
`sdk/services/operations.py:95-111`):
```json
{"operations": [ { "operation": { "name": "models/…/operations/…",
                                  "metadata": { "video": { "mediaId": "<uuid>",
                                                           "fifeUrl": "https://…" } } },
                   "status": "MEDIA_GENERATION_STATUS_PENDING" } ]}
```
**(B-KS)** independently lists `operations`, `operation.name`, `sceneID`, `remainingCredits` in the
video-gen response. **(C)** `remainingCredits` on the submit response is worth reading — free credit
telemetry.

**Poll:** `POST /v1/video:batchCheckAsyncVideoGenerationStatus` with body **`{"operations": [...]}`**
— you feed back the operation objects you got from submit (`flow_client.py:630-639`). No reCAPTCHA.
Loop at `VIDEO_POLL_INTERVAL = 10 s`, timeout `VIDEO_POLL_TIMEOUT = 420 s` (`config.py:25,27`);
terminal on `MEDIA_GENERATION_STATUS_SUCCESSFUL` / `MEDIA_GENERATION_STATUS_FAILED`
(`operations.py:272-276`).

**Submit response, "workflows" schema** — newer, used by `*_low_priority` and `*_ultra_relaxed`
models (`operations.py:98-138`):
```json
{"workflows": [ { "name": "...", "metadata": { "primaryMediaId": "<uuid>" } } ],
 "media": [ { "name": "<uuid>", ... } ]}
```
For these there is **no operation polling**. You poll `GET /v1/media/{primaryMediaId}` until the
response contains `video.encodedVideo` (base64 MP4) — flowkit validates the real thing by checking
`binary[4:8] == b"ftyp"`, because while still generating Flow returns a ~1–2 KB metadata payload
that also base64-decodes (`operations.py:180-197`). **(C) That `ftyp` magic check is the single best
implementation detail in the whole body of research** — it is the only reliable "is it actually
done" signal in workflow mode.

**Media URL shapes:**
- `fifeUrl` / `imageUri` / `servingUri` on media objects (`_parsing.py:54,73,98`,
  `flow_client.py:664-665`).
- Signed GCS URLs, exact regex from `extension/background.js:610`:
  ```
  https://storage.googleapis.com/ai-sandbox-videofx/(image|video)/[0-9a-f-]{36}?<signature…>
  ```
  The 36-char segment **is** the media UUID — flowkit recovers mediaIds by regexing it out of the
  URL when the JSON omits them (`_parsing.py:29-32`).
- Trusted-domain allowlist used before persisting any URL (`flow_client.py:238`):
  `^https://(storage\.googleapis\.com|lh3\.googleusercontent\.com)/`
- **Signed URLs expire.** flowkit refreshes them by monkey-patching `window.fetch` inside
  `labs.google`, watching every `/fx/api/trpc/` response for the
  `storage.googleapis.com/ai-sandbox-videofx/` substring and harvesting fresh URLs
  (`extension/injected.js:11-30`, `background.js:608-645`). Uploaded `media_id`s have a **~1 h TTL**
  (README error table).
- **Critical gotcha (B-FK)** `_parsing.py:38-40`:
  > "mediaId is a UUID. mediaGenerationId is a base64 protobuf string (`CAMS…`) — do NOT use this."
  There are two ID-shaped fields and only the UUID one works downstream.

### 9.7 tRPC on labs.google

**(B-FK)** `flow_client.py:392-408` — the only tRPC *mutation* in that codebase:
```
POST https://labs.google/fx/api/trpc/project.createProject
headers: content-type: application/json, accept: */*, authorization: Bearer <ya29…>
credentials: include
body:    {"json": {"projectTitle": "<title>", "toolName": "PINHOLE"}}
```
So the **POST mutation shape is a bare superjson envelope `{"json": {...}}`** — no `meta`, no
`batch`. **(C)** `meta` only appears when a value needs superjson type info (Date, Map, undefined);
plain scalars omit it. There is **no** `?batch=1` on this call.

**(B-FK)** `background.js:358-362` restricts these to `https://labs.google/` and routes them through
a separate `trpc_request` handler that does **not** solve reCAPTCHA — tRPC calls are captcha-free.

**(B-KS)** additionally observed as GETs: `/fx/api/trpc/videoFx.getVideoModelConfig` and
`/fx/api/trpc/media.fetchUserHistoryDirectly`.
**(B-IFX)** `src/ImageFX.ts:69,128` uses `/fx/api/trpc/media.fetchMedia` and
`/fx/api/trpc/backbone.captionImage`.
**(B-CL)** `comfyui_whisk.py:96,246` uses `/fx/api/trpc/backbone.generateCaption` and
`/fx/api/trpc/backbone.generateStoryBoardPrompt`.

**(C) Your observed GET procedures** (`project.searchUserProjects`, `videoFx.getFlowAppConfig`,
`videoFx.getUserSettings`, `general.fetch*`, `general.submitBatchLog`) are entirely consistent with
this namespace (`project.*`, `videoFx.*`, `media.*`, `backbone.*`, `general.*`) but I did **not**
find any public source that spells out the GET query-string form. **No source I read shows
`?batch=1&input={"0":{"json":…}}` for Flow.** Take the GET convention from your own capture, not
from here.

### 9.8 `_next/data` project fetch

**(B-KS)** verbatim:
```
GET https://labs.google/fx/_next/data/eVHN8UaiK2ThAHJBmKcPD/en/tools/flow/project/[projectId].json
```
returning "compressed JSON payload containing project metadata & state". That confirms your observed
shape including the build hash (`eVHN8UaiK2ThAHJBmKcPD` in that capture).
**(C)** The buildId is Next.js's `__NEXT_DATA__.buildId` — read it out of the HTML of any
`labs.google/fx` page; it changes on every Flow deploy, so never hardcode it. No public source I
found automates this for Flow.

### 9.9 reCAPTCHA — mandatory for generation

**(B-FK)** Generation endpoints require a reCAPTCHA **Enterprise** token; status/credits/media/tRPC
do not. Three-layer solve (`PLAN.md:168-183`, `extension/injected.js`):
```js
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action: pageAction });
```
`pageAction` = `IMAGE_GENERATION` or `VIDEO_GENERATION`. It **must** run in the MAIN world on a live
`labs.google` tab (that is the only place `window.grecaptcha.enterprise` exists), so the token is
injected into the already-built body just before send (`background.js:445-451`):
```js
if (finalBody.clientContext?.recaptchaContext)
  finalBody.clientContext.recaptchaContext.token = captchaToken;
for (const req of finalBody.requests ?? [])
  if (req.clientContext?.recaptchaContext) req.clientContext.recaptchaContext.token = captchaToken;
```
**(C) This is the hard architectural constraint and it decides your design.** You cannot generate
from a pure server-side HTTP client — you need a live authenticated `labs.google` tab to mint a
captcha token per request. That is precisely why flowkit is "Python agent + Chrome extension" and
not just a Python client. Your extension-based project is already the right shape for this.

### 9.10 Limits, quotas, failure modes — (B-FK) `README.md:735-760`, `config.py:24-30`

Throttles flowkit actually enforces: `MAX_CONCURRENT_REQUESTS = 5`, `API_COOLDOWN = 10 s` between
calls, `MAX_RETRIES = 5`, `VIDEO_POLL_INTERVAL = 10 s`, `VIDEO_POLL_TIMEOUT = 420 s`,
`STALE_PROCESSING_TIMEOUT = 600 s`.

Structured errors arrive at **`data.error.details[].reason`**:

| `reason` | Meaning | Recoverable |
|---|---|---|
| `PUBLIC_ERROR_UNSAFE_GENERATION` | safety filter tripped | no — rewrite prompt |
| `PUBLIC_ERROR_USER_QUOTA_REACHED` | daily credits exhausted | no — wait for reset |
| `PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED` | per-model daily cap (`flow_client.py:143`) | switch profile/model |
| `PUBLIC_ERROR_MODEL_ACCESS_DENIED` | tier mismatch | no — downgrade model |
| `PUBLIC_ERROR_UNUSUAL_ACTIVITY` (403, msg `reCAPTCHA evaluation failed`) | session flagged bot-like — bursty submits, VPN/shared IP, stale cookies | **no** — pause, clear `google.com` + `labs.google` cookies, re-sign-in, resume at ≥1 s gap / ≤5 concurrent |
| `Requested entity was not found` | uploaded `media_id` expired (**~1 h TTL**) | yes — re-upload, requeue |
| `Internal error encountered` | transient Flow 500 | yes — backoff `2^retry * 10s`, cap 300 s |

HTTP: **401** = Bearer expired → re-capture token and retry. **403** = captcha failed / no Flow tab /
model access denied. **404** = expired `media_id`. **429** = rate limited → back off.
**(B-FK)** `README.md:591-593` also warns that `*_ultra_relaxed` models **silently return empty
`operations`** on `SERVICE_TIER_ADVANCED` accounts (they need `SERVICE_TIER_ULTRA`) — a failure that
looks like success. Check for an empty operations array explicitly.

### 9.11 Bottom line for your build (C)

1. **Drop DOM automation for generation.** The API path is fully mapped and far more reliable.
2. **Keep the browser** — not for clicking, but as (a) the reCAPTCHA Enterprise token minter and
   (b) the source of the `ya29.` bearer. Your `ai-mcp-extension` already has the right topology.
3. **Get the token from `GET https://labs.google/fx/api/auth/session`** rather than sniffing
   `webRequest` — simpler, and it hands you `expires`.
4. **Enumerate models at runtime** via `GET /fx/api/trpc/videoFx.getVideoModelConfig` instead of
   hardcoding `videoModelKey` strings.
5. **Handle both response schemas** (`operations[]` vs `workflows[] + media[]`) from day one, and
   use the `ftyp` magic-byte check in workflow mode.
6. Respect ≤5 concurrent / ≥1 s spacing — `PUBLIC_ERROR_UNUSUAL_ACTIVITY` is not auto-recoverable
   and burns the session.

### 9.12 Not verified

- The GET query-string form for `/fx/api/trpc/*` (batch/superjson) — no public source found.
- `/v1:fetchUserRecommendations`, `/v1:checkAppAvailability`, `/v1/flow/likeness:checkEligibility` —
  none appear in any source I read. Only `/v1/credits` and `/v1/flow:batchLogFrontendEvents` from
  your list are corroborated.
- `batchAsyncGenerateVideoText`'s exact body — endpoint confirmed (B-KS), field names corroborated
  at the envelope level only.
- Whether `textInput.prompt` or `textInput.structuredPrompt.parts[]` is current.
