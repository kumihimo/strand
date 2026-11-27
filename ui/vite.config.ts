import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
/** The running cockpit `npm run dev:ui` proxies /api to (STRAND_COCKPIT_URL, or the pre-rename SDLC_COCKPIT_URL, overrides the default port). */
const cockpit = process.env.STRAND_COCKPIT_URL ?? process.env.SDLC_COCKPIT_URL ?? 'http://127.0.0.1:4747';

export default defineConfig({
  root,
  plugins: [react()],
  // `npm run dev:ui` against a running cockpit (strand cockpit, default port 4747). Open the cockpit's ?key= link
  // first, then the dev page on http://127.0.0.1:5173 (cookies ignore ports, so the session cookie is sent).
  // The cockpit checks Host and Origin, so the proxy presents itself as the cockpit's own origin.
  server: {
    proxy: {
      '/api': {
        target: cockpit,
        changeOrigin: true,
        // The terminal stream (/api/terminals/<id>/io) is a WebSocket. Its upgrade request carries the browser's
        // Origin too, so it gets the same rewrite as plain requests.
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.getHeader('origin') && req.setHeader('origin', cockpit));
          proxy.on('proxyReqWs', (req) => req.getHeader('origin') && req.setHeader('origin', cockpit));
        },
      },
    },
  },
  build: { outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)), emptyOutDir: true },
});
