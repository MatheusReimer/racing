// Hunts loss-of-control: a state where the player presses throttle, brake and
// steering and none of them do anything.
//
// Total input death has only a few possible causes, and they are worth
// distinguishing rather than guessing between:
//
//   stunned      `body.stunTimer > 0` zeroes throttle, brake and steer at once
//   NaN          one bad number poisons position and every input looks inert
//   finished     `RaceSim.update` returns early; the whole car freezes
//   disabled     `Input.enabled === false`
//   sideways     the car is sliding at speed with almost no forward component.
//                Throttle and brake act on `vFwd` only, so with the car pointing
//                across its own motion both are near-useless, and steering is
//                separately killed by the slip-saturation term. Nothing is
//                broken, but it feels identical to a frozen car.
//
// Runs in plain Node against RaceSim so it can cover long races quickly, and
// reports which cause fired.

import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { BIOMES } from '../src/data/biomes.js';
import { instantiateSkill } from '../src/data/skills.js';

const DT = 1 / 60;
const SEEDS = Number(process.argv[2] || 12);

// Every loss-of-control episode, by cause and duration, using the same
// `controlState()` the HUD now shows the player.
const episodes = new Map();
const record = (id, dur, ctx) => {
  let e = episodes.get(id);
  if (!e) { e = { id, count: 0, total: 0, worst: 0, samples: [] }; episodes.set(id, e); }
  e.count++;
  e.total += dur;
  if (dur > e.worst) { e.worst = dur; e.sample = ctx; }
};

// Several driving styles, because the failure the player reports may only
// appear under one of them.
const STYLES = [
  { name: 'flat out', input: (t) => ({ throttle: 1, brake: 0, steer: Math.sin(t * 0.5) * 0.7, drift: false }) },
  { name: 'full lock', input: (t) => ({ throttle: 1, brake: 0, steer: Math.sign(Math.sin(t * 0.35)), drift: false }) },
  { name: 'drift held', input: (t) => ({ throttle: 1, brake: 0, steer: Math.sign(Math.sin(t * 0.4)) * 0.9, drift: true }) },
  { name: 'stab brake', input: (t) => ({ throttle: Math.sin(t * 2) > -0.3 ? 1 : 0, brake: Math.sin(t * 2) > -0.3 ? 0 : 1, steer: Math.sin(t * 0.6) * 0.8, drift: false }) },
];

for (let i = 0; i < SEEDS; i++) {
  const biome = BIOMES[i % BIOMES.length];
  const style = STYLES[i % STYLES.length];

  const build = new Build('rotary');
  build.addSkill(instantiateSkill('nitro', 4));

  const sim = new RaceSim({
    seed: `CTRL${i}`, biome, playerBuild: build,
    // Disruptors and bombers, because oil slicks and EMPs are exactly the
    // things that take control away.
    config: {
      laps: 3, rivals: 5, difficulty: 2, countdown: 0,
      rivalArchetypes: ['disruptor', 'bomber', 'hunter', 'disruptor', 'racer'],
    },
  });
  sim.state = 'racing';
  const p = sim.player;

  let open = null;
  let t = 0;

  for (let step = 0; step < 60 * 220 && sim.state !== 'finished'; step++) {
    t += DT;
    sim.update(DT, { ...style.input(t), skills: [] });
    if (!p.alive) break;

    const cs = p.controlState(null);
    // Being off the road while still driving is a mistake, not a loss of
    // control. Only count it when the car is also barely moving.
    const id = cs && !(cs.id === 'off' && p.body.speed > 8) ? cs.id : null;

    if (open && open.id !== id) {
      if (open.dur > 0.6) record(open.id, open.dur, open.ctx);
      open = null;
    }
    if (id) {
      if (!open) {
        open = {
          id,
          dur: 0,
          ctx: {
            style: style.name,
            biome: biome.id,
            kmh: Math.round(p.body.speed * 3.6),
            slip: Math.round(Math.abs(p.body.slipAngle) * 57.3),
            grip: p.body.gripPenalty.toFixed(2),
            surface: p.body.surface?.id,
          },
        };
      }
      open.dur += DT;
    }
  }
  if (open && open.dur > 0.6) record(open.id, open.dur, open.ctx);
}

console.log(`Loss-of-control episodes over ${SEEDS} races, four driving styles
`);
console.log('cause      count  total(s)  worst(s)   worst case');
console.log('-'.repeat(78));

