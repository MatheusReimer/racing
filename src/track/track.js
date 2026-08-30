import { Path } from './spline.js';
import { generateCityLayout } from './city.js';
import { generateHouseLayout, houseWidthAt, DOOR_W } from './house.js';
import { SURFACES } from '../vehicle/physics.js';
import { clamp, clamp01, lerp, wrap, TAU, smoothstep } from '../core/math.js';

/**
 * How far the road surface stands above the path it follows.
 *
 * It exists so the tarmac is not z-fighting the ground plane under it, and it
 * lived in mesh.js — which draws the road — while `sample()` here went on
 * reporting the bare path height as the ground. Nothing reconciled the two, so
 * every car in the game drove six centimetres inside the asphalt: enough to bury
 * the bottom of a tyre, and visible on the grid before the lights even go out.
 *
 * The road's height is a fact about the track, not about how it is drawn, so it
 * belongs here and the mesh takes it from here.
 */
export const ROAD_LIFT = 0.06;
/** Branches sit a little higher, so they read as a ramp off the main line. */
export const BRANCH_LIFT = 0.075;

// Track layout.
//
// The centreline is a sum of harmonics on a circle:
//
//   r(theta) = R * (1 + SUM_k a_k * sin(k*theta + phi_k))
//
// Every term is periodic in theta, so the loop closes exactly — no stitching,
// no seam, no validation pass. Bounding SUM|a_k| below 1 keeps r positive and,
// because the low harmonics dominate, keeps the curve free of self-
// intersections without ever having to test for them. Rejection-sampling
// random walks until they happen to close is the usual approach and it is both
// slower and worse: this gives direct control over the *character* of a
// circuit, because each harmonic is a recognisable feature. k=2 is a long
// oval, k=3 a trefoil, k=5-7 are the sweepers, and the high terms with small
// amplitudes are the kinks between them.

/**
 * Lateral offset of the barrier from the edge of the racing surface.
 *
 * Defined once, here, and read by both the collision code and the mesh builder.
 * They were separate constants and had drifted 0.75 m apart, which meant the
 * wall you bounced off sat well inside the wall you could see.
 */
// Steepest gradient any circuit may have. Steep enough to be felt and to make a
// crest read; shallow enough that cresting one does not throw the car, which is
// reserved for ramps.
const MAX_GRADE = 0.12;

export const BARRIER_OFFSET = 1.1;

/**
 * Where the rail is *drawn*, as opposed to where the car's centre is stopped.
 *
 * Collision constrains a single point — the car's centre — so a rail drawn on
 * that same line is a rail passing through the middle of the car, which is
 * exactly how it looked. The drawn rail therefore sits one car half-width
 * further out, so a car resting on its limit has its flank against the rail.
 *
 * Widening the visual corridor rather than insetting the collision line keeps
 * the driving identical: the boundary a player feels has not moved.
 */
// Sized to the *widest* car the roster can build, not the average: under-sizing
// puts that car's flank back inside the rail, which is the whole artifact.
//
// 1.05, not 1.22. The old number was sized to a Truck 2.42 m across, and there
// is no Truck — the roster is six tuners, and the widest thing any of them
// becomes with every widening stat pushed to its limit is the coupe at 2.036 m.
// So the rail was drawn twenty centimetres further out than the widest flank
// could reach, and a player stopped by the collision line saw that much
// daylight between the car and the wall it had supposedly hit. Measured with
// every stat maxed, plus a few millimetres, so a wide build still rests against
// the rail rather than inside it.
export const BARRIER_CAR_CLEARANCE = 1.05;
export const BARRIER_RAIL_OFFSET = BARRIER_OFFSET + BARRIER_CAR_CLEARANCE;

/** Where a shortcut sits relative to the racing line. */
export const BRANCH_KIND = {
  shortcut: 'shortcut', // cuts the inside of a corner: faster, hazardous
  wide: 'wide',         // outside line: longer, safer, better exit speed
  pit: 'pit',           // parallel to the racing line: always longer, has a service
};

