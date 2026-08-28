// Does the car drive like Underground?
//
// "It feels bad" is not actionable, so this turns the feel into numbers that can
// be tuned against. Four things separate an arcade racer from a simulator, and
// all four are measurable:
//
//   1. How tight a corner can it hold at speed, and how much does it have to
//      slow for a city 90? In Underground you brake once and commit; if the
//      answer is "to 70 km/h" the district is a series of pauses.
//   2. Does it go where it is pointed? Big slip angles under normal cornering
//      mean the car argues with the wheel.
//   3. How fast does it change direction? Turn-in delay is what reads as heavy.
//   4. Does the handbrake actually rotate it?

import { VehicleBody, SURFACES } from '../src/vehicle/physics.js';
import { Build } from '../src/build/build.js';

const DT = 1 / 60;
let problems = 0;

function make(id = 'coupe') {
  const b = new Build(id);
  const body = new VehicleBody(b.physics);
  body.place(0, 0, 0);
  return body;
}

function drive(body, input, seconds, surface = SURFACES.road) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) body.step(DT, input, surface, 0);
  return body;
}

console.log('Handling\n');

// --- 1. the tightest circle it will hold, by speed --------------------------
{
  console.log('steady-state cornering (full lock, held):\n');
  console.log('  entry km/h   settles at   radius    lateral g');
  for (const kmh of [60, 90, 120, 160, 200]) {
    const body = make();
    body.vx = 0;
    body.vz = kmh / 3.6;
    // Let it settle into a steady turn.
    drive(body, { throttle: 0.55, brake: 0, steer: 1, drift: false }, 4);
    const speed = body.speed;
    const omega = Math.abs(body.yawRate);
    const radius = omega > 1e-4 ? speed / omega : Infinity;
    const g = (speed * omega) / 9.81;
    console.log(`  ${String(kmh).padStart(9)}   ${(speed * 3.6).toFixed(0).padStart(7)}   `
      + `${radius.toFixed(1).padStart(6)}m   ${g.toFixed(2).padStart(6)}`);
  }
}

// --- 2. a city 90 --------------------------------------------------------
//
// The corner the district is actually built from: a 26 m fillet. The question
// is the highest entry speed from which the car still makes it round without
// leaving a 17 m street.
{
  console.log('\na 26 m city corner, entered without braking:\n');
  let best = 0;
  for (let kmh = 60; kmh <= 200; kmh += 5) {
    const body = make();
    body.vz = kmh / 3.6;
    // Drive a quarter circle of radius 26 by steering to hold it.
    let maxErr = 0;
    const R = 26;
    let ok = true;
    for (let i = 0; i < 60 * 4; i++) {
      // Where should we be on the arc, given how far we have travelled?
      const want = Math.min(Math.PI / 2, (i * DT * body.speed) / R);
      const tx = Math.sin(want) * R;
      const tz = Math.cos(want) * R;
      void tx; void tz;
      // Radius the car is actually describing.
      const omega = Math.abs(body.yawRate);
      const actual = omega > 1e-4 ? body.speed / omega : Infinity;
      if (want > 0.15 && want < Math.PI / 2) {
        maxErr = Math.max(maxErr, actual - R);
      }
      if (want >= Math.PI / 2) break;
      body.step(DT, { throttle: 0, brake: 0, steer: 1, drift: false }, SURFACES.road, 0);
    }
    // Running 8.5 m wide of a 26 m arc puts the car off a 17 m street.
    if (maxErr < 8.5) best = kmh; else { ok = false; }
    if (!ok && best) break;
  }
  console.log(`  highest entry speed that still makes it: ${best} km/h`);
  if (best < 110) {
    console.log('  FAIL  a city corner has to be braked to a crawl — the district');
    console.log('        becomes a series of pauses rather than a lap');
    problems++;
  } else {
    console.log('  ok  you brake once and commit');
  }
}

// --- 3. does it go where it is pointed? -------------------------------------
{
  console.log('\nslip while cornering normally (75% lock at 140 km/h):\n');
  const body = make();
  body.vz = 140 / 3.6;
  drive(body, { throttle: 0.6, brake: 0, steer: 0.75, drift: false }, 3);
  const slip = Math.abs(body.slipAngle) * 57.3;
  console.log(`  slip angle: ${slip.toFixed(1)} deg`);
  if (slip > 12) {
    console.log('  FAIL  the car is sliding when it should be gripping');
    problems++;
  } else {
    console.log('  ok  it goes where it is pointed');
  }
}

// --- 4. turn-in ------------------------------------------------------------
{
  console.log('\nturn-in (time from straight to 90% of the yaw rate it will hold):\n');
  for (const kmh of [90, 150]) {
    const body = make();
    body.vz = kmh / 3.6;
    const settled = (() => {
      const b2 = make();
      b2.vz = kmh / 3.6;
      drive(b2, { throttle: 0.6, brake: 0, steer: 1, drift: false }, 3);
      return Math.abs(b2.yawRate);
    })();
    let t = 0;
    for (let i = 0; i < 60 * 3; i++) {
      body.step(DT, { throttle: 0.6, brake: 0, steer: 1, drift: false }, SURFACES.road, 0);
      t += DT;
      if (Math.abs(body.yawRate) >= settled * 0.9) break;
    }
    console.log(`  ${String(kmh).padStart(3)} km/h : ${t.toFixed(2)}s`);
    if (t > 0.42) {
      console.log('  FAIL  the nose is lazy — this reads as a heavy car, not an arcade one');
      problems++;
    }
  }
}

// --- 5. the handbrake has to do something -----------------------------------
{
  console.log('\nhandbrake:\n');
  const plain = make();
  plain.vz = 110 / 3.6;
  drive(plain, { throttle: 0.4, brake: 0, steer: 1, drift: false }, 1.2);

  const hand = make();
  hand.vz = 110 / 3.6;
  drive(hand, { throttle: 0.4, brake: 0, steer: 1, drift: true }, 1.2);

  const gain = (Math.abs(hand.yaw) / Math.max(1e-4, Math.abs(plain.yaw)));
  console.log(`  rotation in 1.2s: ${(plain.yaw * 57.3).toFixed(0)} deg plain, `
    + `${(hand.yaw * 57.3).toFixed(0)} deg on the handbrake (${gain.toFixed(2)}x)`);
  if (gain < 1.15) {
    console.log('  FAIL  the handbrake does not rotate the car');
    problems++;
  } else {
    console.log('  ok  the handbrake is a tool for tight corners');
  }
}

console.log('');
if (problems) {
  console.log(`${problems} handling problem(s)`);
  process.exitCode = 1;
} else {
  console.log('the car drives like an arcade racer');
}
