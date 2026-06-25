// Service worker: the only place the API key is used. The content-script panel
// sends a transcript + kind; we load settings, call the provider, return data.
import {
  DEFAULT_SETTINGS,
  buildPrompt,
  callLLM,
  parseJsonLoose,
  type LlmKind,
  type Settings,
  type SummaryResult,
  type TimestampedResult,
} from "./core";

type LlmRequest = { type: "llm"; kind: LlmKind; transcript: string; question?: string };
type LlmResponse = { ok: true; data: unknown } | { ok: false; error: string };

async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(got.settings as Partial<Settings> | undefined) };
}

async function handle(req: LlmRequest): Promise<LlmResponse> {
  try {
    const s = await loadSettings();
    const { system, user } = buildPrompt(req.kind, req.transcript, s, req.question);
    const raw = await callLLM(s, system, user, req.kind !== "ask");
    if (req.kind === "ask") return { ok: true, data: raw };
    if (req.kind === "summary") return { ok: true, data: parseJsonLoose<SummaryResult>(raw) };
    return { ok: true, data: parseJsonLoose<TimestampedResult>(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((req: LlmRequest, _sender, sendResponse) => {
  if (req?.type !== "llm") return;
  handle(req).then(sendResponse);
  return true; // keep the message channel open for the async reply
});
