// Does the pit lane behave like a pit lane?
//
// Three things have to be true, and none of them can be read off the code:
//
//   * every circuit has one, and it is beside the racing line rather than
//     across it;
//   * driving it costs time — the limiter, not the six metres of extra
//     tarmac, is where the price is;
//   * completing it buys a service and spends scrap, and brushing the entry
//     buys nothing.
//
// The car is driven, not teleported. A tiny pursuit driver aims at a point down
// whichever path it has been told to follow, which is enough to get a car
// through a lane and is the same geometry the game's own driver sees.

import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { RNG } from '../src/core/rng.js';
import { BIOMES } from '../src/data/biomes.js';
import { VEHICLES } from '../src/data/vehicles.js';
import { PIT_SPEED_LIMIT } from '../src/race/pits.js';
import { SKILLS, instantiateSkill } from '../src/data/skills.js';

const DT = 1 / 60;
const biomes = Object.values(BIOMES);
let problems = 0;
const fail = (m) => { problems++; console.log(`  FAIL  ${m}`); };

/** Steer the player at a point `look` metres down `path` from station `s`. */
function chase(racer, path, s, look, throttle = 1) {
  const b = racer.body;
  const t = path.pointAt(Math.min(path.length, s + look), { x: 0, y: 0, z: 0 });
  const want = Math.atan2(t.x - b.x, t.z - b.z);
  let d = want - b.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  // The car steers with -x for right; the sign here is the one physics-probe
  // pins, so an inverted guess would show up as a car that never turns in.
  racer.input.steer = Math.max(-1, Math.min(1, -d * 2.2));
  racer.input.throttle = throttle;
  racer.input.brake = 0;
  racer.input.drift = false;
  racer.input.nos = false;
}

/** Distance along a Path of the point nearest (x, z). Coarse but sufficient. */
function nearestS(path, x, z) {
  let bestS = 0;
  let best = Infinity;
  for (let s = 0; s <= path.length; s += 2) {
    const p = path.pointAt(s, { x: 0, y: 0, z: 0 });
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bestS = s; }
  }
  return bestS;
}

function makeSim(seed, biome, scrap, skills = 0) {
  const build = new Build(VEHICLES[0].id);
  // The Armory sells cooldowns, so a car with no skills gives it nothing to
  // sell and the lane never fires. Which is correct, and is why the service is
  // chosen from what the build carries — but it means testing it needs a car
  // that actually has some.
  for (let k = 0; k < skills; k++) build.addSkill(instantiateSkill(SKILLS[k].id));
  const sim = new RaceSim({
    seed, biome, playerBuild: build,
    config: { laps: 3, rivals: 0, difficulty: 1, scrap, countdown: 0, trafficDensity: 0 },
  });
  sim.state = 'racing';
  sim.countdown = 0;
  return sim;
}

/**
 * Put the player at the pit entry at speed and drive it down `path`.
 * @returns { seconds, topSpeed, served }
 */
function driveLane(sim, path, seconds, startSpeed) {
  const pit = sim.pit;
  const p = sim.player;
  // At the lane's first point, which is *on the racing line* — the lane tapers
  // out from there. Starting at the middle of the lane would skip the entry,
  // which is the part most likely to be wrong.
  const entry = path.pointAt(0, { x: 0, y: 0, z: 0 });
  const ahead = path.pointAt(6, { x: 0, y: 0, z: 0 });
  p.placeAt({ x: entry.x, y: entry.y + 0.2, z: entry.z,
    yaw: Math.atan2(ahead.x - entry.x, ahead.z - entry.z), s: pit.lane.entryS });
  p.body.vx = Math.sin(p.body.yaw) * startSpeed;
  p.body.vz = Math.cos(p.body.yaw) * startSpeed;
  p.body.speed = startSpeed;
  sim.track.sample(p.body.x, p.body.z, p.sample);

  let steps = 0;
  let inLane = 0;
  let reached = 0;
  const settled = [];       // speeds once the limiter has had time to work
  const before = sim.pitStops.length;
  for (let t = 0; t < seconds; t += DT) {
    const s = nearestS(path, p.body.x, p.body.z);
    reached = Math.max(reached, s / path.length);
    chase(p, path, s, 14);
    sim.update(DT, null);
    steps++;
    if (p.sample.branch === pit.lane) {
      inLane += DT;
      // The limiter brakes, it does not teleport: a car arriving at 216 km/h
      // is legitimately over the limit for the first couple of seconds, and
      // measuring the peak measures the arrival rather than the limiter.
      if (inLane > 2.5) settled.push(p.body.speed);
    }
    if (sim.pitStops.length > before) break;
  }
  settled.sort((a, b) => a - b);
  return {
    seconds: steps * DT,
    inLane,
    reached,
    held: settled.length ? settled[Math.floor(settled.length * 0.9)] : 0,
    served: sim.pitStops.slice(before),
  };
}

