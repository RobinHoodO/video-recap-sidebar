import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx, defineManifest } from "@crxjs/vite-plugin";

const manifest = defineManifest({
  manifest_version: 3,
  name: "Video Recap Sidebar",
  version: "0.1.0",
  description: "A recap panel injected into the YouTube watch page.",
  permissions: ["storage", "webNavigation"],
  host_permissions: [
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://openrouter.ai/*",
    "https://api.apify.com/*",
    "https://hetzner.tail9908c7.ts.net/*",
    "http://100.114.219.63:20128/*",
  ],
  background: { service_worker: "src/background.ts", type: "module" },
  content_scripts: [
    {
      matches: ["https://www.youtube.com/*"],
      js: ["src/content.tsx"],
      run_at: "document_idle",
    },
    {
      matches: ["https://gemini.google.com/*"],
      js: ["src/gemini.ts"],
      run_at: "document_idle",
    },
  ],
});

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: `${process.env.HOME}/Thrivbe-AI/builds/video-recap-sidebar/dist`,
    emptyOutDir: true,
  },
});
