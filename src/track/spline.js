import { clamp, wrap, TAU } from '../core/math.js';

// Arc-length-parameterised centreline.
//
// Everything in a race is expressed as a distance along this curve: lap
// progress, AI lookahead, where a shortcut rejoins, how far off-line the player
// is, where to respawn. So the curve has to answer two questions cheaply and
// exactly, thousands of times a second:
//
//   pointAt(s)          — where am I `s` metres along the track?
//   project(x, z)       — given a world position, what `s` is it nearest, and
//                         how far to the side?
//
// A raw Catmull-Rom spline answers neither: its parameter `t` is not distance,
// and inverting it is not analytic. So we sample it densely once at build time
// into a polyline, build a cumulative length table, and answer both questions
// against that. The polyline is the source of truth from then on.

/** Centripetal Catmull-Rom. Alpha 0.5 avoids the cusps a uniform spline makes. */
function catmullRom(p0, p1, p2, p3, t, out) {
  const t2 = t * t;
  const t3 = t2 * t;
  out.x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
    (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
    (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
    (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
    (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t +
    (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
    (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  return out;
}

export class Path {
  /**
   * @param controls  [{x, y, z}] control points
   * @param closed    loop back to the start
   * @param samplesPerSegment  higher = truer arc length, more memory
   */
  constructor(controls, closed = true, samplesPerSegment = 14) {
    this.controls = controls;
    this.closed = closed;
    this._build(samplesPerSegment);
  }

  _build(sps) {
    const c = this.controls;
    const n = c.length;
    const pts = [];
    const tmp = { x: 0, y: 0, z: 0 };

    const segCount = this.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = c[this.closed ? wrap(i - 1, n) : Math.max(0, i - 1)];
      const p1 = c[this.closed ? wrap(i, n) : i];
      const p2 = c[this.closed ? wrap(i + 1, n) : Math.min(n - 1, i + 1)];
      const p3 = c[this.closed ? wrap(i + 2, n) : Math.min(n - 1, i + 2)];
      for (let j = 0; j < sps; j++) {
        catmullRom(p0, p1, p2, p3, j / sps, tmp);
        pts.push({ x: tmp.x, y: tmp.y, z: tmp.z });
      }
    }
    if (!this.closed) pts.push({ ...c[n - 1] });

    // Cumulative arc length over the polyline.
    const m = pts.length;
    const cum = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % m];
      // On an open path the final "segment" back to the start does not exist.
      const d = (!this.closed && i === m - 1) ? 0 : Math.hypot(b.x - a.x, b.z - a.z);
      cum[i + 1] = cum[i] + d;
    }

    this.points = pts;
    this.cum = cum;
    this.length = cum[m];

    // Per-sample unit tangent, precomputed: every frame needs it and the
    // central difference is not free.
    const tan = new Float32Array(m * 2);
    for (let i = 0; i < m; i++) {
      const a = pts[this.closed ? wrap(i - 1, m) : Math.max(0, i - 1)];
      const b = pts[this.closed ? wrap(i + 1, m) : Math.min(m - 1, i + 1)];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      tan[i * 2] = dx / len;
      tan[i * 2 + 1] = dz / len;
    }
    this.tangents = tan;

    this._buildGrid();
  }

  /**
   * Uniform bucket grid over the sample points, so `project` touches a handful
   * of candidates instead of all several thousand. Rebuilt with the path.
   */
  _buildGrid() {
    const pts = this.points;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.z > maxZ) maxZ = p.z;
    }
    const pad = 60;
    this.gridMinX = minX - pad;
    this.gridMinZ = minZ - pad;
    this.cell = 24;
    this.gridW = Math.max(1, Math.ceil((maxX - minX + pad * 2) / this.cell));
    this.gridH = Math.max(1, Math.ceil((maxZ - minZ + pad * 2) / this.cell));

    const buckets = new Array(this.gridW * this.gridH);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // A sample is registered in its own cell and the ring around it, so a
      // query never has to look at neighbours to find the true nearest.
      const cx = Math.floor((p.x - this.gridMinX) / this.cell);
      const cz = Math.floor((p.z - this.gridMinZ) / this.cell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx, gz = cz + dz;
          if (gx < 0 || gz < 0 || gx >= this.gridW || gz >= this.gridH) continue;
          const k = gz * this.gridW + gx;
          (buckets[k] || (buckets[k] = [])).push(i);
        }
      }
    }
    this.buckets = buckets;
  }

  /** Sample index and local fraction for a distance `s` along the path. */
  _locate(s) {
    const L = this.length;
    if (this.closed) s = wrap(s, L);
    else s = clamp(s, 0, L);

    const cum = this.cum;
    // Binary search the cumulative table.
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLen = cum[lo + 1] - cum[lo];
    const f = segLen > 1e-9 ? (s - cum[lo]) / segLen : 0;
    return { i: lo, f };
  }

  /** World position at distance `s`. */
  pointAt(s, out = { x: 0, y: 0, z: 0 }) {
    const { i, f } = this._locate(s);
    const m = this.points.length;
    const a = this.points[i % m];
    const b = this.points[(i + 1) % m];
    out.x = a.x + (b.x - a.x) * f;
    out.y = a.y + (b.y - a.y) * f;
    out.z = a.z + (b.z - a.z) * f;
    return out;
  }

  /** Unit tangent (direction of travel) at distance `s`. */
  tangentAt(s, out = { x: 0, z: 0 }) {
    const { i, f } = this._locate(s);
    const m = this.points.length;
    const i0 = i % m;
    const i1 = (i + 1) % m;
    const t = this.tangents;
    let dx = t[i0 * 2] + (t[i1 * 2] - t[i0 * 2]) * f;
    let dz = t[i0 * 2 + 1] + (t[i1 * 2 + 1] - t[i0 * 2 + 1]) * f;
    const len = Math.hypot(dx, dz) || 1;
    out.x = dx / len;
    out.z = dz / len;
    return out;
  }

  /** Heading in radians at `s`, in the same convention the vehicle uses. */
  yawAt(s) {
    const t = this.tangentAt(s);
    return Math.atan2(t.x, t.z);
  }

  /**
   * Signed curvature at `s`, in 1/metres. Positive turns right. The AI uses
   * this to decide how much to slow down for what is coming.
   */
  curvatureAt(s, h = 6) {
    const a = this.tangentAt(s - h);
    const b = this.tangentAt(s + h);
    // Cross product of the two tangents gives the signed angle between them.
    const cross = a.x * b.z - a.z * b.x;
    const dot = clamp(a.x * b.x + a.z * b.z, -1, 1);
    const angle = Math.atan2(cross, dot);
    return -angle / (2 * h);
  }

  /**
   * Nearest point on the path to (x, z).
   * @returns { s, dist, side } where `side` is the signed lateral offset:
   *          negative is left of the direction of travel, positive is right.
   */
  project(x, z, out = { s: 0, dist: 0, side: 0 }) {
    const gx = Math.floor((x - this.gridMinX) / this.cell);
    const gz = Math.floor((z - this.gridMinZ) / this.cell);

    let best = -1;
    let bestD2 = Infinity;

    // The nine buckets around the query, not the one it lands in.
    //
    // A bucket holds the polyline's *points*, and the nearest point to a query
    // sitting near a bucket edge is very often in the bucket next door — or in
    // none at all, when the resampler left a long straight with its points far
    // apart. One bucket was enough for circuits whose points are evenly spread;
    // a house is door straights and room arcs, and the round trip from a point
    // on the centreline back to its own `s` came out 6.6 m wrong, which is a
    // car and a half of lap position.
    for (let dz2 = -1; dz2 <= 1; dz2++) {
      const cz = gz + dz2;
      if (cz < 0 || cz >= this.gridH) continue;
      for (let dx2 = -1; dx2 <= 1; dx2++) {
        const cx = gx + dx2;
        if (cx < 0 || cx >= this.gridW) continue;
        const list = this.buckets[cz * this.gridW + cx];
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          const p = this.points[i];
          const ddx = p.x - x, ddz = p.z - z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      }
    }

    // Off the grid entirely (far off track, or a projectile that left the
    // world): fall back to a strided scan, then refine around the winner.
    if (best < 0) {
      const m = this.points.length;
      const stride = Math.max(1, Math.floor(m / 256));
      for (let i = 0; i < m; i += stride) {
        const p = this.points[i];
        const dx = p.x - x, dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      for (let i = best - stride; i <= best + stride; i++) {
        const j = wrap(i, m);
        const p = this.points[j];
        const dx = p.x - x, dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = j; }
      }
    }

    // Refine onto the segment, so `s` is continuous rather than quantised to
    // the sample spacing — the AI and the lap timer both depend on that.
    const m = this.points.length;
    const a = this.points[best];
    const nextI = this.closed ? wrap(best + 1, m) : Math.min(m - 1, best + 1);
    const prevI = this.closed ? wrap(best - 1, m) : Math.max(0, best - 1);

    let s = this.cum[best];
    let px = a.x, pz = a.z;

    for (const [i0, i1] of [[prevI, best], [best, nextI]]) {
      if (i0 === i1) continue;
      const p = this.points[i0];
      const q = this.points[i1];
      const ex = q.x - p.x, ez = q.z - p.z;
      const segLen2 = ex * ex + ez * ez;
      if (segLen2 < 1e-9) continue;
      const t = clamp(((x - p.x) * ex + (z - p.z) * ez) / segLen2, 0, 1);
      const cx = p.x + ex * t, cz = p.z + ez * t;
      const d2 = (cx - x) * (cx - x) + (cz - z) * (cz - z);
      if (d2 <= bestD2 + 1e-6) {
        bestD2 = d2;
        px = cx; pz = cz;
        // Segment i0->i1 may wrap the cum table; use i0's entry plus the
        // fraction, which is correct in both cases.
        const segLen = Math.sqrt(segLen2);
        s = this.cum[i0] + segLen * t;
      }
    }

    const tan = this.tangentAt(s);
    // Right-hand normal of the tangent, matching the vehicle's right vector.
    const nx = tan.z, nz = -tan.x;
    out.s = this.closed ? wrap(s, this.length) : clamp(s, 0, this.length);
    out.dist = Math.sqrt(bestD2);
    out.side = (x - px) * nx + (z - pz) * nz;
    return out;
  }

  /**
   * World position offset `lateral` metres to the right of the centreline at
   * distance `s`. This is how every prop, rival spawn and pickup is placed.
   */
  offsetPoint(s, lateral, out = { x: 0, y: 0, z: 0 }) {
    this.pointAt(s, out);
    const t = this.tangentAt(s);
    out.x += t.z * lateral;
    out.z += -t.x * lateral;
    return out;
  }

  /** Shortest signed distance from `a` to `b` along a closed path. */
  deltaAlong(a, b) {
    if (!this.closed) return b - a;
    let d = (b - a) % this.length;
    if (d > this.length / 2) d -= this.length;
    if (d < -this.length / 2) d += this.length;
    return d;
  }
}
