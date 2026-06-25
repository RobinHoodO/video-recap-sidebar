import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Panel from "./Panel";
import type { Segment } from "./core";

// Standalone preview harness (not part of the extension). Lets you iterate on
// the panel in a normal browser tab via `npm run dev` without loading Chrome.
// Note: chrome.* APIs aren't present here, so LLM calls won't run — this is for
// layout/visual work only.
const style = document.createElement("style");
style.textContent = "@keyframes vrsBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}";
document.head.appendChild(style);

const demoSegments: Segment[] = [
  { tStartMs: 0, text: "Welcome — today we cover a workflow for AI coding." },
  { tStartMs: 179000, text: "The smart zone: the model is sharp early, then degrades past ~100k tokens." },
  { tStartMs: 434000, text: "Treat each phase as a clean context: brief, plan, grill, implement." },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Panel segments={demoSegments} videoId="preview" />
  </StrictMode>
);
