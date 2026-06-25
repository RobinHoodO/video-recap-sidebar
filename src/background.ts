// Service worker: the only place the API key is used. The content-script panel
// sends a transcript + kind; we load settings, call the provider, return data.
import {
  DEFAULT_SETTINGS,
  LIBRARIAN_WEBHOOK_URL,
  buildPrompt,
  callLLM,
  parseJsonLoose,
  type LlmKind,
  type Settings,
  type SummaryResult,
  type TimestampedResult,
} from "./core";

type LlmRequest = { type: "llm"; kind: LlmKind; transcript: string; question?: string };
type LibrarianRequest = { type: "librarian"; title: string; url: string; text: string; selection?: string };
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

// Send the transcript to the Hermes "Librarian" webhook to file it into the
// LLM wiki. Done here (not the content script) so the localhost request isn't
// blocked by the page's private-network restrictions.
async function sendToLibrarian(req: LibrarianRequest): Promise<{ ok: boolean; error?: string }> {
  const s = await loadSettings();
  // Trim: Hermes does a plain constant-time compare of X-Gitlab-Token against
  // the stored secret, so a single pasted whitespace char → 401 Invalid signature.
  const secret = (s.librarianSecret || "").trim();
  if (!secret) return { ok: false, error: "No Librarian secret set in settings (⚙)." };
  try {
    const res = await fetch(LIBRARIAN_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": secret },
      body: JSON.stringify({ title: req.title, url: req.url, selection: req.selection || "", text: req.text }),
    });
    if (!res.ok) return { ok: false, error: `Hermes ${res.status}: ${(await res.text()).slice(0, 150)}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Hermes gateway unreachable — is it running on 127.0.0.1:8644?" };
  }
}

chrome.runtime.onMessage.addListener((req: LlmRequest | LibrarianRequest, _sender, sendResponse) => {
  if (req?.type === "llm") { handle(req as LlmRequest).then(sendResponse); return true; }
  if (req?.type === "librarian") { sendToLibrarian(req as LibrarianRequest).then(sendResponse); return true; }
  return undefined;
});
