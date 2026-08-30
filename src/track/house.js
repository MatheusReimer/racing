import { clamp } from '../core/math.js';

// A circuit through a house.
//
// The car does not change size; the house does. An RC car is about a tenth of
// a real one, so rather than shrink the vehicle — which would invalidate every
// physics constant, every handling probe and every balance run in the project —
// the house is built at ten times life. A 4.6 m kitchen is 46 units across, a
// doorway is 9, and the car that has always been 4.06 units long reads as a
// 1:10 model on a kitchen floor. The top speed cap of 166 does the same trick:
// at this scale it is 16.6 km/h, which is what an RC car does.
//
// The layout is a ring of rooms.
//
//   1. take a rectangle of cells, each cell one room
//   2. the circuit is the *perimeter* ring of those cells
//   3. it enters and leaves each room through a doorway on the shared wall
//
// The perimeter of a rectangle is a single closed loop that never crosses
// itself, which is the same property `city.js` gets from tracing a polyomino
// boundary — except that a city circuit runs *between* the blocks and this one
// runs *through* the rooms. Whatever is in the middle of the rectangle is the
// core of the house: stairs, a chimney, a cupboard. Not drivable, and it is
// what stops the lap being a single open hall.
//
// Everything downstream — `Path`, branches, the start line, props — consumes
// control points and does not care how they were produced.

/** Metres at 1:10, so these read as centimetres of a real house times ten. */
export const ROOM_W = 46;      // 4.6 m across
export const ROOM_D = 40;      // 4.0 m deep
// 1.3 m — a wide door, and deliberately so. At 90 cm the opening was the
// narrowest thing on the circuit by a long way and every lap was eight moments
// of threading a needle. The house is exaggerated; the doors are double.
export const DOOR_W = 13;
export const WALL_H = 26;      // 2.6 m ceiling
export const WALL_T = 2.2;     // a wall you can see the thickness of

/**
 * What each room is, and what that does to the racing.
 *
 * Themed rather than domestic: the brief is stages that happen to be rooms.
 * Order matters — it is the order they are dealt round the ring, so a lap
 * always runs kitchen, hall, bathroom, and the player learns the house.
 */
export const ROOMS = [
  { id: 'kitchen', name: 'Kitchen', floor: 'tile', grip: 0.92,
    note: 'Spilled oil, a boiling pot, and the fridge to go under.' },
  { id: 'hall', name: 'Hallway', floor: 'boards', grip: 1.0,
    note: 'Narrow and fast. The only room with nothing in it.' },
  { id: 'bathroom', name: 'Bathroom', floor: 'tile', grip: 0.78,
    note: 'Flooded. Standing water from the overflowing bath.' },
  { id: 'bedroom', name: 'Bedroom', floor: 'carpet', grip: 1.06,
    note: 'Carpet: grip up, top speed down. Under the bed is the short way.' },
  { id: 'toyroom', name: 'Toy Room', floor: 'boards', grip: 1.0,
    note: 'A track made of building blocks, and a ramp off the toy box.' },
  { id: 'living', name: 'Living Room', floor: 'rug', grip: 0.96,
    note: 'The TV wall, a rug that lifts at the corner, cables to catch a wheel.' },
  { id: 'utility', name: 'Utility', floor: 'concrete', grip: 0.88,
    note: 'Washing machine on spin, and the cat flap out to the garden.' },
  { id: 'study', name: 'Study', floor: 'boards', grip: 1.0,
    note: 'Books stacked into a ramp, and a swivel chair nobody moved.' },
];

const ROOM_BY_ID = Object.fromEntries(ROOMS.map((r) => [r.id, r]));

/** The ring of cells round an `rows` x `cols` rectangle, walked in order. */
function ringCells(rows, cols) {
  const out = [];
  for (let i = 0; i < cols; i++) out.push([i, 0]);
  for (let j = 1; j < rows; j++) out.push([cols - 1, j]);
  for (let i = cols - 2; i >= 0; i--) out.push([i, rows - 1]);
  for (let j = rows - 2; j >= 1; j--) out.push([0, j]);
  return out;
}

