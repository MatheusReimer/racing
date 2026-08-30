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
      // The voxel bake writes its result the same way.
      server.middlewares.use('/__vox', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
        if (!/^[a-z0-9_]{1,32}$/.test(name)) {
          res.statusCode = 400; res.end('{"ok":false,"error":"bad name"}'); return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 5e7) req.destroy(); });
        req.on('end', () => {
          mkdirSync('public/bodies', { recursive: true });
          writeFileSync(`public/bodies/${name}.vox`, Buffer.concat(chunks));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, bytes: size }));
        });
      });

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
            // One mark per line. Pretty-printing puts a crate's six numbers on
            // six lines, and a file of those is unreadable as a diff — which is
            // half of why a mark is a box in space rather than a face list.
            const text = marks.length
              ? `[\n${marks.map((m) => `  ${JSON.stringify(m)}`).join(',\n')}\n]\n`
              : '[]\n';
            writeFileSync(`public/marks/${name}.json`, text);
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
