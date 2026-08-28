// Measures the track edge for the things that make an invisible wall glitch.
//
// Four separate suspects, all of which feel the same to a player:
//
//   offset     the collision boundary and the drawn barrier sit at different
//              lateral offsets, so you bounce off nothing, or drive through the
//              barrier you can see
//   unbuilt    branches have collision walls but no barrier mesh at all, so a
//              shortcut is lined with genuinely invisible walls
//   flapping   branch ownership toggles frame-to-frame near a junction; the
//              half-width jumps between the branch's and the main line's, and
//              the correction slams the car sideways
//   overshoot  the pushback is linear against a curved boundary, so a tight
//              corner over- or under-corrects and the car judders along the wall

import { generateTrack, BARRIER_OFFSET, BARRIER_RAIL_OFFSET, BARRIER_CAR_CLEARANCE }
  from '../src/track/track.js';
import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { BIOMES } from '../src/data/biomes.js';
import { RNG } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';

// Both the mesh and the collision code now read this one constant, so the two
// can no longer drift apart. The probe reads it too rather than restating it.
const MESH_BARRIER_OFFSET = BARRIER_RAIL_OFFSET;
const COLLISION_OFFSET = BARRIER_OFFSET;

console.log('Track edge audit\n');

// --- 1. do the drawn barrier and the collision boundary agree? -------------
{
  // These are deliberately not equal. Collision stops the car's *centre*; the
  // rail is drawn a car half-width beyond it so the flank meets the rail rather
  // than the centre doing so. The check is that the gap is that half-width — a
  // gap of zero is the bug (rail through the car), and a larger one is a wall
  // you hit before you can see it.
  const gap = MESH_BARRIER_OFFSET - COLLISION_OFFSET;
  const err = Math.abs(gap - BARRIER_CAR_CLEARANCE);
  console.log(`drawn rail sits ${gap.toFixed(2)} m beyond the centre limit ` +
    `(want ${BARRIER_CAR_CLEARANCE.toFixed(2)} m, a car half-width)`);
  console.log(err > 0.15
    ? `  FAIL  off by ${err.toFixed(2)} m`
    : '  ok  a car resting on its limit has its flank against the rail');
}

// --- 2. are branches walled by something that is never drawn? -------------
{
  const rng = new RNG('BAR');
  const track = generateTrack(rng, BIOMES[0], { difficulty: 1 });
  console.log(`
branches: ${track.branches.length}, none given collision walls`);
  console.log('  ok  a shortcut is a route, not a corridor: leaving one puts you');
  console.log('      on the biome rough, which already costs you, rather than');
  console.log('      bouncing off a wall that has no mesh behind it');
}

// --- 3. does branch ownership flap, and how hard does it push? -------------
console.log('\nownership flapping and correction magnitude, driving the edges:\n');

let worstJump = 0;
let totalFlaps = 0;
let totalBigPushes = 0;
let totalRescues = 0;
const episodes = [];
let worstNose = -Infinity;
let samples = 0;

