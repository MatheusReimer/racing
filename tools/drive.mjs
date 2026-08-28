// Plays the game with the keyboard, the way a person does.
//
// Distinct from playtest.mjs, which hands the car to the AI: this proves the
// *human* path works — that the title screen's buttons start a run, that the
// map leads to a briefing, that W/A/D/SHIFT/1 reach the physics, and that the
// HUD reflects what the car is doing. Every stage is screenshotted so the
// frames can be looked at rather than assumed.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { mkdirSync } from 'node:fs';

const server = await ensureServer();
mkdirSync('shots/drive', { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

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

const shot = (n) => stableShot(page, `shots/drive/${n}.png`);

const hud = () => page.evaluate(() => {
  const s = window.__game.scene;
  if (!s) return null;
  const p = s.player;
  return {
    state: s.state,
    kmh: Math.round(p.speedKmh),
    pos: p.position,
    lap: p.lap,
    energy: Math.round(p.energy),
    heat: Math.round(p.heat),
    dur: Math.round(p.durability),
    drifting: p.body.drifting,
    slipDeg: Math.round(p.body.slipAngle * 57.3),
    driftQ: +p.body.driftQuality.toFixed(2),
    onTrack: p.sample.onTrack,
    boost: +p.body.boostPower.toFixed(2),
    cooldowns: p.cooldowns.map((c) => +Math.max(0, c).toFixed(1)),
    util: Math.round((window.__game.loop.utilisation || 0) * 100),
    fps: Math.round(window.__game.loop.stats().fps),
    quality: window.__game.quality.name,
  };
});

const log = (label, d) => {
  if (!d) { console.log(`${label.padEnd(22)} (no scene)`); return; }
  console.log(
    `${label.padEnd(22)} ${String(d.kmh).padStart(3)} km/h  P${d.pos} lap${d.lap}  ` +
    `E${String(d.energy).padStart(3)} H${String(d.heat).padStart(2)}% D${String(d.dur).padStart(3)}  ` +
    `${d.drifting ? `DRIFT ${String(d.slipDeg).padStart(3)}deg q${d.driftQ}` : '         '.padEnd(17)}  ` +
    `${d.onTrack ? 'on ' : 'OFF'}  ${d.boost > 0 ? 'BOOST' : '     '}  ` +
    `cd[${d.cooldowns.join(' ')}]  ${d.fps}fps ${d.util}%cpu ${d.quality}`,
  );
};

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game, { timeout: 20000 });
await page.waitForSelector('.screen-title', { timeout: 10000 });

console.log('\n--- title ---');
const vehicles = await page.$$eval('.cards .card .card-name', (n) => n.map((x) => x.textContent.trim()));
console.log(`offered: ${vehicles.join(' | ')}`);
await shot('01-title');

// Pick The Drifter — the vehicle whose identity the drift model has to deliver.
const idx = vehicles.findIndex((v) => v.includes('Drifter'));
await page.click(`.cards .card >> nth=${idx >= 0 ? idx : 0}`);
await page.waitForSelector('.mapnode', { timeout: 10000 });

console.log('\n--- map ---');
const mapInfo = await page.evaluate(() => ({
  region: document.querySelector('.screen-title').textContent,
  nodes: document.querySelectorAll('.mapnode').length,
  available: document.querySelectorAll('.mapnode.available').length,
  edges: document.querySelectorAll('.map-edges line').length,
  seed: window.__game.run.seed,
}));
console.log(`${mapInfo.region} — seed ${mapInfo.seed}, ${mapInfo.nodes} nodes, ${mapInfo.edges} edges, ${mapInfo.available} selectable`);
await shot('02-map');

await page.click('.mapnode.available');
await page.waitForSelector('.screen-foot .btn.primary', { timeout: 10000 });
console.log('\n--- briefing ---');
console.log(await page.$eval('.screen-title', (n) => n.textContent) + ' — '
  + await page.$eval('.tally', (n) => n.textContent.replace(/\s+/g, ' ').trim()));
await shot('03-briefing');

await page.click('.screen-foot .btn.primary');
await page.waitForTimeout(500);
// Audio unlocks on the first keydown, which is how a player starts regardless.
await page.keyboard.press('KeyC');

console.log('\n--- driving (keyboard) ---');
await shot('04-grid');

// Countdown
await page.waitForFunction(() => window.__game.scene?.state === 'racing', { timeout: 20000 });
log('lights out', await hud());

// Launch
await page.keyboard.down('KeyW');
await page.waitForTimeout(3500);
log('full throttle', await hud());
await shot('05-launch');

// Steer through a corner
await page.keyboard.down('KeyD');
await page.waitForTimeout(1600);
log('steering right', await hud());
await shot('06-corner');
await page.keyboard.up('KeyD');

// Handbrake drift — the mechanic the whole Drift attribute exists for
await page.keyboard.down('KeyA');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(1300);
const drifting = await hud();
log('drifting (SHIFT+A)', drifting);
await shot('07-drift');
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyA');

// Fire a skill
await page.waitForTimeout(900);
const before = await hud();
await page.keyboard.press('Digit1');
await page.waitForTimeout(700);
const after = await hud();
log('skill 1 fired', after);
console.log(`   energy ${before.energy} -> ${after.energy}, cooldown ${before.cooldowns[0]} -> ${after.cooldowns[0]}, boost ${after.boost}`);
await shot('08-skill');

await page.keyboard.press('Digit3');
await page.waitForTimeout(1200);
log('skill 3 fired', await hud());
await shot('09-skill3');

// Brake
await page.keyboard.up('KeyW');
await page.keyboard.down('KeyS');
await page.waitForTimeout(1500);
log('braking', await hud());
await page.keyboard.up('KeyS');
await page.keyboard.down('KeyW');

// Let it run a while on autopilot to reach a finish without a human present
await page.evaluate(() => window.__game.scene.setAutopilot(true, 1));
await page.keyboard.up('KeyW');
for (const t of [6000, 6000, 6000]) {
  await page.waitForTimeout(t);
  log('autopilot', await hud());
}
await shot('10-racing');

const perf = await page.evaluate(() => {
  const s = window.__game.loop.stats();
  return { fps: s.fps, p50: s.p50, p99: s.p99, util: s.utilisation, tier: window.__game.quality.name };
});
console.log(`\nperf: ${perf.fps.toFixed(0)} fps  p50 ${perf.p50.toFixed(1)}ms  p99 ${perf.p99.toFixed(1)}ms  `
  + `CPU ${(perf.util * 100).toFixed(0)}%  quality ${perf.tier}`);
console.log('(software-rendered headless Chromium — real GPU numbers are far better)');

await browser.close();
server.stop();

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.log('  ' + e.slice(0, 200));
  process.exit(1);
}
console.log('\nno console errors — shots in shots/drive/');
