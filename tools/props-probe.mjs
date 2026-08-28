// Validates every prop generator.
//
// A NaN vertex produces one console warning and otherwise vanishes: the prop is
// silently invisible, the InstancedMesh's bounding sphere is broken so it may
// never be culled or may never be drawn, and nothing points at which of two
// dozen generators did it. So each one is built and checked directly.

import { PROP_TYPES, BIOME_PROPS, buildPropLibrary, disposePropLibrary } from '../src/world/props.js';
import { triCount } from '../src/world/shapes.js';
import { BIOMES } from '../src/data/biomes.js';
import { RNG } from '../src/core/rng.js';
import { generateProps, collidableProps } from '../src/world/scatter.js';
import { generateTrack } from '../src/track/track.js';

let problems = 0;

console.log('Prop generators\n');
console.log('type            variants   tris  radius  tough   place     verdict');
console.log('-'.repeat(70));

for (const [name, def] of Object.entries(PROP_TYPES)) {
  const rng = new RNG(`probe:${name}`);
  let tris = 0;
  let bad = [];

  for (let v = 0; v < 3; v++) {
    let geo;
    try {
      geo = def.build(rng, BIOMES[0].palette, { biome: BIOMES[0] });
    } catch (e) {
      bad.push(`threw: ${e.message}`);
      break;
    }
    if (!geo) { bad.push('returned nothing'); break; }

    const pos = geo.attributes.position;
    if (!pos) { bad.push('no position attribute'); break; }

    let nan = 0, huge = 0, maxY = -Infinity, minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nan++;
      else {
        if (Math.abs(x) > 300 || Math.abs(y) > 300 || Math.abs(z) > 300) huge++;
        maxY = Math.max(maxY, y); minY = Math.min(minY, y);
      }
    }
    if (nan) bad.push(`${nan} NaN vertices`);
    if (huge) bad.push(`${huge} vertices beyond 300 m`);
    // Props are authored standing on the ground plane.
    if (Number.isFinite(minY) && minY < -0.6) bad.push(`sinks to y=${minY.toFixed(2)}`);
    if (!geo.attributes.color) bad.push('no vertex colours');
    if (geo.index) bad.push('indexed — normals will be smoothed across facets');

    tris += triCount(geo);
    geo.dispose();
  }

  const avg = Math.round(tris / 3);
  const ok = bad.length === 0;
  if (!ok) problems++;
  console.log(
    `${name.padEnd(15)} ${String(3).padStart(4)} ${String(avg).padStart(7)} ` +
    `${String(def.radius).padStart(7)} ${String(def.toughness ?? '-').padStart(6)}  ` +
    `${(def.place ?? '?').padEnd(9)} ${ok ? 'ok' : 'FAIL ' + bad.join('; ')}`,
  );
}

// --- scatter: density, and nothing on the grid ----------------------------
console.log('\nScatter, per biome:\n');
for (const biome of BIOMES) {
  const rng = new RNG(`scatter:${biome.id}`);
  const track = generateTrack(new RNG(`t:${biome.id}`), biome, { difficulty: 1 });
  const props = generateProps(rng, track, biome, { density: 1 });
  const coll = collidableProps(props);

  // Nothing should sit on the starting grid.
  let onGrid = 0;
  for (let slot = 0; slot < 6; slot++) {
    const pose = track.startPose(slot, 6);
    for (const p of props) {
      if (Math.hypot(p.x - pose.x, p.z - pose.z) < 4) onGrid++;
    }
  }

  const lib = buildPropLibrary(biome, 1);
  const types = Object.keys(lib).filter((k) => !k.startsWith('__')).length;
  const libTris = lib.__stats.tris;
  disposePropLibrary(lib);

  // Nothing on the racing surface. Obstacles in the road were removed by
  // choice, and this is what stops them coming back through a band boundary
  // drifting or a new placement rule forgetting.
  let onRoad = 0;
  let deepest = 0;
  const scratch = {};
  for (const p of props) {
    // A gantry spans the road from above and is placed on the centreline on
    // purpose; it is a structure, not an obstacle, and never collides.
    if (PROP_TYPES[p.type]?.spanning) continue;
    if (p.onBranch) { onRoad++; continue; }
    // Ask the track where the prop actually *is*, rather than trusting the
    // lateral offset it was placed with. Those differ: an offset larger than
    // the local radius of curvature folds through the corner, and on a city
    // circuit a large offset simply lands on the next street over. This check
    // read the offset and so reported a clean road while eight buildings stood
    // in the middle of one.
    const sm = track.sample(p.x, p.z, scratch);
    if (sm.halfWidth == null || sm.side == null) continue;
    const off = Math.abs(sm.side) - sm.halfWidth;
    if (off < 0) { onRoad++; deepest = Math.min(deepest, off); }
  }

  // Detail must fall with distance, and the near band must not be empty —
  // "everything is far away" would pass a triangle budget and look like a
  // desert of low-poly blobs.
  const byLod = [0, 0, 0];
  for (const p of props) byLod[Math.min(p.lod ?? 0, 2)]++;

  const bad = [];
  if (props.length < 120) bad.push('too sparse');
  if (onGrid > 0) bad.push(`${onGrid} props on the starting grid`);
  if (coll.length === 0) bad.push('nothing destructible');
  if (onRoad > 0) bad.push(`${onRoad} props on the racing surface (worst ${deepest.toFixed(1)} m in)`);
  if (byLod[0] === 0) bad.push('nothing at the near detail level');
  if (byLod[2] === 0) bad.push('no horizon props');
  if (bad.length) problems++;

  console.log(
    `  ${biome.id.padEnd(11)} ${String(props.length).padStart(4)} props  ` +
    `${String(coll.length).padStart(3)} destructible  ` +
    `${String(types).padStart(2)} types  ` +
    `lod ${byLod[0]}/${byLod[1]}/${byLod[2]}  ` +
    `${String(libTris).padStart(5)} unique tris  ` +
    (bad.length ? 'FAIL ' + bad.join('; ') : 'ok'),
  );
}

console.log('');
if (problems) {
  console.log(`${problems} problem(s) in the prop pipeline`);
  process.exit(1);
}
console.log('every prop generator is valid and every biome is populated');
