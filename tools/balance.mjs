// Runs complete races in plain Node — no browser, no GPU — and reports how
// each vehicle actually performs.
//
// This exists because a roguelike's balance question is statistical, not
// anecdotal: "is the Drifter competitive" cannot be answered by playing one
// race, only by running a few hundred across many seeds and biomes and looking
// at the distribution. RaceSim carries no rendering, so that costs seconds.
//
//   node tools/balance.mjs [racesPerVehicle] [--laps=2] [--vehicle=truck]

import { RaceSim, VEHICLE_DRIVING_STYLE } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { VEHICLES } from '../src/data/vehicles.js';
import { BIOMES } from '../src/data/biomes.js';
import { instantiateSkill } from '../src/data/skills.js';

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) || 24);
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const LAPS = Number(opt('laps', 2));
const ONLY = opt('vehicle', null);
const DIFFICULTY = Number(opt('difficulty', 1));

const vehicles = ONLY ? VEHICLES.filter((v) => v.id === ONLY) : VEHICLES;

const q = (vals, f) => {
  if (!vals.length) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * f))];
};
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

console.log(`Running ${N} races x ${vehicles.length} vehicles, ${LAPS} laps, difficulty ${DIFFICULTY}\n`);

const t0 = Date.now();
const table = [];
let totalRaces = 0;
let anomalies = [];
const notes = [];

for (const v of vehicles) {
  const places = [];
  const times = [];
  const tops = [];
  const drifts = [];
  const driftEnergy = [];
  const offTrack = [];
  const damageTaken = [];
  const damageDealt = [];
  const kills = [];
  let deaths = 0;
  let timeouts = 0;
  let wins = 0;

  for (let i = 0; i < N; i++) {
    const biome = BIOMES[i % BIOMES.length];
    // Every vehicle gets the same loadout. Without skills equipped, half the
    // roster's identity is inert — the Bomber's explosive bonus has nothing to
    // apply to — and the comparison measures raw stats rather than the cars.
    const build = new Build(v.id);
    for (const id of ['rocket', 'nitro', 'mine']) {
      if (build.canAddSkill()) build.addSkill(instantiateSkill(id, 2));
    }

    const sim = new RaceSim({
      seed: `BAL-${v.id}-${i}`,
      biome,
      playerBuild: build,
      config: { laps: LAPS, rivals: 5, difficulty: DIFFICULTY },
    });
    // Drive each vehicle the way its identity asks to be driven.
    sim.setAutopilot(true, DIFFICULTY, VEHICLE_DRIVING_STYLE[v.id]);
    const result = sim.runToCompletion(1 / 60, 400);
    totalRaces++;

    const p = sim.player;
    if (result.outcome === 'timeout') timeouts++;
    if (result.outcome === 'destroyed') deaths++;
    else {
      places.push(result.place);
      times.push(result.time);
      if (result.place === 1) wins++;
    }
    tops.push(p.stats.topSpeed);
    drifts.push(p.stats.drifted);
    driftEnergy.push(p.stats.driftEnergy);
    offTrack.push(p.stats.offTrack);
    damageTaken.push(p.stats.damageTaken);
    damageDealt.push(p.stats.damageDealt);
    kills.push(p.stats.kills);

    if (!Number.isFinite(p.body.x) || !Number.isFinite(p.body.speed)) {
      anomalies.push(`${v.id} seed ${i}: non-finite physics state`);
    }
  }

  table.push({
    id: v.id,
    name: v.name,
    winRate: wins / N,
    avgPlace: mean(places),
    medTime: q(times, 0.5),
    topSpeed: q(tops, 0.5),
    drift: q(drifts, 0.5),
    driftE: q(driftEnergy, 0.5),
    off: q(offTrack, 0.5),
    taken: q(damageTaken, 0.5),
    dealt: q(damageDealt, 0.5),
    kills: mean(kills),
    deathRate: deaths / N,
    timeouts,
  });
}

const secs = (Date.now() - t0) / 1000;

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d = 1) => String(v.toFixed(d)).padStart(n);

console.log(pad('vehicle', 12) + '  win%  avgP  time  top   drift  driftE  off   taken  dealt  kills  died%');
console.log('-'.repeat(92));
for (const r of table) {
  console.log(
    pad(r.name, 12) +
    num(r.winRate * 100, 6, 0) +
    num(r.avgPlace, 6, 2) +
    num(r.medTime, 6, 0) +
    num(r.topSpeed, 6, 0) +
    num(r.drift, 7, 1) +
    num(r.driftE, 8, 0) +
    num(r.off, 6, 1) +
    num(r.taken, 7, 0) +
    num(r.dealt, 7, 0) +
    num(r.kills, 7, 2) +
    num(r.deathRate * 100, 7, 0) +
    (r.timeouts ? `  [${r.timeouts} TIMEOUT]` : ''),
  );
}

// --- health checks -------------------------------------------------------
// The point of a balance pass is not to make every row identical — the design
// brief is explicit that vehicles should be good at different things. It is to
// catch a row that is not *playable*: one that never finishes, always dies, or
// cannot be competitive anywhere.
console.log('');
const problems = [];
// Vehicles whose identity pays off across a *run* rather than within a race
// cannot be judged on race results. The Gambler trades power for reward
// quality; measuring it here and calling the result a balance problem would be
// the tool being wrong, not the car.
const RUN_SCOPED = new Set(['roadster']);

for (const r of table) {
  if (r.timeouts > 0) problems.push(`${r.name}: ${r.timeouts}/${N} races never finished`);
  if (r.deathRate > 0.35) problems.push(`${r.name}: destroyed in ${(r.deathRate * 100).toFixed(0)}% of races`);
  // Win rate is reported, never gated on.
  //
  // A vehicle whose true rate is 2% shows zero wins in 60 races about a sixth
  // of the time, so "never wins" is a coin flip dressed as a test: it fired on
  // the Truck in one run and not the next with no code change in between. A
  // probe that does that is worse than no probe, because it teaches you to
  // ignore the output.
  //
  // Average finishing position is the stable signal, and it is the one that
  // actually answers the playability question this tool exists to ask.
  if (r.avgPlace > 5.6) {
    problems.push(`${r.name}: average finish ${r.avgPlace.toFixed(2)} of ${1 + 5} — effectively always last`);
  }
  if (r.winRate < 0.05 && !RUN_SCOPED.has(r.id)) {
    notes.push(`${r.name}: wins ${(r.winRate * 100).toFixed(0)}% (avg finish ${r.avgPlace.toFixed(2)}) — weak, but mid-field rather than unplayable`);
  }
  if (r.winRate > 0.75) problems.push(`${r.name}: wins ${(r.winRate * 100).toFixed(0)}% — dominant`);
  if (r.off > 25) problems.push(`${r.name}: off-track ${r.off.toFixed(0)}s per race`);
  if (RUN_SCOPED.has(r.id)) {
    notes.push(`${r.name}: win rate not meaningful here — its identity is reward quality across a run. See tools/run-probe.mjs.`);
  }
}
problems.push(...anomalies);

const spread = table.map((r) => r.winRate);
console.log(`${totalRaces} races in ${secs.toFixed(1)}s (${(totalRaces / secs).toFixed(0)}/s)`);
console.log(`win rate spread: ${(Math.min(...spread) * 100).toFixed(0)}% - ${(Math.max(...spread) * 100).toFixed(0)}%`);

if (problems.length) {
  console.log(`\n${problems.length} issue(s):`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nno balance issues');