export class Track {
  constructor(data) {
    Object.assign(this, data);
    this._proj = { s: 0, dist: 0, side: 0 };
    this._pt = { x: 0, y: 0, z: 0 };
  }

  /** Half-width of the racing surface at distance `s`. */
  halfWidthAt(s) {
    const n = this.widthProfile.length;
    const f = wrap(s / this.length, 1) * n;
    const i = Math.floor(f);
    const t = f - i;
    const a = this.widthProfile[i % n];
    const b = this.widthProfile[(i + 1) % n];
    return lerp(a, b, t) * 0.5;
  }

  /** Track surface height under a world position. */
  groundAt(x, z) {
    const p = this.path.project(x, z, this._proj);
    return this.path.pointAt(p.s, this._pt).y;
  }

  /**
   * The one query the race loop makes per entity per step. Resolves which path
   * the entity is on (main line or a branch), how far off-centre it is, what
   * it is driving on, and how far around the lap it has got.
   */
  sample(x, z, out = {}) {
    const main = this.path.project(x, z, this._proj);
    let path = this.path;
    let s = main.s;
    let side = main.side;
    let dist = main.dist;
    let branch = null;

    const mainHalfWidth = this.halfWidthAt(main.s);
    const onMain = Math.abs(main.side) <= mainHalfWidth;

    // A branch only competes for ownership inside the arc it spans, so a car
    // on the far side of the circuit is never pulled onto it.
    // Which branch owned this entity last step. Ownership is sticky: without
    // hysteresis a car near a junction flips between the branch's narrow width
    // and the main line's wide one every frame, and the edge correction throws
    // it sideways by the difference.
    const prevBranch = out.branch ?? null;

    for (const b of this.branches) {
      if (!this._withinArc(main.s, b.entryS, b.exitS)) continue;
      const bp = b.path.project(x, z, b._proj || (b._proj = { s: 0, dist: 0, side: 0 }));
      // Harder to enter than to leave.
      const threshold = b.halfWidth * (prevBranch === b ? 1.45 : 0.9);
      const onThisBranch = Math.abs(bp.side) <= threshold;

      // Proximity alone is not ownership. A branch bulges away from the racing
      // line, so a car sitting legitimately on the main road can easily be
      // nearer to a branch's centreline than to the one it is actually driving
      // on. Claiming it there would apply the branch's much narrower width and
      // report a car in the middle of the road as off-track.
      const claims = onThisBranch && (!onMain || bp.dist < dist);
      if (!claims) continue;

      dist = bp.dist;
      side = bp.side;
      path = b.path;
      branch = b;
      // Map branch distance back onto the main line so lap progress stays
      // monotonic regardless of which route was taken.
      const f = b.path.length > 0 ? bp.s / b.path.length : 0;
      s = b.entryS + this._arcLength(b.entryS, b.exitS) * f;
    }

    const halfWidth = branch ? branch.halfWidth : mainHalfWidth;
    const absSide = Math.abs(side);
    const onTrack = absSide <= halfWidth;

    out.s = wrap(s, this.length);
    out.side = side;
    out.halfWidth = halfWidth;
    out.onTrack = onTrack;
    out.branch = branch;
    out.path = path;
    // The surface, not the path: what the car stands on is the tarmac, and the
    // tarmac is lifted off the path it follows.
    out.groundY = path.pointAt(branch ? this._branchLocalS(branch, s) : s, this._pt).y
      + (branch ? BRANCH_LIFT : ROAD_LIFT);
    out.surface = this._surfaceAt(out.s, side, onTrack, absSide, halfWidth);
    return out;
  }

  _branchLocalS(b, s) {
    const span = this._arcLength(b.entryS, b.exitS);
    if (span <= 0) return 0;
    const f = clamp01(this.path.deltaAlong(b.entryS, s) / span);
    return f * b.path.length;
  }

