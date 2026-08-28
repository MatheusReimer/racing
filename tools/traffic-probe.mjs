// Is traffic a hazard you read, or a coin flip?
//
// The distinction is the whole reason traffic was allowed back onto a racing
// surface that had just been cleared of obstacles. A hazard you read is
// avoidable by a driver paying attention and pays out when threaded; a coin
// flip is a tax with extra steps. These are different measurements, so the
// probe takes both:
//
//   - can a competent line get round a lap without contact?
//   - does threading it actually pay the nitrous it is supposed to?
//   - is it survivable — does a race still finish?
//   - does traffic stay on the road and out of the grid?

import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { BIOMES } from '../src/data/biomes.js';
import { EventBus } from '../src/core/events.js';

const DT = 1 / 60;
let problems = 0;

console.log('Traffic\n');

// --- 1. density per biome --------------------------------------------------
console.log('cars on circuit, by district:\n');
for (const biome of BIOMES) {
  const sim = new RaceSim({
    seed: `TR:${biome.id}`,
    biome,
    playerBuild: new Build('rotary'),
    config: { laps: 2, rivals: 0, difficulty: 1, countdown: 0 },
  });
  const n = sim.traffic.length;
  const onc = sim.traffic.filter((c) => c.dir < 0).length;
  const perKm = n / (sim.track.length / 1000);
  console.log(`  ${biome.id.padEnd(11)} ${String(n).padStart(3)} cars  `
    + `${String(onc).padStart(2)} oncoming  ${perKm.toFixed(1)}/km  `
    + `(density ${biome.traffic ?? 0})`);
  if ((biome.traffic ?? 0) > 0 && n === 0) {
    console.log('    FAIL  district wants traffic and has none');
    problems++;
  }
  if ((biome.traffic ?? 0) === 0 && n > 0) {
    console.log('    FAIL  district wants no traffic and has some');
    problems++;
  }
}

// --- 2. does it stay on the road, and off the grid? ------------------------
{
  console.log('\nplacement:\n');
  let offRoad = 0;
  let onGrid = 0;
  let samples = 0;
  const sim = new RaceSim({
    seed: 'TR:place',
    biome: BIOMES.find((b) => b.id === 'downtown'),
    playerBuild: new Build('rotary'),
    config: { laps: 2, rivals: 0, difficulty: 1, countdown: 0 },
  });
  sim.state = 'racing';

  for (let slot = 0; slot < 6; slot++) {
    const pose = sim.track.startPose(slot, 6);
    for (const c of sim.traffic) {
      const p = sim.track.path.offsetPoint(c.s, c.lane * sim.track.halfWidthAt(c.s),
        { x: 0, y: 0, z: 0 });
      if (Math.hypot(p.x - pose.x, p.z - pose.z) < 8) onGrid++;
    }
  }

  for (let i = 0; i < 60 * 60; i++) {
    sim.update(DT, { throttle: 0.9, brake: 0, steer: 0, drift: false, nos: false, skills: [] });
    if (i % 20) continue;
    for (const c of sim.traffic) {
      const hw = sim.track.halfWidthAt(c.s);
      if (Math.abs(c.lane * hw + c.lateralPush) > hw) offRoad++;
      samples++;
    }
  }
  console.log(`  on the starting grid : ${onGrid}`);
  console.log(`  outside the road     : ${offRoad} of ${samples} samples`);
  if (onGrid > 0) { console.log('  FAIL  traffic parked on the grid'); problems++; }
  if (offRoad / Math.max(1, samples) > 0.02) {
    console.log('  FAIL  traffic wanders off the racing surface');
    problems++;
  }
}

