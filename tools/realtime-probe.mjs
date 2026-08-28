// Does the simulation keep up with the wall clock under load?
//
// The loop caps catch-up at MAX_STEPS_PER_FRAME. When a frame costs more real
// time than that cap can simulate, the game silently runs in slow motion: the
// car still obeys every input, just at a fraction of the rate, which to a
// player is indistinguishable from the controls having died. It is the worst
// possible failure mode for a driving game and it leaves no error behind.
//
// This measures the ratio of simulated seconds to real seconds while a race is
// running, at each quality tier, and reports where it falls off. Anything below
// ~0.9 is felt.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';

const server = await ensureServer();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game, { timeout: 20000 });

await page.evaluate(async () => {
  const { BIOMES } = await import('/src/data/biomes.js');
  const { Build } = await import('/src/build/build.js');
  const { instantiateSkill } = await import('/src/data/skills.js');
  const build = new Build('coupe');
  for (const id of ['nitro', 'electric_grenade', 'rocket', 'mine']) {
    if (build.canAddSkill()) build.addSkill(instantiateSkill(id, 4));
  }
  // Inferno: the busiest circuits, heaviest fog, most hazards.
  window.__game.quickRace({
    build, biome: BIOMES[4], autopilot: true, laps: 9, rivals: 5, difficulty: 2,
  });
});
await page.waitForFunction(() => window.__game.scene?.state === 'racing', { timeout: 20000 });

console.log('simulated-vs-real time under load, per quality tier\n');
console.log('tier      ratio   fps   p50ms   p99ms   CPU%   steps/frame   verdict');
console.log('-'.repeat(74));

const rows = [];

for (const tier of [3, 2, 1, 0]) {
  await page.evaluate((t) => {
    const g = window.__game;
    g.quality.lockTo(t);
    // Push the effect load up: full throttle, skills firing, a busy field.
    g.scene.setAutopilot(true, 2);
  }, tier);
  await page.waitForTimeout(1500);   // let the tier change settle

  const r = await page.evaluate(() => new Promise((resolve) => {
    const g = window.__game;
    const t0 = performance.now();
    const s0 = g.scene.time;
    const f0 = g.loop.frame;
    setTimeout(() => {
      const realS = (performance.now() - t0) / 1000;
      const simS = g.scene.time - s0;
      const frames = g.loop.frame - f0;
      const st = g.loop.stats();
      resolve({
        ratio: simS / realS,
        realS, simS, frames,
        fps: frames / realS,
        p50: st.p50, p99: st.p99,
        util: st.utilisation,
        stepsPerFrame: frames ? (simS * 60) / frames : 0,
      });
    }, 5000);
  }));

  const name = await page.evaluate(() => window.__game.quality.name);
  const verdict = r.ratio > 0.95 ? 'real time'
    : r.ratio > 0.85 ? 'slightly behind'
    : r.ratio > 0.6 ? 'SLOW MOTION'
    : 'SEVERE SLOW MOTION';
  rows.push({ tier, name, ...r, verdict });

  console.log(
    `${name.padEnd(8)} ${r.ratio.toFixed(2).padStart(6)} ` +
    `${r.fps.toFixed(0).padStart(5)} ${r.p50.toFixed(1).padStart(7)} ${r.p99.toFixed(1).padStart(7)} ` +
    `${(r.util * 100).toFixed(0).padStart(6)} ${r.stepsPerFrame.toFixed(1).padStart(13)}   ${verdict}`,
  );
}

await browser.close();
server.stop();

const worst = rows.reduce((a, b) => (a.ratio < b.ratio ? a : b));
console.log('');
console.log(`worst: ${worst.name} at ${worst.ratio.toFixed(2)}x real time`);
console.log('(software-rendered headless Chromium is far slower than a real GPU;');
console.log(' the point here is the *shape* — whether low tiers recover real time.)');

if (rows[rows.length - 1].ratio < 0.85) {
  console.log('\nEven the lowest tier cannot hold real time: the loop will run the game');
  console.log('in slow motion on weak hardware, which reads as dead controls.');
  process.exit(1);
}
console.log('\nthe low tier recovers real time');
