# Building the unpacked extension

Run `npm ci`, then `npm run build`. Load `dist` using Chrome's **Load unpacked** button and reload the extension after rebuilding. The production bundle works with the development server stopped.

`npm run dev` writes a separate `dist-dev` directory, which requires the Vite server to keep running. Development never replaces the installed production output.

When a local `.env` exists, both commands run Vite through `oprun --env-file .env`. Put `oprun` on PATH first. Without a `.env`, a clean clone builds using any environment variables already supplied. Unresolved `VITE_` 1Password references fail the build with the affected key names.

This personal extension deliberately embeds its resolved `VITE_` defaults in the local bundle. Keep `.env` and generated output private; do not upload a build containing personal keys.

`npm test` checks separate output paths, reference rejection, and a real production build using synthetic credentials. `npm run typecheck` checks the TypeScript sources.
