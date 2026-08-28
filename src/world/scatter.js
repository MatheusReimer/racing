import { PROP_TYPES, BIOME_PROPS, CITY_FRONTAGES } from './props.js';
import { BARRIER_RAIL_OFFSET } from '../track/track.js';
import { clamp, clamp01, lerp, wrap, TAU } from '../core/math.js';

// Where the props go.
//
// Pure data — no Three.js — because the simulation needs to know about the
// destructible ones. `generateProps` is part of track generation, so a seed
// reproduces the scenery exactly along with the circuit.
//
// Four bands, and the distinction matters more than it looks:
//
//   road    on the racing surface. Only light, smashable things, and sparse.
//           This is the band that turns Weight and Impact into a *navigation*
//           stat, which the design brief asks for: a Truck drives through a
//           barrel stack that stops a Rocket.
//   verge   just off the road. Punishes cutting a corner without walling it.
//   outer   past the barrier. Scenery you read at speed.
//   far     the horizon. Cranes, spires, grandstands — the things that make a
//           circuit feel like somewhere rather than a ribbon in a void.

// Distance bands, measured *outward from the road edge* rather than from the
// centreline, so a wide corner and a narrow straight both get scenery in the
// same place relative to the tarmac.
//
// Nothing is placed on the racing surface. Obstacles in the road were the
// design's way of making Weight and Impact decide routes; that is now gone by
// choice, and the destructible props that remain are on the verge, where they
// are the price of running wide rather than a toll on the racing line.
const BANDS = {
  verge: { min: 1.5, max: 16, lod: 0 },
  near: { min: 16, max: 70, lod: 1 },
  mid: { min: 70, max: 200, lod: 2 },
  far: { min: 200, max: 480, lod: 3 },
};

/**
 * Detail level for something this far out from the road edge.
 *
 * The thresholds are the band boundaries, applied to the actual placement
 * rather than to which table it came from — a boulder that lands at 180 m gets
 * the mid level whether it was drawn as scenery or as horizon.
 */
function lodFor(off) {
  if (off < BANDS.verge.max) return 0;
  if (off < BANDS.near.max) return 1;
  if (off < BANDS.mid.max) return 2;
  return 3;
}

/** Weighted pick from a { name: weight } table. */
function pickWeighted(rng, table, filter) {
  const entries = Object.entries(table).filter(([name]) => !filter || filter(name));
  let total = 0;
  for (const [, w] of entries) total += w;
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries.length ? entries[entries.length - 1][0] : null;
}

/**
 * @param rng    seeded
 * @param track  the generated Track
 * @param biome  biome definition
 * @param opts   { density } 0..1.5, from the quality tier
 */
