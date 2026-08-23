# HANDOVER — OmniRoute cutover for the FreeLLMAPI provider (2026-07-30)

## Symptom
Recap generation via the "FreeLLMAPI" provider failed with a provider cascade:
`⚠ FreeLLMAPI error 403: [github-models/openai/o3] … o4-mini (413), ollama-cloud/glm-5.1 (403), opencode/mimo-v2.5-free (429) …`

## Root cause
The provider already pointed at OmniRoute (Thrivbe-1, `http://100.114.219.63:20128/v1`),
but with the pre-graduation config:

1. **`model: "auto"`** — plain `auto` walks OmniRoute's free/cheap tier, which the
   grown fleet (~280M tok/30d) drains daily. By afternoon every free provider's
   circuit breaker is open and the walk dies, surfacing whatever error the last
   provider returned (the 403/413/429 cascade). Documented failure mode — see
   memory `omniroute_free_providers` (2026-07-29 entry).
2. **Stale key** — `freellmapi-…` key from the retired freellmapi service. Auth on
   `/v1` is off so it didn't break calls, but it broke per-consumer attribution.
3. **New zombie model** (found during testing) — `nvidia/minimaxai/minimax-m2.7`
   went EOL 2026-07-27 and returns 410; the 410 body wasn't in OmniRoute's
   `customBannedSignals`, so the router surfaced it instead of failing over.

## Fix
- `src/core.ts` — default model `"auto"` → `"auto/best-chat"`; new `mergeSettings()`
  migrates stale stored settings (`auto` → `auto/best-chat`, `freellmapi-…` key →
  baked default); `callLLM` falls back once to `"auto/best-fast"` when the
  best-chat walk dies (mirrors the grown fleet's primary→fallback pairing).
- `src/background.ts` + `src/Panel.tsx` — settings loads now go through
  `mergeSettings`; Panel persists the migrated value back to storage; UI default
  model / placeholder / key hint updated.
- `.env` — `VITE_FREELLMAPI_KEY` replaced with a real per-consumer OmniRoute key
  (`sk-39c7…`, name `video-recap-sidebar`, minted via `POST /api/keys`).
- **Server-side (global, Thrivbe-1)** — added `"end of life"` and
  `"no longer available"` to `customBannedSignals` so EOL'd models (the minimax
  410) count as failures and the router fails over.

## Verification
- Extension-shaped request (big payload, `response_format: json_object`,
  `stream: false`) through the **shipped dist build**: settings migration
  confirmed; `auto/best-fast` completed a real recap (44.8s via glm-4.7-flash)
  at a time when `auto/best-chat` and `grown-chat` were both exhausted.
- The client-side fallback chain was observed executing (best-chat → best-fast).
- Caveat: at peak drain even best-fast can 503 ("Maximum combo retry limit
  reached"). That's pool exhaustion by the grown fleet, not this extension —
  per the memory, the real fix if it keeps hurting is throttling grown or a
  paid-provider lane.

## Open items for Robin
1. **Reload the unpacked extension** (chrome://extensions → ↻) — the rebuild
   renamed the hashed asset files, so the loaded copy is stale until reloaded.
2. **Rename decision**: the provider is still labeled "FreeLLMAPI" in the UI and
   `"freellmapi"` in the `Provider` type/settings. The underlying service is
   retired; renaming to "OmniRoute" is user-facing — say the word and it's a
   small mechanical change (type value + labels + stored-settings migration).
3. Optional: a paid final fallback (extension already has OpenRouter/OpenAI/
   Anthropic keys baked) if free-pool exhaustion keeps biting at peak hours.
