// Service worker: the only place the API key is used. The content-script panel
// sends a transcript + kind; we load settings, call the provider, return data.
import {
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_API_KEY,
  LIBRARIAN_WEBHOOK_URL,
  buildPrompt,
  callLLM,
  mergeSettings,
  parseJsonLoose,
  type LlmKind,
  type Settings,
  type SummaryResult,
  type TimestampedResult,
} from "./core";

type LlmRequest = { type: "llm"; kind: LlmKind; transcript: string; question?: string };
type LibrarianRequest = { type: "librarian"; title: string; url: string; text: string; selection?: string };
type WakeRequest = { type: "wake" };
type VoiceSignedUrlRequest = { type: "voice-signed-url" };
type LlmResponse = { ok: true; data: unknown } | { ok: false; error: string };
type VoiceSignedUrlResponse = { ok: true; data: { signedUrl: string } } | { ok: false; error: string };

async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get("settings");
  return mergeSettings(got.settings as Partial<Settings> | undefined);
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
    return { ok: false, error: "Hermes gateway unreachable — is Tailscale up and hetzner:8644 listening?" };
  }
}

// Fetches a signed WebSocket URL for the private voice agent. Done here (not
// the content script, which runs in the youtube.com page context) so the
// ElevenLabs API key never reaches the page.
async function getVoiceSignedUrl(): Promise<VoiceSignedUrlResponse> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    return { ok: false, error: "Voice agent not configured (missing VITE_ELEVENLABS_API_KEY/AGENT_ID)." };
  }
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } },
    );
    const data = (await res.json().catch(() => ({}))) as { signed_url?: string };
    if (!res.ok || !data.signed_url) return { ok: false, error: `ElevenLabs ${res.status}: could not get a signed URL.` };
    return { ok: true, data: { signedUrl: data.signed_url } };
  } catch {
    return { ok: false, error: "Could not reach ElevenLabs." };
  }
}

chrome.runtime.onMessage.addListener(
  (req: LlmRequest | LibrarianRequest | WakeRequest | VoiceSignedUrlRequest, _sender, sendResponse) => {
    if (req?.type === "wake") { sendResponse({ ok: true }); return false; }
    if (req?.type === "llm") { handle(req as LlmRequest).then(sendResponse); return true; }
    if (req?.type === "librarian") { sendToLibrarian(req as LibrarianRequest).then(sendResponse); return true; }
    if (req?.type === "voice-signed-url") { getVoiceSignedUrl().then(sendResponse); return true; }
    return undefined;
  },
);

function notifyYouTubeTab(tabId: number, url: string | undefined, reason: string) {
  if (!url) return;
  const parsed = new URL(url);
  if (parsed.hostname !== "www.youtube.com" || parsed.pathname !== "/watch") return;
  chrome.tabs.sendMessage(tabId, { type: "youtube-video", reason, url }, () => {
    // The content script may not be injected yet on cold page loads. Ignore that
    // transient miss; the content script also has its own URL watchdog.
    void chrome.runtime.lastError;
  });
}

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) notifyYouTubeTab(details.tabId, details.url, "history");
}, { url: [{ hostEquals: "www.youtube.com", pathEquals: "/watch" }] });

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) notifyYouTubeTab(details.tabId, details.url, "completed");
}, { url: [{ hostEquals: "www.youtube.com", pathEquals: "/watch" }] });
