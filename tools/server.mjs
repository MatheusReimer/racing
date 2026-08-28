// Shared helper: make sure a dev server is reachable, starting one if not.
// The capture and playtest harnesses are meant to be runnable from a cold
// checkout without a human remembering to run `npm run dev` first.

import { spawn } from 'node:child_process';

const URL = process.env.URL || 'http://127.0.0.1:5173/';

async function reachable(url, ms = 1200) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** @returns {Promise<{url: string, stop: () => void}>} */
export async function ensureServer() {
  if (await reachable(URL)) return { url: URL, stop: () => {} };

  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev'],
    { stdio: 'ignore', detached: false, shell: process.platform === 'win32' },
  );

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await reachable(URL)) {
      return { url: URL, stop: () => { try { child.kill(); } catch {} } };
    }
  }
  child.kill();
  throw new Error(`dev server did not come up at ${URL}`);
}
