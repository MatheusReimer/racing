import { defineConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * Let /paint.html write its marks to disk.
 *
 * Development only — `configureServer` never runs in a build — and it writes
 * one place and nowhere else: `public/marks/<body>.json`, with the body name
 * checked against a plain word so a request cannot walk out of the directory.
 */
function markWriter() {
  return {
    name: 'mark-writer',
    configureServer(server) {
      server.middlewares.use('/__marks', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            const { name, marks } = JSON.parse(body);
            if (!/^[a-z0-9_]{1,32}$/.test(name ?? '')) throw new Error('bad name');
            if (!Array.isArray(marks)) throw new Error('marks must be a list');
            mkdirSync('public/marks', { recursive: true });
            writeFileSync(`public/marks/${name}.json`, `${JSON.stringify(marks, null, 2)}\n`);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, wrote: marks.length }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [markWriter()],
  server: { host: '127.0.0.1', port: 5173, open: false },
  build: {
    target: 'es2022',
    // Everything in this project is generated at runtime; there is nothing to inline.
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: { output: { manualChunks: undefined } },
  },
});
