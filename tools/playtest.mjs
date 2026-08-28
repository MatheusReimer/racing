// Runs whole races headlessly with the player's car on autopilot, and reports
// what happened.
//
// This is the harness that answers questions a screenshot cannot: does a lap
// actually complete, does the field finish, does anyone get stuck against a
// wall, does a build reach the speed its stats promise. It drives through the
// real Driver and the real physics, so a pass here means the game is playable,
// not just that it renders.
//
//   node tools/playtest.mjs [races] [--vehicle=drifter] [--laps=2] [--biome=frozen]

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';

const args = process.argv.slice(2);
const RACES = Number(args.find((a) => /^\d+$/.test(a)) || 3);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const VEHICLE = opt('vehicle', 'coupe');
const LAPS = Number(opt('laps', 2));
const BIOME = opt('biome', null);
const TIMEOUT_S = Number(opt('timeout', 200));

const server = await ensureServer();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game, { timeout: 20000 });

const results = [];

for (let i = 0; i < RACES; i++) {
  const seed = `PT${1000 + i}`;

  await page.evaluate(async ({ seed, vehicle, laps, biome }) => {
    const { Build } = await import('/src/build/build.js');
    const { BIOMES, BIOME_BY_ID } = await import('/src/data/biomes.js');
    const { instantiateSkill } = await import('/src/data/skills.js');
    const build = new Build(vehicle);
    for (const id of ['nitro', 'rocket', 'mine']) {
      if (build.canAddSkill()) build.addSkill(instantiateSkill(id, 2));
    }
    window.__game.quickRace({
      seed,
      build,
      vehicleId: vehicle,
      biome: biome ? BIOME_BY_ID[biome] : BIOMES[Math.floor(Math.random() * BIOMES.length)],
      autopilot: true,
      laps,
      rivals: 5,
      difficulty: 1,
    });
  }, { seed, vehicle: VEHICLE, laps: LAPS, biome: BIOME });

  // Drive the simulation as fast as the machine allows rather than in real
  // time: the loop is wall-clock driven, so we just wait for it to converge.
  const outcome = await page.waitForFunction(
    (limit) => {
      const r = window.__game.scene;
      if (!r) return false;
      if (r.state === 'finished') return { done: true };
      if (r.time > limit) return { done: false, timeout: true };
      return false;
    },
    TIMEOUT_S,
    { timeout: 300000, polling: 250 },
  ).then((h) => h.jsonValue()).catch(() => ({ done: false, hung: true }));

  const snap = await page.evaluate(() => {
    const r = window.__game.scene;
    const rank = r.racers.slice().sort((a, b) => a.position - b.position);
    return {
      state: r.state,
      time: r.time,
      biome: r.biome.id,
      trackLength: r.track.length,
      branches: r.track.branches.length,
      result: r.result || null,
      player: {
        lap: r.player.lap,
        pos: r.player.position,
        alive: r.player.alive,
        durability: r.player.durability,
        maxDurability: r.player.maxDurability,
        topSpeed: r.player.stats.topSpeed,
        drifted: r.player.stats.drifted,
        driftEnergy: r.player.stats.driftEnergy,
        offTrack: r.player.stats.offTrack,
        damageTaken: r.player.stats.damageTaken,
        damageDealt: r.player.stats.damageDealt,
        distance: r.player.totalDistance,
      },
      field: rank.map((x) => ({
        name: x.name, pos: x.position, lap: x.lap,
        alive: x.alive, finished: x.finished,
        dur: Math.round(x.durability),
        kmh: Math.round(x.speedKmh),
        offTrack: Math.round(x.stats.offTrack),
      })),
      loop: window.__game.loop.stats(),
      quality: window.__game.quality.name,
    };
  });

  results.push({ seed, outcome, ...snap });

  const p = snap.player;
  const ok = outcome.done && p.lap >= LAPS;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${seed}  ${snap.biome.padEnd(10)} ` +
    `${snap.trackLength.toFixed(0)}m/${snap.branches}br  ` +
    `${snap.time.toFixed(0)}s  P${p.pos}  lap ${p.lap}/${LAPS}  ` +
    `top ${p.topSpeed.toFixed(0)}km/h  ` +
    `drift ${p.drifted.toFixed(0)}s(+${p.driftEnergy.toFixed(0)}e)  ` +
    `off ${p.offTrack.toFixed(0)}s  ` +
    `dur ${Math.round(p.durability)}/${Math.round(p.maxDurability)}` +
    (outcome.timeout ? '  [TIMEOUT]' : outcome.hung ? '  [HUNG]' : ''),
  );
  if (!ok) {
    console.log('        field: ' + snap.field
      .map((f) => `${f.name}:P${f.pos} L${f.lap} ${f.kmh}km/h ${f.alive ? '' : 'DEAD '}off${f.offTrack}s`)
      .join(' | '));
  }
}

await browser.close();
server.stop();

// --- summary ---
const done = results.filter((r) => r.outcome.done && r.player.lap >= LAPS);
const q = (vals, f) => {
  const s = vals.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0;
};
const tops = results.map((r) => r.player.topSpeed);
const times = done.map((r) => r.time);
const offs = results.map((r) => r.player.offTrack);

console.log(`\n${done.length}/${RACES} races completed`);
if (times.length) {
  console.log(`  race time (s)   min ${q(times, 0).toFixed(0)}  p50 ${q(times, 0.5).toFixed(0)}  max ${q(times, 1).toFixed(0)}`);
}
console.log(`  top speed km/h  min ${q(tops, 0).toFixed(0)}  p50 ${q(tops, 0.5).toFixed(0)}  max ${q(tops, 1).toFixed(0)}`);
console.log(`  time off track  p50 ${q(offs, 0.5).toFixed(1)}s  max ${q(offs, 1).toFixed(1)}s`);
console.log(`  finishing pos   ${results.map((r) => 'P' + r.player.pos).join(' ')}`);

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e);
}

process.exit(done.length === RACES && errors.length === 0 ? 0 : 1);
