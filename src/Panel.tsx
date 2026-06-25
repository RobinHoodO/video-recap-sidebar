import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  DEFAULT_GEMINI_PROMPT,
  fmtTime,
  parseTime,
  transcriptToText,
  type Provider,
  type Segment,
  type Settings,
  type SummaryResult,
  type TimestampedResult,
} from "./core";

const ACCENT = "#f1581f";

// Comments aren't wired to a real source yet (would need the YouTube comment
// API). ponytail: demo data until that phase.
const commentItems = [
  { initials: "Qu", bg: "linear-gradient(135deg,#ff4fa3,#d61f69)", handle: "@mistermanko", likes: "322", text: "Wanted to become a programmer, became a markdown-file-manager. Thanks AI." },
  { initials: "OM", bg: "linear-gradient(135deg,#5b8def,#7b5cf0)", handle: "@TheOrionMusicNetwork", likes: "301", text: "Just want to say that you are doing a great thing for people." },
  { initials: "DV", bg: "linear-gradient(135deg,#23c483,#159957)", handle: "@devon.builds", likes: "188", text: "The smart-zone / dumb-zone framing finally made token limits click for me." },
];

type Tab = "summary" | "timestamped" | "ask" | "comments" | "transcript";
type ChatMsg = { role: "user" | "assistant"; text: string };
type Gen<T> = { loading: boolean; data: T | null; error: string };
type LlmResponse = { ok: true; data: unknown } | { ok: false; error: string };

const EMPTY = <T,>(): Gen<T> => ({ loading: false, data: null, error: "" });

const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  openrouter: "openai/gpt-4o-mini",
};
const PROVIDER_LABEL: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};
const PROVIDER_KEY_HINT: Record<Provider, string> = {
  openai: "sk-… (OpenAI API key)",
  anthropic: "sk-ant-… (Anthropic key)",
  openrouter: "sk-or-… (OpenRouter key)",
};