// --- 1. every circuit has a lane, and it is beside the road -----------------
console.log('Every circuit has a pit lane, laid beside the racing line:\n');
let noLane = 0;
let crossings = 0;
const gaps = [];
for (let i = 0; i < 60; i++) {
  const sim = makeSim(`pit-${i}`, biomes[i % biomes.length], 0);
  const lane = sim.pit?.lane;
  if (!lane) { noLane++; continue; }

  // The lane's middle must clear the road's edge, or it is a bulge in the road
  // and the ownership test will flip between the two.
  //
  // Projected onto the main line directly rather than asked of `sample`:
  // `sample` hands the lane's own midpoint to the lane, and reports an offset
  // of zero from the road it is supposed to be measured against.
  let worst = Infinity;
  for (let t = 0.3; t <= 0.7; t += 0.05) {
    const p = lane.path.pointAt(lane.path.length * t, { x: 0, y: 0, z: 0 });
    const m = sim.track.path.project(p.x, p.z, {});
    worst = Math.min(worst,
      Math.abs(m.side) - sim.track.halfWidthAt(m.s) - lane.halfWidth);
  }
  gaps.push(worst);
  // Not merely "does not overlap". Two roads a hand's width apart still put
  // the ownership test on a knife edge, and the barrier has to fit between.
  if (worst < 1.5) crossings++;
}
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
console.log(`  circuits without a lane   ${noLane} of 60`);
console.log(`  lane clear of the tarmac  p50 ${q(gaps, 0.5).toFixed(1)} m   worst ${q(gaps, 0).toFixed(1)} m`);
if (noLane) fail(`${noLane} circuits have no pit lane`);
if (crossings) fail(`${crossings} lanes come within 1.5 m of the racing line`);
if (!noLane && !crossings) console.log('  ok  one lane per circuit, none of them on the road');

// --- 2. the limiter -------------------------------------------------------
console.log('\nArriving flat out and driving the lane:\n');
const tops = [];
const runs = [];
for (let i = 0; i < 12; i++) {
  const sim = makeSim(`pit-${i}`, biomes[i % biomes.length], 400, 2);
  const r = driveLane(sim, sim.pit.lane.path, 20, 60);
  if (r.held > 0) tops.push(r.held);
  runs.push(r.reached);
}
console.log(`  speed held once in the lane  p90 ${(q(tops, 0.9) * 3.6).toFixed(0)} km/h`
  + `   (limit ${(PIT_SPEED_LIMIT * 3.6).toFixed(0)} km/h)`);
console.log(`  how far down the lane driven  p50 ${(q(runs, 0.5) * 100).toFixed(0)}%`
  + `   worst ${(q(runs, 0) * 100).toFixed(0)}%`);
if (!tops.length) fail('no car was ever held in the lane long enough to measure');
else if (q(tops, 0.9) > PIT_SPEED_LIMIT * 1.15) fail('the limiter is not holding the lane');
else console.log('  ok  a car arriving at 216 km/h is pulled down and held there');

// --- 3. what a stop buys, and what it costs -------------------------------
console.log('\nA completed lane is served, and paid for:\n');
let served = 0;
let charged = 0;
const rows = [];
const short = [];
for (let i = 0; i < 12; i++) {
  const sim = makeSim(`pit-${i}`, biomes[i % biomes.length], 400, 2);
  // Give the service something to do.
  sim.player.durability = sim.player.maxDurability * 0.35;
  sim.player.energy = 0;
  // Empty magazines, which is what the Armory sells rounds for. (It used to
  // sell cooldowns, and this line had to set them to forty seconds because
  // they ticked down over the seven the lane takes and were all cool by the
  // exit. Charges do not tick.)
  sim.player.charges = sim.player.charges.map(() => 0);
  const before = sim.scrap;
  const r = driveLane(sim, sim.pit.lane.path, 20, 30);
  if (!r.served.length && short.length < 4) short.push(
    `  drove ${(r.reached * 100).toFixed(0)}% of the lane, ${r.inLane.toFixed(1)}s in it`);
  if (r.served.length) {
    served++;
    if (before - sim.scrap > 0) charged++;
    if (rows.length < 4) rows.push(`  ${sim.pit.service.name.padEnd(10)} ${r.served[0].text}`
      + `  (-${r.served[0].paid} scrap)`);
  }
}
rows.forEach((l) => console.log(l));
short.forEach((l) => console.log(l));
console.log(`  lanes driven to the end that were served  ${served} of 12`);
if (served < 10) fail(`only ${served} of 12 completed lanes were served`);
else if (charged < served) fail('a stop was served without being charged');
else console.log('  ok  driving the lane through buys the service and spends the scrap');

