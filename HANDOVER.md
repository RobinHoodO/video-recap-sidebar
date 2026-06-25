# HANDOVER — 2026-06-25 (video-recap-sidebar + side-tasks)

Session was long/expensive (~$360). Restart fresh; this carries verified facts only.

## PRIMARY: video-recap-sidebar (YouTube transcript-recap MV3 extension)
- **Private repo (source of truth):** `RobinHoodO/video-recap-sidebar`, HEAD `106e518`. Untracked from the Thrivbe-AI monorepo.
- **Path:** `/Users/robinsverd/Thrivbe-AI/lab/video-recap-sidebar`. Stack: MV3 + CRXJS + Vite + React, inline styles, shadow-DOM panel; LLM calls via background worker (BYO key: OpenAI/Anthropic/OpenRouter).

### What WORKS (all built + pushed)
- **Transcript fetching SOLVED.** Tier order in `core.ts`: timedtext (non-gated) → **active panel-open** (gated, free) → Apify (paid fallback) → Innertube (dead, last-ditch). Cached by videoId in chrome.storage.
- **KEY LEARNING:** YouTube killed `youtubei/v1/get_transcript` (Dec 2025, 100% 400 — YouTube.js #1102). The free path is reading YouTube's OWN transcript panel. YouTube renamed its markup to `<transcript-segment-view-model>` (timestamp `.ytwTranscriptSegmentViewModelTimestamp`, text `.ytAttributedStringHost`) — that rename was the whole saga; reader now supports it + legacy. *If transcripts break again, suspect a markup rename — inspect live DOM via CDP (see below).*
- **Per-video isolation** across SPA nav (validates `pr.videoDetails.videoId`; no cache poisoning).
- **Send to Librarian** button (toolbar book icon) → POSTs full transcript to Hermes webhook `127.0.0.1:8644/webhooks/librarian-ingest` (X-Gitlab-Token auth) via background worker. Verified HTTP 202.
- **Framework focus option** (next to Insightful/Funny/etc.) → comprehensive 10-20-bullet framework.
- Keyboard isolation (Enter sends; keys don't reach YT player), inline focus/format/count dropdowns, configurable Gemini prompt, pre-gen Summary+Timestamped.

### SESSION 2 (2026-06-25, HEAD `80a2027`) — done this session
- **SW wake-race fixed** — `sendToWorker()` in core.ts retries `chrome.runtime.sendMessage` on the MV3 wake-race (no keepalive). Fixed dropped LLM/Librarian calls on new videos.
- **Comments wired** — `readPageComments()` reads YouTube's rendered `ytd-comment-thread-renderer` (zero-key); demo data gone. Scroll-to-load + ↻ Refresh hint. Selectors `#author-text`/`#content-text`/`#vote-count-middle` (markup-rename risk).
- **Librarian 401 SOLVED** — root cause was **Remove+Load wiping chrome.storage**, so the secret was re-typed (with whitespace) each reload. Fix: secrets/keys now **baked at build time from a gitignored `.env`** (seeded from `Thrivbe-AI/.env`) → survive reload, byte-exact. Confirmed working (HTTP 202). `.env` + `dist/` gitignored. Trim safety net also added.
- **Secret scrubbed from git history** — `git filter-repo` replaced `BP1HyMa2…`→`***REMOVED***`, force-pushed. Backup bundle in session scratchpad.
- **LEARNINGS.md added** (committed) + memory pointer `video-recap-learnings` — transferable MV3/scraping/CDP/cost learnings.

### TODO / open
1. **ROTATE the Hermes librarian secret** (still the original value, baked but unrotated). Update 3 places: `~/.hermes/webhook_subscriptions.json`, `~/.hermes/config.yaml:650`, extension `.env` → rebuild. Then `launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway`.
2. **Wiki ingest of LEARNINGS.md** — proposed nodes: concepts/cdp-live-dom-debugging, concepts/mv3-extension-patterns, concepts/scraping-tiered-fallback, entities/youtube-transcript-extraction, sources/2026-06-25-video-recap-learnings.
3. Anthropic provider uses the baked OpenAI key by default (single apiKey field) — switch in ⚙ once, persists.
4. Parser tests missing; residual gated-panel SPA carryover; active-panel close uses old engagement-panel id.
- Delete junk wiki note "VRS connectivity test — ignore/delete" (from an auth curl).
- Full detail in `IMPROVEMENT-PLAN.md` (in repo).

### CDP debug technique (reusable)
Launch debug Chrome: `--remote-debugging-port=9222 --user-data-dir=<tmp> --load-extension=dist`, then speak CDP from Node 22 (built-in WebSocket, zero installs) to inspect live DOM / `Page.captureScreenshot` / test selectors. Probe scripts in session scratchpad `cdp-probe*.mjs`. The screenshot is what cracked the markup-rename bug.

## SIDE-TASK A: sandcastle taught into the system
`@ai-hero/sandcastle` (Matt Pocock) — isolated-sandbox agent orchestration (Docker/Podman/Vercel) + auto git worktrees. Added to: coding-strategist catalog (`~/.claude/skills/coding-strategist/references/framework-catalog.md`), `Thrivbe-AI/CODING-FRAMEWORK-MAP.md`, global `~/.claude/rules/common/agents.md`.

## SIDE-TASK B: wiki ingest
`CODING-FRAMEWORK-MAP.md` organized into the LLM wiki: created `concepts/coding-framework-stack`, `entities/sandcastle`, `sources/2026-06-25-coding-framework-map`; index ×3 + log updated; raw snapshot saved. **Lint follow-up:** fill red links ([[coding-strategist]], [[ponytail]], [[gitnexus]], [[codex]]); back-relink from [[claude-code-workflow]]/[[matt-pocock]]; refresh `hot.md`.
