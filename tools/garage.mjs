// Renders vehicles side by side at a fixed angle.
//
// The design brief asks that a specialised build *look* specialised — that an
// electric car read as electric, a tank read as heavy, before the player opens
// the stat panel. That is a claim about the mesh generator, and the only way to
// check it is to put the extremes next to each other and look.
//
//   node tools/garage.mjs            # the six starting vehicles
//   node tools/garage.mjs builds     # the same chassis pushed to build extremes

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const MODE = process.argv[2] || 'vehicles';
const server = await ensureServer();
mkdirSync('shots', { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game, { timeout: 20000 });

const info = await page.evaluate(async ({ mode, aspect, opts }) => {
  // The scene lives in src/dev/garage.js so Vite resolves its `three` import at
  // transform time; a bare `import('three')` from here is not rewritten and
  // fails to resolve in the browser.
  const { showGarage } = await import('/src/dev/garage.js');
  return showGarage(window.__game, mode, aspect, opts);
}, {
  mode: MODE,
  aspect: 1400 / 620,
  opts: {
    hideBody: process.env.HIDE_BODY === '1',
    hideWheels: process.env.HIDE_WHEELS === '1',
    hideGlass: process.env.HIDE_GLASS === '1',
    hideTrim: process.env.HIDE_TRIM === '1',
    hideUnderglow: process.env.HIDE_UNDERGLOW === '1',
    eye: Number(process.env.EYE || 0.55),
    yaw: process.env.YAW ? Number(process.env.YAW) : undefined,
    vehicle: process.env.VEHICLE || undefined,
    bodyType: process.env.BODY || undefined,
    health: process.env.HEALTH ? Number(process.env.HEALTH) : undefined,
    dist: process.env.DIST ? Number(process.env.DIST) : undefined,
  },
});

// Read the canvas inside the frame that drew it, rather than screenshotting the
// page: the garage stops the game loop, so a page screenshot depends on the
// compositor still holding the last frame. See `grab` in src/dev/garage.js.
//
// Note that HIDE_* / EYE / YAW only apply in `single` mode — in `vehicles` mode
// the layout and camera are fixed, so passing them there changes nothing.
const dataUrl = await page.evaluate(() => window.__game.__garage.grab());
writeFileSync(`shots/garage-${MODE}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));

console.log(`\n${MODE}:`);
for (const r of info) {
  console.log(`  ${r.label.padEnd(14)} ${String(r.tris).padStart(5)} tris  `
    + `${String(r.len).padStart(5)}m x ${r.wid}m  ${r.parts} parts  trim ${r.glow}`);
}
console.log(`\nwrote shots/garage-${MODE}.png`);

await browser.close();
server.stop();
if (errors.length) {
  for (const e of [...new Set(errors)].slice(0, 6)) console.log('  ! ' + e.slice(0, 200));
  process.exit(1);
}
