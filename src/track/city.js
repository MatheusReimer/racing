import { RNG } from '../core/rng.js';
import { clamp, TAU } from '../core/math.js';

// City circuits.
//
// The other districts are harmonics on a circle: a closed loop of sweeping
// curves in open country. No amount of street furniture makes that read as a
// city, because a city is not a shape — it is a *grid*. Streets meet at right
// angles, blocks sit between them, and the road is a canyon with walls rather
// than a ribbon in a field.
//
// So the layout is generated the way a city is laid out:
//
//   1. take a grid of blocks
//   2. grow a connected region of them
//   3. the circuit is the **boundary** of that region
//
// The boundary of a simply-connected polyomino is guaranteed to be a single
// closed loop that never crosses itself, which is exactly the property the old
// generator had to test for and hope about. Corners come out at 90 degrees for
// free, and are then filleted to something a car can take.
//
// Everything downstream — `Path`, width, barriers, verge, props, traffic —
// consumes control points and does not care how they were produced.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (i, j) => `${i},${j}`;

/** Grow a connected blob of `count` cells from the origin. */
function growRegion(rng, count) {
  const cells = new Set([key(0, 0)]);
  const frontier = [[0, 0]];

  while (cells.size < count && frontier.length) {
    // Bias toward the older frontier so the blob spreads rather than snaking:
    // a snake produces a circuit that doubles back on itself down a one-block
    // corridor, which is a road with a building in the middle of it.
    const idx = rng.int(0, Math.min(frontier.length - 1, 3));
    const [ci, cj] = frontier[idx];
    const [di, dj] = DIRS[rng.int(0, 3)];
    const ni = ci + di;
    const nj = cj + dj;
    if (!cells.has(key(ni, nj))) {
      cells.add(key(ni, nj));
      frontier.unshift([ni, nj]);
    }
    if (rng.bool(0.25)) frontier.splice(idx, 1);
  }
  return cells;
}

/** Bounds of a cell set, with a one-cell margin. */
function bounds(cells) {
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const k of cells) {
    const [i, j] = k.split(',').map(Number);
    i0 = Math.min(i0, i); i1 = Math.max(i1, i);
    j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  return { i0: i0 - 1, i1: i1 + 1, j0: j0 - 1, j1: j1 + 1 };
}

/**
 * Fill enclosed holes.
 *
 * A hole makes the boundary two loops instead of one, and the circuit would
 * silently become whichever the tracer happened to find first.
 */
function fillHoles(cells) {
  const b = bounds(cells);
  const outside = new Set();
  const stack = [[b.i0, b.j0]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const k = key(i, j);
    if (outside.has(k) || cells.has(k)) continue;
    if (i < b.i0 || i > b.i1 || j < b.j0 || j > b.j1) continue;
    outside.add(k);
    for (const [di, dj] of DIRS) stack.push([i + di, j + dj]);
  }
  for (let i = b.i0; i <= b.i1; i++) {
    for (let j = b.j0; j <= b.j1; j++) {
      const k = key(i, j);
      if (!cells.has(k) && !outside.has(k)) cells.add(k);
    }
  }
}

/**
 * Remove diagonal pinch points.
 *
 * Two cells touching only at a corner give that grid vertex four boundary
 * edges, and the boundary is then a figure-of-eight rather than a loop. On the
 * road that is two streets crossing at a point with no junction — the tracer
 * cannot resolve it and the car would drive through the crossing. Filling one
 * of the two empty diagonals turns the pinch into a proper corner.
 */
function fixPinches(cells) {
  for (let pass = 0; pass < 40; pass++) {
    let fixed = 0;
    const b = bounds(cells);
    for (let i = b.i0; i <= b.i1; i++) {
      for (let j = b.j0; j <= b.j1; j++) {
        // The four cells meeting at grid vertex (i, j).
        const a = cells.has(key(i - 1, j - 1));
        const c = cells.has(key(i, j - 1));
        const d = cells.has(key(i - 1, j));
        const e = cells.has(key(i, j));
        if (a && e && !c && !d) { cells.add(key(i, j - 1)); fixed++; }
        else if (c && d && !a && !e) { cells.add(key(i - 1, j - 1)); fixed++; }
      }
    }
    if (!fixed) return;
  }
}