const rows = [...episodes.values()].sort((a, b) => b.total - a.total);
for (const e of rows) {
  const c = e.sample || {};
  console.log(
    `${e.id.padEnd(10)} ${String(e.count).padStart(5)} ${e.total.toFixed(1).padStart(9)} ` +
    `${e.worst.toFixed(1).padStart(9)}   ${(c.style || '').padEnd(11)} ` +
    `${String(c.kmh).padStart(3)}km/h slip ${String(c.slip).padStart(2)}deg ` +
    `grip ${c.grip} ${c.surface ?? ''}`,
  );
}

const worstAny = rows.reduce((a, b) => (a && a.worst > b.worst ? a : b), null);
console.log('');
if (worstAny) {
  console.log(`longest single episode: ${worstAny.worst.toFixed(1)}s of "${worstAny.id}"`);
}

const problems = [];
const spin = episodes.get('spin');
if (spin && spin.worst > 4) {
  problems.push(`a spin lasted ${spin.worst.toFixed(1)}s — long enough to read as broken controls`);
}
const nogrip = episodes.get('nogrip');
if (nogrip && nogrip.worst > 6) {
  problems.push(`grip loss lasted ${nogrip.worst.toFixed(1)}s`);
}
if (episodes.get('slowmo')) problems.push('simulation fell behind real time');

if (problems.length) {
  console.log('');
  for (const p of problems) console.log('  FAIL  ' + p);
  process.exitCode = 1;
} else {
  console.log('no loss-of-control episode outlasts what the player can recover from');
}

// --- the actual complaint, measured directly --------------------------------
//
// "I hold the accelerator and nothing happens." Being off track at speed is not
// that; nor is being slow while holding full lock into a wall, which no player
// sustains. The question that matters is whether you can *recover* — so this
// pins the car against the barrier, then straightens up and measures how long
// it takes to be driving again.
//
// The old barrier friction was `v *= 0.94` per frame, so the car was scrubbed
// to a standstill and held there indefinitely: recovery never came, and with
// steering authority scaling from a speed near zero, nothing the player did
// registered.
{
  let worstRecovery = 0;
  let neverRecovered = 0;
  let worstCtx = null;

  for (let i = 0; i < 12; i++) {
    const biome = BIOMES[i % BIOMES.length];
    const sim = new RaceSim({
      seed: `PIN${i}`, biome, playerBuild: new Build('rotary'),
      config: { laps: 5, rivals: 0, difficulty: 1, countdown: 0 },
    });
    sim.state = 'racing';
    const p = sim.player;

    // Get up to speed.
    for (let k = 0; k < 60 * 8; k++) {
      sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false, skills: [] });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      // Bury it in the barrier for two seconds.
      for (let k = 0; k < 60 * 2; k++) {
        const toward = Math.sign(p.sample.side ?? 1) || 1;
        sim.update(DT, { throttle: 1, brake: 0, steer: toward, drift: false, skills: [] });
      }
      const pinnedKmh = p.body.speed * 3.6;

      // Now drive like a person who read the HUD: reverse out if wedged,
      // otherwise straighten toward the racing line and accelerate.
      let t = 0;
      let recovered = false;
      for (let k = 0; k < 60 * 15; k++) {
        const s2 = p.sample;
        const cs = p.controlState(null, sim.track);
        // Full lock away from the wall, aimed back along the track — what a
        // person actually does, rather than a polite 55%.
        const trackYaw = sim.track.path.yawAt(p.trackS);
        let dy = ((p.body.yaw - trackYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const away = Math.max(-1, Math.min(1, dy * 2.5));
        // Reversing inverts steering, as it does in a real car, so back out
        // straight rather than fighting the wheel.
        const input = cs && cs.id === 'wedged'
          ? { throttle: 0, brake: 1, steer: 0, drift: false, skills: [] }
          : { throttle: 1, brake: 0, steer: away, drift: false, skills: [] };
        sim.update(DT, input);
        t += DT;
        if (p.body.speed > 20 && p.sample.onTrack !== false) { recovered = true; break; }
      }
      if (!recovered) {
        neverRecovered++;
        t = 15;
      }
      if (t > worstRecovery) {
        worstRecovery = t;
        worstCtx = {
          biome: biome.id,
          pinned: Math.round(pinnedKmh),
          now: Math.round(p.body.speed * 3.6),
          surface: p.body.surface?.id,
        };
      }
    }
  }

  console.log('');
  console.log('Pinned against the barrier, then driving away:');
  console.log(`  slowest recovery to 72 km/h on track : ${worstRecovery.toFixed(1)}s`);
  console.log(`  never recovered in 12s      : ${neverRecovered}`);
  if (worstCtx) {
    console.log(`  worst case                  : ${worstCtx.biome}, pinned at ` +
      `${worstCtx.pinned} km/h on ${worstCtx.surface}`);
  }

  // Recovery by any means counts, including the stuck rescue: the guarantee
  // the game makes is that you always get back to racing, not that you never
  // need help doing it.
  if (neverRecovered > 0) {
    console.log(`
  FAIL  ${neverRecovered} car(s) never got back to racing in 15s`);
    process.exitCode = 1;
  } else {
    console.log('  every pinned car got back to racing, by driving out or by rescue');
  }
}

