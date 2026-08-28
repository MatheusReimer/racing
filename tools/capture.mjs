// Headless capture. Boots the game in Chromium, waits for the first frames to
// settle, optionally drives it, and writes a PNG plus whatever the console
// coughed up on the way.
//
// This is the only way to see the renderer without a human at a keyboard, so
// it is also the regression gate: a shader that fails to compile or a module
// that throws on import shows up here as console errors, not as a blank png
// nobody looked at.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5173/';
const OUT = process.argv[2] || 'shots/frame.png';
const SETTLE = Number(process.env.SETTLE || 2500);
const DRIVE = Number(process.env.DRIVE || 0);
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 800);

const errors = [];
const logs = [];

const server = await ensureServer();

const browser = await chromium.launch({
  args: [
    // Software GL is deterministic across machines; without these flags a
    // headless Chromium has no GL context at all and the canvas comes back black.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: W, height: H } });

page.on('console', (msg) => {
  const t = msg.type();
  const text = `[${t}] ${msg.text()}`;
  logs.push(text);
  if (t === 'error') errors.push(text);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack || ''}`));

await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

await page.waitForFunction(() => window.__game, { timeout: 20000 })
  .catch(() => errors.push('[capture] game object never appeared'));

// The game boots to the title screen; drop straight into a race so the
// capture shows the thing worth looking at.
if (process.env.SCREEN !== 'title') {
  await page.evaluate(async ({ autopilot, biome }) => {
    const { BIOME_BY_ID, BIOMES } = await import('/src/data/biomes.js');
    const { Build } = await import('/src/build/build.js');
    const { instantiateSkill } = await import('/src/data/skills.js');
    const build = new Build('coupe');
    for (const id of ['nitro', 'electric_grenade', 'rocket', 'mine']) {
      if (build.canAddSkill()) build.addSkill(instantiateSkill(id, 3));
    }
    window.__game.quickRace({
      build,
      biome: biome ? BIOME_BY_ID[biome] : BIOMES[0],
      autopilot,
      laps: 3,
    });
  }, { autopilot: process.env.AUTOPILOT !== '0', biome: process.env.BIOME || null });
}

await page.waitForFunction(() => window.__game.loop.frame > 3, { timeout: 20000 })
  .catch(() => errors.push('[capture] game never rendered a frame'));

await page.waitForTimeout(SETTLE);

if (DRIVE > 0) {
  // Hold throttle so the capture shows the car moving rather than on the grid.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(DRIVE);
}

const info = await page.evaluate(() => {
  const g = window.__game;
  if (!g) return null;
  const s = g.loop.stats();
  const race = g.scene;
  return {
    frame: g.loop.frame,
    fps: s.fps, p50: s.p50, p99: s.p99, utilisation: s.utilisation,
    quality: g.quality.name,
    tier: g.quality.tier,
    state: race?.state,
    speed: race?.player?.speedKmh,
    lap: race?.player?.lap,
    pos: race?.player?.position,
    racers: race?.racers?.length,
    trackLength: race?.track?.length,
    branches: race?.track?.branches?.length,
    onTrack: race?.player?.sample?.onTrack,
    surface: race?.player?.body?.surface?.id,
    side: race?.player?.sample?.side,
    halfWidth: race?.player?.sample?.halfWidth,
    maxSpeed: race?.player?.body?.p?.maxSpeed,
    throttle: race?.player?.input?.throttle,
    durability: race?.player?.durability,
    drawCalls: g.renderer.gl.info.render.calls,
    triangles: g.renderer.gl.info.render.triangles,
    programs: g.renderer.gl.info.programs?.length,
  };
}).catch(() => null);

/**
 * Screenshot a live WebGL canvas reliably.
 *
 * The context runs with `preserveDrawingBuffer: false` — the right choice for a
 * shipped game, since preserving it costs a full-buffer copy every frame — but
 * it means the drawing buffer's contents are undefined once a frame has been
 * presented. Grabbing the surface asynchronously while the loop is running
 * therefore returns whatever the compositor happens to hold: a stale frame, a
 * torn composite of two frames, or just the sky. Under SwiftShader it is worse.
 *
 * Freezing the loop first makes every frame identical, so whatever moment the
 * capture lands on is the moment we asked for. Time scale is restored after.
 */
async function stableShot(page, path) {
  await page.evaluate(() => {
    const g = window.__game;
    g.__savedTimeScale = g.loop.timeScale;
    g.loop.timeScale = 0;
  });
  // Let a few identical frames go through before reading the surface.
  await page.waitForTimeout(220);
  await page.screenshot({ path });
  await page.evaluate(() => {
    const g = window.__game;
    g.loop.timeScale = g.__savedTimeScale ?? 1;
  });
}

mkdirSync(dirname(resolve(OUT)), { recursive: true });
await stableShot(page, OUT);

await browser.close();
server.stop();

console.log(`\nwrote ${OUT}`);
if (info) {
  console.log(`  frame ${info.frame}  ${info.fps?.toFixed(0)} fps  p50 ${info.p50?.toFixed(1)}ms  CPU ${(info.utilisation * 100).toFixed(0)}%`);
  console.log(`  quality ${info.quality} (tier ${info.tier})`);
  console.log(`  race: ${info.state}  speed ${info.speed?.toFixed(0)} km/h  lap ${info.lap}  P${info.pos}  field ${info.racers}`);
  console.log(`  track: ${info.trackLength?.toFixed(0)}m  ${info.branches} branches  onTrack=${info.onTrack} surface=${info.surface} side=${info.side?.toFixed(1)}/${info.halfWidth?.toFixed(1)}`);
  console.log(`  input: throttle=${info.throttle}  cap ${(info.maxSpeed*3.6).toFixed(0)} km/h`);
  console.log(`  gpu: ${info.drawCalls} draws  ${(info.triangles / 1000).toFixed(0)}k tris  ${info.programs} programs`);
}

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
  process.exit(1);
}
console.log('\nno console errors');
