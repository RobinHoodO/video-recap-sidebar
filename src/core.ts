// Shared core: transcript extraction (content-script side) + LLM types,
// prompt building, parsing, and provider calls (service-worker side).

// ── Settings ─────────────────────────────────────────────────────────────────
export type Provider = "openai" | "anthropic" | "openrouter";

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
};

// Instruction placed above the transcript when sending to Gemini Canvas.
export const DEFAULT_GEMINI_PROMPT =
  "Outline the framework taught in this talk as a nested outline, then a 4-6 sentence summary. Use markdown headings.";

export const DEFAULT_SETTINGS: Settings = {
  focus: "Insightful",
  format: "List",
  count: "Auto",
  emojis: true,
  highlights: true,
  grouped: true,
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "",
  language: "English",
  apifyToken: "",
  geminiPrompt: DEFAULT_GEMINI_PROMPT,
};

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
// PoToken — unlike the timedtext CDN, which now returns empty bodies.
const TRANSCRIPT_PARAMS_RE = /"getTranscriptEndpoint":\s*\{\s*"params":\s*"([^"]+)"/;

// The params live inside a JS/JSON string literal in the page, so they arrive
// with escapes intact (=, &, …). YouTube decodes these at runtime;
// we must too, or get_transcript rejects the raw token with 400.
function decodeJsonStr(s: string): string {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
}

async function fetchViaInnertube(): Promise<Segment[]> {
  const html = document.documentElement.innerHTML;
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion =
    html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
    html.match(/"clientVersion":"([0-9.]+)"/)?.[1];
  const videoId = new URLSearchParams(location.search).get("v");
  // ponytail: temp breadcrumbs to diagnose gated-video transcript fetch; strip once fixed
  console.log("[recap] innertube keys", { apiKey: !!apiKey, clientVersion, videoId });
  if (!apiKey || !clientVersion || !videoId) return [];
  const context = { client: { clientName: "WEB", clientVersion } };

  // The transcript `params` token isn't always embedded in the page. If it's
  // missing, ask the `next` endpoint for it (it returns the transcript panel's
  // params for any captioned video) — no token construction needed.
  let raw = html.match(TRANSCRIPT_PARAMS_RE)?.[1];
  console.log("[recap] params from page html:", !!raw);
  if (!raw) {
    const nextRes = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context, videoId }),
    });
    console.log("[recap] /next status", nextRes.status);
    if (nextRes.ok) {
      const nextTxt = await nextRes.text();
      raw = nextTxt.match(TRANSCRIPT_PARAMS_RE)?.[1];
      console.log("[recap] params from /next:", !!raw, "| has getTranscriptEndpoint:", nextTxt.includes("getTranscriptEndpoint"));
    }
  }
  if (!raw) return [];
  const params = decodeJsonStr(raw);
  console.log("[recap] params had escapes:", raw !== params);

  const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context, params }),
  });
  console.log("[recap] get_transcript status", res.status);
  if (!res.ok) return [];
  const txt = (await res.text()).trim();
  if (!txt) return [];
  try {
    const segs = findInitialSegments(JSON.parse(txt));
    console.log("[recap] innertube segments:", segs.length);
    return segs;
  } catch (e) {
    console.log("[recap] get_transcript parse failed", e);
    return [];
  }
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

// Tier 4 (passive): if the user ALREADY has YouTube's transcript panel open,
// read it. We never open/click it ourselves — that would hijack the visible
// YouTube UI (which it previously did, by mistake).
export function fetchFromOpenTranscriptPanel(): Segment[] {
  return Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))
    .map((el) => ({
      tStartMs: parseTime(el.querySelector(".segment-timestamp")?.textContent?.trim() || "0") * 1000,
      text: (el.querySelector(".segment-text")?.textContent || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
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
  const segs = await fetchTranscriptUncached();
  if (videoId && segs.length) chrome.storage.local.set({ [key]: segs });
  return segs;
}

async function fetchTranscriptUncached(): Promise<Segment[]> {
  // Tier 1 (best, free): Innertube get_transcript — same-origin, no PoToken.
  const inner = await fetchViaInnertube();
  if (inner.length) return inner;

  const pr = readPlayerResponse();
  const tracks: any[] = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  // Tier 2+3: caption track json3, then XML. English first, then any track.
  const ordered = [...tracks].sort((a, b) =>
    Number(b.languageCode?.startsWith("en")) - Number(a.languageCode?.startsWith("en"))
  );
  for (const track of ordered) {
    if (!track.baseUrl) continue;
    const segs = await fetchTrack(track.baseUrl);
    if (segs.length) return segs;
  }
  // Tier 3.5 (paid, BYO token): Apify scraper — handles gated videos.
  const viaApify = await fetchViaApify();
  if (viaApify.length) return viaApify;

  // Tier 4 (passive): read the transcript panel only if already open.
  const panel = fetchFromOpenTranscriptPanel();
  if (panel.length) return panel;

  throw new Error(
    tracks.length
      ? "Captions are restricted for this video. Click “Show transcript” under the video — it'll load here automatically."
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

// ── LLM result types ─────────────────────────────────────────────────────────
export type SummaryBullet = { emoji: string; text: string };
export type SummaryResult = { heading: string; bullets: SummaryBullet[] };
export type TimestampItem = { t: string; text: string };
export type TimestampedResult = { intro: string; items: TimestampItem[] };

export type LlmKind = "summary" | "timestamped" | "ask";

// ── Prompt building ──────────────────────────────────────────────────────────
const countHint: Record<string, string> = {
  Short: "3 concise items",
  Auto: "4 to 6 items",
  Detailed: "8 to 10 items",
};

function summaryPrompt(transcript: string, s: Settings): { system: string; user: string } {
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
- ${countHint[s.count] || "4 to 6 items"}.
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
- ${countHint[s.count] || "4 to 6 items"}, each anchored to a real timestamp from the transcript.
- "t" must be a timestamp copied from the transcript.

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
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
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
        max_tokens: 1800,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.content?.map((b: any) => b.text).join("") ?? "";
  }

  // OpenAI-compatible: OpenAI and OpenRouter share the same request shape.
  const isOR = s.provider === "openrouter";
  const url = isOR
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
      ...(wantJson ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${isOR ? "OpenRouter" : "OpenAI"} error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
