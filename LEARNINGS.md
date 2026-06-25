# Engineering Learnings — video-recap-sidebar

**Project:** MV3 Chrome extension (CRXJS + Vite + React) that injects a shadow-DOM panel into the
YouTube watch page, fetches the video transcript, and generates AI recaps via a BYO-key background
service worker (OpenAI / Anthropic / OpenRouter).

**Why this doc exists:** The session that built this cost ~$360 and hit nearly every non-obvious
pitfall in YouTube scraping, MV3 lifecycle, and shadow-DOM integration. The lessons below are
captured so future projects — and AI coding agents starting fresh — don't re-pay those costs.

Each entry follows: **Situation → What was tried → What worked → Transferable rule.**

---

## 1. Chrome MV3 / Extension Architecture

### 1.1 Service Worker Wake-Race

**Situation:** MV3 service workers terminate after ~30 s of idle. The first `chrome.runtime.sendMessage`
call after the worker goes to sleep rejects with  
`"Could not establish connection. Receiving end does not exist"` or `"message channel closed"`
before Chrome finishes waking the worker.

**Tried:** Keeping the worker alive with `chrome.alarms` heartbeats (MV3 actively discourages this and
it still has edge-case races).

**Worked:** Catch the wake-race error by message text and retry with linear back-off (150 ms × attempt).
Two retries are enough in practice. The worker re-wakes within one retry window.

```ts
// src/core.ts — sendToWorker()
const wakeRace = /Receiving end does not exist|message channel closed|Could not establish connection/i.test(m);
if (!wakeRace || attempt >= retries) throw err;
await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
```

**Rule:** In MV3 extensions, always wrap `chrome.runtime.sendMessage` with a retry loop that detects
the wake-race error by message substring. Two retries with linear back-off are sufficient. Never try
to keep the service worker alive — work with the lifecycle, not against it.

---

### 1.2 Content Script Isolated World — Can't Read `window.*`

**Situation:** Content scripts run in an "isolated world": they share the page DOM but have a
separate JS heap. `window.ytInitialPlayerResponse` is set by YouTube's page scripts in the main
world and is `undefined` in the content script's world.

**Tried:** `window.ytInitialPlayerResponse` directly — always `undefined`.

**Worked:** Read the raw `<script>` tag text and manually slice out the JSON object by brace-balancing:

```ts
for (const s of Array.from(document.scripts)) {
  const i = s.textContent.indexOf("ytInitialPlayerResponse");
  // brace-balance to extract the JSON object
}
```

**Rule:** In MV3 content scripts, never rely on `window.*` globals set by page scripts. Read them
from the raw `<script>` tag text instead. When parsing embedded JSON from script tags, brace-balance
rather than regex (avoids mismatched escapes).

---

### 1.3 Shadow DOM + Composed Keyboard Events

**Situation:** The panel inputs live inside a shadow DOM. Keyboard events (`keydown`, `keyup`,
`keypress`) from shadow-DOM elements are "composed" — they re-bubble through the outer DOM tree.
YouTube attaches document-level key handlers that treat `space`, `k`, `j`, `←`, `→` as video
controls. Typing in the Ask field paused/seeked the video.

**Tried:** Attaching `stopPropagation` inside the React component tree. This stopped keyboard events
from reaching YouTube but also stopped the panel's own `Enter`-to-send handler from firing (React's
synthetic events see the stopPropagation).

**Worked:** Attach `stopPropagation` to the shadow **host** element — above the React root:

```ts
const host = document.createElement("div");
["keydown", "keyup", "keypress"].forEach((ev) =>
  host.addEventListener(ev, (e) => e.stopPropagation())
);
host.attachShadow({ mode: "open" });
```

React's synthetic events fire inside the shadow tree (below the host listener), so `Enter`-to-send
still works. Keyboard events never escape to the document.

**Rule:** For composed keyboard events in a shadow-DOM extension, always intercept at the shadow
**host** (not inside React). That preserves component-level key handlers while blocking document-level
leakage. Placing `stopPropagation` inside the React tree eats your own event handlers.

---

### 1.4 MV3 Manifest Changes Require Full Remove + Re-add

**Situation:** Adding a new `host_permission` (e.g. `https://api.apify.com/*`) and doing a plain
"reload" in `chrome://extensions` left the old permission set in effect. The new fetch failed with a
CORS/permission error even though `manifest.json` was correct.

**Worked:** Remove the extension entirely → **Load unpacked** → pick `dist/` again. Only a full
re-add picks up permission changes.

**Rule:** Any time `manifest.json` changes (permissions, content script matches, service worker
path), do a **full Remove + Load unpacked** cycle. A plain reload only refreshes JS/CSS assets; it
does not reparse the manifest's permission declarations.