// ── Style helpers ────────────────────────────────────────────────────────────
const tabStyle = (active: boolean): CSSProperties => ({ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 34, borderRadius: 9, cursor: "pointer", transition: "all .12s", background: active ? "#3d3d3d" : "transparent", color: active ? "#f0f0f0" : "#8f8f8f" });
const segStyle = (active: boolean): CSSProperties => ({ padding: "9px 18px", borderRadius: 9, fontSize: 15.5, cursor: "pointer", userSelect: "none", transition: "all .12s", background: active ? "#333" : "transparent", color: active ? "#f2f2f2" : "#9a9a9a", border: active ? "1px solid #3d3d3d" : "1px solid #2b2b2b" });
const iconBtn: CSSProperties = { width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, cursor: "pointer", color: "#9a9a9a" };
const label: CSSProperties = { color: "#7d7d7d", fontSize: 13, fontWeight: 600, letterSpacing: 1.2 };
const hlStyle: CSSProperties = { background: "rgba(150,110,45,.34)", color: "#f1e3c6", borderRadius: 3, padding: "0 3px" };
const inputStyle: CSSProperties = { width: "100%", background: "#161616", border: "1px solid #303030", borderRadius: 9, padding: "10px 12px", color: "#eee", fontSize: 15, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
const scrollPane: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 22px 26px" };

const Divider = () => <span style={{ width: 1, height: 16, background: "#2f2f2f" }} />;
const Dot = ({ delay }: { delay: number }) => <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#888", animation: `vrsBlink 1.2s infinite ${delay}s` }} />;

// Render text with <hl>…</hl> markers as highlighted spans.
function renderHl(text: string): ReactNode[] {
  return (text || "").split(/(<hl>[\s\S]*?<\/hl>)/g).map((part, i) =>
    part.startsWith("<hl>") ? <span key={i} style={hlStyle}>{part.slice(4, -5)}</span> : <span key={i}>{part}</span>
  );
}

function seek(seconds: number) {
  const v = document.querySelector("video") as HTMLVideoElement | null;
  if (v) { v.currentTime = seconds; v.play?.().catch(() => {}); }
}

function Status({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9a9a9a", fontSize: 15, padding: "24px 0" }}>{children}</div>;
}
function TypingDots() {
  return <span style={{ display: "inline-flex", gap: 5 }}><Dot delay={0} /><Dot delay={0.2} /><Dot delay={0.4} /></span>;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function Panel({ segments, transcriptError }: { segments: Segment[] | null; transcriptError?: string; videoId: string }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("summary");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summary, setSummary] = useState<Gen<SummaryResult>>(EMPTY());
  const [tstamp, setTstamp] = useState<Gen<TimestampedResult>>(EMPTY());
  const [chat, setChat] = useState<ChatMsg[]>([{ role: "assistant", text: "Hi! 🤖 Ask me anything about this video — I'll answer from its transcript." }]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  const closed = !settingsOpen;
  const hasKey = !!settings.apiKey;
  const transcriptText = segments ? transcriptToText(segments) : "";

  // Load persisted settings once.
  useEffect(() => {
    chrome.storage.local.get("settings").then((got) => {
      const merged = { ...DEFAULT_SETTINGS, ...(got.settings as Partial<Settings> | undefined) };
      setSettings(merged);
      setSettingsLoaded(true);
      if (!got.settings) chrome.storage.local.set({ settings: merged });
    });
  }, []);

  async function askLLM(kind: "summary" | "timestamped" | "ask", question = ""): Promise<LlmResponse> {
    return (await chrome.runtime.sendMessage({ type: "llm", kind, transcript: transcriptText, question })) as LlmResponse;
  }

  function generate(kind: "summary" | "timestamped") {
    const set = kind === "summary" ? setSummary : setTstamp;
    set({ loading: true, data: null, error: "" });
    askLLM(kind)
      .then((r) => {
        if (!r) return set({ loading: false, data: null, error: "No response from the model." });
        if (!r.ok) return set({ loading: false, data: null, error: r.error });
        const d: any = r.data;
        const okShape = kind === "summary" ? Array.isArray(d?.bullets) : Array.isArray(d?.items);
        if (!okShape) return set({ loading: false, data: null, error: "The model returned an unexpected format — try again or pick another model." });
        set({ loading: false, data: d, error: "" });
      })
      .catch((e) => set({ loading: false, data: null, error: e instanceof Error ? e.message : String(e) }));
  }

  // Pre-generate both recaps as soon as the transcript + key are ready (not
  // gated on the active tab) so every AI tab is instant when entered.
  useEffect(() => {
    if (segments && settingsLoaded && hasKey && !summary.data && !summary.loading && !summary.error) generate("summary");
  }, [segments, settingsLoaded, hasKey, summary]);
  useEffect(() => {
    if (segments && settingsLoaded && hasKey && !tstamp.data && !tstamp.loading && !tstamp.error) generate("timestamped");
  }, [segments, settingsLoaded, hasKey, tstamp]);

  const goto = (t: Tab) => { setTab(t); setSettingsOpen(false); };

  // Only these settings change the recap output; others (token, gemini prompt)
  // must not trigger a costly regenerate — especially now that both recaps
  // pre-generate automatically.
  const RECAP_KEYS: (keyof Settings)[] = ["focus", "format", "count", "emojis", "highlights", "grouped", "provider", "model", "language"];
  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    chrome.storage.local.set({ settings: next });
    if (Object.keys(patch).some((k) => RECAP_KEYS.includes(k as keyof Settings))) {
      setSummary(EMPTY());
      setTstamp(EMPTY());
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  };
  const onCopy = () => { if (transcriptText) navigator.clipboard?.writeText(transcriptText).catch(() => {}); showToast(transcriptText ? "Transcript copied" : "No transcript yet"); };
  const onShare = () => showToast("Share link copied");
  const onGemini = () => {
    if (!transcriptText) return showToast("No transcript yet");
    const prompt = `${settings.geminiPrompt || DEFAULT_GEMINI_PROMPT}\n\n--- TRANSCRIPT ---\n${transcriptText}`;
    navigator.clipboard?.writeText(prompt).catch(() => {});
    window.open("https://gemini.google.com/app", "_blank");
    showToast("Transcript + prompt copied — paste into Gemini");
  };

  const send = () => {
    const q = input.trim();
    if (!q || sending || !segments) return;
    if (!hasKey) { setSettingsOpen(true); return; }
    setChat((c) => [...c, { role: "user", text: q }]);
    setInput("");
    setSending(true);
    askLLM("ask", q).then((r) => {
      setChat((c) => [...c, { role: "assistant", text: r.ok ? String(r.data) : `⚠ ${r.error}` }]);
      setSending(false);
    });
  };

  // Shared gate: returns a status node if content can't render yet, else null.
  const gate = (g?: Gen<unknown>): ReactNode => {
    if (!hasKey) return <KeyNotice onOpen={() => setSettingsOpen(true)} provider={settings.provider} />;
    if (transcriptError) return <Status>⚠ {transcriptError}</Status>;
    if (!segments) return <Status>Reading transcript <TypingDots /></Status>;
    if (g?.error) return <Status>⚠ {g.error}</Status>;
    if (!g?.data) return <Status>Generating <TypingDots /></Status>; // covers loading AND not-yet-started
    return null;
  };

  const focusOpts = ["Insightful", "Funny", "Actionable", "Controversial"];
  const formatOpts = ["List", "Q&A"];
  const countOpts = ["Short", "Auto", "Detailed"];
  const features: { k: keyof Settings; l: string }[] = [{ k: "emojis", l: "Add emojis" }, { k: "highlights", l: "Highlights" }, { k: "grouped", l: "Grouped" }];

  return (
    <div style={{ display: "flex", flexDirection: "column", maxHeight: "var(--vrs-max, 80vh)", minHeight: 0, background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: 16, overflow: "hidden", position: "relative", boxShadow: "0 14px 50px rgba(0,0,0,.6)", fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif", WebkitFontSmoothing: "antialiased" }}>
      {/* toolbar */}
      <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 14px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2, background: "#181818", border: "1px solid #2b2b2b", borderRadius: 13, padding: 4 }}>
          <div style={tabStyle(closed && tab === "summary")} onClick={() => goto("summary")}>
            <svg width="20" height="20" viewBox="0 0 24 24"><defs><linearGradient id="vrsGem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5b9bff" /><stop offset="1" stopColor="#b06cff" /></linearGradient></defs><path d="M6 3h12l3 6-9 12L3 9z" fill="url(#vrsGem)" /><path d="M3 9h18M9 3l-1 6 4 12M15 3l1 6-4 12" stroke="rgba(255,255,255,.25)" strokeWidth="1" fill="none" /></svg>
          </div>
          <Divider />
          <div style={tabStyle(closed && tab === "timestamped")} onClick={() => goto("timestamped")}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none" /><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /></svg>
          </div>
          <Divider />
          <div style={tabStyle(closed && tab === "ask")} onClick={() => goto("ask")}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><line x1="12" y1="4.5" x2="12" y2="8" /><circle cx="12" cy="3.4" r="1.2" fill="currentColor" stroke="none" /><circle cx="9" cy="13.5" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="13.5" r="1.3" fill="currentColor" stroke="none" /><line x1="2" y1="12" x2="2" y2="15" /><line x1="22" y1="12" x2="22" y2="15" /></svg>
          </div>
          <Divider />
          <div style={tabStyle(closed && tab === "comments")} onClick={() => goto("comments")}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M21 14a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" /></svg>
          </div>
          <Divider />
          <div style={tabStyle(closed && tab === "transcript")} onClick={() => goto("transcript")}>
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, border: "1.6px solid currentColor", borderRadius: 5, padding: "2px 4px", lineHeight: 1 }}>cc</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={iconBtn} onClick={onCopy}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg></div>
          <div style={iconBtn} onClick={onShare}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></svg></div>
          {closed ? (
            <div style={iconBtn} onClick={() => setSettingsOpen(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="7" x2="21" y2="7" /><circle cx="9" cy="7" r="2.3" fill="#0a0a0a" /><line x1="3" y1="13.5" x2="21" y2="13.5" /><circle cx="15" cy="13.5" r="2.3" fill="#0a0a0a" /><line x1="3" y1="20" x2="21" y2="20" /><circle cx="7" cy="20" r="2.3" fill="#0a0a0a" /></svg></div>
          ) : (
            <div style={{ ...iconBtn, color: "#ddd", background: "#2a2a2a" }} onClick={() => setSettingsOpen(false)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" /></svg></div>
          )}
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg,#4a8cff,#9b5cf0)", flex: "none", marginLeft: 4 }} />
        </div>
      </div>

      {/* content */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {settingsOpen && (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 22px 26px" }}>
            <div style={{ ...label, margin: "14px 0 12px" }}>FOCUS</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{focusOpts.map((o) => <div key={o} style={segStyle(settings.focus === o)} onClick={() => update({ focus: o })}>{o}</div>)}</div>
            <div style={{ ...label, margin: "26px 0 12px" }}>FORMAT</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{formatOpts.map((o) => <div key={o} style={segStyle(settings.format === o)} onClick={() => update({ format: o })}>{o}</div>)}</div>
            <div style={{ ...label, margin: "26px 0 12px" }}>NUMBER OF ITEMS</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{countOpts.map((o) => <div key={o} style={segStyle(settings.count === o)} onClick={() => update({ count: o })}>{o}</div>)}</div>
            <div style={{ ...label, margin: "26px 0 14px" }}>FEATURES</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {features.map((f) => {
                const on = !!settings[f.k];
                return (
                  <div key={f.k} style={{ display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }} onClick={() => update({ [f.k]: !settings[f.k] } as Partial<Settings>)}>
                    <div style={{ width: 46, height: 26, borderRadius: 14, display: "flex", alignItems: "center", padding: 3, transition: "all .15s", background: on ? ACCENT : "#3a3a3a", justifyContent: on ? "flex-end" : "flex-start" }}><div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff" }} /></div>
                    <span style={{ color: "#e8e8e8", fontSize: 17 }}>{f.l}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ ...label, margin: "26px 0 12px" }}>AI MODEL</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              {(["openai", "anthropic", "openrouter"] as Provider[]).map((p) => (
                <div key={p} style={segStyle(settings.provider === p)} onClick={() => update({ provider: p, model: PROVIDER_DEFAULT_MODEL[p] })}>{PROVIDER_LABEL[p]}</div>
              ))}
            </div>
            <input style={{ ...inputStyle, marginBottom: 10 }} value={settings.model} onChange={(e) => update({ model: e.target.value })} placeholder={settings.provider === "openrouter" ? "e.g. anthropic/claude-3.5-sonnet" : "model id"} />
            <input style={inputStyle} type="password" value={settings.apiKey} onChange={(e) => update({ apiKey: e.target.value })} placeholder={PROVIDER_KEY_HINT[settings.provider]} />
            <div style={{ color: "#6f6f6f", fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>Stored locally in this browser only. Calls go straight from the extension to {PROVIDER_LABEL[settings.provider]}.{settings.provider === "openrouter" ? " Use any model id from openrouter.ai/models." : ""}</div>
            <div style={{ ...label, margin: "26px 0 12px" }}>TRANSCRIPT FALLBACK</div>
            <input style={inputStyle} type="password" value={settings.apifyToken} onChange={(e) => update({ apifyToken: e.target.value })} placeholder="Apify API token (optional)" />
            <div style={{ color: "#6f6f6f", fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>Only used when YouTube blocks the in-page transcript (gated captions). Get a token at apify.com — ~$0.50 per 1k transcripts. Stored locally.</div>
            <div style={{ ...label, margin: "26px 0 12px" }}>LANGUAGE</div>
            <input style={inputStyle} value={settings.language} onChange={(e) => update({ language: e.target.value })} placeholder="English" />
            <div style={{ ...label, margin: "26px 0 12px" }}>GEMINI PROMPT</div>
            <textarea style={{ ...inputStyle, minHeight: 90, resize: "vertical", lineHeight: 1.5 }} value={settings.geminiPrompt} onChange={(e) => update({ geminiPrompt: e.target.value })} placeholder={DEFAULT_GEMINI_PROMPT} />
            <div style={{ color: "#6f6f6f", fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>Placed above the full transcript when you send it to Gemini Canvas.</div>
          </div>
        )}

        {closed && tab === "summary" && (
          <div style={scrollPane}>
            <div style={{ display: "flex", gap: 10, margin: "6px 0 18px", flexWrap: "wrap" }}>
              {([{ key: "focus", opts: focusOpts }, { key: "format", opts: formatOpts }, { key: "count", opts: countOpts }] as { key: keyof Settings; opts: string[] }[]).map(({ key, opts }) => (
                <div key={key} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                  <select value={settings[key] as string} onChange={(e) => update({ [key]: e.target.value } as Partial<Settings>)} style={{ appearance: "none", WebkitAppearance: "none", padding: "7px 32px 7px 13px", background: "#1a1a1a", border: "1px solid #2f2f2f", borderRadius: 19, color: "#d4d4d4", fontSize: 14.5, cursor: "pointer", fontFamily: "inherit", outline: "none" }}>
                    {opts.map((o) => <option key={o} value={o} style={{ background: "#1a1a1a", color: "#d4d4d4" }}>{o}</option>)}
                  </select>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round" style={{ position: "absolute", right: 11, pointerEvents: "none" }}><path d="M6 9l6 6 6-6" /></svg>
                </div>
              ))}
            </div>
            {gate(summary) ?? (
              <>
                <h2 style={{ color: "#ededed", fontSize: 21, fontWeight: 700, margin: "0 0 16px", letterSpacing: "-.3px" }}>{summary.data!.heading}</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 16.5, lineHeight: 1.55, color: "#cccccc" }}>
                  {(summary.data!.bullets ?? []).map((b, i) => (
                    <div key={i} style={{ display: "flex", gap: 11 }}>
                      {b.emoji && <span style={{ fontSize: 18, lineHeight: 1.4, flex: "none" }}>{b.emoji}</span>}
                      <div>{renderHl(b.text)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {closed && tab === "timestamped" && (
          <div style={scrollPane}>
            <h2 style={{ color: "#f4f4f4", fontSize: 34, fontWeight: 800, margin: "8px 0 14px", letterSpacing: -1 }}>Timestamped summary</h2>
            {gate(tstamp) ?? (
              <>
                <p style={{ color: "#e4e4e4", fontSize: 19, fontWeight: 600, lineHeight: 1.45, margin: "0 0 24px" }}>{tstamp.data!.intro}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  {(tstamp.data!.items ?? []).map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 11 }}>
                      <span style={{ fontSize: 18, lineHeight: 1.4, flex: "none" }}>🤖</span>
                      <div style={{ fontSize: 16.5, lineHeight: 1.55, color: "#cfcfcf" }}><span style={{ color: "#4a9eef", fontWeight: 600, cursor: "pointer" }} onClick={() => seek(parseTime(t.t))}>{t.t}</span> {t.text}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {closed && tab === "comments" && (
          <div style={scrollPane}>
            <h2 style={{ color: "#f4f4f4", fontSize: 34, fontWeight: 800, margin: "8px 0 16px", letterSpacing: -1 }}>Top comments</h2>
            <div style={{ color: "#7d7d7d", fontSize: 12.5, marginBottom: 18 }}>Demo data — comment summaries land in a later phase.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              {commentItems.map((c, i) => (
                <div key={i}>
                  <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 8 }}>
                    <div style={{ width: 38, height: 38, borderRadius: "50%", flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#fff", background: c.bg }}>{c.initials}</div>
                    <span style={{ color: "#f1f1f1", fontSize: 16, fontWeight: 700 }}>{c.handle}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4, color: "#9a9a9a", fontSize: 14 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M7 10v11H4V10zM7 10l4-7a2 2 0 0 1 2 2v3h5.6a2 2 0 0 1 2 2.3l-1.4 8a2 2 0 0 1-2 1.7H7" /></svg>{c.likes}</span>
                  </div>
                  <div style={{ color: "#c8c8c8", fontSize: 16, lineHeight: 1.55 }}>{c.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {closed && tab === "transcript" && (
          <div style={scrollPane}>
            <h2 style={{ color: "#f4f4f4", fontSize: 34, fontWeight: 800, margin: "8px 0 16px", letterSpacing: -1 }}>Transcript</h2>
            {!segments ? (transcriptError ? <Status>⚠ {transcriptError}</Status> : <Status>Reading transcript <TypingDots /></Status>) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, width: "100%", padding: 12, borderRadius: 11, background: "linear-gradient(135deg,#3a7bd5,#9b5cf0)", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer", marginBottom: 22 }} onClick={onGemini}>
                  <svg width="17" height="17" viewBox="0 0 24 24"><defs><linearGradient id="vrsGem2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#e6dcff" /></linearGradient></defs><path d="M12 2c.5 4.5 3.5 7.5 8 8-4.5.5-7.5 3.5-8 8-.5-4.5-3.5-7.5-8-8 4.5-.5 7.5-3.5 8-8z" fill="url(#vrsGem2)" /></svg>
                  Outline framework in Gemini Canvas
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {segments.map((t, i) => (
                    <div key={i} style={{ fontSize: 16, lineHeight: 1.6, color: "#cccccc" }}><span style={{ color: "#4a9eef", fontWeight: 600, cursor: "pointer", marginRight: 6 }} onClick={() => seek(t.tStartMs / 1000)}>{fmtTime(t.tStartMs)}</span>{t.text}</div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {closed && tab === "ask" && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, color: "#8a8a8a", fontSize: 13, padding: "2px 22px 12px" }}>
              Grounded in this video's transcript
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 22px 8px" }}>
              {!hasKey && <KeyNotice onOpen={() => setSettingsOpen(true)} provider={settings.provider} />}
              {chat.map((m, i) => {
                const u = m.role === "user";
                return <div key={i} style={{ display: "flex", justifyContent: u ? "flex-end" : "flex-start", marginBottom: 12 }}><div style={{ maxWidth: "82%", padding: "11px 14px", borderRadius: 15, fontSize: 15, lineHeight: 1.5, background: u ? "#2b6fb0" : "#1d1d1d", color: u ? "#fff" : "#dcdcdc", borderTopRightRadius: u ? 4 : 15, borderTopLeftRadius: u ? 15 : 4, whiteSpace: "pre-wrap" }}>{m.text}</div></div>;
              })}
              {sending && <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}><div style={{ display: "flex", gap: 5, padding: "14px 16px", background: "#1f1f1f", borderRadius: 14, borderTopLeftRadius: 4 }}><TypingDots /></div></div>}
            </div>
            <div style={{ flex: "none", display: "flex", gap: 10, padding: "12px 18px 16px", borderTop: "1px solid #1d1d1d" }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Ask anything about this video…" style={{ flex: 1, background: "#161616", border: "1px solid #303030", borderRadius: 11, padding: "12px 14px", color: "#eee", fontSize: 15, outline: "none", fontFamily: "inherit" }} />
              <div style={{ width: 46, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 11, background: ACCENT, cursor: "pointer", opacity: segments ? 1 : 0.5 }} onClick={send}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9z" /></svg></div>
            </div>
          </div>
        )}
      </div>

      {toast && <div style={{ position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#1e1e1e", border: "1px solid #383838", color: "#f0f0f0", padding: "13px 20px", borderRadius: 11, fontSize: 14.5, boxShadow: "0 8px 30px rgba(0,0,0,.5)", zIndex: 50 }}>{toast}</div>}
    </div>
  );
}

function KeyNotice({ onOpen, provider }: { onOpen: () => void; provider: Provider }) {
  return (
    <div style={{ background: "#141414", border: "1px solid #262626", borderRadius: 12, padding: "18px 18px", margin: "8px 0 16px" }}>
      <div style={{ color: "#e8e8e8", fontSize: 15.5, fontWeight: 600, marginBottom: 6 }}>Add your API key to start</div>
      <div style={{ color: "#9a9a9a", fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>Paste a {PROVIDER_LABEL[provider]} key in settings. It's stored locally and used to generate recaps from the transcript.</div>
      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "10px 16px", borderRadius: 10, background: ACCENT, color: "#fff", fontWeight: 700, fontSize: 14.5, cursor: "pointer" }} onClick={onOpen}>Open settings</div>
    </div>
  );
}
