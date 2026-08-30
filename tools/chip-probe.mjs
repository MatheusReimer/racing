// Does a car actually lose pieces when it is hit?
//
// The claim being made is small and easy to get wrong in four places at once:
// a knock knocks cells out of the body, the body redraws without them, and the
// cells that went come back in world space wearing the colour of the panel
// they came off. Each of those is checkable, and none of them is visible in a
// screenshot at speed — a chip that comes back grey, or at the origin, or that
// never leaves the grid, all look about the same from the driver's seat.
//
// So this hits every car in the roster, at the nose, in body coordinates, and
// asks: did the triangle count drop, did we get cubes, are they where the car
// is, and are they the car's colour.

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { VehicleMesh, visualProfile } from '../src/vehicle/chassis.js';
import { Build } from '../src/build/build.js';
import { VEHICLES } from '../src/data/vehicles.js';
import { HULLS, HULL_NAMES, VOX, parseHull } from '../src/data/bodies/index.js';
import { parseVox } from '../src/vehicle/voxmesh.js';
import { Debris } from '../src/fx/debris.js';

// Both bodies off disk: in Node there is nothing to fetch, and a probe that
// fell back to the generated car would be measuring a car the game no longer
// builds.
const read = (p) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
for (const n of HULL_NAMES) HULLS[n] = parseHull(read(`public/bodies/${n}.bin`));
for (const n of HULL_NAMES) VOX[n] = parseVox(read(`public/bodies/${n}.vox`));

const tris = (mesh) => mesh.bodyParts.reduce(
  (n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);

let problems = 0;
console.log('A car comes apart where it is hit\n');
console.log('  car            tris before    after    cells   colour   ms');
console.log('  ' + '-'.repeat(60));

for (const v of VEHICLES) {
  const b = new Build(v.id);
  const mesh = new VehicleMesh(visualProfile(b.stats.all(), b.tags, b.vehicle),
    { shadows: false });

  if (!mesh.voxBody) {
    problems++;
    console.log(`  ${v.id.padEnd(12)} FAIL — not a voxel body, nothing to chip`);
    mesh.dispose();
    continue;
  }

  const before = tris(mesh);
  // The nose, in world space. The car sits at the origin facing +z, so the
  // front of its own bounding box is where a barrier would meet it.
  const box = new THREE.Box3();
  for (const m of mesh.bodyParts) box.union(new THREE.Box3().setFromObject(m));
  const mid = box.getCenter(new THREE.Vector3());

  const t0 = performance.now();
  const cells = mesh.chipAt(mid.x, mid.y, box.max.z - 0.15, 0.25, 20);
  const ms = performance.now() - t0;
  const after = tris(mesh);

  const n = cells?.length ?? 0;
  const paint = new THREE.Color(visualProfile(b.stats.all(), b.tags, b.vehicle).baseColor);
  // "The car's colour" is the honest test only for painted cells; a chip off a
  // window or a grille is legitimately not the paint. So: did *any* of them
  // come back in the body colour.
  const painted = (cells ?? []).filter((c) =>
    Math.abs(c.r - paint.r) < 0.02 && Math.abs(c.g - paint.g) < 0.02
    && Math.abs(c.b - paint.b) < 0.02).length;

  // Where they are. Debris that comes back in grid coordinates rather than
  // world ones lands in a heap next to the track, and nothing else catches it.
  const stray = (cells ?? []).filter((c) =>
    Math.abs(c.x - mid.x) > 2 || Math.abs(c.z - mid.z) > 4 || c.y < 0 || c.y > 3).length;

  // Not "fewer triangles": a dent *adds* surface, because the cells behind the
  // ones that went were never drawn and now face the air. What has to be true
  // is that the body was remeshed at all.
  const ok = n > 0 && after !== before && painted > 0 && stray === 0;
  if (!ok) problems++;
  console.log(`  ${v.id.padEnd(12)} ${String(before).padStart(9)}  `
    + `${String(after).padStart(8)}  ${String(n).padStart(6)}  `
    + `${String(painted).padStart(4)}/${n}  ${ms.toFixed(1).padStart(5)}`
    + (ok ? '' : `   FAIL${stray ? ` — ${stray} cells nowhere near the car` : ''}`));

  mesh.dispose();
}

// --- a knock that lands just off the paint still takes something ----------
//
// A contact point comes from two collision volumes meeting, and a car is not
// its bounding box: a nose-in can report a point sitting in the air past the
// bumper. That used to take nothing off at all — the hardest hits in the game
// were the ones most likely to do nothing. And the reach that fixes it must
// not become a magnet: a point three metres away is not a hit on this car.
{
  console.log('\nA near miss still lands, a real miss still misses\n');
  const b = new Build(VEHICLES[0].id);
  const mesh = new VehicleMesh(visualProfile(b.stats.all(), b.tags, b.vehicle),
    { shadows: false });
  const box = new THREE.Box3();
  for (const m of mesh.bodyParts) box.union(new THREE.Box3().setFromObject(m));
  const mid = box.getCenter(new THREE.Vector3());

  const near = mesh.chipAt(mid.x, mid.y, box.max.z + 0.12, 0.22, 20);
  const far = mesh.chipAt(mid.x, mid.y + 6, mid.z, 0.22, 20);

  const ok = (near?.length ?? 0) > 0 && far === null;
  if (!ok) problems++;
  console.log(`  12 cm past the nose  -> ${near?.length ?? 0} cubes`
    + `\n  6 m above the roof   -> ${far?.length ?? 0} cubes${ok ? '' : '   FAIL'}`);
  mesh.dispose();
}

// --- and the pieces fall ---------------------------------------------------
//
// The debris system on its own is checked elsewhere; what is checked here is
// that what `chipAt` hands back is the shape `burst` wants. A field renamed on
// one side of that seam gives cubes of size zero, or black ones, and neither
// throws.
{
  const scene = new THREE.Scene();
  const debris = new Debris(scene, 64);
  const b = new Build(VEHICLES[0].id);
  const mesh = new VehicleMesh(visualProfile(b.stats.all(), b.tags, b.vehicle),
    { shadows: false });
  const box = new THREE.Box3();
  for (const m of mesh.bodyParts) box.union(new THREE.Box3().setFromObject(m));
  const mid = box.getCenter(new THREE.Vector3());
  const cells = mesh.chipAt(mid.x, mid.y, box.max.z - 0.15, 0.25, 20) ?? [];
  debris.burst(cells, 0, 2, 12);

  const live = debris.mesh.count;
  const m4 = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  // Size is written into the instance matrix by `update`, not by `burst`, so
  // this reads it after a step — before one, every cube measures 1 m.
  debris.update(1 / 60, () => 0);
  debris.mesh.getMatrixAt(0, m4);
  m4.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);

  for (let t = 0; t < 3; t += 1 / 60) debris.update(1 / 60, () => 0);
  const settled = debris.mesh.count;

  const ok = live === cells.length && scale.x > 0.02 && scale.x < 0.4 && settled > 0;
  if (!ok) problems++;
  console.log(`\n  ${live} cubes thrown, ${scale.x.toFixed(3)} m each, `
    + `${settled} still on the road after 3 s${ok ? '' : '   FAIL'}`);
  mesh.dispose();
}

console.log(problems
  ? `\n${problems} problem(s): a hit does not take the car apart`
  : '\na hit takes cubes off the car, in the car\'s colours, and they fall');
process.exit(problems ? 1 : 0);
