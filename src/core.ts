// Shared core: transcript extraction (content-script side) + LLM types,
// prompt building, parsing, and provider calls (service-worker side).

// ── Settings ─────────────────────────────────────────────────────────────────
export type Provider = "openai" | "anthropic" | "openrouter" | "freellmapi";

export type Settings = {
  focus: string;
  format: string;
  count: string;
  emojis: boolean;
  highlights: boolean;
  grouped: boolean;
  provider: Provider;
  model: string;
  apiKey: string;
  language: string;
  apifyToken: string;
  geminiPrompt: string;
  librarianSecret: string;
};

// Instruction placed above the transcript when sending to Gemini Canvas.
export const DEFAULT_GEMINI_PROMPT =
  "Analyze the entire transcript and extract the complete framework taught in this talk. Start with a concise overview, then produce a deeply structured nested outline of all major concepts, steps, distinctions, workflows, examples, and practical actions. Use markdown headings.";

// Build-time defaults, baked in by Vite from the gitignored .env so keys/secrets
// survive a full "Remove + Load unpacked" (which wipes chrome.storage). Stored
// settings still override these, so editing a value in ⚙ persists as normal.
// ponytail: `?? {}` guards plain-node imports (e.g. this file's own test),
// where import.meta.env isn't injected the way Vite injects it at build time.
const ENV = (import.meta.env ?? {}) as Record<string, string | undefined>;
export const DEFAULT_PROVIDER_KEYS: Record<Provider, string> = {
  openai: ENV.VITE_OPENAI_KEY ?? "",
  anthropic: ENV.VITE_ANTHROPIC_KEY ?? "",
  openrouter: ENV.VITE_OPENROUTER_KEY ?? "",
  freellmapi: ENV.VITE_FREELLMAPI_KEY ?? "",
};

// Not a text-LLM provider in the Provider union above — kept separate.
export const ELEVENLABS_API_KEY = ENV.VITE_ELEVENLABS_API_KEY ?? "";
export const ELEVENLABS_AGENT_ID = ENV.VITE_ELEVENLABS_AGENT_ID ?? "";

// The retired consumer may be absent after migration. Keep a configured
// consumer, otherwise use the OpenRouter provider/model already offered in UI.
const USE_OPENROUTER_DEFAULT = !DEFAULT_PROVIDER_KEYS.freellmapi && !!DEFAULT_PROVIDER_KEYS.openrouter;
export const DEFAULT_SETTINGS: Settings = {
  focus: "Insightful",
  format: "List",
  count: "Auto",
  emojis: true,
  highlights: true,
  grouped: true,
  provider: USE_OPENROUTER_DEFAULT ? "openrouter" : "freellmapi",
  // "auto/best-chat", NOT plain "auto": plain auto walks OmniRoute's free tier,
  // which the grown fleet exhausts daily → 403/413/429 provider cascade.
  model: USE_OPENROUTER_DEFAULT ? "openai/gpt-4o-mini" : "auto/best-chat",
  apiKey: USE_OPENROUTER_DEFAULT ? DEFAULT_PROVIDER_KEYS.openrouter : DEFAULT_PROVIDER_KEYS.freellmapi,
  language: "English",
  apifyToken: ENV.VITE_APIFY_TOKEN ?? "",
  geminiPrompt: DEFAULT_GEMINI_PROMPT,
  // Hermes "Librarian" webhook secret — from the gitignored .env, never source.
  librarianSecret: ENV.VITE_LIBRARIAN_SECRET ?? "",
};

