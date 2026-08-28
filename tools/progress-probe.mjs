// Guards the race-progress metric and the no-progress rescue.
//
// These two together caused the worst bug in the project: a car driving
// perfectly normally got slammed from 150 km/h to 43 km/h every five seconds
// for most of every lap, with no visible cause.
//
// `raceProgress` must be monotonic for a car driving forward. It is used for
// ranking *and* as the rescue's trigger, so a discontinuity in it does not just
// scramble the standings — it reaches into the physics and slows the player
// down. Both properties are asserted here across many seeds, because the failure
// only appears when the start line is far from the spline's seam.

import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { BIOMES } from '../src/data/biomes.js';

const DT = 1 / 60;
const SEEDS = Number(process.argv[2] || 40);
let failures = 0;

console.log(`Checking progress monotonicity and rescue behaviour over ${SEEDS} seeds\n`);

const rows = [];

for (let i = 0; i < SEEDS; i++) {
  const biome = BIOMES[i % BIOMES.length];
  const sim = new RaceSim({
    seed: `PROG${i}`,
    biome,
    playerBuild: new Build('coupe'),
    config: { laps: 3, rivals: 3, difficulty: 1, countdown: 0 },
  });
  sim.setAutopilot(true, 1);
  sim.state = 'racing';

  const player = sim.player;
  let prev = player.raceProgress(sim.track);
  let worstDrop = 0;
  let worstAt = null;
  let rescues = 0;
  let hardSlowdowns = 0;
  let prevSpeed = 0;

  // Count rescues by watching for the signature the rescue leaves behind.
  const origCheck = sim._checkStuck.bind(sim);
  sim._checkStuck = (racer, dt) => {
    const before = racer._stuckFor ?? 0;
    origCheck(racer, dt);
    if (before >= 5 && (racer._stuckFor ?? 0) === 0 && racer === player) rescues++;
  };

  for (let step = 0; step < 60 * 260 && sim.state !== 'finished'; step++) {
    sim.update(DT, null);
    if (!player.alive) break;

    const p = player.raceProgress(sim.track);
    const drop = prev - p;
    // Only a *backward* jump matters, and only a large one — sub-metre jitter
    // from re-projection near a branch is expected.
    if (drop > worstDrop) { worstDrop = drop; worstAt = { s: player.trackS, lap: player.lap }; }
    prev = p;

    // A sudden loss of most of the car's speed while on track and undamaged is
    // the symptom a player actually reports.
    const speed = player.body.speed;
    if (prevSpeed > 25 && speed < prevSpeed * 0.45 && player.sample.onTrack) hardSlowdowns++;
    prevSpeed = speed;
  }

  const startS = sim.track.startS;
  const seamOffset = Math.min(startS, sim.track.length - startS);
  const problems = [];
  if (worstDrop > 30) problems.push(`progress fell ${worstDrop.toFixed(0)} at lap ${worstAt.lap}`);
  if (rescues > 2) problems.push(`${rescues} rescues`);

  rows.push({ i, biome: biome.id, startS, seamOffset, worstDrop, rescues, hardSlowdowns, problems });
  if (problems.length) failures++;
}

const q = (v, f) => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0;
};

for (const r of rows.filter((x) => x.problems.length).slice(0, 10)) {
  console.log(`FAIL seed ${r.i} (${r.biome})  startS=${r.startS.toFixed(0)}  ${r.problems.join('; ')}`);
}

console.log(`${SEEDS - failures}/${SEEDS} seeds clean`);
console.log(`  worst backward jump  p50 ${q(rows.map((r) => r.worstDrop), 0.5).toFixed(1)}m  max ${q(rows.map((r) => r.worstDrop), 1).toFixed(1)}m`);
console.log(`  rescues per race     p50 ${q(rows.map((r) => r.rescues), 0.5)}  max ${q(rows.map((r) => r.rescues), 1)}`);
console.log(`  hard slowdowns       p50 ${q(rows.map((r) => r.hardSlowdowns), 0.5)}  max ${q(rows.map((r) => r.hardSlowdowns), 1)}`);
console.log(`  start line offset from seam: p50 ${q(rows.map((r) => r.seamOffset), 0.5).toFixed(0)}m`);

if (failures) {
  console.log('\nprogress metric is not monotonic, or the rescue is firing on healthy cars');
  process.exit(1);
}
console.log('\nprogress is monotonic and the rescue stays out of the way');