---

### 1.5 MutationObserver on `document.body` + `querySelectorAll` = CPU Spike

**Situation:** A `MutationObserver` on `document.body` with `subtree: true` was used to detect when
YouTube's transcript panel had rendered. The callback ran a `querySelectorAll` on every DOM mutation.
YouTube mutates continuously (player progress, comments lazy-loading, animations). Result: two YouTube
tabs each pegged a renderer process at ~190% CPU; system load hit 45.

**Worked:**
- Throttle the expensive selector scan to ~2×/sec using a `scheduled` flag + `setTimeout(fn, 500)`.
- Add a deadline (5 min) after which the observer disconnects unconditionally.

```ts
let scheduled = false;
const deadline = Date.now() + 5 * 60_000;
transcriptObserver = new MutationObserver(() => {
  if (scheduled) return;
  if (Date.now() > deadline) return stop();
  scheduled = true;
  setTimeout(() => { scheduled = false; /* do the scan */ }, 500);
});
```

**Rule:** Never run expensive DOM queries (querySelector, getBoundingClientRect) synchronously inside
a `MutationObserver` on `document.body subtree:true`. Always throttle with a `scheduled` flag.
Always add a deadline so the observer can't run unbounded on a long-lived page.

---

### 1.6 YouTube SPA Navigation — `ytInitialPlayerResponse` Poisoning

**Situation:** YouTube is a SPA. When you navigate to a new video, the page doesn't reload; it
re-renders the player and updates the URL, but the **previous video's** `ytInitialPlayerResponse`
remains in the existing `<script>` tags for a brief window (or until the new scripts are injected).
The transcript fetch was reading the old video's caption tracks, generating the recap for the wrong
video, and caching that bad data under the new video's key.

**Worked:** After reading `ytInitialPlayerResponse`, validate `videoDetails.videoId` against the
current URL's `v=` parameter before trusting the caption tracks. Abort the cache write if the video
changed mid-fetch:

```ts
const stale = !!pr?.videoDetails?.videoId && pr.videoDetails.videoId !== expectedVid;
const tracks = stale ? [] : (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
// …
const onSameVideo = (new URLSearchParams(location.search).get("v") || "") === videoId;
if (videoId && segs.length && onSameVideo) chrome.storage.local.set({ [key]: segs });
```