/** Chain the region's boundary edges into a single closed loop of vertices. */
function traceBoundary(cells) {
  // Every cell edge with no cell on the far side is on the boundary.
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const k of cells) {
    const [i, j] = k.split(',').map(Number);
    if (!cells.has(key(i, j - 1))) { link(key(i, j), key(i + 1, j)); link(key(i + 1, j), key(i, j)); }
    if (!cells.has(key(i, j + 1))) { link(key(i, j + 1), key(i + 1, j + 1)); link(key(i + 1, j + 1), key(i, j + 1)); }
    if (!cells.has(key(i - 1, j))) { link(key(i, j), key(i, j + 1)); link(key(i, j + 1), key(i, j)); }
    if (!cells.has(key(i + 1, j))) { link(key(i + 1, j), key(i + 1, j + 1)); link(key(i + 1, j + 1), key(i + 1, j)); }
  }

  for (const [, list] of adj) {
    // Degree is 2 on a clean boundary. Anything else means a pinch survived and
    // the caller should regenerate rather than trace a figure-of-eight.
    if (list.length !== 2) return null;
  }

  const start = adj.keys().next().value;
  if (!start) return null;
  const loop = [start];
  let prev = null;
  let cur = start;
  for (let guard = 0; guard < adj.size + 2; guard++) {
    const [a, b] = adj.get(cur);
    const next = a === prev ? b : a;
    if (next === start) break;
    loop.push(next);
    prev = cur;
    cur = next;
  }
  return loop.length === adj.size ? loop : null;
}

/** Drop vertices that lie on a straight run, leaving only the corners. */
function cornersOnly(loop) {
  const pts = loop.map((k) => k.split(',').map(Number));
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    const d1i = Math.sign(b[0] - a[0]);
    const d1j = Math.sign(b[1] - a[1]);
    const d2i = Math.sign(c[0] - b[0]);
    const d2j = Math.sign(c[1] - b[1]);
    if (d1i !== d2i || d1j !== d2j) out.push(b);
  }
  return out;
}

/**
 * Build the drivable centreline: straights joined by filleted corners.
 *
 * A 90-degree corner taken literally is a stop. The fillet radius is what makes
 * a junction a corner you carry speed through, and it is clamped to the shorter
 * of the two streets meeting there so a short block cannot produce an arc
 * longer than the street it is cutting.
 */
function buildCentreline(corners, cw, ch, radius, spacing) {
  const P = corners.map(([i, j]) => ({ x: i * cw, z: j * ch }));
  const n = P.length;
  const pts = [];

  const push = (x, z) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last.x - x, last.z - z) < spacing * 0.35) return;
    pts.push({ x, z });
  };

  for (let i = 0; i < n; i++) {
    const prev = P[(i - 1 + n) % n];
    const cur = P[i];
    const next = P[(i + 1) % n];

    const inLen = Math.hypot(cur.x - prev.x, cur.z - prev.z);
    const outLen = Math.hypot(next.x - cur.x, next.z - cur.z);
    const r = Math.min(radius, inLen * 0.42, outLen * 0.42);

    const inX = (cur.x - prev.x) / inLen;
    const inZ = (cur.z - prev.z) / inLen;
    const outX = (next.x - cur.x) / outLen;
    const outZ = (next.z - cur.z) / outLen;

    // Straight from the end of the previous fillet to the start of this one.
    const startX = prev.x + inX * Math.min(radius, inLen * 0.42);
    const startZ = prev.z + inZ * Math.min(radius, inLen * 0.42);
    const endX = cur.x - inX * r;
    const endZ = cur.z - inZ * r;
    const runLen = Math.hypot(endX - startX, endZ - startZ);
    const steps = Math.max(1, Math.round(runLen / spacing));
    for (let k = 0; k <= steps; k++) {
      push(startX + (endX - startX) * (k / steps), startZ + (endZ - startZ) * (k / steps));
    }

    // The fillet itself, as a quarter-circle between the two tangent points.
    const cx = cur.x - inX * r + outX * r * 0 + (-inX + outX) * 0;
    void cx;
    const t0x = cur.x - inX * r;
    const t0z = cur.z - inZ * r;
    const t1x = cur.x + outX * r;
    const t1z = cur.z + outZ * r;
    // Centre of the arc: from each tangent point, perpendicular to its street.
    // For axis-aligned streets meeting at 90 degrees this is simply the corner
    // of the square the two tangent points span.
    const ccx = t0x + (t1x - cur.x);
    const ccz = t0z + (t1z - cur.z);
    const a0 = Math.atan2(t0z - ccz, t0x - ccx);
    let a1 = Math.atan2(t1z - ccz, t1x - ccx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    const arcSteps = Math.max(3, Math.round((Math.abs(sweep) * r) / (spacing * 0.6)));
    for (let k = 1; k <= arcSteps; k++) {
      const a = a0 + sweep * (k / arcSteps);
      push(ccx + Math.cos(a) * r, ccz + Math.sin(a) * r);
    }
  }
  return pts;
}

