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

// --- every window has a wall immediately behind it --------------------------
//
// The building is a stack of masses that step in as they rise. The first
// window grid was sized from the whole building and seated on the base slab,
// so it ran off the top of that slab and left lit windows hanging in the air
// with nothing behind them — visible from the road as floors that are not
// there. A ray cast inward from the glass catches it: behind a real window is
// the wall it is set into, a couple of hundred millimetres away. Behind a
// floating one is either nothing, or the next mass in — which is narrower and
// centred, so it is metres away rather than centimetres. Hence a *near* hit is
// required, not just any hit; "some geometry is over there somewhere" is what
// the eye is already telling us is wrong.
{
  console.log('\nEvery window has a wall behind it:\n');
  const REACH = 0.6;          // metres; a wall this far back reads as absent
  const GLASS_LUMA = 0.02;    // linear-space; glazing is far darker than render
  const bad = [];
  let glassSeen = 0;
  for (const biome of BIOMES) {
    const lib = buildPropLibrary(biome, 7);
    for (const type of ['building', 'facade', 'tenement', 'townhouse', 'mall']) {
      const entry = lib[type];
      if (!entry) continue;
      for (const geo of (entry.levels ?? [])[0] ?? []) {
        const pos = geo?.attributes?.position;
        const col = geo?.attributes?.color;
        if (!pos || !col) continue;
        const glass = [];
        const solid = [];
        for (let t = 0; t < pos.count; t += 3) {
          const luma = 0.2126 * col.getX(t) + 0.7152 * col.getY(t) + 0.0722 * col.getZ(t);
          const tri = [0, 1, 2].map((k) => [pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k)]);
          (luma < GLASS_LUMA ? glass : solid).push(tri);
        }
        // Only elevations, not one-off panes.
        //
        // A projecting bay or a shopfront return is glazing whose side faces
        // have no wall behind them and never did — that is what a bay is. The
        // regression this guards against is a *grid* left standing where its
        // slab ended, so panes are bucketed by the plane they lie in and only
        // planes carrying a row of them are tested.
        const plane = (n, c) => {
          const ax = Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2;
          return `${ax}:${Math.round(c[ax] * 4)}`;
        };
        const rows = new Map();
        for (const tri of glass) {
          const n = faceNormal(tri);
          if (Math.abs(n[1]) > 0.5) continue;
          const c = centroid(tri);
          const k = plane(n, c);
          rows.set(k, (rows.get(k) ?? 0) + 1);
        }
        // Every pane, not a sample of them. Sampling one in four looked
        // harmless and was not: between the inward faces, the slivers and the
        // panes that are not on an elevation, four fifths of the glass is
        // filtered out before it is tested, and a quarter of what is left is
        // three triangles. Checked against the bug it was written for, the
        // sampled version reported clean and the exhaustive one found ten.
        for (let i = 0; i < glass.length; i++) {
          const tri = glass[i];
          const e1 = sub(tri[1], tri[0]);
          const e2 = sub(tri[2], tri[0]);
          const n = norm(cross(e1, e2));
          // The near level's colour bands are 60 mm strips in the same near-
          // black as the glazing, and their end caps look exactly like small
          // panes to everything above. A window is big; a strip's end is not.
          if (Math.hypot(...cross(e1, e2)) / 2 < 0.10) continue;
          // Only the outward pane, not the reveals or the box's own back.
          const c = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
          // Outward-facing means the normal agrees with the direction out
          // from the building's axis — horizontally only, since every pane
          // sits well above the origin and height would swamp the sign.
          if (n[0] * c[0] + n[2] * c[2] <= 0) continue;
          glassSeen++;
          // A glass box has six faces, and its two side faces also point away
          // from the building's axis — with the opposite jamb a pane's width
          // "behind" them. Only the outermost surface is a window: if there is
          // anything in front of this face, it is an edge, not a view.
          if ((rows.get(plane(n, c)) ?? 0) < 8) continue;
          // And on the outside of the building at its own height. A pane's
          // side faces point sideways from well inside the envelope; an
          // elevation's panes sit at the extremity. Measured per height band
          // so a setback's own narrower face still counts as an extremity.
          const ax = Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2;
          if (Math.abs(c[ax]) < 0.85 * envelopeAt(solid, c[1], ax)) continue;
          const ahead = [0, 1, 2].map((k) => c[k] + n[k] * 0.02);
          if (hitsWithin(solid, ahead, n, 1.0)) continue;
          if (hitsWithin(glassTris(glass), ahead, n, 1.0)) continue;
          const from = [0, 1, 2].map((k) => c[k] - n[k] * 0.02);
          const dir = [-n[0], -n[1], -n[2]];
          if (!hitsWithin(solid, from, dir, REACH)) {
            bad.push(`${biome.id}/${type} (${c.map((v) => v.toFixed(1)).join(',')}) n=${n.map((v) => v.toFixed(0)).join(',')}`);
            break;
          }
        }
      }
    }
    disposePropLibrary(lib);
  }
  if (bad.length) problems++;
  console.log(`  ${glassSeen} panes checked, ${bad.length} with no wall within ${REACH} m`
    .padEnd(52) + (bad.length ? `FAIL ${bad.slice(0, 4).join('; ')}` : 'ok'));
}

/** The soup, unchanged — named so the intent at the call site reads. */
function glassTris(g) { return g; }

/** Half-extent of the solid mass on `ax`, within a couple of metres of `y`. */
function envelopeAt(solid, y, ax) {
  let half = 0;
  for (const tri of solid) {
    for (const v of tri) {
      if (Math.abs(v[1] - y) > 2.0) continue;
      half = Math.max(half, Math.abs(v[ax]));
    }
  }
  return half;
}

function faceNormal(tri) {
  return norm(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
}
function centroid(tri) {
  return [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Möller–Trumbore against a triangle soup, stopping at the first close hit. */
function hitsWithin(tris, o, d, maxT) {
  for (const tri of tris) {
    const e1 = sub(tri[1], tri[0]);
    const e2 = sub(tri[2], tri[0]);
    const p = cross(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-9) continue;
    const inv = 1 / det;
    const tv = sub(o, tri[0]);
    const u = dot(tv, p) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross(tv, e1);
    const v = dot(d, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, q) * inv;
    if (t > 1e-4 && t <= maxT) return true;
  }
  return false;
}