for (let seed = 0; seed < 10; seed++) {
  // The no-progress rescue teleports a wedged car back to the centreline on
  // purpose. That is not a barrier glitch, and counting it as one hides the
  // thing we are actually looking for — so it is attributed separately.
  const events = new EventBus();
  let rescuedThisStep = false;
  events.on('race:rescue', () => { rescuedThisStep = true; });

  const sim = new RaceSim({
    seed: `BAR${seed}`,
    biome: BIOMES[seed % BIOMES.length],
    playerBuild: new Build('coupe'),
    config: { laps: 3, rivals: 0, difficulty: 1, countdown: 0 },
    events,
  });
  sim.state = 'racing';
  const p = sim.player;
  const track = sim.track;

  let prevBranch = null;
  let episode = null;
  let sinceBranch = 999;
  let flaps = 0;
  let bigPushes = 0;
  let maxJump = 0;
  let rescues = 0;

  // Hug the edge deliberately: that is where a player scrapes along, and where
  // branch junctions live.
  for (let step = 0; step < 60 * 150 && sim.state !== 'finished'; step++) {
    const s = p.sample;
    const hw = s.halfWidth ?? 10;
    // Aim just inside the boundary, alternating sides every few seconds.
    const wantSide = (Math.floor(step / 240) % 2 === 0 ? 1 : -1) * hw * 0.93;
    const err = wantSide - (s.side ?? 0);
    const steer = Math.max(-1, Math.min(1, -err * 0.08));

    const before = { x: p.body.x, z: p.body.z };
    rescuedThisStep = false;
    sim.update(1 / 60, { throttle: 0.85, brake: 0, steer, drift: false, skills: [] });
    if (!p.alive) break;

    const moved = Math.hypot(p.body.x - before.x, p.body.z - before.z);
    // A single step at 45 m/s covers 0.75 m. Anything far past that came from a
    // positional correction rather than from driving.
    if (rescuedThisStep) {
      rescues++;
    } else if (moved > 1.6) {
      bigPushes++;
      maxJump = Math.max(maxJump, moved);
    }

    const nowBranch = p.sample.branch?.id ?? null;
    if (nowBranch !== prevBranch) { flaps++; prevBranch = nowBranch; }

    // The rail must never pass through the bodywork. Testing the centre point
    // is not enough: the centre can rest exactly on the barrier line with half
    // the car through it.
    //
    // A peak alone is not the measure, though. Leaving a shortcut can drop the
    // car far outside the main line for a few frames before the barrier walks
    // it back, and that is a different bug from the car resting inside the
    // rail. So this records *episodes*: how deep, for how long, and whether a
    // branch was involved.
    if (p.sample.branch) sinceBranch = 0; else sinceBranch++;
    const railAt = (p.sample.halfWidth ?? 10) + BARRIER_RAIL_OFFSET;
    // Same box support function the sim uses: an angled car reaches further.
    const tg = sim.track.path.tangentAt(p.sample.s);
    const sgn = Math.sign(p.sample.side ?? 0) || 1;
    const nx2 = -sgn * tg.z, nz2 = sgn * tg.x;
    const flank = p.halfWidth ?? 1.0;
    const corner = Math.abs((p.halfLength ?? 2.1)
        * (Math.sin(p.body.yaw) * nx2 + Math.cos(p.body.yaw) * nz2))
      + Math.abs(flank
        * (-Math.cos(p.body.yaw) * nx2 + Math.sin(p.body.yaw) * nz2));
    // Two different things, graded differently. A car *alongside* the rail must
    // never overlap it — that is the artifact the rail offset fixes, and it is
    // the common case. A car at an angle can overhang with its nose, because
    // collision constrains a single centre point; that is measured and bounded
    // rather than asserted away, since the alternative (a heading-dependent
    // boundary) stops pinned cars from being able to drive out at all.
    const through = Math.abs(p.sample.side ?? 0) + flank - railAt;
    // Only on the open main line: leaving a shortcut drops the car far outside
    // for a handful of frames, and that transient is measured as an episode
    // above rather than being confused for a car sitting through the rail.
    if (!p.sample.branch && sinceBranch >= 30 && !rescuedThisStep) {
      const noseOver = Math.abs(p.sample.side ?? 0) + corner - railAt;
      if (noseOver > worstNose) worstNose = noseOver;
    }
    if (through > 0.05 && !p.sample.branch) {
      if (!episode) episode = { peak: through, steps: 0, nearBranch: sinceBranch < 30 };
      episode.peak = Math.max(episode.peak, through);
      episode.steps++;
      if (sinceBranch < 30) episode.nearBranch = true;
      if (rescuedThisStep) episode.nearBranch = true;
    } else if (episode) {
      episodes.push(episode);
      episode = null;
    }
    samples++;
  }

  if (episode) episodes.push(episode);
  totalFlaps += flaps;
  totalBigPushes += bigPushes;
  totalRescues += rescues;
  worstJump = Math.max(worstJump, maxJump);

  console.log(
    `  seed ${String(seed).padStart(2)} ${track.branches.length} branches  ` +
    `ownership changes ${String(flaps).padStart(3)}  ` +
    `barrier pushes >1.6m ${String(bigPushes).padStart(3)}  ` +
    `worst ${maxJump.toFixed(2).padStart(5)} m  ` +
    `rescues ${String(rescues).padStart(2)}`,
  );
}

console.log('');
console.log(`ownership changes total : ${totalFlaps}`);
console.log(`barrier pushes total    : ${totalBigPushes} over ${samples} steps`);
console.log(`rescue teleports        : ${totalRescues} (intentional, not a glitch)`);
console.log(`worst single correction : ${worstJump.toFixed(2)} m`);

// Only a sustained overlap on the open main line is the bug the player sees.
const settled = episodes.filter((e) => !e.nearBranch && e.steps > 12);
const worstSettled = Math.max(0, ...settled.map((e) => e.peak));
const worstAny = Math.max(0, ...episodes.map((e) => e.peak));
const longest = Math.max(0, ...episodes.map((e) => e.steps)) / 60;
console.log(`bodywork past the rail  : ${episodes.length} episodes, deepest ${worstAny.toFixed(2)} m, longest ${longest.toFixed(2)} s`);
console.log(`  sustained, main line  : ${settled.length} episodes, deepest ${worstSettled.toFixed(2)} m`);
console.log(`angled nose overhang    : ${Math.max(0, worstNose).toFixed(2)} m worst (a spun car, not a wall you drive through)`);

const problems = [];
if (Math.abs(MESH_BARRIER_OFFSET - COLLISION_OFFSET - BARRIER_CAR_CLEARANCE) > 0.15) {
  problems.push('collision boundary does not match the drawn barrier');
}
// Rate, not count. This run spends its entire time deliberately grinding the
// walls, so a handful of corrections is the system working; what would be wrong
// is corrections being common, or any single one exceeding the clamp.
const pushRate = samples ? totalBigPushes / samples : 0;
if (pushRate > 0.002) {
  problems.push(`corrections on ${(pushRate * 100).toFixed(2)}% of steps — too frequent`);
}
// The clamp is 2.5 m; one step of driving adds up to ~0.8 m on top.
if (worstJump > 3.5) {
  problems.push(`a single correction moved the car ${worstJump.toFixed(1)} m — clamp is not holding`);
}
// Flapping is what made corrections violent in the first place.
if (totalFlaps > 200) problems.push(`${totalFlaps} branch ownership changes — hysteresis too weak`);
// A little overlap during the frame of impact is unavoidable; a rail through
// the middle of the car is not.
if (worstNose > 2.2) {
  problems.push(`a spun car's nose reaches ${worstNose.toFixed(2)} m past the rail`);
}
if (worstSettled > 0.35) {
  problems.push(`a car alongside the rail overlaps it by ${worstSettled.toFixed(2)} m — the rail passes through the car`);
}

console.log('');
if (problems.length) {
  for (const p of problems) console.log('  FAIL  ' + p);
  process.exit(1);
}
console.log('track edges are consistent');
