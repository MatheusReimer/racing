// Checks that generated vehicle meshes are closed and consistently oriented.
//
// A flipped triangle is invisible from outside (back-face culling throws it
// away) and shows as a hole you can see the car's interior through. Comparing
// normals against a centroid does not detect it: on a merged mesh built from
// many separate boxes, a quarter of all faces legitimately point toward the
// centre, so that test reports 25% "inward" on perfect geometry.
//
// The decisive test is manifold orientation. In a closed surface with
// consistent winding, every edge is shared by exactly two triangles and each
// traverses it in the opposite direction. An edge seen twice in the *same*
// direction means those two triangles disagree — which is exactly a flipped
// face. An edge seen once means a hole.

import { VehicleMesh, visualProfile } from '../src/vehicle/chassis.js';
import { Build } from '../src/build/build.js';
import { VEHICLES } from '../src/data/vehicles.js';
import { PART_BY_ID } from '../src/data/parts.js';

// The bodies the game fetches at boot, read straight off disk: in Node there is
// no relative URL to fetch, and a probe that quietly fell back to the generated
// route would be checking a car the game no longer builds.
import { readFileSync } from 'node:fs';
import { HULLS, HULL_NAMES, parseHull } from '../src/data/bodies/index.js';
for (const n of HULL_NAMES) {
  const b = readFileSync(`public/bodies/${n}.bin`);
  HULLS[n] = parseHull(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function analyse(geo) {
  const pos = geo.attributes.position.array;
  // Indexed or not. A generated body comes out of `mergeGeometries` indexed; a
  // hull is de-indexed by construction, because a class belongs to a triangle
  // and an indexed buffer can only colour corners. The welding below makes the
  // distinction irrelevant, so a missing index is just the identity.
  const idx = geo.index
    ? geo.index.array
    : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);

  // Weld by position: separate boxes have distinct vertex indices, and an
  // unwelded test would call every shared corner a hole.
  const key = (i) => {
    const r = (v) => Math.round(v * 1000) / 1000;
    return `${r(pos[i * 3])},${r(pos[i * 3 + 1])},${r(pos[i * 3 + 2])}`;
  };
  const ids = new Map();
  const vid = (i) => {
    const k = key(i);
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };

  const directed = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = vid(idx[t]), b = vid(idx[t + 1]), c = vid(idx[t + 2]);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = `${u}>${v}`;
      directed.set(k, (directed.get(k) || 0) + 1);
    }
  }

  let flipped = 0, holes = 0, ok = 0;
  const seen = new Set();
  for (const [k, count] of directed) {
    const [u, v] = k.split('>');
    const rev = `${v}>${u}`;
    const pair = u < v ? `${u}|${v}` : `${v}|${u}`;
    if (seen.has(pair)) continue;
    seen.add(pair);

    const back = directed.get(rev) || 0;
    if (count === 1 && back === 1) ok++;
    // Two triangles traversing the same edge the same way disagree on which
    // side is outside.
    else if (count >= 2 && back === 0) flipped += count;
    else if (count === 1 && back === 0) holes++;
    else ok++;
  }
  return { edges: seen.size, ok, flipped, holes, tris: idx.length / 3 };
}

let problems = 0;
const cases = [];

for (const v of VEHICLES) {
  const b = new Build(v.id);
  cases.push({ label: v.name, build: b, def: v });
}
// Also the extremes, since Armor and Top Speed add whole sub-assemblies.
for (const [label, ids] of [
  ['Tank build', ['heavy_armor', 'absolute_unit', 'reinforced_frame']],
  ['Speed build', ['velocity_core', 'hell_engine', 'featherframe']],
  ['Impact build', ['ram_prow', 'reinforced_bumper', 'flywheel']],
]) {
  const b = new Build('rotary');
  for (const id of ids) if (PART_BY_ID[id] && b.canAddPart()) b.addPart(PART_BY_ID[id]);
  cases.push({ label, build: b, def: b.vehicle });
}

