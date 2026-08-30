import { RNG } from '../core/rng.js';
import { assignPit } from '../race/pits.js';
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
  // The pit lane is a branch, but it is not a line: it is drawn differently and
  // labelled, so it comes out of the list separately.
  const laneBranch = (track.branches ?? []).find((b) => b.isPit) ?? null;
  const branches = (track.branches ?? [])
    .filter((b) => !b.isPit).map((b) => b.path.points);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const set of [main, ...branches, ...(laneBranch ? [laneBranch.path.points] : [])]) {
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

  // The same fork the race uses, off the same seed, so this is the service the
  // race will actually offer rather than a second roll of the same dice.
  const pitService = assignPit(new RNG(seed).fork('pit'), track, opts.racer ?? null);

  return {
    outline: main.map(to),
    branches: branches.map((set) => set.map(to)),
    // The lane and what it sells, so the briefing can say both before the
    // player is doing 200 km/h towards the entry.
    pitLane: laneBranch ? laneBranch.path.points.map(to) : null,
    pitService: pitService?.service ?? null,
    start: to(start),
    // The direction the grid faces, in the same flipped frame as the outline,
    // so a marker can be drawn across the road rather than along it.
    startAngle: Math.atan2(to(ahead).y - to(start).y, to(ahead).x - to(start).x),
    stats: measure(track),
  };
}

/**
 * Every corner on a circuit, in order, as something a pace note could read.
 *
 * The same curvature walk `measure` does, kept rather than counted: where the
 * corner starts, which way it goes, and how tight it gets at its worst. A
 * driver approaching a bend wants those three and nothing else.
 */
export function findCorners(track) {
  const pts = track.path.points;
  const cum = track.path.cum;
  const n = pts.length;
  const out = [];

  let run = null;
  const close = () => {
    if (run && run.length >= CORNER_MIN_LENGTH) out.push({
      s: run.s,
      // Signed: negative turns left, positive right, in the same frame the
      // road's own normal uses.
      direction: run.turn < 0 ? -1 : 1,
      radius: Math.round(run.tightest),
      length: Math.round(run.length),
    });
    run = null;
  };

  // Twice around, so a corner that straddles the start line is found whole
  // rather than as two stubs. The second lap only closes what the first began.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      const ax = b.x - a.x, az = b.z - a.z;
      const bx = c.x - b.x, bz = c.z - b.z;
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) continue;

      const cross = ax * bz - az * bx;
      let turn = Math.acos(Math.min(1, Math.max(-1, (ax * bx + az * bz) / (la * lb))));
      if (turn < 1e-6) turn = 1e-6;
      const radius = ((la + lb) / 2) / turn;

      if (radius < CORNER_RADIUS) {
        // Where this point *is*, not what fraction of the list it is.
        //
        // `(i / n) * length` assumes the polyline is evenly spaced, and it is
        // not: the resampler puts points where the curve needs them. On the
        // circuits that existed when this was written the error was small
        // enough to hide; on a house — a lap of tight door straights and open
        // room arcs — a corner's reported start landed before the end of the
        // one before it, and the briefing had two corners overlapping.
        if (!run) {
          run = {
            s: cum ? cum[i] : (i / n) * track.length,
            length: 0, tightest: radius, turn: cross,
          };
        }
        run.length += lb;
        if (radius < run.tightest) { run.tightest = radius; run.turn = cross; }
      } else {
        if (pass === 1 && run && run.s >= track.length - (track.length / n)) { close(); continue; }
        close();
      }
      if (pass === 1 && out.length && run === null) break;
    }
  }
  close();

  // The wrap pass can find the same corner twice.
  const seen = new Set();
  const list = out.filter((c) => {
    const k = Math.round(c.s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.s - b.s);

  // A corner across the start line is found as two: a tail at station zero and
  // a head near the lap's end. Whichever the walk saw first keeps the length.
  if (list.length > 1) {
    const last = list[list.length - 1];
    const first = list[0];
    if (last.s + last.length > track.length && first.s < (last.s + last.length) - track.length + 1) {
      last.length = Math.round(last.length + first.length);
      last.radius = Math.min(last.radius, first.radius);
      list.shift();
    }
  }
  return list;
}

/** What to call a corner, from how tight it gets. */
export function cornerName(radius) {
  if (radius < 26) return 'hairpin';
  if (radius < 48) return 'sharp';
  if (radius < 85) return 'medium';
  return 'easy';
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
    // Not the pit lane: it is a branch in the geometry but it is not a line
    // anyone drives for pace, and counting it told the briefing there was one
    // more shortcut than the circuit has.
    shortcuts: (track.branches ?? []).filter((b) => !b.isPit).length,
    climb: Math.round(maxY - minY),
    width: Math.round(track.baseWidth),
  };
}
