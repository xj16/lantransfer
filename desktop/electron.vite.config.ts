import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * electron-vite orchestrates three separate builds — main, preload, and the
 * renderer — each with the right target and module format. The renderer is a
 * standard Vite + React SPA; main/preload are bundled for Node/Electron.
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/main.ts') },
      rollupOptions: {
        external: ['electron', 'mime-types'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/preload.ts') },
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    plugins: [react()],
  },
});
