import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, open: false },
  build: {
    target: 'es2022',
    // Everything in this project is generated at runtime; there is nothing to inline.
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: { output: { manualChunks: undefined } },
  },
});
