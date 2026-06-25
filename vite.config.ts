import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx, defineManifest } from "@crxjs/vite-plugin";

const manifest = defineManifest({
  manifest_version: 3,
  name: "Video Recap Sidebar",
  version: "0.1.0",
  description: "A recap panel injected into the YouTube watch page.",
  permissions: ["storage"],
  host_permissions: [
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://openrouter.ai/*",
    "https://api.apify.com/*",
    "http://127.0.0.1:8644/*",
  ],
  background: { service_worker: "src/background.ts", type: "module" },
  content_scripts: [
    {
      matches: ["https://www.youtube.com/*"],
      js: ["src/content.tsx"],
      run_at: "document_idle",
    },
  ],
});

export default defineConfig({
  plugins: [react(), crx({ manifest })],
});