/**
 * Where the doorway between two adjacent rooms sits.
 *
 * On the shared wall, and deliberately *not* in the middle of it: a door on
 * the centreline makes every room a straight through-shot, and a door pushed
 * toward one end makes the room a corner. Which end is decided by where the
 * previous door was, so the line through a room is always a diagonal rather
 * than sometimes a diagonal and sometimes a chicane nobody can take.
 */
function doorway(a, b, bias) {
  const ax = a[0] * ROOM_W, az = a[1] * ROOM_D;
  const bx = b[0] * ROOM_W, bz = b[1] * ROOM_D;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  // Along the wall, which is whichever axis the two rooms do *not* differ on.
  // `nx`/`nz` is the way through it, which the route needs so it can enter and
  // leave square rather than turning in the opening.
  if (a[0] === b[0]) {
    return { x: mx + bias * (ROOM_W * 0.22), z: mz, nx: 0, nz: 1 };
  }
  return { x: mx, z: mz + bias * (ROOM_D * 0.22), nx: 1, nz: 0 };
}

/**
 * Take the wiggle out, without moving the doors.
 *
 * The route is assembled from pieces — a sampled arc, three collinear points
 * through a door, another arc — and where two pieces meet the direction
 * changes over a couple of metres. The spline through that has a kink at the
 * scale of its own points, and it does not read as a corner: it reads as the
 * line being nervous.
 *
 * It was also invisible to every measurement until the right one was taken.
 * The minimum corner radius came out 5.3 m for *every* combination of room
 * size, door width, ring size, bulge and street width that was swept — which
 * is the tell, because a number that ignores every input is not measuring the
 * inputs. Measuring the same circuits with a wider curvature window gave 3.3,
 * 5.6, 8.1, 13.0, 21.2, 28.8 metres for windows of 4 to 45: the "radius" was
 * tracking the window. A real corner does not do that — the wasteland's
 * minimum sits at 79 m however it is measured.
 *
 * So: Laplacian smoothing, with the door points pinned. Everything else drifts
 * toward the average of its neighbours and the kinks disappear; the doors do
 * not move, because a route that misses the opening is not a route.
 */
function smooth(pts, passes) {
  const out = pts.map((p) => ({ ...p }));
  const n = out.length;
  for (let k = 0; k < passes; k++) {
    const prev = out.map((p) => ({ ...p }));
    for (let i = 0; i < n; i++) {
      if (out[i].anchor) continue;
      const a = prev[(i - 1 + n) % n];
      const b = prev[(i + 1) % n];
      out[i].x = (a.x + b.x + prev[i].x * 2) / 4;
      out[i].z = (a.z + b.z + prev[i].z * 2) / 4;
    }
  }
  return out;
}

/**
 * Re-space a control polyline evenly.
 *
 * The spline wiggles at the scale of its own control spacing, and this route
 * is built from pieces with very different spacings — four samples along a
 * room's arc, three tight ones through a door. Measured across a sweep of
 * every swing and width worth trying, the minimum corner radius came out 5.2 m
 * *every time*: it was never the shape of the room arc, it was the distance
 * between the points describing it. Points every fourteen metres give a
 * minimum radius set by the layout instead of by the sampling.
 */
function resample(pts, step) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    for (let t = carry; t < len; t += step) {
      out.push({ x: a.x + (dx * t) / len, y: 0, z: a.z + (dz * t) / len });
    }
    carry = ((carry - len) % step + step) % step;
  }
  return out;
}

/**
 * @param opts.rooms  how many rooms to aim for; the ring is sized to fit
 * @returns { controls, cells, doorways, rows, cols } — `controls` is what
 *          `finishTrack` consumes, the rest is what the room builder needs to
 *          put walls and floors around it
 */