// --- 4. brushing the entry buys nothing ------------------------------------
console.log('\nPutting a wheel in the entry and thinking better of it:\n');
let freebies = 0;
let inconclusive = 0;
for (let i = 0; i < 12; i++) {
  const sim = makeSim(`pit-${i}`, biomes[i % biomes.length], 400, 2);
  sim.player.durability = sim.player.maxDurability * 0.35;
  sim.player.energy = 0;
  const before = sim.scrap;
  // Across the lane rather than along it: dropped into the middle of it
  // pointing at the racing line, so the car is in and out in a fraction of a
  // second. That is the shape of clipping the entry, and it is the case the
  // minimum-time guard exists for.
  const p = sim.player;
  const lane = sim.pit.lane;
  const mid = lane.path.pointAt(lane.path.length * 0.5, { x: 0, y: 0, z: 0 });
  const road = sim.track.path.project(mid.x, mid.z, {});
  const onLine = sim.track.path.pointAt(road.s, { x: 0, y: 0, z: 0 });
  p.placeAt({ x: mid.x, y: mid.y + 0.2, z: mid.z,
    yaw: Math.atan2(onLine.x - mid.x, onLine.z - mid.z), s: road.s });
  p.body.vx = Math.sin(p.body.yaw) * 25;
  p.body.vz = Math.cos(p.body.yaw) * 25;
  p.body.speed = 25;
  sim.track.sample(p.body.x, p.body.z, p.sample);
  const entered = p.sample.branch === lane;
  for (let t = 0; t < 3; t += DT) {
    p.input.throttle = 1; p.input.brake = 0; p.input.steer = 0;
    p.input.drift = false; p.input.nos = false;
    sim.update(DT, null);
  }
  if (!entered) inconclusive++;
  if (sim.pitStops.length || sim.scrap !== before) freebies++;
}
console.log(`  stops bought by clipping the lane  ${freebies} of 12`
  + (inconclusive ? `   (${inconclusive} never got into it)` : ''));
if (freebies) fail(`${freebies} cars were served without driving the lane`);
else console.log('  ok  a stop has to be driven all the way through');

// --- 4b. the premise the Armory rests on -----------------------------------
//
// A skill has to be able to run out, or the reload is a service for a problem
// nobody has. Before charges existed, a car firing whenever it was allowed got
// about ten uses out of a race and *every* refusal was the cooldown — the
// Energy cost never bit once, because Energy regenerates and a cooldown is
// always longer than the time it takes to earn the cost back.
console.log('\nSkills run out, which is why there is somewhere to reload:\n');
{
  const dryAt = [];
  const used = [];
  for (let i = 0; i < 8; i++) {
    const sim = makeSim(`ammo-${i}`, biomes[i % biomes.length], 0, 2);
    sim.setAutopilot(true, 1);
    const p = sim.player;
    const mag = p.charges[0];
    let fired = 0;
    let dry = null;
    let t = 0;
    for (; t < 300 && sim.state !== 'finished'; t += DT) {
      sim.update(DT, null);
      if (sim.state !== 'racing') continue;
      if (sim.useSkill(p, 0)) fired++;
      if (dry === null && p.charges[0] <= 0) dry = t;
    }
    used.push(fired);
    if (dry !== null && t > 0) dryAt.push(dry / t);
    if (i === 0) console.log(`  a magazine holds ${mag}`);
  }
  const spent = q(used, 0.5);
  const point = dryAt.length ? q(dryAt, 0.5) : null;
  console.log(`  uses in a race, firing at every chance  p50 ${spent}`);
  console.log(point == null ? '  never ran dry'
    : `  ran dry at  ${(point * 100).toFixed(0)}% of the race`);
  if (point == null) fail('a skill fired at every chance never runs out');
  else console.log('  ok  spamming a skill empties it, and the lane is the way back');
}