  _arcLength(a, b) {
    let d = b - a;
    if (d < 0) d += this.length;
    return d;
  }

  _withinArc(s, a, b) {
    const span = this._arcLength(a, b);
    const rel = this._arcLength(a, s);
    // A little slack at each end so ownership does not flicker at the seams.
    return rel <= span + 14 || rel >= this.length - 14;
  }

  /**
   * The racing surface is racing surface, everywhere, always.
   *
   * There used to be hazard patches strewn across it — oil at 0.12 grip, ice at
   * 0.20 — placed by the generator and drawn by nothing. An invisible patch
   * that takes the car away from you in the middle of clean asphalt is not a
   * hazard, it is the road lying about itself: nothing on screen said it was
   * there, so there was no line to take and no mistake to have made. Grip is
   * now something you only lose by leaving the road, by being hit, or by asking
   * too much of the tyres — all three of which you can see coming.
   */
  _surfaceAt(s, side, onTrack, absSide, halfWidth) {
    if (onTrack) return SURFACES.road;
    // Well past the edge is the biome's rough; just past it is a verge that
    // still has some bite, so clipping a kerb is not instantly fatal.
    const over = absSide - halfWidth;
    return over < 2.5 ? SURFACES.gravel : this.offTrackSurface;
  }

  /**
   * Grid position, `slot` 0..n-1. The whole grid sits a clear margin *behind*
   * the start line: a car parked exactly on it can jitter backwards under the
   * held brake during the countdown and register a lap crossing in reverse.
   */
  startPose(slot, count) {
    const row = Math.floor(slot / 2);
    const col = slot % 2;
    const s = wrap(this.startS - 14 - row * 7.5, this.length);
    const hw = this.halfWidthAt(s);
    const lateral = (col === 0 ? -1 : 1) * hw * 0.34;
    const p = this.path.offsetPoint(s, lateral, { x: 0, y: 0, z: 0 });
    // On the road, not in it — the grid is the first thing anybody sees.
    return { x: p.x, y: p.y + ROAD_LIFT, z: p.z, yaw: this.path.yawAt(s), s };
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Where the grid will go, needed before the pit lane is placed so the two do
 * not land on the same stretch of road.
 *
 * The real `startS` below picks the same way; this is that search, hoisted, and
 * the two must not drift apart.
 */
function startSGuess(path) {
  let startS = 0;
  let flattest = Infinity;
  for (let s = 0; s < path.length; s += 20) {
    const c = Math.abs(path.curvatureAt(s, 30));
    if (c < flattest) { flattest = c; startS = s; }
  }
  return startS;
}

/**
 * A pit lane beside the straightest stretch that is free to take one.
 *
 * @param usedArcs  arcs already spoken for by branches, so the lane's geometry
 *                  does not overlap theirs and set the ownership test in
 *                  `sample` flip-flopping between two roads
 * @param startS    the grid, which the lane must keep away from
 * @param widthProfile  the road's *width* around the lap; the lane is set out
 *                  from the widest point it runs beside, not from the nominal
 *                  width, because the road swells up to 6% and pinches 22% and
 *                  a lane placed at the average clips the road where it bulges
 * @returns a branch record, or null if the circuit has nowhere to put one
 */
function buildPitLane(path, usedArcs, startS, baseWidth, widthProfile) {
  // Long enough that the tapers are gentle. At 150 m every lane's entry pinched
  // to a 40-50 m radius, which no car can hold at the limiter's speed — so the
  // corner governed the lane and the limiter was decoration.
  const SPAN = 190;           // entry to exit, along the racing line
  const CLEAR = 40;           // from another branch, and from the grid

  // The straightest span available. A pit lane through a corner is one nobody
  // can enter at the limit, and it would also cross the racing line.
  //
  // Two passes: the second gives up half the clearance. A busy circuit can
  // have no 190 m stretch that is 40 m clear of everything, and a lane a
  // little close to a shortcut is worth far more than no lane at all — every
  // circuit having one is what lets the player plan around it.
  let best = null;
  for (const clear of [CLEAR, CLEAR * 0.5]) {
    for (let s0 = 0; s0 + SPAN < path.length; s0 += 12) {
      const s1 = s0 + SPAN;
      if (usedArcs.some((u) => s0 < u.s1 + clear && s1 > u.s0 - clear)) continue;
      // Wrapped, because the grid can sit either side of the seam.
      const dStart = Math.abs(((startS - (s0 + s1) / 2) + path.length * 1.5)
        % path.length - path.length * 0.5);
      if (dStart < SPAN * 0.5 + clear) continue;

      let bend = 0;
      let signed = 0;
      for (let t = 0; t <= 8; t++) {
        const k = path.curvatureAt(s0 + (SPAN * t) / 8, 25);
        bend += Math.abs(k);
        signed += k;
      }
      if (!best || bend < best.bend) best = { s0, s1, bend, signed };
    }
    if (best) break;
  }
  if (!best) return null;

  // Far enough out that the lane's tarmac clears the road's, with room between,
  // measured against the widest the road gets anywhere along the span.
  const halfWidth = (baseWidth * 0.34) / 2;
  let widest = baseWidth;
  for (let t = 0; t <= 12; t++) {
    const f = ((best.s0 + (SPAN * t) / 12) / path.length) % 1;
    widest = Math.max(widest, widthProfile[Math.floor(f * widthProfile.length)] ?? baseWidth);
  }
  const depth = widest * 0.5 + halfWidth + 9;

  // On the outside of whatever bend the span still has.
  //
  // The offset is measured along the road's normal, but the clearance that
  // matters is the perpendicular distance back to the road — and on the inside
  // of a bend those are not the same number. Offsetting inward ate three of
  // the five metres of margin, and on two circuits in sixty ate all of it and
  // put the lane on the racing line.
  const side = (best.signed ?? 0) > 0 ? -1 : 1;

  // Tapered in, parallel through the middle, tapered out — the shape that makes
  // it read as a lane beside the road rather than a bulge in it.
  const SHAPE = [0, 0.10, 0.38, 0.78, 1, 1, 1, 0.78, 0.38, 0.10, 0];
  const pts = SHAPE.map((k, i) => path.offsetPoint(
    best.s0 + (SPAN * i) / (SHAPE.length - 1), side * depth * k, { x: 0, y: 0, z: 0 }));

  const bpath = new Path(pts, false, 8);
  return {
    id: 'pit',
    kind: BRANCH_KIND.pit,
    path: bpath,
    entryS: best.s0,
    exitS: best.s1,
    halfWidth,
    // Negative: taking the pit lane always costs distance, before the limiter
    // costs you the rest.
    saving: SPAN - bpath.length,
    risky: false,
    isPit: true,
    // Which way the lane left the racing line, so anything placed beside it
    // can be placed on the far side rather than back across the road.
    pitSide: side,
  };
}

/**
 * @param rng     seeded RNG — the same seed must always give the same circuit
 * @param biome   entry from data/biomes.js
 * @param opts    { lengthScale, difficulty }
 */
export function generateTrack(rng, biome, opts = {}) {
  const difficulty = opts.difficulty ?? 0;

  // A city is laid out, not drawn.
  //
  // The harmonic generator below produces a closed loop of sweeping curves in
  // open country, which is the right shape for a wasteland highway and can
  // never be a city however much street furniture is put beside it. City
  // districts get their centreline from a block grid instead — see city.js —
  // and rejoin this function at the width profile, so branches, surfaces, the
  // start line and everything downstream are unchanged.
  if (biome.city) {
    const layout = generateCityLayout(rng.fork('city'), {
      elevation: biome.elevation ?? 6,
      blocks: rng.int(6, 10),
    });
    if (layout) return finishTrack(rng, biome, opts, layout.controls, { layout });
  }

  // Indoors is laid out too, and by a third rule again: a ring of rooms with a
  // doorway between each pair. See house.js — the car does not shrink, the
  // house is built at ten times life.
  if (biome.house) {
    const layout = generateHouseLayout(rng.fork('house'), {});
    if (layout) return finishTrack(rng, biome, opts, layout.controls, { layout });
  }
  const R = (opts.radius ?? 300) * (opts.lengthScale ?? 1) * rng.range(0.9, 1.12);

  // --- Centreline harmonics ------------------------------------------------
  // Amplitudes are budgeted so the total stays well under 1. Low harmonics get
  // the lion's share (they are the circuit's overall shape); the high ones are
  // small because at k=9 even a modest amplitude produces a corner tighter
  // than any car in the game could take.
  const harmonics = [];
  const budget = biome.trackChaos ?? 0.34;
  const bands = [
    { k: 2, w: 0.34 }, { k: 3, w: 0.26 }, { k: 4, w: 0.18 },
    { k: 5, w: 0.13 }, { k: 6, w: 0.09 }, { k: 7, w: 0.06 },
    { k: 9, w: 0.04 },
  ];
  let used = 0;
  for (const b of bands) {
    // Skipping a band outright is what stops every circuit feeling like the
    // same lumpy ring: a track with no k=3 term reads as a completely
    // different shape from one dominated by it.
    if (rng.bool(0.22)) continue;
    const amp = budget * b.w * rng.range(0.45, 1.6);
    used += Math.abs(amp);
    harmonics.push({ k: b.k, amp, phase: rng.range(0, TAU) });
  }
  // Renormalise if the random draws overshot the budget.
  if (used > budget * 1.25) {
    const scale = (budget * 1.25) / used;
    for (const h of harmonics) h.amp *= scale;
  }

  const elevation = [];
  const elevAmp = biome.elevation ?? 8;
  // Long harmonics give the circuit its shape; short ones give it crests.
  //
  // This was [1, 2, 3, 5] only — wavelengths of 400 m to a full lap. That is a
  // change of horizon, not a hill: at racing speed you cross a 2 km harmonic in
  // fifty seconds and never feel it. The rolling set is what you actually drive
  // over. Amplitude stays proportional to 1/k, so every harmonic contributes
  // the same maximum gradient and the short ones cannot turn the track into a
  // washboard; the 1.5 is so they are not swamped by the long ones.
  for (const k of [1, 2, 3, 5]) {
    if (rng.bool(0.3)) continue;
    elevation.push({ k, amp: elevAmp * rng.range(0.3, 1) / k, phase: rng.range(0, TAU) });
  }
  for (const k of [8, 13, 21]) {
    if (rng.bool(0.2)) continue;
    elevation.push({ k, amp: elevAmp * rng.range(0.35, 1) / k * 1.5, phase: rng.range(0, TAU) });
  }

  // Three times the control points the radial harmonics alone needed. A k=21
  // elevation term sampled 96 times around the loop is 4.5 samples per cycle,
  // which aliases into a different, lumpier shape than the one asked for.
  const CONTROLS = 288;
  const controls = [];
  for (let i = 0; i < CONTROLS; i++) {
    const th = (i / CONTROLS) * TAU;
    let rMul = 1;
    for (const h of harmonics) rMul += h.amp * Math.sin(h.k * th + h.phase);
    let y = 0;
    for (const e of elevation) y += e.amp * Math.sin(e.k * th + e.phase);
    const r = R * rMul;
    controls.push({ x: Math.sin(th) * r, y, z: Math.cos(th) * r });
  }

  // Cap the steepest gradient the circuit can have.
  //
  // Harmonics sum, so a seed that lines several of them up produces a slope no
  // amount of per-harmonic tuning prevents — inferno reached 33%, a one-in-three
  // ramp. Measuring the assembled controls and scaling once is the only version
  // of this that is actually a guarantee rather than a hope.
  {
    let steepest = 0;
    for (let i = 0; i < controls.length; i++) {
      const a = controls[i];
      const b = controls[(i + 1) % controls.length];
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      if (run > 0.01) steepest = Math.max(steepest, Math.abs(b.y - a.y) / run);
    }
    if (steepest > MAX_GRADE) {
      const k = MAX_GRADE / steepest;
      for (const c of controls) c.y *= k;
    }
  }

  return finishTrack(rng, biome, opts, controls, { harmonics });
}

/**
 * Everything a track needs once its centreline exists.
 *
 * Shared by both generators so a city circuit is a real Track — same width
 * profile, branches, surface zones and start line — rather than a special case
 * the rest of the game has to know about.
 */
function finishTrack(rng, biome, opts, controls, extra = {}) {
  const difficulty = opts.difficulty ?? 0;
  const harmonics = extra.harmonics ?? [];
  const path = new Path(controls, true, 4);

  // --- Width profile -------------------------------------------------------
  // Narrow sections are pressure. They are placed against curvature rather
  // than at random: a pinch on a straight is a non-event, a pinch at the exit
  // of a fast corner is the moment a race is won or lost.
  // Enough samples that the profile can describe the features it is made of.
  //
  // A fixed 128 is one sample every fifteen metres on an outdoor circuit,
  // which is finer than anything out there changes. Indoors the width goes
  // from a room to a doorway and back inside twenty metres, so 128 samples on
  // an 800 m lap stepped straight over the pinch — and the clamp that keeps
  // the road narrower than its own corners was being interpolated around.
  const WSAMPLES = Math.max(128, Math.round(path.length / 3));
  const baseWidth = biome.trackWidth ?? 22;
  const widthProfile = new Float32Array(WSAMPLES);
  for (let i = 0; i < WSAMPLES; i++) {
    const s = (i / WSAMPLES) * path.length;
    let w;
    if (biome.house) {
      // Wide in a room, one car at a door. Where the width comes from is the
      // distance to the nearest doorway, not the curvature — indoors the
      // tightest part of the circuit is the middle of a room, which is where
      // there is the most space.
      const at = path.pointAt(s, { x: 0, y: 0, z: 0 });
      w = houseWidthAt(at.x, at.z, extra.layout?.doorways ?? [],
        baseWidth, DOOR_W / 2 + 0.4);

      // No curvature clamp any more.
      //
      // There was one, and then a second term for the barrier rail outside it,
      // and each fixed one probe by breaking another — which is what it looks
      // like when a constant is standing in for a decision. The decision is the
      // width, and it is made in the biome: at nine units the road is narrower
      // than any corner in this house needs it to be, and nothing has to be
      // clamped at all.

    } else if (biome.city) {
      // A junction is the widest part of a street, not the narrowest. Pinching
      // the road at high curvature is right for a country circuit and exactly
      // backwards here — it would squeeze every corner in the district.
      w = baseWidth * (1 + 0.06 * Math.sin(s * 0.004));
    } else {
      const curv = Math.abs(path.curvatureAt(s, 10));
      const tight = clamp01(curv * 90);
      w = baseWidth * lerp(1.0, 0.78, tight);
      w *= 1 + 0.10 * Math.sin(s * 0.013 + (harmonics[0]?.phase ?? 0));
    }
    w *= lerp(1, 0.88, clamp01(difficulty / 3));
    widthProfile[i] = w;
  }

  // --- Branches ------------------------------------------------------------
  const branches = [];
  const wantBranches = rng.int(2, 4);
  const usedArcs = [];

  // A city shortcut is an alley, not a wider line.
  //
  // The lateral-offset builder below works by pushing the racing line to the
  // inside of a bend, which shortens a sweeping curve. A city corner is a short
  // arc between two long straights, so offsetting across that span leaves the
  // straights exactly as long and adds the lateral excursion on top — every
  // city "shortcut" came out 77 m *longer* than the main line. Cutting the
  // corner diagonally is what actually saves distance here: 120 m round two
  // sides of a right angle against an 85 m hypotenuse.
  if (biome.city) {
    const corners = [];
    const STEP_C = 6;
    for (let s = 0; s < path.length; s += STEP_C) {
      const c = Math.abs(path.curvatureAt(s, 6));
      if (c < 0.012) continue;
      const last = corners[corners.length - 1];
      if (last && Math.abs(path.deltaAlong(last.s, s)) < 60) {
        if (c > last.c) { last.s = s; last.c = c; }
        continue;
      }
      corners.push({ s, c });
    }

    for (const corner of corners) {
      if (branches.length >= wantBranches) break;
      if (rng.bool(0.35)) continue;
      const d = rng.range(52, 78);
      const s0 = wrap(corner.s - d, path.length);
      const s1 = wrap(corner.s + d, path.length);
      if (usedArcs.some((u) => Math.abs(path.deltaAlong(u.s0, s0)) < 120)) continue;

      const a = path.pointAt(s0, { x: 0, y: 0, z: 0 });
      const b = path.pointAt(s1, { x: 0, y: 0, z: 0 });
      const chord = Math.hypot(b.x - a.x, b.z - a.z);
      const span = 2 * d;
      if (span - chord < 18) continue;

      // Straight, with the ends eased onto the racing line so entry and exit
      // are drivable rather than a kerb to hop.
      const pts = [];
      const N = 6;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const lx = a.x + (b.x - a.x) * t;
        const lz = a.z + (b.z - a.z) * t;
        const on = path.pointAt(wrap(s0 + span * t, path.length), { x: 0, y: 0, z: 0 });
        const blend = Math.sin(t * Math.PI) ** 0.6;
        pts.push({
          x: on.x + (lx - on.x) * blend,
          y: on.y,
          z: on.z + (lz - on.z) * blend,
        });
      }
      const bpath = new Path(pts, false, 8);
      usedArcs.push({ s0, s1 });
      branches.push({
        id: `br${branches.length}`,
        kind: BRANCH_KIND.shortcut,
        path: bpath,
        entryS: s0,
        exitS: s1,
        halfWidth: (baseWidth * 0.40) / 2,
        saving: span - bpath.length,
        risky: true,
      });
    }
  }

  // Score every candidate window by how much distance a chord across it would
  // save. A shortcut is only interesting where the main line bends a long way
  // around, so the corners themselves select where shortcuts can exist.
  const STEP = 18;
  const candidates = [];
  if (biome.city) branches.length = Math.min(branches.length, wantBranches);

  // Indoors there is no such thing as a wider line.
  //
  // The builder below shortens a sweeping curve by pushing the racing line to
  // the inside of it. A house has no sweeping curves — it has rooms joined by
  // doors — so every "shortcut" it produced came out between nineteen and a
  // hundred and thirty-seven metres *longer* than the line it was shortening.
  // A real shortcut here is a different door: under the bed, through the cat
  // flap, behind the sofa. That is furniture, and it is not built yet, so for
  // now a house has the pit lane and nothing else.
  const wantOffsets = !biome.house;
  for (let s0 = 0; wantOffsets && s0 < path.length; s0 += STEP) {
    for (const span of [110, 150, 190, 240]) {
      const s1 = s0 + span;
      if (s1 >= path.length) continue;
      const a = path.pointAt(s0, { x: 0, y: 0, z: 0 });
      const b = path.pointAt(s1, { x: 0, y: 0, z: 0 });
      const chord = Math.hypot(b.x - a.x, b.z - a.z);
      if (chord < 30) continue;
      const saving = span / chord;
      // These circuits are built from low harmonics, so most of the lap is
      // gentle sweepers and a 20%-shorter chord almost never exists. Gate on
      // metres saved rather than ratio: ten metres decides a race, and a 3%
      // saving across a short span does not.
      if (saving > 1.03 && span - chord > 10) {
        candidates.push({ s0, s1, span, chord, saving });
      }
    }
  }
  candidates.sort((a, b) => b.saving - a.saving);

  for (const c of candidates) {
    if (biome.city) break;
    if (branches.length >= wantBranches) break;
    // Keep branches clear of each other, or the geometry overlaps and the
    // ownership test in `sample` starts flip-flopping between them.
    if (usedArcs.some((u) => c.s0 < u.s1 + 40 && c.s1 > u.s0 - 40)) continue;
    usedArcs.push({ s0: c.s0, s1: c.s1 });

    const mid = (c.s0 + c.s1) / 2;
    // Which way the corner bends decides which side the inside line is on.
    const bend = path.curvatureAt(mid, 20);
    const inward = bend > 0 ? 1 : -1;

    const kind = rng.bool(0.75) ? BRANCH_KIND.shortcut : BRANCH_KIND.wide;
    const dir = kind === BRANCH_KIND.shortcut ? inward : -inward;

    const pts = [];
    const N = 8;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const s = c.s0 + (c.s1 - c.s0) * t;
      // Ease the offset in and out so the branch leaves and rejoins the racing
      // line tangentially instead of at a corner nobody could drive.
      const bulge = Math.sin(t * Math.PI);
      const depth = (c.span / c.chord - 1) * c.chord * 0.45;
      const lateral = dir * bulge * clamp(depth, 8, 46) * (kind === BRANCH_KIND.wide ? 0.55 : 1);
      const p = path.offsetPoint(s, lateral, { x: 0, y: 0, z: 0 });
      pts.push(p);
    }

    const bpath = new Path(pts, false, 8);
    const isShort = bpath.length < c.span - 4;
    branches.push({
      id: `br${branches.length}`,
      kind,
      path: bpath,
      entryS: c.s0,
      exitS: c.s1,
      halfWidth: (baseWidth * (kind === BRANCH_KIND.shortcut ? 0.42 : 0.52)) / 2,
      // A shortcut has to *be* shorter to deserve its hazards.
      saving: c.span - bpath.length,
      risky: kind === BRANCH_KIND.shortcut && isShort,
    });
  }