// --- the cabin blank stays inside the car ----------------------------------
//
// A decimated shell has no interior, so a dark box sits inside the greenhouse
// and is what a window shows. It is sized from the hull's own extents, and a
// hull is measured across its mirrors and its wing — so a fraction that looks
// modest can still be wider than the cabin. The first one took 86% of the
// width and pushed a black slab out through both doors.
{
  const THREE = await import('three');
  console.log('\nThe cabin blank stays inside the bodywork\n');
  let worst = -Infinity;
  let worstCar = '';
  for (const v of VEHICLES) {
    const b = new Build(v.id);
    const mesh = new VehicleMesh(visualProfile(b.stats.all(), b.tags, b.vehicle),
      { shadows: false });
    if (!mesh.cabin) { mesh.dispose(); continue; }
    const body = new THREE.Box3().setFromObject(mesh.bodyMesh);
    const cab = new THREE.Box3().setFromObject(mesh.cabin);
    const out = Math.max(
      cab.max.x - body.max.x, body.min.x - cab.min.x,
      cab.max.y - body.max.y, body.min.y - cab.min.y,
      cab.max.z - body.max.z, body.min.z - cab.min.z,
    );
    if (out > worst) { worst = out; worstCar = v.bodyType; }
    mesh.dispose();
  }
  const ok = worst < -0.05;
  if (!ok) problems++;
  console.log(`  closest approach ${(-worst * 100).toFixed(0)} cm inside (${worstCar})`
    .padEnd(52) + (ok ? 'ok' : 'FAIL — the blank is showing'));
}


console.log('Manifold orientation of generated vehicle meshes\n');

for (const c of cases) {
  const m = new VehicleMesh(visualProfile(c.build.stats.all(), c.build.tags, c.def),
    { shadows: false });

  // A body decimated off a reference is exempt, and the exemption is the point
  // rather than a way round a failure.
  //
  // This test asks whether a surface is closed and consistently wound, which is
  // a fair question of geometry this project generated out of boxes and lofts:
  // if it is not, somebody's arithmetic is wrong. It is not a fair question of
  // a real car model. Those are built as dozens of open shells — a bonnet is a
  // panel with a rim, glass is a plane, a door shut is a genuine gap — and no
  // amount of care makes them watertight, because they were never meant to be.
  // Their bodies are drawn double-sided for exactly that reason, which is what
  // makes an inconsistent winding a non-event instead of a hole.
  //
  // Everything the generator still builds is checked as strictly as before.
  const traced = !!HULLS[c.def?.bodyType];

  for (const [name, geo] of [['body', m.bodyGeo], ['glass', m.glassGeo], ['trim', m.trimGeo]]) {
    if (!geo) continue;
    const r = analyse(geo);
    const exempt = traced && name === 'body';
    const bad = !exempt && (r.flipped > 0 || r.holes > 0);
    if (bad) problems++;
    console.log(
      `  ${c.label.padEnd(13)} ${name.padEnd(6)} ${String(r.tris).padStart(4)} tris  ` +
      `${String(r.edges).padStart(4)} edges  ` +
      `flipped ${String(r.flipped).padStart(3)}  holes ${String(r.holes).padStart(3)}  ` +
      (bad ? 'FAIL' : (exempt ? 'traced — not expected to be closed' : 'ok')),
    );
  }
  m.dispose();
}

// --- and every one of them points forward ----------------------------------
//
// A body decimated off a reference inherits whichever way that reference was
// modelled, and half the catalogue faces the other way. Nothing downstream can
// tell: the car drives, corners and collides perfectly well backwards, it just
// does it rear-first, and the GC8 did exactly that until somebody watched it.
//
// Two readings, because no single one covers every car. Where there is glass,
// the cabin of a front-engined car sits behind the middle — decisive, and every
// car here has a healthy margin on it. Where there is none, the rear deck of a
// car is higher than its bonnet, which is weak on a hatchback and unmistakable
// on the saloon that needed it.
{
  console.log('');
  for (const [name, hull] of Object.entries(HULLS)) {
    let glassZ = 0;
    let glassN = 0;
    for (let t = 0; t < hull.classes.length; t++) {
      if (hull.classes[t] !== 1) continue;
      for (let k = 0; k < 3; k++) glassZ += hull.positions[hull.indices[t * 3 + k] * 3 + 2];
      glassN += 3;
    }
    const lim = hull.length * 0.36;
    let fs = 0; let fn = 0; let rs = 0; let rn = 0;
    for (let i = 0; i < hull.positions.length; i += 3) {
      const z = hull.positions[i + 2];
      const y = hull.positions[i + 1];
      if (z > lim) { fs += y; fn++; } else if (z < -lim) { rs += y; rn++; }
    }
    const byGlass = glassN > 600;
    // Both readings are stated as "how far forward this car faces", so a
    // negative answer means it is the wrong way round either way.
    const value = byGlass ? -(glassZ / glassN) : (rs / rn) - (fs / fn);
    const bad = !(value > 0.05);
    if (bad) problems++;
    console.log(`  ${name.padEnd(13)} faces forward by `
      + `${byGlass ? 'cabin' : 'deck '} ${value.toFixed(3).padStart(7)}   ${bad ? 'FAIL — built back to front' : 'ok'}`);
  }
}