// Merge stored settings over defaults, migrating values that predate the
// OmniRoute graduation (2026-07-30): plain "auto" walks the free tier that the
// grown fleet exhausts daily (403/413/429 cascade), and "freellmapi-…" keys
// belong to the retired freellmapi service.
export function mergeSettings(stored?: Partial<Settings>): Settings {
  const s = {
    ...DEFAULT_SETTINGS,
    ...stored,
    apiKey: stored?.apiKey ?? DEFAULT_PROVIDER_KEYS[stored?.provider ?? DEFAULT_SETTINGS.provider],
  };
  if (s.provider !== "freellmapi") return s;
  const key = s.apiKey.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  const unusableKey = !key || key.startsWith("op://") || key.startsWith("freellmapi-");
  if (USE_OPENROUTER_DEFAULT && unusableKey) {
    return { ...s, provider: "openrouter", model: "openai/gpt-4o-mini", apiKey: DEFAULT_PROVIDER_KEYS.openrouter };
  }
  return {
    ...s,
    model: s.model === "auto" ? "auto/best-chat" : s.model,
    apiKey: s.apiKey.startsWith("freellmapi-") ? DEFAULT_PROVIDER_KEYS.freellmapi : s.apiKey,
  };
}

// Hermes gateway "Send to Librarian" webhook — ingests the page into the wiki.
export const LIBRARIAN_WEBHOOK_URL = "https://hetzner.tail9908c7.ts.net:8644/webhooks/librarian-ingest";

