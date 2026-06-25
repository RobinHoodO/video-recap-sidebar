import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import Panel from "./Panel";
import { fetchTranscript, fetchFromOpenTranscriptPanel, type Segment } from "./core";

const HOST_ID = "vrs-host";
let root: Root | null = null;
let containerEl: HTMLElement | null = null;
let transcriptObserver: MutationObserver | null = null;

const onWatchPage = () => location.pathname === "/watch";
const currentVideoId = () => new URLSearchParams(location.search).get("v") || "";

// Cap the panel to the current video player height, exposed as a CSS custom
// property the panel consumes (custom properties inherit through the shadow
// boundary). Recomputed on resize and navigation.
function sizeToVideo() {
  if (!containerEl) return;
  const player =
    document.querySelector("#movie_player") || document.querySelector("#player");
  const h = player?.getBoundingClientRect().height ?? 0;
  containerEl.style.setProperty("--vrs-max", `${h > 120 ? h : 480}px`);
}

type Props = { segments: Segment[] | null; transcriptError?: string; videoId: string };

function renderPanel(props: Props) {
  // Keyed by videoId so the panel resets cleanly when the video changes.
  root?.render(
    <StrictMode>
      <Panel key={props.videoId} {...props} />
    </StrictMode>
  );
}

function ensureMounted(): boolean {
  if (document.getElementById(HOST_ID)) return true;

  const secondary =
    document.querySelector("ytd-watch-flexy #secondary") ||
    document.querySelector("#secondary");
  if (!secondary) return false; // not ready yet — caller retries

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "display:block;margin-bottom:16px;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = "@keyframes vrsBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}";
  shadow.appendChild(style);

  const container = document.createElement("div");
  // Sticky, pinned to the top of the column. Height capped via --vrs-max.
  container.style.cssText = "position:sticky;top:16px;";
  shadow.appendChild(container);
  containerEl = container;

  secondary.prepend(host); // very top of the recommendations column
  root = createRoot(container);
  return true;
}

// When auto-fetch fails (e.g. captions are token-gated), watch for the user
// opening YouTube's "Show transcript" panel, then read those segments straight
// into our panel.
function watchForTranscriptPanel(vid: string) {
  transcriptObserver?.disconnect();
  // YouTube mutates the DOM constantly, so scanning on every mutation pegs a
  // CPU core. Throttle the (expensive) querySelectorAll to ~2x/sec and give up
  // after 5 min so the observer can't run unbounded.
  let scheduled = false;
  const deadline = Date.now() + 5 * 60_000;
  const stop = () => { transcriptObserver?.disconnect(); transcriptObserver = null; };
  transcriptObserver = new MutationObserver(() => {
    if (scheduled) return;
    if (Date.now() > deadline) return stop();
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const segments = fetchFromOpenTranscriptPanel();
      if (!segments.length) return;
      stop();
      if (currentVideoId() === vid) renderPanel({ segments, videoId: vid });
    }, 500);
  });
  transcriptObserver.observe(document.body, { childList: true, subtree: true });
}

async function refresh() {
  if (!ensureMounted()) return;
  transcriptObserver?.disconnect();
  const vid = currentVideoId();
  renderPanel({ segments: null, videoId: vid }); // loading state
  sizeToVideo();
  setTimeout(sizeToVideo, 1200);
  try {
    const segments = await fetchTranscript();
    if (currentVideoId() === vid) renderPanel({ segments, videoId: vid });
  } catch (err) {
    if (currentVideoId() === vid) {
      renderPanel({
        segments: null,
        transcriptError: err instanceof Error ? err.message : String(err),
        videoId: vid,
      });
      watchForTranscriptPanel(vid);
    }
  }
}

function unmount() {
  transcriptObserver?.disconnect();
  transcriptObserver = null;
  root?.unmount();
  root = null;
  containerEl = null;
  document.getElementById(HOST_ID)?.remove();
}

// #secondary can lag behind document_idle on a fresh load.
// ponytail: bounded poll. Swap for a MutationObserver if this proves flaky.
function mountWithRetry(tries = 20) {
  if (ensureMounted()) {
    refresh();
    return;
  }
  if (onWatchPage() && tries > 0) setTimeout(() => mountWithRetry(tries - 1), 300);
}

// YouTube is a SPA — it fires this instead of a full reload between videos.
window.addEventListener("yt-navigate-finish", () => {
  if (onWatchPage()) mountWithRetry();
  else unmount();
});

window.addEventListener("resize", sizeToVideo);

if (onWatchPage()) mountWithRetry();
