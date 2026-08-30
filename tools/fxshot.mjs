// Look at the effects, still.
//
// Every judgement about an effect was being made from a screenshot taken at
// ninety-six kilometres an hour with motion blur over it, which is the one
// view in which a cube and a smudge are the same picture. This boots a race,
// waits for the flag, emits one burst of each kind beside a stationary car and
// shoots the next frame.
//
//   node tools/fxshot.mjs shots/fx.png
//   BIOME=frozen node tools/fxshot.mjs
//
// Set DRIVE=1 to hold throttle and nitrous instead, which is the only way to
// see the boost plume as the game actually emits it.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const server = await ensureServer();
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game, { timeout: 20000 });
await page.evaluate(async (biomeId) => {
  const { BIOME_BY_ID, BIOMES } = await import('/src/data/biomes.js');
  const { Build } = await import('/src/build/build.js');
  window.__game.quickRace({
    build: new Build('coupe'),
    biome: BIOME_BY_ID[biomeId] ?? BIOMES[0], autopilot: false, laps: 3,
  });
}, process.env.BIOME || 'wasteland');
await page.waitForFunction(() => window.__game.loop.frame > 3, { timeout: 20000 });
// The countdown runs on sim time and SwiftShader is at two thirds of real
// time, so wait for the flag rather than for a number of seconds.
await page.waitForFunction(() => window.__game.scene?.state === 'racing', { timeout: 40000 })
  .catch(() => console.log('never got racing'));
await page.waitForTimeout(1200);

// Still, so the effects can be looked at rather than guessed at through motion
// blur: emit each kind beside the stationary car and shoot the next frame.
if (process.env.DRIVE) {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(2200);
}
await page.evaluate((driving) => {
  const r = window.__game.scene;
  const b = r.player.body;
  const p = r.fx.particles;
  if (driving) return;
  p.emit('boost', b.x - 1.6, b.y + 0.5, b.z - 2.2, 40, { speed: 3, dirX: 0, dirZ: -1 });
  p.emit('fire', b.x + 2.2, b.y + 0.7, b.z - 1.0, 26, { speed: 2 });
  p.emit('spark', b.x + 4.6, b.y + 0.7, b.z + 0.5, 30, { speed: 5 });
  p.emit('smoke', b.x - 4.4, b.y + 0.8, b.z + 0.5, 22, { speed: 2 });
  p.emit('electric', b.x, b.y + 1.6, b.z + 1.6, 26, { speed: 4 });
}, !!process.env.DRIVE);
await page.waitForTimeout(120);
mkdirSync('shots', { recursive: true });
writeFileSync(process.argv[2] || 'shots/fx.png', await page.screenshot());

console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 5).join('\n') : 'no console errors');
await browser.close();
await server.close?.();
process.exit(0);