// MV3 service workers terminate after ~30s idle. The first message to a
// sleeping worker can reject with "Could not establish connection / Receiving
// end does not exist" before Chrome finishes waking it. Retry on that wake-race
// instead of keeping the worker alive (which MV3 actively discourages).
// ponytail: 2 retries, linear backoff. Raise if you still see dropped wakes.
export async function sendToWorker<T>(msg: unknown, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage(msg)) as T;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      const wakeRace = /Receiving end does not exist|message channel closed|Could not establish connection/i.test(m);
      if (!wakeRace || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

// ── Comments (runs in the content script / page DOM) ─────────────────────────
export type CommentItem = { handle: string; likes: string; text: string };

// Read the top comment threads YouTube has already rendered into the page.
// Zero-key, same approach as reading the transcript panel. Comments lazy-load
// on scroll, so this returns [] until the user reaches the comments section —
// the panel surfaces a "scroll down" hint in that case.
// ponytail: DOM selectors. If this returns [] when comments are clearly loaded,
// suspect a YouTube markup rename (same saga as the transcript reader).
export function readPageComments(max = 20): CommentItem[] {
  const out: CommentItem[] = [];
  const threads = document.querySelectorAll("ytd-comment-thread-renderer");
  for (const t of Array.from(threads)) {
    if (out.length >= max) break;
    const handle = (t.querySelector("#author-text")?.textContent || "").trim();
    const text = (t.querySelector("#content-text")?.textContent || "").trim();
    const likes = (t.querySelector("#vote-count-middle")?.textContent || "").trim();
    if (handle && text) out.push({ handle, likes, text: text.replace(/\s+/g, " ") });
  }
  return out;
}

// ── Transcript (runs in the content script / page DOM) ───────────────────────
export type Segment = { tStartMs: number; text: string };

// The isolated content-script world can't read window.ytInitialPlayerResponse,
// but it can read the inline <script> that defines it. Balance braces to slice
// out the JSON object.
function readPlayerResponse(): any | null {
  for (const s of Array.from(document.scripts)) {
    const txt = s.textContent || "";
    const i = txt.indexOf("ytInitialPlayerResponse");
    if (i === -1) continue;
    const start = txt.indexOf("{", i);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < txt.length; j++) {
      const c = txt[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(txt.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  // DOMParser parses inertly (no script execution) and decodes HTML entities.
  const doc = new DOMParser().parseFromString(s, "text/html");
  return doc.documentElement.textContent || "";
}

function parseJson3(text: string): Segment[] {
  let data: any;
  try { data = JSON.parse(text); } catch { return []; }
  return (data.events || [])
    .filter((e: any) => e.segs)
    .map((e: any) => ({
      tStartMs: e.tStartMs ?? 0,
      text: (e.segs.map((s: any) => s.utf8).join("") || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((s: Segment) => s.text);
}

function parseXmlCaptions(xml: string): Segment[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return Array.from(doc.getElementsByTagName("text"))
    .map((n) => ({
      tStartMs: Math.round(parseFloat(n.getAttribute("start") || "0") * 1000),
      text: decodeEntities(n.textContent || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

// timedtext can return an empty 200 for json3, so read as text and fall back to
// the default XML format before giving up on a track.
async function fetchTrack(baseUrl: string): Promise<Segment[]> {
  const json = new URL(baseUrl);
  json.searchParams.set("fmt", "json3");
  const r1 = await fetch(json.toString());
  if (r1.ok) {
    const t = (await r1.text()).trim();
    if (t) {
      const segs = parseJson3(t);
      if (segs.length) return segs;
    }
  }
  const xml = new URL(baseUrl);
  xml.searchParams.delete("fmt");
  const r2 = await fetch(xml.toString());
  if (r2.ok) {
    const t = (await r2.text()).trim();
    if (t) return parseXmlCaptions(t);
  }
  return [];
}

// Recursively find the first "initialSegments" array in the get_transcript
// response and map it to segments.
function findInitialSegments(obj: any): Segment[] {
  let found: any[] | null = null;
  const walk = (o: any) => {
    if (!o || found || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (Array.isArray(o.initialSegments)) { found = o.initialSegments; return; }
    for (const k in o) walk(o[k]);
  };
  walk(obj);
  if (!found) return [];
  return (found as any[])
    .map((s) => s.transcriptSegmentRenderer)
    .filter(Boolean)
    .map((r: any) => ({
      tStartMs: Number(r.startMs ?? 0),
      text: (r.snippet?.runs?.map((x: any) => x.text).join("") || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((s: Segment) => s.text);
}

// Tier 1 (best, free): YouTube's own Innertube get_transcript endpoint. Called
// same-origin from the page session, so it carries cookies and needs no
// PoToken — unlike the timedtext CDN, which now returns empty bodies. The flow
// (verified against YouTube.js + yt-dlp): recover the real INNERTUBE_CONTEXT
// from ytcfg, POST /next to get the transcript panel's params, then POST
// /get_transcript with the full context + visitor headers.
async function fetchViaInnertube(): Promise<Segment[]> {
  const ytOrigin = "https://www.youtube.com";
  const videoId = new URLSearchParams(location.search).get("v");
  if (!videoId) return [];

  const parseJsonObjectAt = (text: string, start: number): any | null => {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  };

  const pageText = Array.from(document.scripts).map((s) => s.textContent || "").join("\n");
  const ytcfg: any = {};
  for (let from = 0; ;) {
    const i = pageText.indexOf("ytcfg.set", from);
    if (i === -1) break;
    const start = pageText.indexOf("{", i);
    if (start === -1) break;
    Object.assign(ytcfg, parseJsonObjectAt(pageText, start) || {});
    from = start + 1;
  }

  const apiKey =
    ytcfg.INNERTUBE_API_KEY ||
    pageText.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];

  const context = JSON.parse(JSON.stringify(ytcfg.INNERTUBE_CONTEXT || { client: {} }));
  context.client ||= {};
  context.user ||= { enableSafetyMode: false, lockedSafetyMode: false };
  context.request ||= { useSsl: true, internalExperimentFlags: [] };

  const clientVersion =
    context.client.clientVersion ||
    ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION ||
    pageText.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];

  if (!clientVersion) return [];

  context.client.clientName ||= "WEB";
  context.client.clientVersion = clientVersion;
  context.client.hl ||= ytcfg.HL || "en";
  context.client.gl ||= ytcfg.GL || "US";
  context.client.visitorData ||=
    ytcfg.VISITOR_DATA ||
    pageText.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1];
  context.client.originalUrl ||= location.href;
  context.client.timeZone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
  context.client.utcOffsetMinutes ??= -new Date().getTimezoneOffset();
  context.client.userAgent ||= navigator.userAgent;
  context.client.clientFormFactor ||= "UNKNOWN_FORM_FACTOR";

  const endpointUrl = (endpoint: "next" | "get_transcript") => {
    const url = new URL(`/youtubei/v1/${endpoint}`, ytOrigin);
    if (apiKey) url.searchParams.set("key", apiKey);
    url.searchParams.set("prettyPrint", "false");
    return url.toString();
  };

  const sha1Hex = async (value: string) => {
    const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  };

  const readCookie = (name: string) => {
    for (const part of document.cookie.split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
    }
    return "";
  };

  const headers: Record<string, string> = {
    "accept": "*/*",
    "content-type": "application/json",
    "x-youtube-client-name": String(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME || 1),
    "x-youtube-client-version": clientVersion,
    "x-origin": ytOrigin,
  };
  if (context.client.visitorData) headers["x-goog-visitor-id"] = context.client.visitorData;
  if (ytcfg.SESSION_INDEX !== undefined) headers["x-goog-authuser"] = String(ytcfg.SESSION_INDEX);
  if (ytcfg.LOGGED_IN === true) headers["x-youtube-bootstrap-logged-in"] = "true";

  const authParts: string[] = [];
  const addSidAuth = async (scheme: string, sid: string) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    authParts.push(`${scheme} ${ts}_${await sha1Hex(`${ts} ${sid} ${ytOrigin}`)}`);
  };
  const sapisid = readCookie("SAPISID") || readCookie("__Secure-3PAPISID");
  const sid1p = readCookie("__Secure-1PAPISID");
  const sid3p = readCookie("__Secure-3PAPISID");
  if (sapisid) await addSidAuth("SAPISIDHASH", sapisid);
  if (sid1p) await addSidAuth("SAPISID1PHASH", sid1p);
  if (sid3p) await addSidAuth("SAPISID3PHASH", sid3p);
  if (authParts.length) headers["authorization"] = authParts.join(" ");

  const readJson = async (res: Response) =>
    JSON.parse((await res.text()).replace(/^\)\]\}'\n?/, ""));

  const findTranscriptParams = (obj: any): string | null => {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.getTranscriptEndpoint?.params === "string") {
      return obj.getTranscriptEndpoint.params;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findTranscriptParams(item);
        if (found) return found;
      }
      return null;
    }
    for (const key of Object.keys(obj)) {
      const found = findTranscriptParams(obj[key]);
      if (found) return found;
    }
    return null;
  };

  let nextRes: Response;
  try {
    nextRes = await fetch(endpointUrl("next"), {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, videoId, racyCheckOk: true, contentCheckOk: true }),
    });
  } catch { return []; }
  if (!nextRes.ok) return [];

  const nextJson = await readJson(nextRes);
  let params: string | null = null;
  for (const panel of nextJson.engagementPanels || []) {
    const renderer = panel.engagementPanelSectionListRenderer;
    if (renderer?.panelIdentifier === "engagement-panel-searchable-transcript") {
      params = findTranscriptParams(renderer.content) || findTranscriptParams(renderer);
      break;
    }
  }
  params ||= findTranscriptParams(nextJson);
  if (!params) return [];

  let transcriptRes: Response;
  try {
    transcriptRes = await fetch(endpointUrl("get_transcript"), {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, params }),
    });
  } catch { return []; }
  if (!transcriptRes.ok) return [];

  const transcriptJson = await readJson(transcriptRes);
  return findInitialSegments(transcriptJson)
    .map((s) => ({ tStartMs: s.tStartMs, text: decodeEntities(s.text).replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text);
}

// Tier 3.5 (paid, BYO token): the Apify scraper works on PoToken-gated videos
// that the in-page paths can't reach. Token read from settings; the call is
// CORS-allowed because the manifest grants host access to api.apify.com.
const APIFY_ACTOR = "supreme_coder~youtube-transcript-scraper";

async function fetchViaApify(): Promise<Segment[]> {
  const v = new URLSearchParams(location.search).get("v");
  if (!v) return [];
  const got = await chrome.storage.local.get("settings");
  const token = (got.settings as Settings | undefined)?.apifyToken || "";
  if (!token) return [];
  let res: Response;
  try {
    res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: [{ url: `https://www.youtube.com/watch?v=${v}` }], outputFormat: "json" }),
        signal: AbortSignal.timeout(45_000), // run-sync can hang on cold start; cap it
      }
    );
  } catch {
    return []; // timeout or network error → fall through to next tier
  }
  if (!res.ok) return [];
  const items = await res.json();
  const tr = Array.isArray(items) ? items[0]?.transcript : null;
  if (!Array.isArray(tr)) return [];
  return tr
    .map((s: any) => ({
      tStartMs: Math.round(Number(s.start ?? 0) * 1000),
      text: decodeEntities(String(s.text ?? "")).replace(/\s+/g, " ").trim(),
    }))
    .filter((s: Segment) => s.text);
}

// Read whatever transcript segments YouTube has rendered in its own panel.
// YouTube migrated the markup to <transcript-segment-view-model> (2026); we
// support that first and fall back to the legacy <ytd-transcript-segment-renderer>.
export function fetchFromOpenTranscriptPanel(): Segment[] {
  const vm = Array.from(document.querySelectorAll("transcript-segment-view-model"));
  if (vm.length) {
    return vm
      .map((el) => ({
        tStartMs: parseTime(el.querySelector(".ytwTranscriptSegmentViewModelTimestamp")?.textContent?.trim() || "0") * 1000,
        text: (el.querySelector(".ytAttributedStringHost")?.textContent || "").replace(/\s+/g, " ").trim(),
      }))
      .filter((s) => s.text);
  }
  return Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))
    .map((el) => ({
      tStartMs: parseTime(el.querySelector(".segment-timestamp")?.textContent?.trim() || "0") * 1000,
      text: (el.querySelector(".segment-text")?.textContent || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

const TRANSCRIPT_PANEL_SEL =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';

// Free path that survives PoToken gating: drive YouTube's OWN "Show transcript"
// panel. Its UI already holds the PoToken, so the rendered segments are the
// real transcript even when every API tier is blocked (get_transcript is 100%
// 400 since Dec 2025 — YouTube.js #1102). We open the panel, read it, and close
// it again (if we opened it) to leave the page as we found it.
async function fetchViaTranscriptPanel(): Promise<Segment[]> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Already open? Just read it.
  let segs = fetchFromOpenTranscriptPanel();
  if (segs.length) return segs;

  const findBtn = (): HTMLElement | null => {
    const direct = document.querySelector(
      'button[aria-label="Show transcript" i], ytd-video-description-transcript-section-renderer button'
    ) as HTMLElement | null;
    if (direct) return direct;
    // Fallback: any clickable whose label or text mentions "transcript".
    return (
      Array.from(document.querySelectorAll<HTMLElement>("button, a, yt-button-shape")).find(
        (el) =>
          /transcript/i.test(el.getAttribute("aria-label") || "") ||
          /show transcript/i.test(el.textContent || "")
      ) || null
    );
  };

  // The transcript button is hidden until the description is expanded — do that
  // first (selectors vary across YouTube layouts, so try several).
  (document.querySelector(
    "ytd-text-inline-expander #expand, #description-inline-expander #expand, tp-yt-paper-button#expand"
  ) as HTMLElement | null)?.click();

  let btn = findBtn();
  for (let i = 0; i < 16 && !btn; i++) { await wait(150); btn = findBtn(); }
  if (!btn) return [];

  const wasOpen = !!document.querySelector(`${TRANSCRIPT_PANEL_SEL}[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]`);
  btn.click();

  for (let i = 0; i < 40 && !segs.length; i++) { await wait(150); segs = fetchFromOpenTranscriptPanel(); }

  // Close the panel again only if we were the ones who opened it.
  if (segs.length && !wasOpen) {
    (document.querySelector(`${TRANSCRIPT_PANEL_SEL} #visibility-button button, ${TRANSCRIPT_PANEL_SEL} button[aria-label="Close" i]`) as HTMLElement | null)?.click();
  }
  return segs;
}

// Cache successful transcripts by video id so revisits are instant and skip the
// ~11s Apify round-trip entirely. ponytail: no eviction yet — transcripts are
// ~tens of KB; add an LRU cap if storage ever bloats.
const TRANSCRIPT_CACHE_PREFIX = "transcript:";

export async function fetchTranscript(): Promise<Segment[]> {
  const videoId = new URLSearchParams(location.search).get("v") || "";
  const key = TRANSCRIPT_CACHE_PREFIX + videoId;
  if (videoId) {
    const got = await chrome.storage.local.get(key);
    const hit = got[key] as Segment[] | undefined;
    if (hit?.length) return hit;
  }
  const segs = await fetchTranscriptUncached(videoId);
  // Don't cache if the user navigated to another video mid-fetch — that would
  // poison the new video's cache key with the previous transcript.
  const onSameVideo = (new URLSearchParams(location.search).get("v") || "") === videoId;
  if (videoId && segs.length && onSameVideo) chrome.storage.local.set({ [key]: segs });
  return segs;
}

async function fetchTranscriptUncached(expectedVid: string): Promise<Segment[]> {
  // Tier 1 (free, instant): caption-track timedtext — works on non-gated videos.
  const pr = readPlayerResponse();
  // YouTube's SPA leaves the PREVIOUS video's ytInitialPlayerResponse in the
  // page <script> tags after navigation, so only trust these caption tracks if
  // they belong to the video we're actually on — otherwise we'd fetch (and
  // generate the recap from) the wrong video's transcript.
  const stale = !!pr?.videoDetails?.videoId && pr.videoDetails.videoId !== expectedVid;
  const tracks: any[] = stale ? [] : (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  const ordered = [...tracks].sort((a, b) =>
    Number(b.languageCode?.startsWith("en")) - Number(a.languageCode?.startsWith("en"))
  );
  for (const track of ordered) {
    if (!track.baseUrl) continue;
    const segs = await fetchTrack(track.baseUrl);
    if (segs.length) return segs;
  }

  // Tier 2 (free, gated-safe): drive YouTube's own transcript panel.
  const panel = await fetchViaTranscriptPanel();
  if (panel.length) return panel;

  // Tier 3 (paid, BYO token): Apify scraper.
  const viaApify = await fetchViaApify();
  if (viaApify.length) return viaApify;

  // Tier 4 (last-ditch): Innertube get_transcript — 100% blocked since Dec 2025
  // (YouTube.js #1102), but occasionally slips through, so try it last.
  const inner = await fetchViaInnertube();
  if (inner.length) return inner;

  throw new Error(
    tracks.length
      ? "Couldn't load this transcript automatically. Open “Show transcript” under the video and it'll appear here."
      : "This video has no transcript available."
  );
}

export function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function parseTime(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function transcriptToText(segs: Segment[]): string {
  return segs.map((s) => `[${fmtTime(s.tStartMs)}] ${s.text}`).join("\n");
}

// ponytail: ElevenLabs dynamic-variable size ceiling — keeps the voice agent's
// prompt context bounded. Raise if the agent starts truncating relevant detail.
export const VOICE_TRANSCRIPT_CHAR_CAP = 60_000;

// Formats a transcript for the voice agent's dynamic variables, capping length.
// Over the cap, keeps the start and end and marks the gap so the agent knows
// context was cut rather than silently missing it.
export function buildVoiceTranscript(segs: Segment[]): string {
  const full = transcriptToText(segs);
  if (full.length <= VOICE_TRANSCRIPT_CHAR_CAP) return full;
  const half = Math.floor((VOICE_TRANSCRIPT_CHAR_CAP - 20) / 2);
  return `${full.slice(0, half)}\n...[truncated]...\n${full.slice(full.length - half)}`;
}

// ── LLM result types ─────────────────────────────────────────────────────────
export type SummaryBullet = { emoji: string; text: string };
export type SummaryResult = { heading: string; bullets: SummaryBullet[]; markdown?: string };
export type TimestampItem = { t: string; text: string };
export type TimestampedResult = { intro: string; items: TimestampItem[] };

export type LlmKind = "summary" | "timestamped" | "ask";

// ── Prompt building ──────────────────────────────────────────────────────────
const countHint: Record<string, string> = {
  Short: "Cover the core arc in 6 to 8 substantive items",
  Auto: "Identify every major idea across the whole transcript; usually 10 to 18 items, but use as many as the material genuinely needs",
  Detailed: "Create a comprehensive breakdown of all main points and meaningful subpoints; usually 18 to 30 items for long talks, and never stop at six by default",
};

const timestampCountHint: Record<string, string> = {
  Short: "6 to 8 timestamped entries covering the full arc",
  Auto: "one timestamped entry for every major section, transition, concept, example, or argument in the whole transcript; usually 10 to 18 entries",
  Detailed: "a dense timestamp map of the entire video, including all major points and meaningful subpoints; usually 18 to 30 entries for long talks",
};

function summaryPrompt(transcript: string, s: Settings): { system: string; user: string } {
  // "Framework" focus: extract the FULL teachable framework, comprehensively —
  // every concept/step as its own bullet, ordered so they build on each other.
  if (s.focus === "Framework") {
    return {
      system: `You are a principal systems architect and technical writer. You distill YouTube talks into a comprehensive, deeply structured, and teachable framework. Respond in ${s.language}. Return ONLY valid JSON, no markdown fences.`,
      user: `Extract the COMPLETE framework taught in this video as JSON of the shape {"heading": string, "markdown": string, "bullets": []}.
- "heading" names the overall framework.
- "bullets" must be an empty array [].
- "markdown" must contain a comprehensive, exhaustive, and beautifully formatted markdown document of the framework.
- Analyze the full transcript before writing. Do not summarize only the opening or most obvious ideas.
- Do not cap the output at six bullets. Include every main concept, step, distinction, loop, example, tool, warning, and practical implication that is materially taught.
- Prefer depth and completeness over brevity. Long technical talks should produce a long framework.

Structure the "markdown" field with the following sections and formatting:
1. **Introduction / Meta-Overview**: A concise paragraph summarizing the high-level context, strategic value of the framework, and what the reader will learn.
2. **Core Concepts / Philosophy (The Duality & Taxonomy Principle)**: Deeply break down the main paradigms, contrasting philosophies, or conceptual categories (e.g., Tactical vs. Strategic, Model vs. Harness, Procedures vs. Abilities) using bold headers, bullet lists, and clear explanations.
3. **The Visual Workflow (The Flow Principle)**: Construct a clean, highly readable Unicode/ASCII flowchart diagram mapping out the logical queue, steps, pipeline, or loops discussed. Wrap this diagram in a markdown code block (using \`\`\` text ... \`\`\`).
4. **Detailed Framework Map**: List all major pillars, steps, mechanisms, patterns, and examples in order. Use nested bullets where needed.
5. **Tooling & Technical Stack**: If specific tools, environments, safety protocols, or configurations were mentioned, detail them concretely.
6. **Practical Action Steps**: Conclude with a section titled "### Practical Action Steps" listing concrete, step-by-step actions that a developer can take today to get started.

Formatting constraints inside "markdown":
- Use standard markdown headers (###, ####) for sections.
- Use bold lead phrases for key points.
- ${s.highlights ? "Wrap the 3-5 most important terms or key concepts in <hl></hl> tags (e.g., <hl>Harness</hl>)." : "Do not add any highlight tags."}
- Ensure any ASCII flowcharts are perfectly aligned and clean.

TRANSCRIPT:
${transcript}`,
    };
  }
  const hl = s.highlights
    ? "Wrap 3-6 of the most important key terms or phrases per item in <hl></hl> tags."
    : "Do not add any highlight tags.";
  const emoji = s.emojis ? "Give each item a single relevant leading emoji in the \"emoji\" field." : "Leave \"emoji\" as an empty string.";
  const fmt = s.format === "Q&A"
    ? "Phrase each item as a question followed by a short answer."
    : "Phrase each item as a punchy declarative takeaway.";
  return {
    system: `You summarize YouTube talks into a tight recap. Emphasize ${s.focus.toLowerCase()} points. Respond in ${s.language}. Return ONLY valid JSON, no markdown fences.`,
    user: `From this transcript, produce a recap as JSON of the shape {"heading": string, "bullets": [{"emoji": string, "text": string}]}.
- First analyze the entire transcript and identify the complete set of main points.
- ${countHint[s.count] || countHint.Auto}.
- Do not default to six bullets. If the talk contains more major points, include them.
- Each bullet should capture one distinct main point, argument, example, or practical takeaway.
- ${fmt}
- ${emoji}
- ${hl}
- "heading" is a short title for the recap.

TRANSCRIPT:
${transcript}`,
  };
}

function timestampedPrompt(transcript: string, s: Settings): { system: string; user: string } {
  return {
    system: `You create timestamped summaries of YouTube talks. Respond in ${s.language}. Return ONLY valid JSON, no markdown fences.`,
    user: `Using the timestamps already present in the transcript (format [m:ss] or [h:mm:ss]), produce JSON {"intro": string, "items": [{"t": string, "text": string}]}.
- "intro" is a 1-2 sentence overview.
- ${timestampCountHint[s.count] || timestampCountHint.Auto}, each anchored to a real timestamp from the transcript.
- Cover the whole video from beginning to end. Do not stop after six entries when more major points exist.
- "t" must be a timestamp copied from the transcript.
- "text" should explain what starts or changes at that point, not merely label the section.

TRANSCRIPT:
${transcript}`,
  };
}

function askPrompt(transcript: string, question: string): { system: string; user: string } {
  return {
    system: "You answer questions about a specific YouTube talk using ONLY its transcript. Be concise and conversational (2-4 sentences). If the transcript doesn't cover it, say so.",
    user: `TRANSCRIPT:\n${transcript}\n\nQUESTION: ${question}`,
  };
}

export function buildPrompt(kind: LlmKind, transcript: string, s: Settings, question = ""): { system: string; user: string } {
  if (kind === "summary") return summaryPrompt(transcript, s);
  if (kind === "timestamped") return timestampedPrompt(transcript, s);
  return askPrompt(transcript, question);
}

// ── Parsing ──────────────────────────────────────────────────────────────────
export function parseJsonLoose<T>(raw: string): T {
  let cleaned = raw.trim();
  
  // Try to extract content inside markdown code fences first
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    // Otherwise, try to find the first '{' and last '}' and extract the JSON block
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1).trim();
    } else {
      // No braces anywhere (e.g. a truncated/degenerate completion that's just
      // a stray ``` fence marker) — surface the actual model output instead of
      // letting JSON.parse throw an opaque "Unexpected token" error.
      throw new Error(`Model returned no JSON (got: "${cleaned.slice(0, 120)}${cleaned.length > 120 ? "…" : ""}")`);
    }
  }

  return JSON.parse(cleaned) as T;
}

// ── Provider calls (service worker) ──────────────────────────────────────────
export async function callLLM(
  s: Settings,
  system: string,
  user: string,
  wantJson: boolean
): Promise<string> {
  if (!s.apiKey) throw new Error("No API key set. Add one in settings (⚙).");

  if (s.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: s.model,
        max_tokens: wantJson ? 5000 : 1200,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.content?.map((b: any) => b.text).join("") ?? "";
  }

  // OpenAI-compatible: OpenAI, OpenRouter, and OmniRoute (Hetzner, tailnet)
  // share the same request shape. OmniRoute routes to free providers with
  // model="auto"; reached directly over Tailscale, no local tunnel needed.
  const isOR = s.provider === "openrouter";
  const isFree = s.provider === "freellmapi";
  const url = isFree
    ? "http://100.114.219.63:20128/v1/chat/completions"
    : isOR
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${s.apiKey}`,
  };
  if (isOR) {
    headers["HTTP-Referer"] = "https://github.com/video-recap-sidebar";
    headers["X-Title"] = "Video Recap Sidebar";
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: s.model,
      temperature: 0.4,
      max_tokens: isFree && wantJson ? 10000 : wantJson ? 5000 : 1200,
      stream: false,
      ...(wantJson ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const label = isFree ? "FreeLLMAPI" : isOR ? "OpenRouter" : "OpenAI";
  if (!res.ok) {
    // OmniRoute's free pool gets drained daily by the grown fleet; when the
    // best-chat walk dies (429/5xx cascade), retry once on the lighter combo —
    // same primary→fallback pairing the rest of the fleet uses.
    if (isFree && s.model === "auto/best-chat") {
      return callLLM({ ...s, model: "auto/best-fast" }, system, user, wantJson);
    }
    throw new Error(`${label} error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