// --- 3. avoidable, and does threading it pay? ------------------------------
{
  console.log('\nan attentive lap vs a blind one:\n');

  const run = (avoid, seed) => {
    const sim = new RaceSim({
      seed,
      biome: BIOMES.find((b) => b.id === 'downtown'),
      playerBuild: new Build('rotary'),
      config: { laps: 2, rivals: 0, difficulty: 1, countdown: 0 },
    });
    sim.state = 'racing';
    const p = sim.player;
    let hits = 0;
    let misses = 0;
    let trafficDamage = 0;
    sim.onTrafficHit = (racer, car, closing) => {
      hits++;
      trafficDamage += 2 + closing * 0.26;
    };
    const bus = new EventBus();
    sim.events = bus;
    bus.on('race:nearmiss', () => { misses++; });

    // Start the bottle empty. Measuring "nitrous earned" from a full bottle
    // reports zero however much is awarded, because every gain is clamped away
    // — the number looked like a broken reward and was a broken measurement.
    p.nos = 0;
    let nosGained = 0;
    let prevNos = p.nos;

    for (let i = 0; i < 60 * 120 && sim.state !== 'finished'; i++) {
      const sm = p.sample;
      const trackYaw = sim.track.path.yawAt(p.trackS);
      const dy = ((p.body.yaw - trackYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      let want = 0;

      if (avoid) {
        // Score the road across its width and drive at the clearest column,
        // looking at everything within reach rather than only the nearest car.
        // A reader that commits to a full-width swerve for one car drives
        // straight into the next one.
        const hw = sim.track.halfWidthAt(p.trackS);
        let bestScore = -Infinity;
        for (let k = -3; k <= 3; k++) {
          const cand = (k / 3) * hw * 0.8;
          let score = -Math.abs(cand - (sm.side ?? 0)) * 0.02;
          for (const c of sim.traffic) {
            const ahead = sim.track.path.deltaAlong(p.trackS, c.s);
            if (ahead < -4 || ahead > 70) continue;
            const theirSide = c.lane * sim.track.halfWidthAt(c.s);
            const gap = Math.abs(cand - theirSide);
            const urgency = 1 - Math.min(1, Math.max(0, ahead) / 70);
            if (gap < 4.5) score -= (4.5 - gap) * urgency * 3;
          }
          if (score > bestScore) { bestScore = score; want = cand; }
        }
      }

      const err = want - (sm.side ?? 0);
      const steer = Math.max(-1, Math.min(1, dy * 1.6 - err * 0.05));
      sim.update(DT, { throttle: 0.85, brake: 0, steer, drift: false, nos: false, skills: [] });

      if (p.nos > prevNos) nosGained += p.nos - prevNos;
      prevNos = p.nos;
      if (!p.alive) break;
    }
    return { hits, misses, nosGained, trafficDamage, alive: p.alive, dur: p.durability, maxDur: p.maxDurability };
  };

  // Averaged over several circuits, not measured on one.
  //
  // A single track put one hit against one hit, which distinguishes nothing:
  // the verdict then flipped whenever unrelated scenery changed the driven
  // line. The claim being tested is "reading traffic helps on average", so the
  // measurement has to be an average.
  const SEEDS = 8;
  const blind = { hits: 0, misses: 0, nosGained: 0, dmg: 0, worstDmg: 0 };
  const aware = { hits: 0, misses: 0, nosGained: 0, dmg: 0, worstDmg: 0 };
  let maxDur = 0;
  for (let i = 0; i < SEEDS; i++) {
    const b = run(false, `TR:drive${i}`);
    const a = run(true, `TR:drive${i}`);
    maxDur = Math.max(maxDur, b.maxDur ?? 0);
    for (const [acc, r] of [[blind, b], [aware, a]]) {
      acc.hits += r.hits;
      acc.misses += r.misses;
      acc.nosGained += r.nosGained;
      acc.dmg += r.trafficDamage;
      acc.worstDmg = Math.max(acc.worstDmg, r.trafficDamage);
    }
  }

  console.log(`  driving the centreline blind : ${blind.hits} hits, ${blind.misses} near misses`);
  console.log(`  reading it and taking the gap: ${aware.hits} hits, ${aware.misses} near misses`);
  console.log(`  (over ${SEEDS} circuits)`);
  console.log(`  nitrous earned by threading  : `
    + `${(aware.nosGained / SEEDS * 100).toFixed(0)}% of a bottle per race`);

  if (aware.hits >= blind.hits && blind.hits > 0) {
    console.log('  FAIL  reading the traffic does not help — it is a coin flip, not a hazard');
    problems++;
  } else {
    console.log('  ok  paying attention is rewarded');
  }
  if (aware.misses === 0) {
    console.log('  FAIL  threading traffic never registers as a near miss');
    problems++;
  }
  // Attributed, not inferred. The previous version failed on `!alive`, which
  // also counts a car that smashed its way through the scenery — the message
  // said "by traffic alone" and the measurement could not tell.
  const worstFrac = aware.worstDmg / Math.max(1, maxDur);
  console.log(`  worst race's traffic damage  : ${aware.worstDmg.toFixed(0)} `
    + `of ${maxDur.toFixed(0)} durability (${(worstFrac * 100).toFixed(0)}%)`);
  if (worstFrac > 0.6) {
    console.log('  FAIL  traffic alone can take most of a car in one race');
    problems++;
  } else {
    console.log('  ok  traffic costs races, not runs');
  }
}

// --- 4. races still finish -------------------------------------------------
{
  console.log('\nfull races with a field, in the city:\n');
  let finished = 0;
  let timedOut = 0;
  let totalHits = 0;

  for (let seed = 0; seed < 6; seed++) {
    const sim = new RaceSim({
      seed: `TR:race${seed}`,
      biome: BIOMES.find((b) => b.id === 'downtown'),
      playerBuild: new Build('rotary'),
      config: { laps: 2, rivals: 5, difficulty: 1, countdown: 0 },
    });
    sim.state = 'racing';
    sim.autopilot = true;
    sim.setAutopilot?.(true, 1);
    let hits = 0;
    sim.onTrafficHit = () => { hits++; };

    let steps = 0;
    for (; steps < 60 * 300 && sim.state !== 'finished'; steps++) {
      sim.update(DT, { throttle: 0, brake: 0, steer: 0, drift: false, nos: false, skills: [] });
    }
    totalHits += hits;
    if (sim.state === 'finished') finished++; else timedOut++;
  }
  console.log(`  finished ${finished}/6, timed out ${timedOut}/6`);
  console.log(`  traffic contacts across all six: ${totalHits}`);
  if (timedOut > 1) {
    console.log('  FAIL  traffic is stopping races from finishing');
    problems++;
  } else {
    console.log('  ok  the field still gets home');
  }
}

// --- and you cannot drive through it ---------------------------------------
//
// The hit cooldown used to skip the entire contact rather than only what it
// cost, so for eight tenths of a second after touching one car you passed clean
// through the next. Traffic arrives in groups, so that was most of the time
// anyone spent in it, and it is exactly what "sometimes I go straight through
// them" was. Two cars in a row is the case that failed.
{
  const { stepTraffic } = await import('../src/race/traffic.js');
  const racer = {
    alive: true, finished: false, halfWidth: 0.95, _trafficCd: 0,
    body: {
      x: 0, z: 0, vx: 0, vz: 45, yawRate: 0, speed: 45,
      gripPenalty: 1, gripPenaltyTimer: 0, jolt() {},
    },
    awardNearMiss() {},
  };
  // Two civilians dead ahead, one right behind the other.
  // `stepTraffic` derives x and z from `s`, so that is what a car is placed by.
  const mk = (z) => ({ alive: true, s: z, x: 0, y: 0, z, yaw: 0, dir: 1, speed: 20,
    lane: 0, lateralPush: 0, _missCd: 0 });
  const cars = [mk(30), mk(38)];
  racer.body.z = 0;
  const track = { length: 1000, halfWidthAt: () => 10, path: {
    offsetPoint: (s, l, o) => { o.x = l; o.y = 0; o.z = s; return o; },
    yawAt: () => 0,
  } };

  let deepest = 0;
  for (let i = 0; i < 400; i++) {
    stepTraffic(cars, track, [racer], DT, {});
    racer.body.z += racer.body.vz * DT;
    for (const c of cars) {
      const d = Math.hypot(racer.body.x - c.x, racer.body.z - c.z);
      deepest = Math.max(deepest, (2.6 + racer.halfWidth) - d);
    }
  }
  // A metre and a bit. At forty-five metres a second a car covers three
  // quarters of a metre between steps, so it is always slightly inside a
  // civilian before anything can push it out — that is discrete time, not a
  // fault. Driving *through* one looks completely different: with the contact
  // being skipped this measured 3.52 m, which is the whole hit radius, and with
  // it fixed it measures 0.63.
  const bad = deepest > 1.2;
  if (bad) problems++;
  console.log(`\n  two civilians in a row, driven into at 45 m/s`.padEnd(50)
    + `deepest ${deepest.toFixed(2)} m inside  ${bad ? 'FAIL — drove through one' : 'ok'}`);
}

console.log('');
if (problems) {
  console.log(`${problems} problem(s) with traffic`);
  process.exitCode = 1;
} else {
  console.log('traffic is a hazard to read, not a toll to pay');
}