export function generateProps(rng, track, biome, opts = {}) {
  const density = opts.density ?? 1;
  const spec = BIOME_PROPS[biome.id] || BIOME_PROPS.wasteland;
  const props = [];
  const L = track.length;

  // Keep the grid and the run-up to the start line clear.
  const nearStart = (s) => {
    const d = Math.abs(track.path.deltaAlong(track.startS, s));
    return d < 60;
  };

  const scratch = {};

  /**
   * Would something here be standing in a road?
   *
   * Offsetting sideways from a centreline assumes open country either side, and
   * that assumption fails twice. In a city, 200 m sideways is three blocks over
   * — on *another street*, which is how buildings ended up in the middle of the
   * road. And on any circuit, an inward offset larger than the local radius of
   * curvature folds through the centre of the corner and comes out the far
   * side; a 26 m city corner does that to anything placed past 26 m in.
   *
   * Rather than guard each cause separately, ask the track where the thing
   * actually landed. It is one sample per prop at generation time and it closes
   * both, plus whichever third one exists that nobody has found yet.
   */
  // Every road, not just the racing line.
  //
  // This asked `track.sample`, and `sample` only claims a branch when the point
  // is inside it — a shortcut's own width. So anything sitting beside a
  // shortcut was measured against the main line, which is somewhere else
  // entirely, and sailed through. Between eighteen and fifty-six props per
  // biome were standing in a shortcut, one of them a ridge a hundred and forty
  // metres into it, and both the placement check and the probe that was
  // supposed to catch it were blind the same way, so it kept being reported and
  // kept measuring clean.
  //
  // A branch is a road. It has tarmac, it has rails, and driving down it into
  // the side of a building is the same experience as doing it on the main line.
  const roads = [{ path: track.path, halfWidth: (s) => track.halfWidthAt(s), closed: true }]
    .concat((track.branches ?? []).map((b) => ({
      path: b.path,
      halfWidth: () => b.halfWidth,
      closed: false,
    })));

  const landsOnRoad = (x, z, clearance) => {
    for (const road of roads) {
      const q = road.path.project(x, z, scratch);
      // An open branch's projection clamps to its ends, which would have
      // anything past the exit measured against the exit point. Only the span
      // the road actually covers counts.
      if (!road.closed) {
        const L = road.path.length;
        if (q.s <= 0.01 || q.s >= L - 0.01) continue;
      }
      // The road ends at the rail, not at the tarmac: the red-and-white barrier
      // stands 2.3 m outside the painted surface, and anything sharing space
      // with it reads as being on the track, because from the driver's seat the
      // barrier is where the track ends.
      if (Math.abs(q.side) < road.halfWidth(q.s) + BARRIER_RAIL_OFFSET + clearance) {
        return true;
      }
    }
    return false;
  };

  const place = (type, s, lateral, extra = {}) => {
    const def = PROP_TYPES[type];
    if (!def) return;
    const p = track.path.offsetPoint(s, lateral, { x: 0, y: 0, z: 0 });
    const scale = extra.scale ?? (1 + rng.spread(0.22));
    // Which way an aligned prop faces.
    //
    // `alignToTrack` gives a prop the road's yaw, and that rotation always maps
    // its local +X onto the *positive lateral* direction — which is toward the
    // road on one side of it and away on the other. Anything with a front, a
    // boom or a lit face therefore came out backwards on half the circuit: half
    // the street lamps hung their heads over the block behind them, and forty
    // per cent of the frontages put their shopfront, their canopy and their lit
    // windows in the alley. A type declares which local X sign is its front and
    // gets turned to face the road when it lands on the wrong side.
    let yaw = extra.alignToTrack
      ? track.path.yawAt(s) + rng.spread(0.25)
      : rng.range(0, TAU);
    if (extra.alignToTrack && def.faceRoad && def.faceRoad * Math.sign(lateral) > 0) {
      yaw += Math.PI;
    }

    // Spanning structures are built to stand over the road on purpose.
    if (!def.spanning) {
      // A prop is not a point.
      //
      // This tested the origin against a flat two-metre margin, which is fine
      // for a barrel and useless for anything larger than the margin: a
      // building whose origin clears the kerb by two metres still puts the
      // other four metres of building in the road, and that is exactly what was
      // turning up in the middle of the street. The margin is the prop's own
      // footprint now, so a bigger thing is held further out — and `scale` is
      // drawn before the test rather than after it, so the size being checked
      // is the size that gets built.
      //
      // Frontages are the exception and stay on a small fixed margin: they are
      // placed deliberately at the kerb with their face to the road, and their
      // bulk extends away from it, so their radius is not a reach into the
      // street.
      const clearance = extra.clearance
        ?? (def.frontage ? 0.5 : Math.max(2.0, (def.footprint ?? def.radius) * scale));
      if (landsOnRoad(p.x, p.z, clearance)) return;

      // A frontage is thirty metres deep, and all of that is behind it.
      //
      // Its origin sits at the kerb by design, so it cannot be held out by a
      // margin the way loose scenery is — but the block it fills has to land
      // somewhere, and on a circuit that folds back on itself "into the block"
      // can be "onto the next straight". Checking along its depth costs a few
      // samples and catches the one that was standing in a downtown street.
      if (def.frontage) {
        // Both directions from the origin, because the mesh is centred on it.
        // Sweeping only into the block left the half facing the traffic
        // unexamined through three rounds of this being reported.
        const reach = (def.frontage.reach ?? def.frontage.depth / 2) * scale;
        const ux = Math.cos(yaw);
        const uz = -Math.sin(yaw);
        for (let u = -1; u <= 1.0001; u += 0.25) {
          if (Math.abs(u) < 0.2) continue;
          if (landsOnRoad(p.x + ux * reach * u, p.z + uz * reach * u, 0.6)) return;
        }
      }
    }
    const off = Math.abs(lateral) - track.halfWidthAt(s);

    props.push({
      type,
      variant: rng.int(0, 2),
      x: p.x,
      y: p.y,
      z: p.z,
      yaw,
      scale,
      s,
      lateral,
      radius: def.radius * scale,
      height: (def.height ?? 1) * scale,
      // A prop with a toughness can be driven through; one without is scenery
      // and is never collided against at all.
      destructible: def.toughness != null,
      toughness: def.toughness,
      alive: true,
      emissive: def.emissive ?? null,
      lod: extra.lod ?? lodFor(off),
    });
  };

  // Nothing is placed on the racing surface, on the main line or on a
  // shortcut. Road clusters and shortcut hazards used to live here.

  // --- street frontage ----------------------------------------------------
  //
  // The thing that makes a city a city. Buildings are laid end to end down both
  // sides of the road at a fixed setback, so the street has walls; scattering
  // them at random distances — which is what every other district does — gives
  // buildings *near* a road rather than a street.
  //
  // Gaps are deliberate and sparse: a side street or an empty lot every so
  // often, which is where the alley shortcuts come out and what stops the wall
  // reading as one extruded ribbon.
  if (biome.city) {
    const front = PROP_TYPES.facade?.frontage;
    if (front) {
      // A stretch of one kind of building at a time — offices, then terraces,
      // then a mall — rather than a fresh draw per plot. See `CITY_FRONTAGES`
      // for why the run length is the part that does the work.
      const kinds = Object.entries(CITY_FRONTAGES)
        .filter(([name]) => PROP_TYPES[name]?.frontage);
      const totalWeight = kinds.reduce((t, [, k]) => t + k.weight, 0);
      const drawKind = () => {
        let r = rng.range(0, totalWeight);
        for (const [name, k] of kinds) {
          r -= k.weight;
          if (r <= 0) return { name, left: rng.int(k.run[0], k.run[1]) };
        }
        return { name: kinds[0][0], left: 1 };
      };
      // Each side of the street runs its own stretch, so the two never change
      // character on the same plot and the street is never symmetrical.
      const runs = { '-1': drawKind(), 1: drawKind() };
      const nextKind = (side) => {
        const run = runs[side];
        if (run.left <= 0) runs[side] = drawKind();
        runs[side].left--;
        return runs[side].name;
      };

      // The alleys have to stay open. Shortcuts cut diagonally across a corner,
      // straight through the block a frontage row would otherwise wall off —
      // and a shortcut with a building in it is worse than no shortcut, because
      // it is a route the map offers and the world refuses.
      const alley = [];
      for (const br of track.branches) {
        const n = Math.max(4, Math.round(br.path.length / 8));
        for (let i = 0; i <= n; i++) {
          alley.push(br.path.pointAt((i / n) * br.path.length, { x: 0, y: 0, z: 0 }));
        }
      }
      const blocksAlley = (x, z) => alley.some((a) =>
        Math.hypot(a.x - x, a.z - z) < front.depth * 0.75);
      const step = front.width;
      // Right at the kerb. A generous setback leaves a strip of open ground
      // between the barrier and the buildings, and open ground beside a city
      // street reads as a field with offices behind it — the wall has to be
      // close enough that the road is the only floor you can see.
      const setback = 2.4;
      for (let s = 0; s < L; s += step) {
        if (nearStart(s)) continue;
        const hw = track.halfWidthAt(s);
        for (const side of [-1, 1]) {
          // A gap on one side does not force a gap on the other.
          if (rng.bool(0.14)) continue;
          const kind = nextKind(side);
          // Placed by its front face, not its centre: whatever the type's depth
          // is, its shopfront meets the pavement on the same line as its
          // neighbours' and the wall stays flush.
          // Offset by what the thing measures, not by what it declares.
          //
          // `depth` describes the block a frontage is meant to fill; the mesh
          // is modelled centred on its own origin and reaches `reach` in both
          // directions. Offsetting by half the declared depth put the near half
          // of every building in the street — eight metres of it for a
          // townhouse, which declares seventeen and is built thirty-eight
          // across. Offsetting by the measured reach puts its face on the
          // setback line whichever way it ends up turned.
          const fr = PROP_TYPES[kind].frontage;
          const reach = fr.reach ?? fr.depth / 2;
          const fs = wrap(s + rng.spread(1.2), L);
          const lat = side * (hw + BARRIER_RAIL_OFFSET + setback + reach);
          const at = track.path.offsetPoint(fs, lat, { x: 0, y: 0, z: 0 });
          if (blocksAlley(at.x, at.z)) continue;
          // A frontage is deep, so its *back* can reach the next street even
          // when its centre does not. Check both ends of it.
          const yaw = track.path.yawAt(fs);
          // Both ends of it, at its measured reach: the back can land on the
          // next street even when the centre does not, and the front is the
          // half that used to end up in this one.
          // Its corners, not just its axis. A frontage is twenty-two metres
          // along the street, and on a bend it is a corner that reaches into
          // the road while the centreline of the thing still clears.
          const ax = -Math.sin(yaw + Math.PI / 2) * side;
          const az = -Math.cos(yaw + Math.PI / 2) * side;
          const wx = Math.cos(yaw + Math.PI / 2) * side;
          const wz = -Math.sin(yaw + Math.PI / 2) * side;
          const halfW = fr.width * 0.5;
          let blocked = false;
          for (const u of [-1, -0.5, 0.5, 1]) {
            for (const v of [-1, 0, 1]) {
              const px = at.x + ax * reach * u + wx * halfW * v;
              const pz = at.z + az * reach * u + wz * halfW * v;
              if (landsOnRoad(px, pz, 0.5)) { blocked = true; break; }
            }
            if (blocked) break;
          }
          if (blocked) continue;
          place(kind, fs, lat, { alignToTrack: true, scale: 1, lod: 0 });
        }
      }

      // Street lighting on a regular pitch, alternating sides. Regular is the
      // point: the rhythm of light pools going past is most of what reads as
      // speed at night, and scattering them at random spacing destroys it.
      let lampSide = 1;
      for (let s = 0; s < L; s += 34) {
        if (nearStart(s)) continue;
        const hw = track.halfWidthAt(s);
        place('streetlight', s, lampSide * (hw + BARRIER_RAIL_OFFSET + 1.2),
          { alignToTrack: true, scale: 1, lod: 0 });
        lampSide = -lampSide;
      }
    }
  }

  // --- verge --------------------------------------------------------------
  const vergeCount = Math.round((L / 20) * density);
  for (let i = 0; i < vergeCount; i++) {
    const s = rng.range(0, L);
    const hw = track.halfWidthAt(s);
    const type = pickWeighted(rng, spec.trackside);
    if (!type) continue;
    const side = rng.bool() ? 1 : -1;
    place(type, s, side * (hw + BARRIER_RAIL_OFFSET + rng.range(0.8, BANDS.verge.max)),
      { alignToTrack: PROP_TYPES[type].place === 'trackside' });
  }

  // --- markers, regularly, so the road always has edge cues ---------------
  const markerEvery = 42;
  for (let s = 0; s < L; s += markerEvery) {
    if (nearStart(s)) continue;
    const hw = track.halfWidthAt(s);
    // Place on the outside of the corner, where a marker board belongs.
    const curv = track.path.curvatureAt(s, 16);
    const side = curv > 0 ? -1 : 1;
    place('marker', s, side * (hw + BARRIER_RAIL_OFFSET + 1.3), { alignToTrack: true, scale: 1 });
  }

  // --- outer scenery ------------------------------------------------------
  // Near and mid scenery. Denser close in, thinning outward — the far bands
  // cover many times the area, so a flat rate per metre of track would put a
  // wall of props at the horizon and a bare strip beside the road.
  const nearCount = Math.round((L / 13) * density);
  for (let i = 0; i < nearCount; i++) {
    const s = rng.range(0, L);
    const hw = track.halfWidthAt(s);
    const type = pickWeighted(rng, spec.scenery);
    if (!type) continue;
    const side = rng.bool() ? 1 : -1;
    place(type, s, side * (hw + BARRIER_RAIL_OFFSET
      + rng.range(BANDS.verge.max, BANDS.near.max)));
  }

  const midCount = Math.round((L / 26) * density);
  for (let i = 0; i < midCount; i++) {
    const s = rng.range(0, L);
    const hw = track.halfWidthAt(s);
    const type = pickWeighted(rng, spec.scenery);
    if (!type) continue;
    const side = rng.bool() ? 1 : -1;
    place(type, s, side * (hw + BARRIER_RAIL_OFFSET
      + rng.range(BANDS.near.max, BANDS.mid.max)));
  }

  // --- horizon ------------------------------------------------------------
  // Silhouettes at the edge of what the fog lets through. Placed on both sides
  // so the infield is not empty either, and always at the coarsest level: at
  // this range they are an outline against the sky and nothing more.
  const horizonTable = spec.horizon;
  if (horizonTable) {
    const horizonCount = Math.round((L / 34) * density);
    for (let i = 0; i < horizonCount; i++) {
      const s = rng.range(0, L);
      const hw = track.halfWidthAt(s);
      const type = pickWeighted(rng, horizonTable);
      if (!type) continue;
      const side = rng.bool() ? 1 : -1;
      place(type, s, side * (hw + BARRIER_RAIL_OFFSET
        + rng.range(BANDS.mid.max, BANDS.far.max)),
      { scale: 1 + rng.spread(0.35) });
    }
  }

  // --- gantries -----------------------------------------------------------
  // Spanning the road, on the straightest stretches, spaced far apart. They are
  // the single strongest cue that you are moving.
  const gantryCount = clamp(Math.round(L / 700), 1, 4);
  for (let i = 0; i < gantryCount; i++) {
    let best = null;
    let flattest = Infinity;
    for (let k = 0; k < 24; k++) {
      const s = wrap(rng.range(0, L), L);
      if (nearStart(s)) continue;
      if (props.some((p) => p.type === 'gantry'
        && Math.abs(track.path.deltaAlong(p.s, s)) < 380)) continue;
      const c = Math.abs(track.path.curvatureAt(s, 26));
      if (c < flattest) { flattest = c; best = s; }
    }
    if (best == null) continue;
    const p = track.path.offsetPoint(best, 0, { x: 0, y: 0, z: 0 });
    props.push({
      type: 'gantry', variant: 0, x: p.x, y: p.y, z: p.z,
      yaw: track.path.yawAt(best),
      // Gantries are built to the width of the road they span.
      scale: 1, spanScale: track.halfWidthAt(best),
      s: best, lateral: 0,
      radius: 0, height: 6.5,
      destructible: false, toughness: null, alive: true, emissive: null,
    });
  }

  return props;
}

/** The subset the simulation has to collide against. */
export function collidableProps(props) {
  return props.filter((p) => p.destructible && p.radius > 0);
}
