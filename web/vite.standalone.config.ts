import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Standalone build: the engine runs in the page, so the output has no server to
 * talk to. `scripts/build-standalone.mjs` folds the emitted chunk and stylesheet
 * into the HTML afterwards — doing it here would race Vite's own tag injection.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Selects the in-browser engine instead of the REST/WebSocket backend.
    'import.meta.env.VITE_STANDALONE': '"true"',
  },
  build: {
    outDir: 'dist-standalone',
    emptyOutDir: true,
    sourcemap: false,
    // Nothing is fetched at runtime, so the preload polyfill would only leave a
    // dead chunk URL embedded in the page.
    modulePreload: false,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    // One chunk, so there is nothing for the page to fetch at runtime.
    codeSplitting: false,
  },
});
