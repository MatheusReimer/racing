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
import { generateTrack, BARRIER_RAIL_OFFSET } from '../src/track/track.js';

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

// --- the declared footprints still match the geometry ----------------------
//
// `footprint` is how much room a prop needs, measured off what actually gets
// built by tools/footprints.mjs and pasted in. Pasted numbers rot: the reason
// ridges were going through the track is that this was a hand guess of 25 m
// against a thing that is a hundred and forty-five across. So the geometry is
// re-measured here and the declaration has to still cover it.
{
  console.log('\nDeclared footprints still cover the geometry:\n');
  const CAR_HEIGHT = 2.5;
  const SCALE_HEADROOM = 1.35;
  const widest = new Map();
  for (const biome of BIOMES) {
    const lib = buildPropLibrary(biome, 1);
    for (const [type, entry] of Object.entries(lib)) {
      let w = widest.get(type) ?? 0;
      for (const group of [entry.variants, ...(entry.levels ?? [])]) {
        for (const g of group ?? []) {
          const pos = g?.attributes?.position;
          if (!pos) continue;
          for (let i = 0; i < pos.count; i++) {
            if (pos.getY(i) > CAR_HEIGHT) continue;
            w = Math.max(w, Math.abs(pos.getX(i)), Math.abs(pos.getZ(i)));
          }
        }
      }
      widest.set(type, w);
    }
    disposePropLibrary(lib);
  }
  let drifted = 0;
  let worst = '';
  let by = 0;
  for (const [type, w] of widest) {
    const def = PROP_TYPES[type];
    if (!def || def.spanning || def.frontage) continue;
    const need = w * SCALE_HEADROOM;
    const have = def.footprint ?? def.radius ?? 0;
    if (need > have + 0.25) {
      drifted++;
      if (need - have > by) { by = need - have; worst = type; }
    }
  }
  if (drifted) problems++;
  console.log(`  ${String(widest.size).padStart(3)} types measured, ${drifted} under-declared`
    + `${drifted ? `, worst ${worst} short by ${by.toFixed(1)} m` : ''}`.padEnd(52)
    + (drifted ? 'FAIL — rerun tools/footprints.mjs' : 'ok'));
}

// --- and none of them standing in the road ---------------------------------
//
// Placement tested a prop's origin against a flat two-metre margin, which is
// right for a barrel and useless for anything wider than the margin: a building
// whose origin clears the kerb by two metres still leaves four metres of
// building in the street, and that is what kept turning up there. Asked here of
// the props that were actually placed, at the size they were actually built,
// rather than of the arithmetic that placed them.
//
// Gantries are exempt: they are built to stand over the road. Frontages are
// too — they are put at the kerb facing the street on purpose and their bulk
// runs away from it, so their radius is not a reach into the road.
{
  console.log('\nNothing standing in any road, which ends at the rail:\n');
  const scratch = {};
  for (const biome of BIOMES) {
    const track = generateTrack(new RNG(`ROAD-${biome.id}`), biome, {});
    const props = generateProps(new RNG(`ROAD-P-${biome.id}`), track, biome);

    // Every road, projected against directly.
    //
    // This used to ask `track.sample`, which only claims a branch when the
    // point is already inside it — so anything beside a shortcut was measured
    // against the main line, somewhere else entirely, and reported clean. It
    // reported clean three times while there were between eighteen and
    // fifty-six props standing in a shortcut, one of them a ridge a hundred and
    // forty metres into one. A probe that shares the blind spot of the code it
    // checks is worse than no probe: it is a reason to stop looking.
    const roads = [{ path: track.path, halfWidth: (s) => track.halfWidthAt(s), closed: true }]
      .concat((track.branches ?? []).map((b) => ({
        path: b.path, halfWidth: () => b.halfWidth, closed: false,
      })));
    const intoRoad = (x, z, reach) => {
      let worst = -Infinity;
      for (const road of roads) {
        const q = road.path.project(x, z, scratch);
        if (!road.closed && (q.s <= 0.01 || q.s >= road.path.length - 0.01)) continue;
        worst = Math.max(worst, road.halfWidth(q.s) + BARRIER_RAIL_OFFSET + reach - Math.abs(q.side));
      }
      return worst;
    };

    let worst = 0;
    let offender = '';
    let count = 0;
    for (const p of props) {
      const def = PROP_TYPES[p.type];
      if (def?.spanning) continue;
      let into = -Infinity;
      if (def?.frontage) {
        // The whole slab, both ways from its origin.
        //
        // A frontage is modelled centred, so `depth` is not where it ends: a
        // townhouse declares seventeen metres and is built thirty-eight across.
        // Sweeping only into the block — which is what this did — never looked
        // at the half facing the traffic, which is the half that was standing
        // in the street through three rounds of this being reported and
        // measuring clean.
        const reach = (def.frontage.reach ?? def.frontage.depth / 2) * (p.scale ?? 1);
        const c = Math.cos(p.yaw);
        const sn = Math.sin(p.yaw);
        for (let u = -1; u <= 1.0001; u += 0.2) {
          for (let v = -0.5; v <= 0.5; v += 0.125) {
            const lx = u * reach;
            const lz = v * def.frontage.width * (p.scale ?? 1);
            into = Math.max(into, intoRoad(p.x + c * lx + sn * lz, p.z - sn * lx + c * lz, 0));
          }
        }
      } else {
        const reach = def?.footprint ?? p.radius;
        if (!reach) continue;
        into = intoRoad(p.x, p.z, reach * (p.scale ?? 1));
      }
      if (into > 0) {
        count++;
        if (into > worst) { worst = into; offender = p.type; }
      }
    }
    const bad = worst > 0.01;
    if (bad) problems++;
    console.log(`  ${biome.id.padEnd(12)} ${String(count).padStart(3)} in a road`
      + `${count ? `, worst ${worst.toFixed(2)} m of ${offender}` : ''}`.padEnd(38)
      + (bad ? 'FAIL' : 'ok'));
  }
}

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
  const byLod = [0, 0, 0, 0];
  // Four levels since the kerb band was split off; clamping at 2 folded the
  // horizon into the mid-field and made the finest and the coarsest bands
  // invisible in the same column.
  for (const p of props) byLod[Math.min(p.lod ?? 0, byLod.length - 1)]++;

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
    `lod ${byLod[0]}/${byLod[1]}/${byLod[2]}/${byLod[3] ?? 0}  ` +
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
