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

// --- the panels come off, and only after the paint has gone -----------------
//
// A grey panel hanging off a car that has merely been scraped reads as a part
// somebody bolted on, so nothing detaches at three quarters. And a panel that
// is hidden is not just invisible: it must also cost nothing, which is what
// `visible = false` buys and what a zero rotation would not.
{
  const mesh = build('rotary');
  const seen = [];
  for (let level = 0; level < DAMAGE_STATES.length; level++) {
    mesh.setDamage(level === 0 ? 1 : DAMAGE_STATES[level].at - 0.001);
    seen.push({
      bonnet: mesh.torn.bonnet.visible,
      bumper: mesh.torn.bumper.visible,
      lift: mesh.torn.bonnet.rotation.x,
      smoke: mesh.damageSmoke,
    });
  }
  check('nothing has come off a car that has only been scraped',
    !seen[0].bonnet && !seen[0].bumper && !seen[1].bonnet && !seen[1].bumper,
    `untouched ${seen[0].bonnet || seen[0].bumper}, hit ${seen[1].bonnet || seen[1].bumper}`);
  check('panels are off by half, and further by wrecked',
    seen[2].bonnet && seen[2].bumper && Math.abs(seen[3].lift) > Math.abs(seen[2].lift),
    `lift ${Math.abs(seen[2].lift).toFixed(2)} -> ${Math.abs(seen[3].lift).toFixed(2)} rad`);
  check('smoke starts when the panels do',
    seen[0].smoke === 0 && seen[1].smoke === 0 && seen[2].smoke > 0 && seen[3].smoke > seen[2].smoke,
    seen.map((x) => x.smoke).join(' -> '));

  // Back to health: repair has to put the car back together, not leave a
  // bumper hanging off a fully repaired one.
  mesh.setDamage(1);
  check('a repaired car has its panels back',
    !mesh.torn.bonnet.visible && !mesh.torn.bumper.visible && mesh.damageSmoke === 0,
    'bonnet and bumper hidden, smoke off');
  mesh.dispose();
}

// --- torn panels stay inside the car they came off --------------------------
//
// They are positioned from the reference's own extents, and a rotation about a
// hinge can swing a panel a long way from where it was placed. A bumper that
// reaches a metre past the nose is not a bumper, and it would collide with
// nothing — the physics body is unchanged — so it would pass through cars.
{
  const THREE = await import('three');
  const bounds = (obj) => new THREE.Box3().setFromObject(obj);
  let worst = 0;
  let worstCar = '';
  for (const def of VEHICLES) {
    const mesh = build(def.id);
    mesh.setDamage(0);
    // The bodywork, not the group: the group carries an underglow plane wider
    // than the car, which would make any panel look well behaved.
    // The whole of the bodywork: a voxel car is drawn in slabs, and one slab
    // is a slice of the car, not the car.
    const body = new THREE.Box3();
    for (const m of mesh.bodyParts) body.union(bounds(m));
    for (const piece of [mesh.torn.bonnet, mesh.torn.bumper]) {
      const b = bounds(piece);
      const past = Math.max(b.max.z - body.max.z, body.min.z - b.min.z,
        b.max.x - body.max.x, body.min.x - b.min.x);
      if (past > worst) { worst = past; worstCar = def.bodyType; }
    }
    mesh.dispose();
  }
  // A panel may hang past the bodywork, but by a hand's width. Further and it
  // is not a panel — and nothing would hit it, since the physics body is
  // unchanged, so it would pass through other cars.
  check('a hanging panel stays within reach of the bodywork', worst < 0.30,
    `worst overhang ${(worst * 100).toFixed(0)} cm (${worstCar})`);
}

// --- the smoke is wired to the same table the panels are --------------------
//
// The mesh and the effects layer read damage independently — one from the state
// it is told, one from the racer's durability — so they can silently disagree,
// and a car with its bonnet up and no smoke is the kind of wrong that looks
// like a missing feature rather than a bug.
{
  const THREE = await import('three');
  const { FX } = await import('../src/fx/fx.js');
  const { EventBus } = await import('../src/core/events.js');

  const fx = new FX(new THREE.Scene(), new EventBus(),
    { particleBudget: 600, tireMarkSegments: 100 });
  const seen = {};
  const real = fx.particles.emit;
  fx.particles.emit = (preset, x, y, z, n, opts) => {
    seen[preset] = (seen[preset] ?? 0) + n;
    return real(preset, x, y, z, n, opts);
  };

  // One object across the frames: the emitter accumulates its rate on the racer,
  // so a fresh one each frame never reaches a whole particle.
  const car = {
    alive: true, isPlayer: true, name: 'p', heat: 0,
    durability: 100, maxDurability: 100, sample: { onTrack: true },
    body: {
      x: 0, y: 0, z: 0, forwardX: 0, forwardZ: 1, rightX: 1, rightZ: 0,
      speed: 40, drifting: false, boostTimer: 0, driftQuality: 0,
    },
  };
  const puffs = (health) => {
    for (const k of Object.keys(seen)) delete seen[k];
    car.durability = health;
    for (let i = 0; i < 60; i++) fx.update(1 / 60, [car], null, null);
    return seen.smoke ?? 0;
  };

  const clean = puffs(100);
  const hit = puffs(80);
  const trouble = puffs(20);
  check('a healthy car does not smoke, and one in trouble does',
    clean === 0 && hit === 0 && trouble > 0,
    `untouched ${clean}, hit ${hit}, in trouble ${trouble} puffs/s`);
}

console.log(fails
  ? `\n${fails} problem(s) with damage`
  : '\ndamage reads as damage, and holding it is free');
process.exit(fails ? 1 : 0);
