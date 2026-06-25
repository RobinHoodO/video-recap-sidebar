# Video Recap Sidebar — Project Approach

A clone of a YouTube video-recap / summarizer Chrome extension: a dark side
panel injected **into the watch page** (next to the video, over the
recommendations column) that fetches the transcript, calls an LLM, and renders
a configurable recap with highlighted terms, timestamps, and sections.

Source of truth for the design: `reference/Video Recap.dc.html` (the rendered
mockup) + `reference/uploads/*.png` (screenshots of states).

## Locked decisions (FRAME)

| Fork | Decision | Consequence |
|---|---|---|
| v1 scope | Working end-to-end with real LLM | No auth, no payments in v1 |
| LLM backend | BYO key, no backend | User pastes own key → `chrome.storage.local` → direct API call |
| Stack | MV3 + CRXJS + React + Tailwind | Content-script injected panel, Shadow-DOM isolated |
| Placement | In-page (next to video), NOT native side_panel | Matches mockup; must survive YouTube SPA nav |

## Status (2026-06-24) — END-TO-END DONE

Full working extension, build + typecheck green.

- **UI** — pixel-perfect panel from the mockup (5 views + settings + toast),
  capped to video height, pinned to top of the column, Shadow-DOM isolated.
- **Transcript** — extracted from the watch page (`ytInitialPlayerResponse`
  captionTracks → json3) in the content script. `src/core.ts`.
- **LLM** — real summary, timestamped summary, and grounded chat. BYO key
  (OpenAI **or** Anthropic) in settings → `chrome.storage.local`. Calls run in
  the **service worker** (`src/background.ts`) so there's no CORS / key-leak in
  the page. Focus/Format/Length/Highlights/emoji/language all feed the prompt.
- **Seek** — clicking a timestamp scrubs the video.
- **Not wired (later):** Comments tab (needs the comment API) — shows demo data.

**Use it:** load `dist/` (below) → open a video → ⚙ settings → pick provider,
paste API key → Summary/Timestamped/Ask generate from the real transcript.

**Run it:** `npm install` → `npm run build` (or `npm run dev` for HMR) → Chrome
→ `chrome://extensions` → Developer mode → "Load unpacked" → select **`dist/`**
→ open any `youtube.com/watch` video.

## Spine

Trimmed GSD (greenfield + UI-heavy + AI). UI and AI design phases injected;
IMPLEMENT fanned out in parallel. Full GSD new-project ceremony skipped (solo
lab clone). Ponytail hard throughout.

## Phases

- [ ] **0 · FRAME** — ✅ done. Scope locked (table above).
- [ ] **1 · RESEARCH (spike)** — `/gsd-spike` on YouTube transcript extraction
      from a content script. Timebox 30 min. Output: go/no-go + chosen method.
      → see `SPIKE.md`.
- [ ] **2 · PLAN** — `/gsd-plan-phase`; gate with `/grill-me`. Output: `PLAN.md`.
- [ ] **3a · DESIGN · UI** — `/gsd-ui-phase` + `/image-to-code-skill` against
      `reference/`. Output: `UI-SPEC.md`, tokens, component list.
- [ ] **3b · DESIGN · AI** — `/gsd-ai-integration-phase` (lite): config→prompt
      mapping (Focus/Format/Length/toggles), BYO-key flow, summary eval
      criteria. Output: `AI-SPEC.md`.
- [ ] **4 · IMPLEMENT (parallel)** — `superpowers:dispatching-parallel-agents`,
      TDD on logic-heavy bits. 3 workstreams:
      - **W1 · Scaffold** — CRXJS+Vite+React+Tailwind, MV3 manifest, inject into
        watch page, Shadow DOM, survive SPA nav (`yt-navigate-finish` +
        MutationObserver re-mount). *Unblocks W2 & W3.*
      - **W2 · UI** — tab bar (Recap/List/Chat/Transcript) · settings panel
        (segmented controls + toggles) · summary renderer (highlighted terms,
        timestamps, sections).
      - **W3 · Brains** — transcript fetch → BYO-key provider client → prompt
        assembly from settings → streamed render. Settings/key UI in
        `chrome.storage`.
- [ ] **5 · REVIEW & VERIFY** — `ecc:react-reviewer` + `ecc:typescript-reviewer`
      + `/qa` (load unpacked, test real videos) + `/ponytail-review`.
- [ ] **6 · SHIP (lab)** — package unpacked/zip; `/github-flow` to a repo
      (optional). No Web Store submission in v1.
- [ ] **7 · LEARN** — `/gsd-extract-learnings` + claude-mem; `/handoff` at
      session cap.

## Cross-cutting (always on)

ponytail (smallest working diff) · claude-mem (continuity) · grill-me at the
plan gate · codex = escape hatch if a YouTube-DOM/transcript fight stalls 3+
attempts.

## Deliberately skipped & why

Full GSD new-project (solo overkill) · backend/proxy phase (BYO key chosen) ·
`/gsd-secure-phase` + auth + Stripe paywall (not in v1) · Chrome Web Store
submission (lab build).