// --- the grid must not move before the lights go out ----------------------
// In this model the brake becomes reverse once the car is stationary (that is
// what the S key is for), so holding the field on the brake through the
// countdown drove every car backwards off the grid.
{
  let worst = 0;
  for (let i = 0; i < 12; i++) {
    const sim = new RaceSim({
      seed: `GRID${i}`, biome: BIOMES[i % BIOMES.length],
      playerBuild: new Build('coupe'),
      config: { laps: 2, rivals: 5, difficulty: 1 },
    });
    const start = sim.racers.map((r) => ({ x: r.body.x, z: r.body.z }));
    const steps = Math.ceil(sim.config.countdown / DT) - 2;
    for (let k = 0; k < steps; k++) {
      // Everything mashed at once, which is what a player does on the grid.
      sim.update(DT, { throttle: 1, brake: 1, steer: 1, drift: true, skills: [] });
    }
    sim.racers.forEach((r, j) => {
      worst = Math.max(worst, Math.hypot(r.body.x - start[j].x, r.body.z - start[j].z));
    });
  }
  console.log(`
grid drift during countdown: ${worst.toFixed(3)} m ` +
    (worst < 0.05 ? '(holds)' : '(MOVES BEFORE THE START)'));
  if (worst >= 0.05) process.exitCode = 1;
}

// --- the wheels stay on the road ------------------------------------------
//
// Airborne cuts grip to 5% and the yaw ceiling to 18%, so a car that is
// wrongly flagged airborne has quietly stopped answering the controls. The
// contact test once used a 1 mm tolerance, which any downgrade clears — at
// 40 m/s a 2% grade drops the surface 13 mm per step — and the car spent 12%
// of an ordinary lap "in flight" with a worst gap of five centimetres.
//
// Nothing calls `launch()` yet, so on current tracks the correct answer is
// zero. When ramps arrive this becomes the check that they are the *only*
// thing that lifts the car.
{
  let worstPct = 0;
  let worstGap = 0;
  for (const seed of ['AIR1', 'AIR2', 'AIR3']) {
    const sim = new RaceSim({
      seed, biome: BIOMES[0], playerBuild: new Build('rotary'),
      config: { laps: 2, rivals: 0, difficulty: 1, countdown: 0 },
    });
    sim.state = 'racing';
    const p = sim.player;
    let air = 0, steps = 0;
    for (let i = 0; i < 60 * 90 && sim.state !== 'finished'; i++) {
      // Follow the road: driving into the scenery makes the figure meaningless.
      const trackYaw = sim.track.path.yawAt(p.trackS);
      const dy = ((p.body.yaw - trackYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const steer = Math.max(-1, Math.min(1, dy * 1.6 + (p.sample.side ?? 0) * 0.05));
      sim.update(DT, { throttle: 0.9, brake: 0, steer, drift: false, skills: [] });
      if (p.body.airborne) air++;
      worstGap = Math.max(worstGap, p.body.y - (p.sample.groundY ?? 0));
      steps++;
    }
    worstPct = Math.max(worstPct, (air / steps) * 100);
  }
  console.log(`
airborne while driving the line: ${worstPct.toFixed(1)}% of the time, ` +
    `worst gap ${(worstGap * 1000).toFixed(0)} mm`);
  if (worstPct > 1) {
    console.log(`
  FAIL  the car is flagged airborne on ordinary terrain — grip drops to 5% ` +
      'and the yaw ceiling to 18% for no reason the player can see');
    process.exitCode = 1;
  } else {
    console.log('  ok  only a real launch takes the wheels off the road');
  }
}
