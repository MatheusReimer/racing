// Slipstream.
//
// Three things have to be true of a tow, and none of them can be checked by
// driving around and feeling it: that being behind a car is measurably faster
// than being alone, that it is not so much faster that leading becomes a
// mistake, and that it only happens when you are actually behind something —
// not beside it, not passing it head-on, not a hundred metres back.

import { VehicleBody } from '../src/vehicle/physics.js';
import { StatBlock } from '../src/stats/statblock.js';
import { baseStats } from '../src/stats/attributes.js';

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${detail}`);
};

const phys = () => new StatBlock(baseStats()).physics();

/** Flat out from a standstill for `seconds`, with a fixed draft. */
function runFlatOut(draft, seconds) {
  const b = new VehicleBody(phys());
  const input = { throttle: 1, brake: 0, steer: 0, drift: false, nos: false };
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) {
    b.draft = draft;
    b.step(dt, input, undefined, 0);
  }
  return b.speed;
}

console.log('A tow is worth having, and only where a tow exists\n');

// --- it is faster, and by a knowable amount --------------------------------
{
  const alone = runFlatOut(0, 40);
  const towed = runFlatOut(1, 40);
  const gain = (towed / alone - 1) * 100;
  check('sitting in the wake is faster at the top end', gain > 3,
    `${(alone * 3.6).toFixed(1)} -> ${(towed * 3.6).toFixed(1)} km/h, +${gain.toFixed(1)}%`);
  // A tow big enough to beat a clean lap turns a race into a queue nobody
  // wants to be at the front of.
  check('and not so much faster that leading is a mistake', gain < 12,
    `+${gain.toFixed(1)}%`);
}

// --- and it closes a gap, which is the point --------------------------------
{
  // Two identical cars, both flat out, the follower towed. Over a long straight
  // the follower should reel the leader in.
  const lead = new VehicleBody(phys());
  const chase = new VehicleBody(phys());
  const input = { throttle: 1, brake: 0, steer: 0, drift: false, nos: false };
  const dt = 1 / 60;
  // Settle both to speed first, then start the clock on a 10 m gap.
  for (let i = 0; i < 40 * 60; i++) {
    lead.draft = 0; chase.draft = 0;
    lead.step(dt, input, undefined, 0);
    chase.step(dt, input, undefined, 0);
  }
  let gap = 10;
  for (let i = 0; i < 12 * 60; i++) {
    lead.draft = 0;
    chase.draft = 1;
    lead.step(dt, input, undefined, 0);
    chase.step(dt, input, undefined, 0);
    gap -= (chase.speed - lead.speed) * dt;
  }
  check('a towed car reels the one in front in', gap < 8,
    `10.0 m -> ${gap.toFixed(1)} m over twelve seconds`);
}

// --- the wake is where the wake is ------------------------------------------
{
  const { RaceSim } = await import('../src/race/sim.js');
  const { Build } = await import('../src/build/build.js');
  const { EventBus } = await import('../src/core/events.js');
  const { BIOMES } = await import('../src/data/biomes.js');

  const sim = new RaceSim({
    seed: 'draft', biome: BIOMES[0], playerBuild: new Build('coupe'),
    events: new EventBus(), config: { laps: 1, rivals: 1, difficulty: 1 },
  });
  const [me, them] = sim.racers;

  // Place `them` relative to `me` and ask the simulation who is towing whom.
  const place = (along, across, facing = 1) => {
    const b = me.body;
    // From clean air each time. The tow eases in and out, so a case measured
    // straight after a full tow is measuring the decay, not the geometry —
    // which is what the first version of this did, and it read 0.13 for a car
    // six metres to one side.
    b.draft = 0;
    b.x = 0; b.z = 0; b.yaw = 0; b.speed = 60; b.forwardSpeed = 60;
    const t = them.body;
    t.x = b.forwardX * along + b.rightX * across;
    t.z = b.forwardZ * along + b.rightZ * across;
    t.yaw = facing > 0 ? 0 : Math.PI;
    t.speed = 60; t.forwardSpeed = 60;
    // A whole second of wake, so the easing has settled.
    for (let i = 0; i < 60; i++) sim._updateDraft(1 / 60);
    return b.draft;
  };

  const behind = place(9, 0);
  const wide = place(9, 6.0);
  const far = place(60, 0);
  const beside = place(0.5, 2.6);
  const oncoming = place(9, 0, -1);
  const ahead = place(-9, 0);

  check('right behind is a full tow', behind > 0.7, behind.toFixed(2));
  check('a lane and a half across is clean air', wide < 0.05, wide.toFixed(2));
  check('sixty metres back is clean air', far < 0.05, far.toFixed(2));
  check('alongside is not a tow', beside < 0.35, beside.toFixed(2));
  check('an oncoming car does not tow you', oncoming < 0.05, oncoming.toFixed(2));
  check('and neither does one you have passed', ahead < 0.05, ahead.toFixed(2));

  // And the easing itself, which the geometry cases deliberately step around.
  place(9, 0);
  const held = me.body.draft;
  const them2 = them.body;
  them2.x = 400; them2.z = 400;          // gone
  for (let i = 0; i < 30; i++) sim._updateDraft(1 / 60);
  const halfSecond = me.body.draft;
  check('the tow lets go over about a second, not instantly',
    halfSecond < held * 0.55 && halfSecond > 0.02,
    `${held.toFixed(2)} -> ${halfSecond.toFixed(2)} after half a second`);
}

console.log(fails ? `\n${fails} problem(s) with the slipstream`
  : '\nfollowing is faster, leading is still worth it');
process.exit(fails ? 1 : 0);
