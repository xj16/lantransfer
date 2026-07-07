import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * The web client reuses the desktop's runtime-agnostic shared modules verbatim
 * (crypto.ts / peer.ts / protocol.ts / relayClient.ts) via the `@shared` alias,
 * so there is a single source of truth for the wire protocol across all three
 * clients.
 *
 * `base: './'` emits relative asset URLs so the built bundle is a truly
 * standalone static site that works when embedded under any path (a portfolio
 * subfolder, GitHub Pages project page, an iframe, or opened via file://).
 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../desktop/src/shared'),
    },
  },
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
});