  // --- Pit lane ------------------------------------------------------------
  //
  // Not a branch that happened to come out long. A pit lane is a deliberate
  // piece of a circuit: it leaves the racing line on a straight, runs beside
  // it, and rejoins — always slower, because it is not a line, it is a place
  // you go to have something done to the car.
  //
  // It has to be there. Putting pits on whichever branches came out longer than
  // the line they left covered 44% of circuits, and a service the player cannot
  // count on is one they never plan a run around. So every circuit gets one,
  // built here rather than rolled for.
  const pit = buildPitLane(path, usedArcs, startSGuess(path), baseWidth, widthProfile);
  if (pit) branches.push(pit);

  // --- Start line ----------------------------------------------------------
  // Start on the straightest stretch available, so the grid is not stacked
  // into a corner.
  let startS = 0;
  let flattest = Infinity;
  for (let s = 0; s < path.length; s += 20) {
    const c = Math.abs(path.curvatureAt(s, 30));
    if (c < flattest) { flattest = c; startS = s; }
  }

  return new Track({
    path,
    // The layout the centreline came from, kept rather than thrown away: a
    // house has to build its floors and walls around the same rooms the route
    // was threaded through, and rediscovering them from the spline afterwards
    // would be inventing them a second time.
    layout: extra.layout ?? null,
    length: path.length,
    widthProfile,
    baseWidth,
    branches,
    startS,
    biome,
    offTrackSurface: SURFACES[biome.offTrack || 'offroad'] || SURFACES.offroad,
    harmonics,
    seedInfo: {
      // Three layout rules now, and the summary has to name which one ran:
      // a city traced from a block grid, a house threaded through a ring of
      // rooms, or harmonics on a circle.
      layout: extra.layout?.rooms ? 'room ring' : extra.layout ? 'city grid' : 'harmonics',
      blocks: extra.layout?.cells?.size ?? extra.layout?.rooms?.length ?? 0,
      harmonics: harmonics.length,
      branches: branches.length,
    },
  });
}