Listen for `yt-navigate-finish` (YouTube's SPA nav event) to re-trigger the panel mount and transcript
fetch keyed to the new video. Key the React component by `videoId` so state resets cleanly.

**Rule:** On YouTube SPA navigation, treat all in-page data derived from `ytInitialPlayerResponse` as
potentially stale. Always cross-check `videoDetails.videoId` against `location.search`. Never cache
data indexed by video ID if a navigation happened mid-fetch.

---

### 1.7 API Calls Must Go Through the Background Worker

**Situation:** Making LLM API calls (OpenAI, Anthropic) directly from the content script fails: the
API keys are visible in the page's network traffic, and cross-origin requests from content scripts
are blocked by CORS headers on those endpoints.

**Worked:** Route all API calls through the MV3 service worker (`background.ts`). The worker reads
the BYO key from `chrome.storage.local`, makes the fetch, and returns the result. Service workers are
exempt from the page's CORS restrictions (they use the extension origin, not the page origin).

**Rule:** In MV3 extensions, always route third-party API calls through the background service worker.
Content scripts get CORS-blocked by design. The worker is the right layer for all key-holding and
external network I/O.

---

## 2. Web Scraping Resilience

### 2.1 `youtubei/v1/get_transcript` Is Dead (Dec 2025)

**Situation:** The Innertube `get_transcript` endpoint was the "obvious" fast, free, same-origin
transcript path. Multiple implementations (YouTube.js, yt-dlp, our own Codex-generated code) correctly
constructed the request: full `INNERTUBE_CONTEXT`, visitor headers, SAPISIDHASH auth, params from
the `/next` response. All returned **HTTP 400** 100% of the time.

**Tried:** Unicode-escape decoding of the params token, additional auth headers, calling from the
page's own session cookies — all 400.

**Root cause:** YouTube deployed new bot-detection in Dec 2025 that blocks `get_transcript` for all
automated callers. Confirmed in YouTube.js GitHub issue #1102: *"Now they went 100% block."*
The Codex implementation was correct; the endpoint simply refuses.

**Worked:** Accept the endpoint is dead and route around it (see §2.2).

**Rule:** Do not attempt to fix a `youtubei/v1/get_transcript` 400 error. As of Dec 2025 this
endpoint is server-side blocked for all automated access regardless of credentials or context.
Research the issue tracker (YouTube.js #1102) before spending time on it.

---

### 2.2 timedtext CDN Returns Empty 200s on PoToken-Gated Videos

**Situation:** Caption tracks have `baseUrl` fields. Fetching them for non-gated videos returns the
transcript. For PoToken-gated videos (most logged-in content), the CDN returns an HTTP 200 with an
**empty body**. `response.json()` then throws; `response.text()` returns `""`.

**Rule:** Always read timedtext responses as text first, check for emptiness before parsing, and try
both `?fmt=json3` and the default XML format. If all tracks return empty, the video is PoToken-gated
and this tier must be skipped.

---

### 2.3 The Only Free Path for Gated Videos: YouTube's Own Transcript Panel

**Situation:** Both Innertube `get_transcript` and the timedtext CDN fail on PoToken-gated videos.

**Worked:** Drive YouTube's own **"Show transcript"** UI:
1. Click the `#expand` description expander (the button is hidden until description is expanded).
2. Find and click the "Show transcript" button (search by `aria-label`, fallback to text content).
3. Poll for `<transcript-segment-view-model>` or `<ytd-transcript-segment-renderer>` elements.
4. Read the rendered segments.
5. Close the panel if you were the one who opened it.

YouTube's own UI already carries the PoToken, so the rendered DOM contains the real transcript even
when every API path is blocked.

**Rule:** When YouTube's transcript APIs are blocked, piggybacking their own UI is the most reliable
free path. Open → read rendered DOM → close. The UI does the auth; you just read what's there.

---

### 2.4 YouTube Renamed Transcript Markup (2026)

**Situation:** The transcript panel was opening and loading successfully. Our reader returned 0
segments. Multiple rounds of tweaking the opener (12+ attempts, ~$15–20 each) found nothing because
the **opener was fine** — the **reader** was broken.

**Root cause:** YouTube migrated from:
```
<ytd-transcript-segment-renderer>
  <span class="segment-timestamp">0:02</span>
  <div class="segment-text">Hello world</div>
</ytd-transcript-segment-renderer>
```
to:
```
<transcript-segment-view-model>
  <div class="ytwTranscriptSegmentViewModelTimestamp">0:02</div>
  <span class="ytAttributedStringHost">Hello world</span>
</transcript-segment-view-model>
```

The rename was caught **only after a CDP screenshot** showed the panel was loaded (see §3.1).

**Fix:** Read new markup first, fall back to legacy:
```ts
const vm = document.querySelectorAll("transcript-segment-view-model");
if (vm.length) {
  // .ytwTranscriptSegmentViewModelTimestamp, .ytAttributedStringHost
} else {
  // ytd-transcript-segment-renderer fallback
}
```

**Rule:** When a YouTube DOM reader returns 0 results despite the expected UI being visible,
**suspect a markup rename first** — not a timing issue, not a selector typo. Get a screenshot of
the live DOM (CDP or DevTools) before iterating on selectors. Keep legacy selectors as fallback when
adding new ones; YouTube A/B-tests markup across videos and user cohorts.

---

### 2.5 Tiered Fallback Architecture for Fragile Data Sources

**Situation:** Any single path to YouTube transcript data can fail due to API kills, markup renames,
PoToken gating, or video-specific quirks.

**Worked:** A four-tier waterfall with explicit fallback semantics:

| Tier | Method | Cost | Coverage |
|------|---------|------|----------|
| 1 | `timedtext` CDN (json3 + XML) | Free, instant | Non-gated videos |
| 2 | Active panel-open (DOM drive) | Free, ~1–4 s | Gated videos |
| 3 | Apify scraper (BYO token) | ~$0.01, ~11 s | Nearly universal |
| 4 | Innertube `get_transcript` | Free but dead | Last-ditch |

Cache by `videoId` in `chrome.storage` — instant on revisit, and eliminates Tier 3's cold-start cost.

**Rule:** Whenever a data source is owned by a third party (especially a platform fighting scraping),
design a tiered fallback from day one: free-fast → free-slow → paid-reliable → last-ditch-dead.
Cache successes aggressively to amortize slow tiers.

---

## 3. Debugging Techniques

### 3.1 CDP Live DOM Inspection — The Technique That Cracked the Markup Rename

**Situation:** After 12 failed attempts to fix the transcript panel opener with different selectors
(each attempt costing ~$15–20 in session context), the root cause was still unknown. The extension
runs in Chrome; the AI coding agent has no direct window into the running browser.

**Worked:** Launch a throwaway debug Chrome instance from the terminal:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --load-extension=/path/to/dist
```

Then speak CDP from Node 22 (built-in `WebSocket`, zero npm installs):

```js
// cdp-probe.mjs
import { WebSocket } from "node:stream"; // Node 22 has native WS
const ws = new WebSocket("ws://127.0.0.1:9222/json/version");
// ... navigate to the YouTube URL, run Runtime.evaluate, Page.captureScreenshot
```

`Page.captureScreenshot` returned a PNG of the live page. The screenshot showed the transcript panel
**was loaded and visible** — 115 timestamped segments clearly rendered. This proved the opener
worked and the reader was wrong. The next CDP call, `Runtime.evaluate` with
`document.querySelector("transcript-segment-view-model")?.outerHTML`, returned the real new markup.
One read → exact selectors → fix landed on the first attempt.

**Rule:** When debugging a content-script interaction with a live web page DOM, reach for CDP
**immediately** rather than iterating blind. The CDP debug Chrome setup takes ~2 minutes. A single
screenshot or `Runtime.evaluate` call gives ground truth that can eliminate entire categories of
hypotheses. Every blind iteration without ground truth is speculative and expensive.

**Concrete setup checklist:**
- Launch: `--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug --load-extension=dist`
- Connect: `fetch("http://127.0.0.1:9222/json/version")` → get the WebSocket URL
- Navigate: `Page.navigate({url: "..."})`
- Wait: `Page.loadEventFired`
- Read DOM: `Runtime.evaluate({expression: "document.querySelector('...').outerHTML"})`
- Screenshot: `Page.captureScreenshot({format: "png"})` → base64 → save to file → view

---

### 3.2 Console Breadcrumbs → Ground Truth, Not Iteration

**Situation:** When `get_transcript` was returning 400, the approach was to add `console.log`
breadcrumbs, ask the user to paste them, then iterate on the fix — multiple round-trips of
implement → build → reload → test → paste logs → interpret → implement.

**Cost:** ~$135 before research finally found the root cause (the endpoint is dead; no implementation
fix is possible).

**What would have saved it:** Research the known failure (YouTube.js issue tracker) *before* adding
breadcrumbs. The 400 body said "invalid argument" and the issue was well-known — 10 minutes of web
research would have saved ~$100 of session context.

**Rule (the meta-lesson):** Before iterating on a failing API call:
1. Search for the error in the library's GitHub issues and StackOverflow.
2. If the endpoint returns 400/403/429 uniformly, suspect the endpoint is dead or rate-limited
   platform-wide — not a bug in your code.
3. Only add breadcrumbs if the root cause is genuinely ambiguous after research.

---

### 3.3 Stale Build Detection

**Situation:** Multiple times during development, a fix was shipped, the extension was "reloaded" in
`chrome://extensions`, and the old behavior persisted. The build hash in error messages (`content.tsx-DMXcPZy5.js`)
revealed the stale build — it matched the previous build, not the current one.

**Rule:** When debugging an extension, always verify the build hash in error messages or console logs
matches the most recent build artifact. If there's a mismatch, do a full Remove + Load unpacked.
Never trust a plain "reload" after a manifest change.

---

## 4. Process & Cost

### 4.1 Blind Iteration Is the Biggest Cost Multiplier

**Situation:** The session cost ~$360 total. A significant fraction was spent iterating on selectors
and parameters without ground truth — 12+ CDP-less attempts at the transcript opener at ~$15–20 each.

**The calculation:** One CDP session setup (2 min) + one screenshot → exact answer. Twelve blind
selector attempts → 12× $15 = ~$180, still no answer.

**Rule:** The first action when debugging any DOM interaction in a live browser should be to get a
screenshot or `outerHTML` of the target element. This is the "pay once, learn exactly" strategy.
Blind iteration is the "pay many times, maybe learn" strategy. The upfront cost of ground truth is
almost always lower than the accumulated cost of speculation.

---

### 4.2 Research Before Implementing Dead Paths

**Situation:** Significant effort was spent implementing and diagnosing the Innertube `get_transcript`
path — Codex-built implementation, Unicode-escape decoding, SAPISIDHASH auth, `/next` params
recovery. All of it was correct; the endpoint just refuses.

**The cost:** ~$135 in session context (including breadcrumb cycles) before research revealed the
endpoint was killed platform-wide.

**Rule:** Before implementing a scraping/API path for a major platform, search:
- `site:github.com <platform> <endpoint> 400` (or 403, 429)
- The official library's issue tracker (YouTube.js, yt-dlp, etc.)
- Recent StackOverflow answers (< 6 months old)

If the endpoint is dead, no amount of correct implementation will fix it.

---

### 4.3 Secrets in Source Code → Git History Is Forever

**Situation:** A Hermes webhook secret (`BP1HyMa2…`) was hardcoded as the default in `DEFAULT_SETTINGS`
to make the "Send to Librarian" button work immediately without setup. A background security review
caught it. The secret was removed in the next commit — but it remains in git history at commit
`9419e0d` permanently.

**Fix:** Default to empty; user pastes their own secret in settings. Add a note to rotate:

```ts
export const DEFAULT_SETTINGS: Settings = {
  // ...
  librarianSecret: "",  // paste in ⚙ → LIBRARIAN (HERMES); never commit it
};
```

**Rule:** Never hardcode any secret — even a "low-risk" localhost webhook token — as a default value
in source code. If it gets committed, it's in git history forever and must be rotated. Always BYO.
Always default to empty. Validate presence at use-time with a user-friendly error.

---

### 4.4 Long Sessions Compound Cost Geometrically

**Situation:** This project was built in one or two very long sessions, with accumulated context
replaying millions of tokens on each turn. Cost checkpoints at $57, $74, $135, and ~$250 were
noted but the session continued each time.

**The math:** A fresh session replays ~10–20K tokens. A long session replays millions. At a natural
handoff point (feature complete, docs written), restarting carries verified facts only and costs
~100× less per turn for equivalent reasoning quality.

**Rule:** Restart at natural break points. Establish handover docs (`HANDOVER.md`) that carry *only*
verified facts (what works, what's next, key config values) — not the full dialogue. The HANDOVER.md
pattern is the correct "session memory" primitive.

---

### 4.5 Dispatch Parallel Research While Doing Implementation Work

**Situation:** When the Innertube 400 was being diagnosed, a subagent (Codex) was dispatched in
the background to spike on the `get_transcript` problem while the main session did caching,
timeouts, and UI work. The subagent confirmed the endpoint was dead and returned the best available
implementation.

**Rule:** When a task has an uncertain research question and a certain implementation queue, dispatch
the research to a background agent immediately. Don't let uncertainty block progress on the known work.
The parallel agent pays for itself if it returns before the implementation is done.

---

## 5. Tips for AI Coding Agents

These are the highest-leverage rules distilled from the learnings above.

- **Get a screenshot before iterating on DOM selectors.** Launch debug Chrome with
  `--remote-debugging-port=9222 --load-extension=dist`, connect via Node 22's built-in WebSocket,
  call `Page.captureScreenshot`. One screenshot replaces 10 blind attempts.

- **When a platform API returns 400 uniformly, stop iterating on the implementation.** Search the
  library's issue tracker and StackOverflow first. The endpoint may be dead platform-wide.

- **In MV3, always wrap `chrome.runtime.sendMessage` with a 2-retry wake-race handler.** Detect
  `"Receiving end does not exist"` / `"message channel closed"` and retry with 150 ms back-off.

- **Never read `window.ytInitialPlayerResponse` in a content script** — it's `undefined` in the
  isolated world. Read from raw `<script>` tag text with brace-balancing.

- **Stop keyboard events at the shadow host, not inside React.** Attaching `stopPropagation`
  inside the React tree eats your own key handlers.

- **After any `manifest.json` change, always Remove + Load unpacked.** Plain reload does not
  reparse permissions.

- **Throttle MutationObserver callbacks on high-mutation pages** (YouTube, Google Docs, etc.) with
  a `scheduled` flag and `setTimeout(fn, 500)`. Add a 5-minute deadline.

- **Validate `videoDetails.videoId` against `location.search` before trusting in-page data on
  YouTube SPA pages.** The old response lingers in `<script>` tags after navigation.

- **Keep both new and legacy DOM selectors.** YouTube (and other platforms) A/B-test markup; a
  selector that works on one video may not work on another. Always fall through to the legacy form.

- **Never hardcode secrets as default values.** Even "low-risk" local tokens become permanent git
  history if committed. Always BYO + default empty.

- **Design tiered fallbacks for any scraping target.** Free-fast → free-slow → paid-reliable →
  last-ditch. Cache successes aggressively.

- **Route all third-party API calls through the MV3 background service worker.** Content scripts
  get CORS-blocked; workers don't. This also prevents key exposure in the page.

- **Restart sessions at natural break points and write `HANDOVER.md` with verified facts only.**
  Long sessions replay millions of tokens per turn; fresh sessions replay ~10–20K. The cost
  difference is real and compounds with every turn.

---

*Written 2026-06-25. Mined from: git history, HANDOVER.md, IMPROVEMENT-PLAN.md, and session
transcripts for sessions fb8ade7d, 3da8678e, and 0767898.*
