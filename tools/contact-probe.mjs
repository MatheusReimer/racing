// Does the car stand on the road?
//
// The fault this exists for: in most situations the car was either hovering
// above the surface or sunk into it, and nothing caught it. The physics was
// innocent — it holds `y` exactly at the ground — and so were the three probes
// that already existed, because all of them ask about forces and none of them
// asks where the tyre is. Two separate errors were hiding behind that:
//
//   1. Pitch and roll were applied to the whole car about the group's origin,
//      which sits on the tarmac. Five degrees of pitch swung the front wheels
//      ten centimetres. The body pivots over its suspension now and the wheels
//      are not its children, so attitude cannot lift them.
//   2. The axle sat at the tyre's nominal radius, but the tread blocks stand
//      proud of it — so twenty-seven millimetres of every tyre was inside the
//      road, on every car, permanently.
//
// Both are geometry, both are invisible in a still, and both are exactly the
// kind of thing a number catches and an eye does not.

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { HULLS, HULL_NAMES, parseHull } from '../src/data/bodies/index.js';

for (const n of HULL_NAMES) {
  const b = readFileSync(`public/bodies/${n}.bin`);
  HULLS[n] = parseHull(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
const { VehicleMesh, visualProfile } = await import('../src/vehicle/chassis.js');
const { Build } = await import('../src/build/build.js');
const { VEHICLES } = await import('../src/data/vehicles.js');

// A millimetre. Tighter than anything anyone can see, and loose enough that
// float noise in a matrix chain does not fail the build.
const TOL = 0.001;
// How far the lowest bodywork may go under the road at the simultaneous
// extreme of pitch and roll, before it counts as a fault rather than as
// cornering. A car leaning hard into a bend and grazing a sill is a real thing
// real cars do — the 205 and the Impreza have the lowest sills on the grid and
// touch by about twelve millimetres — and calling that a failure would only
// teach the next person to widen the tolerance. Sitting on the floor while
// parked would not be real, and that is checked separately and strictly.
const GRAZE = 0.025;
// Attitudes the physics actually reaches: squat, dive, and both together with
// cornering lean.
// The range the physics can actually reach, not a guess: bodyPitch is clamped
// to ±0.035 rad and roll to ±0.06, so these are the corners of that box. If
// either clamp is ever widened, this has to follow or the probe stops covering
// the attitudes the game can produce.
const ATTITUDES = [
  [0, 0], [0.035, 0], [-0.035, 0], [0, 0.06], [0, -0.06],
  [0.035, 0.06], [-0.035, -0.06],
];

const box = new THREE.Box3();
const v = new THREE.Vector3();

/**
 * The true lowest point of a mesh in world space.
 *
 * `Box3.setFromObject` gives the axis-aligned box of an axis-aligned box, which
 * for anything rotated is bigger than the thing inside it — and a car under
 * pitch is always rotated, so it reported bodywork through the road that was
 * never there. Walking the vertices costs a few million transforms in a probe
 * that runs in a second, and it answers the question actually being asked.
 */
function lowestPoint(mesh) {
  const a = mesh.geometry.attributes.position;
  mesh.updateMatrixWorld(true);
  let lo = Infinity;
  for (let i = 0; i < a.count; i++) {
    v.fromBufferAttribute(a, i).applyMatrix4(mesh.matrixWorld);
    if (v.y < lo) lo = v.y;
  }
  return lo;
}
let problems = 0;

console.log('Wheels on the road, and bodywork above it\n');
for (const v of VEHICLES) {
  const build = new Build(v.id);
  const mesh = new VehicleMesh(visualProfile(build.stats.all(), build.tags, v), { shadows: false });

  let worstWheel = 0;
  let worstBody = Infinity;
  let restBody = 0;
  for (const [pitch, roll] of ATTITUDES) {
    mesh.update(0.016, {
      x: 0, y: 0, z: 0, yaw: 0, pitch, roll, bodyPitch: pitch, terrainPitch: 0,
      forwardSpeed: 0, slipAngle: 0, drifting: false, driftQuality: 0,
    }, {});
    mesh.group.updateMatrixWorld(true);
    for (const w of mesh.wheels) {
      box.setFromObject(w.pivot);
      worstWheel = Math.max(worstWheel, Math.abs(box.min.y));
    }
    const lo = lowestPoint(mesh.bodyMesh);
    worstBody = Math.min(worstBody, lo);
    if (pitch === 0 && roll === 0) restBody = lo;
  }

  // A wheel has to touch. Bodywork has to clear — a nose that dives through the
  // tarmac is the same bug wearing a different panel.
  const bad = worstWheel > TOL || restBody < TOL || worstBody < -GRAZE;
  if (bad) problems++;
  console.log(`  ${v.name.padEnd(17)} wheel ${(worstWheel * 1000).toFixed(2).padStart(5)} mm off  `
    + `body clears ${(restBody * 1000).toFixed(0).padStart(4)} mm at rest, `
    + `${(worstBody * 1000).toFixed(0).padStart(4)} mm worst  ${bad ? 'FAIL' : 'ok'}`);
  mesh.dispose();
}

console.log('');
if (problems) {
  console.log(`${problems} vehicle(s) do not stand on the road.`);
  process.exit(1);
}
console.log('every wheel touches the tarmac at every attitude, every car clears it at rest');
