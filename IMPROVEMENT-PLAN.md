# Video Recap Sidebar — Status & Learnings

**Updated:** 2026-06-25 · **Trajectory:** prototype/exploring · **Repo:** private `RobinHoodO/video-recap-sidebar` · **HEAD:** `e218c54`

---

## ✅ STATUS: transcript fetching SOLVED

Gated videos load **free + automatically** by driving YouTube's own transcript panel. Verified working across videos.

**Tier order in `fetchTranscript` (`core.ts`):**
1. **timedtext** caption tracks — instant/free, works on non-gated videos.
2. **Active transcript panel** — expand description → click "Show transcript" → read rendered segments → close. Free, works on gated videos (YouTube's UI carries the PoToken). **This is the primary path for gated videos.**
3. **Apify** (`supreme_coder~youtube-transcript-scraper`, BYO token, 45s timeout) — reliable paid fallback, ~11s.
4. **Innertube `get_transcript`** — last-ditch; effectively dead (see learnings).

Transcripts cached by videoId in `chrome.storage` → instant revisits.

## 🔑 KEY LEARNINGS (the hard-won ones — don't relearn these)

1. **`youtubei/v1/get_transcript` is dead (Dec 2025).** YouTube's new bot-detection returns **400 to ~100% of automated calls** — confirmed in YouTube.js issue #1102 by its own maintainers. No context/header/params/auth fix gets around it. Our Codex-built "correct" implementation was correct; the endpoint just refuses. Don't sink more time into it.
2. **timedtext CDN is PoToken-gated** → empty 200s on gated videos. Works only for non-gated.
3. **The only free path for gated videos = YouTube's own transcript panel.** Its UI already solved PoToken, so reading its rendered DOM is the reliable free route. We open it programmatically, read, close.
4. **YouTube migrated transcript markup (2026):** `<ytd-transcript-segment-renderer>` → **`<transcript-segment-view-model>`** (timestamp `.ytwTranscriptSegmentViewModelTimestamp`, text `.ytAttributedStringHost`). This single rename caused the whole "panel won't load" saga — the click worked all along; our *reader* returned 0. `fetchFromOpenTranscriptPanel` now reads new markup first, legacy as fallback. **If transcripts break again, suspect a markup rename first.**
5. **Debugging technique that cracked it:** launch a throwaway debug Chrome (`--remote-debugging-port=9222 --user-data-dir=<tmp> --load-extension=dist`), then speak CDP from Node 22 (built-in `WebSocket`, zero installs) to inspect live DOM, `Page.captureScreenshot`, and test selectors against the real page. Probe scripts in session scratchpad (`cdp-probe*.mjs`). Reach for this whenever a fix depends on YouTube's live DOM — beats guessing selectors.

## DONE this session
- **Send to Librarian** — toolbar book-icon button POSTs the full transcript (`{title,url,text}`) to the Hermes gateway webhook (`127.0.0.1:8644/webhooks/librarian-ingest`, `X-Gitlab-Token` auth) via the background worker; Hermes files it into the Thrivbe LLM wiki. Secret defaulted in `DEFAULT_SETTINGS.librarianSecret`. Verified HTTP 202.
- **Framework focus option** — new choice next to Insightful/Funny/etc.; generates a comprehensive, exhaustive nested framework (10-20 bullets) from the video. Branch in `summaryPrompt` (`core.ts`).
- **Per-video isolation across SPA navigation** — YouTube keeps the previous video's `ytInitialPlayerResponse` in page `<script>` tags after navigating, so timedtext was fetching/caching/recapping the WRONG video. Now validates `pr.videoDetails.videoId` against the current video before trusting tracks; skips caching if navigated mid-fetch. (Verified working.)
- Apify fallback + timeout · transcript cache · pre-generate Summary + Timestamped on load
- Keyboard isolation moved to shadow host (Enter sends in Ask; keys don't reach YT player)
- Inline focus/format/count dropdowns on Summary (no jump to config)
- Configurable Gemini prompt (full transcript already sent) · removed BETA badge
- Single private repo, untracked from the Thrivbe-AI monorepo

## REMAINING / NEXT
- 🟡 **Gated-video SPA carryover (residual):** if YouTube keeps the *previous* video's transcript panel open across a navigation, the panel-reader could read stale segments before YouTube refreshes them. Rare (YouTube usually closes the panel on nav). Guard `fetchViaTranscriptPanel` against this if it ever shows up.
- 🟡 **Active-panel "close after read"** uses the old engagement-panel id (`engagement-panel-searchable-transcript`); the new "In this video" panel likely has a different target-id, so the panel may stay open after reading. Cosmetic. Update the close selector if the lingering panel annoys.
- 🟡 **Top comments tab is demo data** — wire real (innertube `next` continuation) or drop the tab. Decision pending.
- 🟡 **No parser tests** — `findInitialSegments`, `parseJsonLoose`, Apify mapping, the new panel reader. A ~20-line check would catch the next markup rename fast.
- 🟢 Pre-gen fires 2 LLM calls/video automatically — fine for BYO key; gate Timestamped behind first-open if cost matters.

## Run / load
```
cd /Users/robinsverd/Thrivbe-AI/lab/video-recap-sidebar
npm run build
# chrome://extensions → reload (full re-add only after a manifest change)
# ⚙ → AI key (OpenAI/Anthropic/OpenRouter). Apify token optional (gated-video paid fallback).
```

## Key files
- `src/core.ts` — transcript tiers (timedtext → active panel → Apify → Innertube) + cache + LLM providers.
- `src/content.tsx` — panel injection, shadow-host keyboard isolation, transcript-panel observer, SPA nav.
- `src/Panel.tsx` — UI: pre-gen, inline dropdowns, Gemini prompt, settings.
- `vite.config.ts` — MV3 manifest (host_permissions incl. api.apify.com).
