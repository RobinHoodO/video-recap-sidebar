# HANDOVER — Video Recap Sidebar

**Date:** 2026-06-25
**Project:** `/Users/robinsverd/Thrivbe-AI/lab/video-recap-sidebar/`
**Why this handover:** prior session hit ~$195 (long context replaying every turn). Continue in a fresh session.

## What it is
A YouTube video-recap Chrome extension (MV3). A dark panel injects into the watch page (top of the recommendations column), fetches the transcript, and uses a BYO-key LLM to produce a configurable recap, timestamped summary, and grounded chat. Cloned from the design in `reference/Video Recap.dc.html` + `reference/uploads/*.png`.

## Stack
MV3 + CRXJS + Vite + React 18, **inline styles** (ported from the mockup for pixel-fidelity — no Tailwind), Shadow-DOM isolated. LLM calls run in a **background service worker** (`src/background.ts`) so the API key never touches the page and there's no CORS.

## Locked decisions
- v1 = working end-to-end with real LLM. No auth, no payments.
- **BYO key**, stored in `chrome.storage.local.settings`. Providers: **OpenAI, Anthropic, OpenRouter** (OpenRouter = any model id).
- In-page content-script panel (NOT the native side_panel) — matches the mockup.

## Status — what WORKS (build + typecheck green)
- Full pixel-perfect UI: 5 views (Summary / Timestamped / Ask / Comments / Transcript) + settings overlay + toast. Capped to video height, pinned to top, Shadow-DOM isolated.
- Settings persisted; provider/model/key UI; Focus/Format/Length/emoji/highlights/language feed the prompt.
- LLM: Summary, Timestamped, grounded Ask — all from the real transcript, via the service worker.
- Click-a-timestamp seeks the video.
- Render hardened: malformed LLM JSON shows a friendly error instead of crashing (two prior crashes fixed: null `data.heading`, missing `bullets/items`).

## Status — the OPEN problem: transcript fetching on gated videos
YouTube now gates the `timedtext` caption endpoint behind a **PoToken** (returns empty 200s). Current `src/core.ts` `fetchTranscript()` tries, in order:
1. **Innertube `next` → `get_transcript`** (same-origin, no PoToken). Just added: fetches the transcript `params` from `youtubei/v1/next` when the page doesn't embed them. **← needs real-video testing; may already fix gated videos for free.**
2. timedtext `json3`
3. timedtext XML
4. **passive** scrape of YouTube's own transcript panel — only if the user has it open. A MutationObserver (`watchForTranscriptPanel` in `src/content.tsx`) auto-loads it into our panel the moment "Show transcript" is opened.

Test video that was failing: `https://www.youtube.com/watch?v=wjnWnAvQ43Y`

## NEXT TASKS (priority order)
1. **TEST the Innertube `/next` fix** on `wjnWnAvQ43Y` (reload extension → open panel). If the transcript auto-loads, the core problem is solved free.
2. **If still flaky → wire Apify fallback** (researched, recommended):
   - Actor: **`supreme_coder/youtube-transcript-scraper`** (~$0.30/1k; Apify's $5/mo free credit ≈ ~16k transcripts/mo; actively maintained through YT's Dec'25/Jan'26 changes via residential proxies).
   - Call from content script: `POST https://api.apify.com/v2/acts/supreme_coder~youtube-transcript-scraper/run-sync-get-dataset-items?token=<APIFY_TOKEN>` (CORS-OK; run-sync fine, ~5–30s cold start → show loading).
   - Add `"https://api.apify.com/*"` to `host_permissions` (manifest in `vite.config.ts`); add an Apify token field to settings (BYO).
   - Insert as tier between Innertube and the passive scrape.
3. **Comments tab** is still demo data — wire to real comments later (needs YT comment API) or drop the tab.
4. Pixel-QA the panel against `reference/` on a real video.

## Run / load
```
cd /Users/robinsverd/Thrivbe-AI/lab/video-recap-sidebar
npm install            # if fresh
npm run build          # or: npm run dev  (HMR)
# chrome://extensions → Developer mode → Load unpacked → select dist/
# Open a youtube.com/watch video → ⚙ → pick provider, paste API key
```
After ANY manifest change: remove the extension and re-add (a plain reload can wedge). Confirm you're on the latest build (check the hashed filename in any error isn't an old one).

## Key files
- `src/core.ts` — transcript fetch (4 tiers) + LLM types/prompts/provider calls (OpenAI/Anthropic/OpenRouter).
- `src/background.ts` — service worker; reads settings, calls the LLM.
- `src/Panel.tsx` — the UI (~380 lines), wired to transcript + LLM, hardened renders.
- `src/content.tsx` — injects panel, fetches transcript, SPA-nav handling, transcript-panel MutationObserver.
- `vite.config.ts` — MV3 manifest (permissions: storage; host_permissions: openai/anthropic/openrouter).
- `reference/` — design mockup + screenshots. `PROJECT-APPROACH.md` — the plan.
- `spike/` — early transcript spike (superseded by core.ts).

## Notes
- JSON mode works best on OpenAI `gpt-4o-mini`/`gpt-4o`; on OpenRouter pick a model that supports structured output.
- Research detail (PoToken, Innertube, Apify, Supadata comparison) was gathered this session — summarized in the priority tasks above.
