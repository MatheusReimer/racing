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

function analyse(geo) {
  const idx = geo.index.array;
  const pos = geo.attributes.position.array;

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

console.log('Manifold orientation of generated vehicle meshes\n');

for (const c of cases) {
  const m = new VehicleMesh(visualProfile(c.build.stats.all(), c.build.tags, c.def),
    { shadows: false });

  for (const [name, geo] of [['body', m.bodyGeo], ['glass', m.glassGeo], ['trim', m.trimGeo]]) {
    if (!geo) continue;
    const r = analyse(geo);
    const bad = r.flipped > 0 || r.holes > 0;
    if (bad) problems++;
    console.log(
      `  ${c.label.padEnd(13)} ${name.padEnd(6)} ${String(r.tris).padStart(4)} tris  ` +
      `${String(r.edges).padStart(4)} edges  ` +
      `flipped ${String(r.flipped).padStart(3)}  holes ${String(r.holes).padStart(3)}  ` +
      (bad ? 'FAIL' : 'ok'),
    );
  }
  m.dispose();
}

console.log('');
if (problems) {
  console.log(`${problems} mesh piece(s) are not closed and consistently wound —`);
  console.log('flipped faces are invisible from outside and read as see-through holes.');
  process.exit(1);
}
console.log('every vehicle mesh is closed and consistently wound');