// --- 4c. the lane changes a wheel, free ------------------------------------
//
// The HUD tells a punctured driver "the pits can fix it", so the pits have to
// fix it — whichever service the circuit's lane happens to sell, and without
// charging, because five seconds in the lane is already the price of a stop.
console.log('\nA punctured car that pits comes out on fresh rubber:\n');
{
  let mended = 0;
  let charged = 0;
  let servedAnyway = 0;
  for (let i = 0; i < 8; i++) {
    const sim = makeSim(`flat-${i}`, biomes[i % biomes.length], 0, 2);
    const p = sim.player;
    // Flat, whole, and skint: nothing but the wheel to sell, and no money.
    p.body.puncture(0.72, 30);
    const r = driveLane(sim, sim.pit.lane.path, 20, 30);
    if (p.body.speedPenaltyTimer <= 0 && p.body.speedPenalty === 1) mended++;
    if (sim.scrapSpent > 0) charged++;
    if (r.served.length) servedAnyway++;
  }
  console.log(`  came out mended       ${mended} of 8`);
  console.log(`  charged for it        ${charged} of 8`);
  console.log(`  reported as a stop    ${servedAnyway} of 8`);
  if (mended < 8) fail(`${8 - mended} punctured cars left the lane still flat`);
  else if (charged) fail('a wheel change took money');
  else if (servedAnyway < 8) fail('a wheel change did not report as a stop');
  else console.log('  ok  the lane mends it, free, and says so');
}

// --- 5. what a stop costs in seconds ---------------------------------------
//
// The number that decides whether any of this is a real choice. Too cheap and
// every player pits every lap; too dear and nobody ever does. Measured rather
// than reasoned about: the same car, from the same point, down the lane and
// down the racing line, timed to where the lane rejoins.
console.log('\nWhat a stop costs, against staying on the line:\n');
const costs = [];
for (let i = 0; i < 10; i++) {
  const biome = biomes[i % biomes.length];
  const times = [];
  for (const route of ['lane', 'line']) {
    const sim = makeSim(`pit-${i}`, biome, 400, 2);
    const lane = sim.pit.lane;
    const p = sim.player;
    const path = route === 'lane' ? lane.path : sim.track.path;
    const from = route === 'lane' ? 0 : lane.entryS;
    const start = path.pointAt(from, { x: 0, y: 0, z: 0 });
    const ahead = path.pointAt(from + 6, { x: 0, y: 0, z: 0 });
    p.placeAt({ x: start.x, y: start.y + 0.2, z: start.z,
      yaw: Math.atan2(ahead.x - start.x, ahead.z - start.z), s: lane.entryS });
    // Both start at the limiter's speed, so the comparison is the route rather
    // than who happened to arrive faster.
    p.body.vx = Math.sin(p.body.yaw) * PIT_SPEED_LIMIT;
    p.body.vz = Math.cos(p.body.yaw) * PIT_SPEED_LIMIT;
    p.body.speed = PIT_SPEED_LIMIT;
    sim.track.sample(p.body.x, p.body.z, p.sample);

    let t = 0;
    // Timed to the exit station, which both routes share.
    for (; t < 30; t += DT) {
      const s0 = route === 'lane'
        ? nearestS(path, p.body.x, p.body.z) : (p.sample.s ?? 0);
      chase(p, path, s0, route === 'lane' ? 14 : 32);
      sim.update(DT, null);
      const done = route === 'lane'
        ? nearestS(path, p.body.x, p.body.z) >= path.length - 8
        : (p.sample.s ?? 0) >= lane.exitS - 4;
      if (done) break;
    }
    times.push(t);
  }
  costs.push(times[0] - times[1]);
}
costs.sort((a, b) => a - b);
const med = costs[Math.floor(costs.length / 2)];
// A floor, not the true cost: both cars set off at the limiter's speed, so the
// racing-line car pays the same acceleration the pitting one does. In a race
// you arrive at 200 and the gap is wider than this.
console.log(`  seconds given up for a stop  p50 ${med.toFixed(1)}s`
  + `   range ${costs[0].toFixed(1)}s to ${costs[costs.length - 1].toFixed(1)}s`);
// Not a pass/fail: a design figure, recorded so a change to the limiter or the
// lane's length shows up as a change to the decision rather than silently.
console.log(med < 2 ? '  note  a stop is almost free — nobody will weigh it'
  : med > 12 ? '  note  a stop costs most of a lap — nobody will take it'
    : '  ok  a stop costs a place or two, which is a decision');
if (med < 2 || med > 12) fail(`a stop costs ${med.toFixed(1)}s`);

console.log(problems
  ? `\n${problems} problem(s)`
  : '\nthe pit lane is a lane: slow, optional, and paid for');
process.exit(problems ? 1 : 0);
