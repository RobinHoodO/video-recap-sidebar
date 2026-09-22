import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import Panel from "./Panel";
import { fetchTranscript, fetchFromOpenTranscriptPanel, type Segment } from "./core";

const HOST_ID = "vrs-host";
let root: Root | null = null;
let transcriptObserver: MutationObserver | null = null;
let lastSeenUrl = location.href;

const onWatchPage = () => location.pathname === "/watch";
const currentVideoId = () => new URLSearchParams(location.search).get("v") || "";

const player = () => document.querySelector("#movie_player");

// The right-hand column of the layout the user is actually watching in: the
// live player's own flexy. Stale hidden layouts YouTube keeps in the DOM have
// their own #secondary, which is how the panel used to land on the video.
function activeSecondary(): Element | null {
  return player()?.closest("ytd-watch-flexy")?.querySelector("#secondary") ?? null;
}

// Cap the panel to the current video player height, exposed as a CSS custom
// property the panel consumes (custom properties inherit through the shadow
// boundary).
function sizeToVideo(host: HTMLElement) {
  const h = player()?.getBoundingClientRect().height ?? 0;
  host.style.setProperty("--vrs-max", `${h > 120 ? h : 480}px`);
}

// True when the host's box actually intersects the player's box on screen —
// the one failure mode that matters, tested directly instead of inferred from
// container identity (which is what kept going wrong).
function overlapsPlayer(host: HTMLElement): boolean {
  const p = player()?.getBoundingClientRect();
  if (!p || p.width === 0) return false;
  const h = host.getBoundingClientRect();
  if (h.width === 0 || h.height === 0) return false;
  const m = 8; // tolerance so touching edges don't count
  return h.left < p.right - m && h.right > p.left + m && h.top < p.bottom - m && h.bottom > p.top + m;
}

// Self-correcting placement: the panel lives in the column's normal flow, and
// this check runs on player resize + a 1s tick. If YouTube reflows and the
// panel ends up over the video, re-anchor it into the live column; if it STILL
// overlaps after that, hide it — covering the video is the one unacceptable
// state. ponytail: geometry check over layout events; YouTube reflows with no
// event we can hook.
function ensurePlacement() {
  const host = document.getElementById(HOST_ID) as HTMLElement | null;
  if (!host) return;
  sizeToVideo(host);
  if (!overlapsPlayer(host)) {
    host.style.visibility = "";
    return;
  }
  const secondary = activeSecondary();
  if (secondary && !secondary.contains(host)) secondary.prepend(host); // DOM move keeps React state
  host.style.visibility = overlapsPlayer(host) ? "hidden" : "";
}

// Reposition the instant the player resizes (theater toggle, window drag)
// instead of waiting for the next tick.
const playerObserver = new ResizeObserver(ensurePlacement);
function observePlayer() {
  playerObserver.disconnect();
  const p = player();
  if (p) playerObserver.observe(p);
}

type Props = {
  segments: Segment[] | null;
  transcriptError?: string;
  videoId: string;
  videoTitle: string;
  videoChannel: string;
};

// Best-effort video metadata for the voice agent's dynamic variables. Reads
// straight from YouTube's own DOM — no API call, no extra permission.
function videoMeta(): { title: string; channel: string } {
  const title = document.title.replace(/\s*-\s*YouTube$/, "");
  const channel = document.querySelector("ytd-channel-name#channel-name a")?.textContent?.trim() ?? "";
  return { title, channel };
}

function renderPanel(props: Omit<Props, "videoTitle" | "videoChannel">) {
  const { title, channel } = videoMeta();
  // Keyed by videoId so the panel resets cleanly when the video changes.
  root?.render(
    <StrictMode>
      <Panel key={props.videoId} {...props} videoTitle={title} videoChannel={channel} />
    </StrictMode>
  );
}

function ensureMounted(): boolean {
  if (document.getElementById(HOST_ID)) return true;
  const secondary = activeSecondary();
  if (!secondary) return false; // not ready yet — caller retries

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Normal flow inside the column — integrated above the recommendations, so
  // it pushes them down instead of floating over them.
  host.style.cssText = "display:block;margin-bottom:16px;";
  // Keyboard events from our inputs are `composed` and bubble to YouTube's
  // document handlers (space/k/j/arrows = video commands). Stop them at the
  // host — above the React root, so the panel's own key handlers (Enter to
  // send) still fire, but nothing leaks to the player.
  ["keydown", "keyup", "keypress"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation())
  );
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = "@keyframes vrsBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}";
  shadow.appendChild(style);

  const container = document.createElement("div");
  // Sticky, pinned to the top of the column. Height capped via --vrs-max.
  container.style.cssText = "position:sticky;top:16px;";
  shadow.appendChild(container);

  secondary.prepend(host); // very top of the recommendations column
  root = createRoot(container);
  observePlayer();
  ensurePlacement();
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
  observePlayer(); // SPA nav can swap the player element out
  ensurePlacement();
  setTimeout(ensurePlacement, 1200); // layout settles late on cold loads
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
  playerObserver.disconnect();
  root?.unmount();
  root = null;
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

function handlePossibleVideoNavigation() {
  if (onWatchPage()) mountWithRetry();
  else unmount();
}

// YouTube is a SPA — it fires this instead of a full reload between videos.
window.addEventListener("yt-navigate-finish", handlePossibleVideoNavigation);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "youtube-video") handlePossibleVideoNavigation();
});

window.addEventListener("resize", ensurePlacement);

// Fallback for cases where YouTube or Chrome misses an expected navigation
// signal. Cheap URL polling is boring, but it makes SPA navigation resilient.
setInterval(() => {
  if (location.href !== lastSeenUrl) {
    lastSeenUrl = location.href;
    handlePossibleVideoNavigation();
    chrome.runtime.sendMessage({ type: "wake" }).catch(() => {});
    return;
  }
  // Backstop for reflows that fire no event at all.
  if (!root || !onWatchPage()) return;
  if (!document.getElementById(HOST_ID)) {
    unmount(); // something removed our host
    mountWithRetry();
    return;
  }
  ensurePlacement();
}, 1000);

if (onWatchPage()) mountWithRetry();