/** Even out a closed polyline to a fixed step, which is what keeps the spline honest. */
function resample(pts, step) {
  const n = pts.length;
  const seg = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    seg.push(d);
    total += d;
  }
  const count = Math.max(24, Math.round(total / step));
  const out = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (acc + seg[i] < target && i < n - 1) { acc += seg[i]; i++; }
    const t = seg[i] > 1e-6 ? (target - acc) / seg[i] : 0;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

/**
 * Generate a city circuit.
 *
 * @returns { controls, cells, cellSize, corners } — `controls` feeds `Path`;
 *          `cells` and `corners` let the world builder fill the blocks.
 */
export function generateCityLayout(rng, opts = {}) {
  const cw = opts.blockWidth ?? 190;
  const ch = opts.blockDepth ?? 155;
  const radius = opts.cornerRadius ?? 26;
  const spacing = opts.spacing ?? 9;
  const targetCells = opts.blocks ?? rng.int(7, 12);

  // Retry rather than hope. A blob can come out with a topology the tracer
  // cannot resolve; regenerating is cheap and a silent bad trace is not.
  for (let attempt = 0; attempt < 24; attempt++) {
    const cells = growRegion(rng, targetCells);
    fillHoles(cells);
    fixPinches(cells);
    fillHoles(cells);

    const loop = traceBoundary(cells);
    if (!loop || loop.length < 8) continue;

    const corners = cornersOnly(loop);
    if (corners.length < 6) continue;

    let flat = buildCentreline(corners, cw, ch, radius, spacing);
    if (flat.length < 40) continue;

    // Resample to a uniform arc-length step.
    //
    // The centreline comes out of `buildCentreline` with straights sampled at
    // one spacing and fillets at another, and a Catmull-Rom through unevenly
    // spaced points overshoots at the joins. That overshoot measured as a 6.4 m
    // radius on a circuit whose tightest real corner is 26 m — a curvature
    // spike that exists in the spline and not in the road.
    flat = resample(flat, spacing);

    // Centre it on the origin, and give the streets a gentle rise and fall.
    // A city is not flat, but it is nothing like the open country: a couple of
    // metres over a block, no more.
    let mx = 0, mz = 0;
    for (const p of flat) { mx += p.x; mz += p.z; }
    mx /= flat.length; mz /= flat.length;

    const elev = opts.elevation ?? 6;
    const phase = rng.range(0, TAU);
    const controls = flat.map((p, i) => {
      const t = (i / flat.length) * TAU;
      const y = Math.sin(t * 2 + phase) * elev * 0.10
        + Math.sin(t * 5 + phase * 1.7) * elev * 0.05;
      return { x: p.x - mx, y, z: p.z - mz };
    });

    return {
      controls,
      cells,
      corners: corners.map(([i, j]) => ({ x: i * cw - mx, z: j * ch - mz })),
      cellSize: { w: cw, d: ch },
      origin: { x: mx, z: mz },
    };
  }
  return null;
}
