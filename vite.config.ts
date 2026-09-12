import { defineConfig, loadEnv } from "vite";
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

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const unresolved = Object.keys(env).filter(key => {
    const value = env[key].trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    return value.startsWith("op://");
  });
  if (unresolved.length) {
    throw new Error(`Unresolved 1Password references: ${unresolved.join(", ")}. Start with npm run dev or npm run build through oprun.`);
  }
  return {
    // CRX's serve hook empties outDir, even during preview. Preview only
    // serves an existing production bundle and must not run that writer.
    plugins: [react(), ...(isPreview ? [] : [crx({ manifest })])],
    // CRX development output depends on a running Vite server. Keep it away
    // from the production extension Chrome loads between development sessions.
    build: { outDir: command === "serve" && !isPreview ? "dist-dev" : "dist", emptyOutDir: true },
  };
});