export function generateHouseLayout(rng, opts = {}) {
  // A ring of twenty-four to twenty-eight rooms.
  //
  // Bigger than a house, and the reason is the lap. Smoothing the route is
  // what fixed the kinks, and it also flattens the very bulge that was making
  // the lap long — raising the sweep does not help, because the smoothing
  // takes it straight back out. The only thing left that lengthens a lap is
  // more rooms in the ring.
  //
  // Fewer is more house-like and produced laps of 690 to 900 metres, which is
  // a third of what every other circuit runs — a lap the player is round
  // before the field has sorted itself out. The ring has to be big enough that
  // a lap is a lap, and at 1:10 a twenty-room ring is a house about twenty-six
  // metres across, which is a large house rather than an impossible one.
  const cols = opts.cols ?? rng.int(7, 8);
  const rows = opts.rows ?? rng.int(7, 8);
  const cells = ringCells(rows, cols);

  // Deal the themes round the ring in order, starting somewhere different each
  // time so the start line is not always the kitchen door.
  const start = rng.int(0, ROOMS.length - 1);
  const rooms = cells.map((cell, i) => ({
    cell,
    theme: ROOMS[(start + i) % ROOMS.length],
    x: cell[0] * ROOM_W,
    z: cell[1] * ROOM_D,
  }));

  // Centre the plan on the origin, like every other layout here.
  const mx = ((cols - 1) * ROOM_W) / 2;
  const mz = ((rows - 1) * ROOM_D) / 2;

  // What kind of room each one is to drive through.
  //
  // Every room used to be the same: the same sweep, the same doorway offset,
  // the same everything, and a lap was twenty-four identical corners. A
  // circuit needs somewhere to commit and somewhere to recover.
  //
  //   straight — the exit door lines up with the entry door, so the route runs
  //              dead through. Several in a row make a real straight, which is
  //              the thing this layout could not previously produce at all.
  //   soft     — a wide early sweep, the room used as one long curve.
  //   hard     — a late apex, tight, and *anchored* so the smoothing pass
  //              cannot flatten it back into the average of its neighbours.
  //
  // A room where the ring turns a corner is never straight: the route has to
  // change direction there whatever anybody wants.
  const N = rooms.length;
  const turnsHere = (i) => {
    const p0 = rooms[(i - 1 + N) % N].cell;
    const p1 = rooms[i].cell;
    const p2 = rooms[(i + 1) % N].cell;
    return (p1[0] - p0[0]) !== (p2[0] - p1[0]) || (p1[1] - p0[1]) !== (p2[1] - p1[1]);
  };
  const kinds = [];
  let run = 0;
  for (let i = 0; i < N; i++) {
    if (turnsHere(i)) { kinds.push(rng.bool(0.45) ? 'hard' : 'soft'); run = 0; continue; }
    // On a straight side, straights come in runs — one straight room between
    // two curves is not a straight, it is a pause.
    if (run > 0) { kinds.push('straight'); run--; continue; }
    if (rng.bool(0.5)) { run = rng.int(1, 3); kinds.push('straight'); continue; }
    kinds.push(rng.bool(0.4) ? 'hard' : 'soft');
  }

  // Then the doorway offsets, which is where a straight actually comes from.
  //
  // The offsets used to alternate blindly, so even a room with no sweep in it
  // had its two doors at opposite ends of their walls and the route through it
  // was a diagonal. A straight room takes the offset it was entered by.
  const biases = new Array(N);
  biases[N - 1] = rng.bool(0.5) ? 1 : -1;
  for (let i = 0; i < N; i++) {
    const entry = biases[(i - 1 + N) % N];
    biases[i] = kinds[i] === 'straight' ? entry : -entry;
  }

  const controls = [];
  const doorways = [];
  let prev = null;
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i];
    const b = rooms[(i + 1) % rooms.length];
    const kind = kinds[i];
    const d = doorway(a.cell, b.cell, biases[i]);
    const enter = prev
      ?? doorway(rooms[(i - 1 + rooms.length) % rooms.length].cell, a.cell, biases[(i - 1 + N) % N]);

    // The line through a room is a curve, not a diagonal.
    //
    // One waypoint at the room's centre made the shortest possible lap and,
    // worse, made the corner *inside* the room the tightest on the circuit —
    // 5.8 m of radius where the road is 12.5 m wide, which folds the inside
    // edge through itself. It also made a lap 550 m, a fifth of what every
    // other circuit runs.
    //
    // So the route swings out to the far side of the room between the door it
    // came in by and the door it leaves by. That is what a room is for: the
    // long way round the table. It roughly doubles the lap, it opens every
    // corner, and it is the shape the furniture will be placed against.
    const cxr = a.x - mx;
    const czr = a.z - mz;
    const inX = enter.x - mx - cxr;
    const inZ = enter.z - mz - czr;
    const outXd = d.x - mx - cxr;
    const outZd = d.z - mz - czr;
    // Which way the room bulges, and it is not one answer.
    //
    // Swinging every room toward its outside wall was right for the rooms the
    // route runs straight through and badly wrong for the four at the corners
    // of the ring. There the two doors are on *perpendicular* walls, so the
    // route already has to turn ninety degrees; sending it out to the outside
    // corner first turns that into a hairpin, and the tightest corner on the
    // circuit came out under 6 m of radius in a room 18 m wide. Sweeping every
    // constant that could plausibly have caused it — the swing, the width, the
    // control spacing — moved the number by less than a metre, which is what
    // said it was the shape and not the tuning.
    //
    // So a room that is a corner bulges *away from its own corner*, which is
    // the outside of the turn it is already making, and a room the route runs
    // through bulges toward the outside wall for the length.
    const inLen = Math.hypot(inX, inZ) || 1;
    const outLen = Math.hypot(outXd, outZd) || 1;
    const iux = inX / inLen, iuz = inZ / inLen;
    const oux = outXd / outLen, ouz = outZd / outLen;
    const sumX = iux + oux, sumZ = iuz + ouz;
    const sumLen = Math.hypot(sumX, sumZ);

    // The bulge is what makes the lap long enough. Straightening it right out
    // is tempting — fewer curves is the brief — but a route that runs door to
    // door in a straight line makes a lap of 715 m, and the shortest circuit
    // anywhere else in the game is 949. This is the compromise: enough of a
    // sweep through each room to be worth driving, smoothed afterwards so it
    // is a sweep and not a kink.
    // How far out of its way the route goes, per kind. A straight goes none,
    // a soft room is used as one long curve, and a hard one turns late in a
    // smaller space.
    const swing = Math.min(ROOM_W, ROOM_D)
      * (kind === 'straight' ? 0 : kind === 'hard' ? 0.30 : 0.62);
    let mxr; let mzr;
    if (sumLen > 0.35) {
      // A corner room: the doors point somewhere in common, so bulge the
      // opposite way and the turn opens out.
      mxr = cxr - (sumX / sumLen) * swing;
      mzr = czr - (sumZ / sumLen) * swing;
    } else {
      // A through room: the doors are opposite, so use the outside wall.
      const outX = a.cell[0] === 0 ? -1 : a.cell[0] === cols - 1 ? 1 : 0;
      const outZ = a.cell[1] === 0 ? -1 : a.cell[1] === rows - 1 ? 1 : 0;
      const olen = Math.hypot(outX, outZ) || 1;
      mxr = cxr + (outX / olen) * swing;
      mzr = czr + (outZ / olen) * swing;
    }

    // A quadratic through that point. Sampled rather than dropped in as three
    // control points: three points is a hairpin, and the spline through them
    // turned inside a room at 5.6 m of radius where the road is 12 m wide,
    // which folds the inside edge through itself.
    //
    // The control point is `2M - (P0 + P2) / 2`, which is the one that makes
    // the curve pass *through* M at the halfway mark. Getting that expression
    // wrong is how the circuit started crossing itself the second time.
    // How far the arc runs toward each door, and it is a balance with two
    // failure modes on either side of it.
    //
    // Stop short and the join between the arc and the door's straight is a
    // kink: 5.6 m of corner radius where the road is 6.4 m wide, which folds
    // the inside edge through itself. Run too far and the arc's end is *past*
    // where the door's straight starts, so the route goes forward, back and
    // forward again in the space of a metre — invisible in the shape, and it
    // shows up as a projection landing 6.6 m away along the lap from where it
    // started, which is the car's lap position rather than a cosmetic number.
    //
    // So the arc runs most of the way and the straight is sized from what is
    // left, rather than both being constants that happened to fit.
    const ARC_TO_DOOR = 0.62;
    const p0x = cxr + inX * ARC_TO_DOOR, p0z = czr + inZ * ARC_TO_DOOR;
    const p2x = cxr + outXd * ARC_TO_DOOR, p2z = czr + outZd * ARC_TO_DOOR;
    const bx = 2 * mxr - (p0x + p2x) * 0.5;
    const bz = 2 * mzr - (p0z + p2z) * 0.5;
    for (let k = 0; k <= 4; k++) {
      // A hard corner apexes late: the curve is sampled with the parameter
      // biased toward the exit, which is where a driver turns in when the
      // corner is meant to hurt.
      const u0 = k / 4;
      const t = kind === 'hard' ? u0 * u0 : u0;
      const u = 1 - t;
      controls.push({
        x: u * u * p0x + 2 * u * t * bx + t * t * p2x,
        y: 0,
        z: u * u * p0z + 2 * u * t * bz + t * t * p2z,
        // The apex of a hard corner is pinned, or sixty passes of smoothing
        // average it into its neighbours and every corner on the circuit is
        // the same corner again. This is the one place the line stays sharp.
        anchor: kind === 'hard' && k === 2,
      });
    }

    // Which two rooms it joins, so the shell builder knows which wall to cut
    // the opening in rather than guessing from the position.
    doorways.push({
      x: d.x - mx, z: d.z - mz, nx: d.nx, nz: d.nz,
      a: a.cell, b: b.cell,
    });

    // Straight through the opening.
    //
    // A single control point at the door made the spline *turn* at the
    // narrowest place on the circuit: 5.7 m of corner radius in a gap 6.9 m
    // wide, which folds the inside edge through itself and would have the car
    // clipping the frame on the way through every time. Three collinear points
    // — approach, opening, exit — force it square, which is also how anybody
    // drives through a door.
    // Along the way the route is actually going. The wall's normal has no
    // sign of its own, and taking it as given put the approach point on the
    // far side of the door and the exit point on the near side — so the line
    // doubled back through the opening and the circuit self-intersected at
    // every second door.
    // Three quarters of whatever the arc left, so the two can never overlap
    // however the room is proportioned or wherever the door sits on its wall.
    const gap = Math.hypot(outXd, outZd) * (1 - ARC_TO_DOOR);
    const reach = gap * 0.75;
    const sgn = (d.nx * (b.x - a.x) + d.nz * (b.z - a.z)) >= 0 ? 1 : -1;
    for (const k of [-1, 0, 1]) {
      controls.push({
        x: d.x - mx + d.nx * reach * k * sgn,
        y: 0,
        z: d.z - mz + d.nz * reach * k * sgn,
        // Pinned through the smoothing pass: the route has to go through the
        // opening, square, whatever the rest of the line does.
        // Only the opening itself is pinned. Pinning the approach and exit
        // points too held three metres of straight line rigid against the
        // smoothing on either side of every door, and the join to the room's
        // arc stayed a kink: 18 corners a lap against 15, for no gain.
        anchor: k === 0,
      });
    }
    prev = d;
  }

  return {
    controls: resample(smooth(controls, 60), 9),
    rooms: rooms.map((r) => ({ ...r, x: r.x - mx, z: r.z - mz })),
    doorways,
    rows,
    cols,
    roomSize: { w: ROOM_W, d: ROOM_D },
  };
}

/**
 * How wide the track is at a point, for a house.
 *
 * A room is wide and a doorway is one car. Curvature is the wrong thing to
 * measure here for the same reason it is wrong in a city — the tightest part
 * of this circuit is the middle of a room, where there is the most space —
 * so width comes from proximity to a doorway instead.
 */
export function houseWidthAt(x, z, doorways, wide, narrow) {
  let best = Infinity;
  for (const d of doorways) {
    const dx = x - d.x, dz = z - d.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < best) best = dist;
  }
  // The pinch reaches half a room out from the door, not a third.
  //
  // A corner has to have more radius than the track has half-width or the
  // inside edge folds through itself, and the tightest corner on this circuit
  // is where the arc through a room meets the straight through a door. With a
  // short pinch that corner sat in a stretch already back at 85 per cent of
  // full width — 5.8 m of radius in 7.5 m of half-width. Widening the *zone*
  // rather than narrowing the *door* is what fixes it: the door stays a door,
  // and the approach to it is a funnel.
  const t = clamp(best / (ROOM_D * 0.52), 0, 1);
  return narrow + (wide - narrow) * (t * t * (3 - 2 * t));
}

export { ROOM_BY_ID };
