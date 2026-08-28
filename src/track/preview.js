import { RNG } from '../core/rng.js';
import { generateTrack } from './track.js';

// What a circuit looks like from above, and what is true about it.
//
// The pre-race briefing used to be four numbers — laps, rivals, difficulty,
// durability — which says what the race costs and nothing about what it is.
// A circuit has a shape, and the shape is the thing a driver wants: whether it
// is a fast loop or a technical one, where the shortcuts leave the road, how
// far it actually is.
//
// The track is generated from the race's own seed with the same options the
// simulation will use, so this is not an impression of the circuit — it is the
// circuit. `generateTrack` costs about seven milliseconds and builds no meshes,
// which is affordable on a screen the player is reading.

// A corner is anything this tight; above it the road is a sweep.
//
// 130 m, not the 22 m `tools/track-probe.mjs` calls a sharp corner. That
// threshold asks whether a corner is tight enough to be a problem; this one
// asks whether a driver would call it a corner at all, on a road twenty metres
// wide at a hundred and fifty. At 70 m half the circuits reported none, which
// is not what any of them look like from above.
const CORNER_RADIUS = 130;

/** Ignore wobbles shorter than this; a corner is a stretch of road. */
const CORNER_MIN_LENGTH = 18;

/**
 * Generate a race's circuit and reduce it to a drawable outline and some facts.
 *
 * @param seed     the race seed — the same string `RaceSim` is given
 * @param biome    the biome the race is set in
 * @param opts     `difficulty` and `lengthScale`, as `RaceSim` passes them
 * @returns        outline and branches in a 0..100 box, y already flipped for
 *                 screen coordinates, plus the circuit's measurements
 */
export function previewTrack(seed, biome, opts = {}) {
  // `RaceSim` forks its own RNG for the track. Forking the same way off the
  // same seed is what makes this the circuit that will actually be raced,
  // rather than a different one drawn from the same family.
  const track = generateTrack(new RNG(seed).fork('track'), biome, {
    difficulty: opts.difficulty ?? 0,
    lengthScale: opts.lengthScale ?? 1,
  });

  const main = track.path.points;
  const branches = (track.branches ?? []).map((b) => b.path.points);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const set of [main, ...branches]) {
    for (const p of set) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  // One scale for both axes: a circuit squashed to fill a box is not the shape
  // of the circuit, and the shape is the whole point of drawing it.
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const offX = (span - (maxX - minX)) / 2;
  const offZ = (span - (maxZ - minZ)) / 2;
  const to = (p) => ({
    x: ((p.x - minX + offX) / span) * 100,
    // Z grows north in the world and down the screen in SVG.
    y: 100 - ((p.z - minZ + offZ) / span) * 100,
  });

  const start = track.path.pointAt ? track.path.pointAt(track.startS ?? 0) : main[0];
  const ahead = track.path.pointAt
    ? track.path.pointAt((track.startS ?? 0) + 12) : main[1];

  return {
    outline: main.map(to),
    branches: branches.map((set) => set.map(to)),
    start: to(start),
    // The direction the grid faces, in the same flipped frame as the outline,
    // so a marker can be drawn across the road rather than along it.
    startAngle: Math.atan2(to(ahead).y - to(start).y, to(ahead).x - to(start).x),
    stats: measure(track),
  };
}

/** Length, corners and climb — the things a circuit is described by. */
function measure(track) {
  const pts = track.path.points;
  const n = pts.length;

  let corners = 0;
  let tightest = Infinity;
  let run = 0;          // how much road we have been turning tightly for
  let minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;

    const ax = b.x - a.x, az = b.z - a.z;
    const bx = c.x - b.x, bz = c.z - b.z;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;

    // Turn angle between the two segments, and the radius that implies.
    let turn = Math.acos(Math.min(1, Math.max(-1,
      (ax * bx + az * bz) / (la * lb))));
    if (turn < 1e-6) turn = 1e-6;
    const radius = ((la + lb) / 2) / turn;
    if (radius < tightest) tightest = radius;

    if (radius < CORNER_RADIUS) {
      run += lb;
    } else {
      // A corner is counted when it ends, and only if it lasted.
      if (run >= CORNER_MIN_LENGTH) corners++;
      run = 0;
    }
  }
  if (run >= CORNER_MIN_LENGTH) corners++;

  return {
    length: Math.round(track.length),
    corners,
    tightest: Math.round(tightest),
    shortcuts: (track.branches ?? []).length,
    climb: Math.round(maxY - minY),
    width: Math.round(track.baseWidth),
  };
}
