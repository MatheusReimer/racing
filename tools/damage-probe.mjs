// Damage you can see.
//
// A car takes damage all race and the number in the HUD is the only thing that
// says so. This checks the three things that has to be true of the fix: the
// states are actually distinguishable from each other, the paint that goes is
// paint rather than glass or bare metal that was already grey, and repainting
// fifty thousand triangles happens when a threshold is crossed rather than
// every frame — which is the difference between free and unaffordable.

import { readFileSync } from 'node:fs';
import { VehicleMesh, visualProfile, damageLevel, DAMAGE_STATES } from '../src/vehicle/chassis.js';
import { Build } from '../src/build/build.js';
import { VEHICLES } from '../src/data/vehicles.js';
import { HULLS, HULL_NAMES, parseHull } from '../src/data/bodies/index.js';

for (const n of HULL_NAMES) {
  const b = readFileSync(`public/bodies/${n}.bin`);
  HULLS[n] = parseHull(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`);
};

const build = (id) => {
  const b = new Build(id);
  return new VehicleMesh(visualProfile(b.stats.all(), b.tags, b.vehicle), { shadows: false });
};

/** Snapshot of a body's colours, so two states can be compared. */
const colours = (mesh) => Float32Array.from(mesh.bodyGeo.getAttribute('color').array);

const changed = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 9) if (a[i] !== b[i] || a[i + 1] !== b[i + 1]) n++;
  return n / (a.length / 9);
};

console.log('Damage states are visible, and cost nothing to hold\n');

// --- the thresholds are where they are said to be --------------------------
{
  const cases = [[1.0, 0], [0.9, 0], [0.76, 0], [0.75, 1], [0.6, 1],
    [0.5, 2], [0.2, 2], [0.001, 2], [0, 3]];
  const wrong = cases.filter(([h, want]) => damageLevel(h) !== want);
  check('75%, 50% and wrecked land on the right state', wrong.length === 0,
    wrong.length ? wrong.map(([h, w]) => `${h}->${damageLevel(h)} want ${w}`).join(', ')
      : `${cases.length} fractions`);
}

// --- each state looks different from the last ------------------------------
{
  let worstStep = 1;
  let worstCar = '';
  for (const def of VEHICLES) {
    const mesh = build(def.id);
    let prev = colours(mesh);
    for (let level = 1; level < DAMAGE_STATES.length; level++) {
      mesh.setDamage(DAMAGE_STATES[level].at - 0.001);
      const now = colours(mesh);
      const step = changed(prev, now);
      if (step < worstStep) { worstStep = step; worstCar = `${def.bodyType} at state ${level}`; }
      prev = now;
    }
    mesh.dispose();
  }
  // A step nobody can see is not a state. Five per cent of the body's triangles
  // changing colour is about a wing.
  check('every state changes the car from the one before', worstStep >= 0.05,
    `smallest step ${(worstStep * 100).toFixed(1)}% of triangles (${worstCar})`);
}

// --- and it is the paint that goes, not the windows ------------------------
{
  const mesh = build('rotary');
  const before = colours(mesh);
  mesh.setDamage(0);
  const after = colours(mesh);
  // Glass is near-black and unlit; if the scuffing touched it, some triangle
  // that was almost black is now mid-grey.
  let glassTouched = 0;
  for (let i = 0; i < before.length; i += 9) {
    const wasDark = before[i] < 0.02 && before[i + 1] < 0.02 && before[i + 2] < 0.03;
    if (wasDark && after[i] > 0.05) glassTouched++;
  }
  check('a wrecked car keeps its glass black', glassTouched === 0,
    `${glassTouched} dark triangles lightened`);
  mesh.dispose();
}

// --- holding a state costs nothing ------------------------------------------
{
  const mesh = build('coupe');
  mesh.setDamage(0.60);
  const held = colours(mesh);
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) mesh.setDamage(0.60 - (i % 3) * 0.001);
  const ms = performance.now() - t0;
  const stable = changed(held, colours(mesh)) === 0;
  check('repainting only happens when a threshold is crossed', ms < 5 && stable,
    `600 unchanged updates in ${ms.toFixed(2)} ms${stable ? '' : ', and the colours moved'}`);
  mesh.dispose();
}

// --- crossing one is affordable ---------------------------------------------
{
  const mesh = build('gt');
  let worst = 0;
  for (const level of [1, 2, 3, 0]) {
    const t0 = performance.now();
    mesh.setDamage(DAMAGE_STATES[level].at - (level ? 0.001 : 0));
    worst = Math.max(worst, performance.now() - t0);
  }
  check('crossing a threshold costs under a frame', worst < 16,
    `worst transition ${worst.toFixed(2)} ms`);
  mesh.dispose();
}

console.log(fails
  ? `\n${fails} problem(s) with damage`
  : '\ndamage reads as damage, and holding it is free');
process.exit(fails ? 1 : 0);
