// Is the house drivable?
//
// Two questions that nothing else in the suite can ask, because they are about
// the room geometry and the racing line being the same world — and the rooms
// are one mesh the simulation knows nothing about.
//
//   * Nothing stands on the street. Fixtures go against walls and the racing
//     line swings toward the outside wall, so the two meet; a bath ended up on
//     the start line once, with no collision, and the car drove through it.
//     The route is subtracted from the room afterwards, and this is what says
//     the subtraction worked.
//   * The route goes through the doorways. The openings are cut where the
//     layout says the doors are and the centreline is smoothed afterwards —
//     smoothing a line through a wall is exactly as easy as smoothing one
//     through a door, and it would look like a car driving through plaster.

import * as THREE from 'three';
import { generateTrack } from '../src/track/track.js';
import { buildHouse } from '../src/world/rooms.js';
import { DOOR_W } from '../src/track/house.js';
import { BIOME_BY_ID } from '../src/data/biomes.js';
import { RNG } from '../src/core/rng.js';

const biome = BIOME_BY_ID.house;
let problems = 0;

console.log('The house is drivable\n');
console.log('  seed  rooms      cubes  triangles  on street  doors missed  worst door');
console.log('  ' + '-'.repeat(74));

for (let seed = 0; seed < 5; seed++) {
  const track = generateTrack(new RNG(`house:${seed}`), biome, { difficulty: 1 });
  const group = buildHouse(track, biome, new RNG(`houseprops:${seed}`));
  if (!group) { problems++; console.log(`  ${seed}  FAIL — built nothing`); continue; }

  // --- nothing above the floor inside the corridor -------------------------
  //
  // Vertices, not cells: what matters is the geometry that actually got built,
  // and reading it back is the only way to be sure the carve ran on the same
  // grid the fixtures were drawn into.
  const proj = { s: 0, dist: 0, side: 0 };
  let intruders = 0;
  let worstIn = 0;
  for (const mesh of group.children) {
    const pos = mesh.geometry.attributes.position.array;
    const ox = mesh.position.x;
    const oz = mesh.position.z;
    for (let v = 0; v < pos.length; v += 3) {
      // Above the floor's top. The floor itself is meant to be there.
      if (pos[v + 1] < 0.3) continue;
      const x = pos[v] + ox;
      const z = pos[v + 2] + oz;
      track.path.project(x, z, proj);
      const into = track.halfWidthAt(proj.s) - proj.dist;
      if (into > 0.5) { intruders++; worstIn = Math.max(worstIn, into); }
    }
  }

  // --- the route goes through the openings ---------------------------------
  let missed = 0;
  let worstDoor = 0;
  for (const d of track.layout.doorways) {
    track.path.project(d.x, d.z, proj);
    const p = track.path.pointAt(proj.s, { x: 0, y: 0, z: 0 });
    const off = Math.hypot(p.x - d.x, p.z - d.z);
    worstDoor = Math.max(worstDoor, off);
    // The centreline has to pass within half an opening of the middle of it,
    // or the car is going through the frame.
    if (off > DOOR_W / 2) missed++;
  }

  const ok = intruders === 0 && missed === 0;
  if (!ok) problems++;
  // Cubes *and* triangles.
  //
  // The cube count is what the house is; the triangle count is what the GPU is
  // billed for, because a GPU cannot draw a cube — it draws two triangles per
  // visible face and nothing else. The ratio between them is the only measure
  // of whether the greedy mesher is earning its keep: a naive voxel renderer
  // emits twelve triangles a cube, and a house here emits a third of one.
  let cubes = 0;
  let tris = 0;
  for (const m of group.children) {
    cubes += m.geometry.userData.cubes ?? 0;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  console.log(`  ${String(seed).padStart(4)}  ${String(group.children.length).padStart(5)}  `
    + `${String(cubes).padStart(9)}  ${String(tris).padStart(9)}  `
    + `${String(intruders).padStart(6)}v   ${String(missed).padStart(6)} of ${track.layout.doorways.length}  `
    + `${worstDoor.toFixed(2)} m`
    + (ok ? '' : `   FAIL${worstIn ? ` — ${worstIn.toFixed(2)} m into the road` : ''}`));

  for (const m of group.children) m.geometry.dispose();
  group.userData.material?.dispose();
}

console.log(problems
  ? `\n${problems} house(s) with something on the street or a door the route misses`
  : '\nnothing stands on the street, and the route goes through every door');
process.exit(problems ? 1 : 0);