// --- and each of them has lamps that say something -------------------------
//
// A car with no brake light is worse than one with an approximate light: it is
// the single thing the driver behind you reads. Only three of seven references
// mark their lamps — the MX-5's headlights are pop-ups and the model has them
// shut, and several name every material `Material.005` — so the rest are placed
// from the car's own shape, and this is what says whether that happened.
{
  console.log('');
  for (const c of cases) {
    const m = new VehicleMesh(visualProfile(c.build.stats.all(), c.build.tags, c.def),
      { shadows: false });
    const f = m.lampFront?.geometry.attributes.position.count ?? 0;
    const r = m.lampRear?.geometry.attributes.position.count ?? 0;

    // And that the rear pair actually changes with what the car is doing.
    const drive = (over) => {
      m.update(0.016, {
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, bodyPitch: 0, terrainPitch: 0,
        slipAngle: 0, drifting: false, driftQuality: 0, forwardSpeed: 20, ...over,
      }, over.state ?? {});
      return m.lampRearMat.color.getHex();
    };
    const cruise = drive({});
    const braking = drive({ state: { brake: 1 } });
    const reversing = drive({ forwardSpeed: -3 });

    const bad = f === 0 || r === 0 || cruise === braking || braking === reversing;
    if (bad) problems++;
    console.log(`  ${c.label.padEnd(13)} lamps ${String(f / 3).padStart(5)} front `
      + `${String(r / 3).padStart(5)} rear   `
      + `cruise/brake/reverse ${[cruise, braking, reversing].map((h) => h.toString(16).padStart(6, '0')).join(' ')}  `
      + (bad ? 'FAIL' : 'ok'));
    m.dispose();
  }
}

// --- and each is drawn between two simulation steps ------------------------
//
// The loop has computed the fraction of a step it is ahead by since the day it
// was written, and passed it to a renderer that ignored it — so a car was drawn
// at the last simulated pose and nowhere in between. At two hundred an hour a
// step is ninety centimetres, and the display never lines up with 60 Hz, so one
// frame repeated a position and the next covered the lot. That is what
// "teleporting when I go fast" was, and nothing about frame rate would have
// fixed it.
{
  console.log('');
  const c = cases[0];
  const m = new VehicleMesh(visualProfile(c.build.stats.all(), c.build.tags, c.def),
    { shadows: false });
  const body = {
    px: 0, py: 0, pz: 0, pyaw: 0, ppitch: 0, pbodyPitch: 0, pterrainPitch: 0, proll: 0,
    x: 0, y: 0, z: 10, yaw: 0, pitch: 0, bodyPitch: 0, terrainPitch: 0, roll: 0,
    forwardSpeed: 55, slipAngle: 0, drifting: false, driftQuality: 0, boostTimer: 0,
  };
  const at = (a) => { m.update(0.016, body, {}, a); return m.group.position.z; };
  const z0 = at(0);
  const zh = at(0.5);
  const z1 = at(1);
  const bad = Math.abs(z0 - 0) > 1e-6 || Math.abs(zh - 5) > 1e-6 || Math.abs(z1 - 10) > 1e-6;
  if (bad) problems++;
  console.log(`  ${'drawn between steps'.padEnd(28)} `
    + `alpha 0/0.5/1 -> z ${z0.toFixed(2)} ${zh.toFixed(2)} ${z1.toFixed(2)} of 10   `
    + (bad ? 'FAIL — the frame is pinned to one step' : 'ok'));
  m.dispose();
}

console.log('');
if (problems) {
  console.log(`${problems} mesh piece(s) are not closed and consistently wound —`);
  console.log('flipped faces are invisible from outside and read as see-through holes,');
  console.log('and a body built back to front drives rear-first.');
  process.exit(1);
}
console.log('every vehicle mesh is closed and consistently wound');
