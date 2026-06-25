# Video Recap Sidebar — Improvement Plan & Handoff

**Date:** 2026-06-25 · **Trajectory:** prototype/exploring · **Rigor:** ship-fast, ponytail-hard
**Last commit:** `d73e1e5b` (Apify fallback, caching, keyboard fix, configurable Gemini prompt)

---

## Strategist route (prototype-trimmed `/gsd-quick` + ponytail)

Brownfield · UI + AI/LLM · solo · fast. **No** full GSD lifecycle, **no** secure/validate/TDD ceremony — revisit only if trajectory flips to Chrome Web Store.

| Phase | Tool | Status |
|-------|------|--------|
| AUDIT | `/improve` + `/ponytail-review` | condensed audit below |
| PLAN per item | `/gsd-quick <feature>` (else inline) | — |
| IMPLEMENT | ponytail + `ecc:react-reviewer` on diff | in progress |
| REVIEW | `/code-review` on the diff | pending |
| SHIP | `/github-flow` (or scoped commit) | first commit done |
| LEARN | `/handoff` | this doc |

Cross-cutting: ponytail (on) · claude-mem · codex (Innertube spike, see below).

---

## DONE this session
- **Apify transcript fallback** (`supreme_coder~youtube-transcript-scraper`, BYO token, 45s timeout) — gated videos now work. Tier order: Innertube → timedtext → **Apify** → passive panel.
- **Transcript cache** by videoId in `chrome.storage` — revisits instant, skip Apify.
- **Pre-generate** Summary + Timestamped on load — instant tab switching.
- **Keyboard fix** — panel keystrokes no longer drive YouTube's player (space/k/j/arrows).
- **Inline dropdowns** for focus/format/count on Summary (no jump to config).
- **Configurable Gemini prompt** (settings → GEMINI PROMPT); full transcript already sent.
- Removed Ask "BETA" badge. Scoped `update()` so token/prompt edits don't trigger regen.

## OPEN — transcript fetch speed (the priority)
Two separate costs:
1. **Repeat visits** → FIXED by cache (instant).
2. **First visit of a gated video** → ~11s, almost all **Apify cold-start**.

Levers, ranked:
- **B (the prize): fix the Innertube tier.** It returns **HTTP 400** even with params decoded. If fixed → first fetch ~0.5s **and free**, Apify becomes rarely-hit. **→ Codex spike was dispatched this session** (background agent). **Check its output and apply its recommended `fetchViaInnertube`.** Likely cause per the brief: WEB `context` missing `visitorData`/`hl`/`gl`, or must use `/next`-returned params + SAPISIDHASH auth headers.
- **C (fallback if B dies):** swap Apify for a warm API (Supadata / youtube-transcript.io) → ~2s, no cold start.
- **D:** race Apify in parallel with in-page tiers — only shaves 1–3s, spends credits every video. Skip unless needed.

## REMAINING DEBT
- 🔴 **`[recap]` console breadcrumbs still inside `fetchViaInnertube`** (`core.ts` ~155–205) — left intentionally because Codex's spike will replace the whole function. If you DON'T take Codex's version, strip them.
- 🟡 **No parser tests** — `decodeJsonStr`, `findInitialSegments`, `parseJsonLoose`, Apify mapping. Add one ~20-line `test_parsers` (ponytail: money/parser paths leave one check behind).
- 🟡 **Pre-gen fires 2 LLM calls per video automatically** — fine for BYO key, but consider gating Timestamped behind first-open if cost matters.

## ROADMAP (where to take it)
- Reliability: land Innertube fix (B) · cache (done) · Apify timeout (done).
- Features: real **Top comments** (currently demo data — innertube `next` continuation) OR drop the tab · transcript language picker · keyboard shortcut to open panel.
- Polish: loading skeletons · better error states.

## DECISIONS PENDING (yours)
- **Top comments:** wire real / drop tab / leave demo.
- **Innertube:** if Codex can't crack the 400 → adopt warm-API (C)?

---

## Run / load
```
cd /Users/robinsverd/Thrivbe-AI/lab/video-recap-sidebar
npm run build
# chrome://extensions → Remove → Load unpacked → dist/   (full re-add: Apify host_permission)
# ⚙ → paste OpenAI/Anthropic/OpenRouter key + Apify token (in .env as APIFY_TOKEN)
```

## Key files
- `src/core.ts` — transcript tiers (+ cache, + Apify) + LLM types/prompts/providers.
- `src/content.tsx` — panel injection, throttled transcript-panel observer, SPA nav.
- `src/Panel.tsx` — UI; pre-gen, inline dropdowns, keyboard-isolation, Gemini prompt.
- `vite.config.ts` — MV3 manifest (host_permissions incl. api.apify.com).
