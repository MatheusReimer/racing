import { VoxCanvas } from './canvas.js';
import { shade, mix } from './shapes.js';

// Street furniture, on the grid.
//
// These were the last things in the world still sampled from smooth
// primitives, and unlike the buildings they were not *wrong* — a quarter-metre
// cylinder sampled at fifteen centimetres is a two-cell column, which is a
// voxel post whether or not anybody meant it to be. What they were was thin.
// Every one of them was modelled at the scale a real one is, so at the cell
// they got, a traffic light was eighty triangles of nothing much and a lamp
// post was a line.
//
// Built as cells they can be deliberately chunky instead: a post two cells
// square with a visible head, a signal with three lamps you can count, a
// shelter with a bench in it. Which is the whole grammar of this look — things
// are simplified toward the grid rather than shrunk away from it.

/**
 * The cell every piece of street furniture shares.
 *
 * Twenty centimetres, and one size for all of them rather than one scaled to
 * each. These stand next to each other on the same pavement, closer to the
 * player than anything except the cars, and a bin whose cubes are half the
 * size of the lamp post beside it is the thing that reads as sloppy. It is
 * also close to the buildings' four hundred at half the viewing distance, so a
 * kerb and the wall behind it agree about how big a cube is on screen.
 */
const CELL = 0.2;

/** A canvas in metres, at the shared cell, with room to overhang. */
function canvasFor(w, h, d, pad = 0.6) {
  return new VoxCanvas(w + pad * 2, h + pad, d + pad * 2, CELL);
}

/** Where the mass sits, given the margin every canvas leaves around it. */
function frame(C, w, d) {
  const cx = Math.round(C.nx / 2);
  const cz = Math.round(C.nz / 2);
  const hw = Math.max(1, Math.round(w / (2 * CELL)));
  const hd = Math.max(1, Math.round(d / (2 * CELL)));
  return { cx, cz, x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd };
}

const stash = (C, ctx, kind, extra = {}) => {
  ctx.layout = {
    kind, step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims, ...extra,
  };
};

function glowCanvas(layout) {
  if (!layout?.cells) throw new Error('glow canvas needs the body\'s cell dimensions');
  return new VoxCanvas(1, 1, 1, layout.step, {
    origin: [layout.ox, layout.oy, layout.oz], cells: layout.cells,
  });
}

const orNull = (C) => (C.count ? C.geometry() : null);

/**
 * A lamp post.
 *
 * Faces -x, like everything else with a front: the arm reaches out over the
 * road and the head hangs off the end of it. The post is two cells square
 * rather than one, which is the difference between a lamp post and a wire.
 */
export function voxStreetlight(rng, pal, ctx = {}) {
  const h = 8.4 + rng.range(0, 1.6);
  const reach = 2.6;
  const C = canvasFor(reach * 2 + 1.2, h + 0.8, 1.2, 0.6);
  const f = frame(C, 0.4, 0.4);
  const cPost = C.colour(mix(pal.prop ?? 0x3a3f47, 0x22262c, 0.5));
  const cHead = C.colour(shade(pal.accent ?? 0xd8b062, 0.55));

  const top = C.c(h);
  // Base, post, and a taper: three cells at the foot, two up the shaft.
  C.box(f.cx - 2, 0, f.cz - 2, f.cx + 2, C.c(0.5), f.cz + 2, cPost);
  C.box(f.cx - 1, 0, f.cz - 1, f.cx + 1, top, f.cz + 1, cPost);

  // The arm, stepped out and over — a bracket, not a straight cantilever.
  const armEnd = f.cx - C.c(reach);
  for (let i = 0; i <= 2; i++) {
    C.box(f.cx - 1 - Math.round((f.cx - armEnd) * (i / 2)), top - i, f.cz - 1,
      f.cx + 1, top - i + 1, f.cz + 1, cPost);
  }
  // The head, which is the part anybody actually sees lit.
  C.box(armEnd, top - 3, f.cz - 2, armEnd + C.c(1.1), top - 1, f.cz + 2, cHead);

  stash(C, ctx, 'streetlight', { head: { x: armEnd, y: top - 4, z: f.cz - 2, w: C.c(1.1), d: 4 } });
  return C.geometry();
}

voxStreetlight.glow = (rng, layout) => {
  if (!layout?.head) return null;
  const C = glowCanvas(layout);
  const hue = C.colour([0xffe6b0, 0xfff4de, 0xd8e8ff][rng.int(0, 2)]);
  const hd = layout.head;
  // The underside of the head. A lamp is lit on the side facing the road.
  C.box(hd.x, hd.y, hd.z, hd.x + hd.w, hd.y + 1, hd.z + hd.d, hue);
  return orNull(C);
};

/**
 * A signal head on a pole.
 *
 * Three lamps you can count, stacked, in a housing with a peak over each — the
 * peaks are two cells and they are what makes it a traffic light rather than a
 * dark box on a stick.
 */
export function voxTrafficLight(rng, pal, ctx = {}) {
  const h = 4.6 + rng.range(0, 0.8);
  const C = canvasFor(3.6, h + 1.2, 1.2, 0.5);
  const f = frame(C, 0.4, 0.4);
  const cPost = C.colour(0x2b3038);
  const cBox = C.colour(0x1b1f24);

  const top = C.c(h);
  C.box(f.cx - 2, 0, f.cz - 2, f.cx + 2, C.c(0.4), f.cz + 2, cPost);
  C.box(f.cx - 1, 0, f.cz - 1, f.cx + 1, top, f.cz + 1, cPost);
  // A short arm over the road.
  const armEnd = f.cx - C.c(1.5);
  C.box(armEnd, top - 2, f.cz - 1, f.cx + 1, top, f.cz + 1, cPost);

  // The housing, hung under the arm.
  const hx = armEnd;
  const hy = top - 2 - C.c(1.9);
  C.box(hx, hy, f.cz - 2, hx + 3, top - 2, f.cz + 2, cBox);
  const lamps = [];
  for (let i = 0; i < 3; i++) {
    const y = hy + 1 + i * C.c(0.6);
    // A peak over each lamp, sticking out toward the road.
    C.box(hx - 1, y + 2, f.cz - 2, hx, y + 3, f.cz + 2, cBox);
    lamps.push({ x: hx - 1, y, z: f.cz - 1, h: 2, d: 2 });
  }
  stash(C, ctx, 'traffic_light', { lamps });
  return C.geometry();
}

voxTrafficLight.glow = (rng, layout) => {
  if (!layout?.lamps) return null;
  const C = glowCanvas(layout);
  // One of the three, and only one: a signal showing two aspects at once is a
  // fault, and the eye notices even at speed.
  const which = rng.int(0, 2);
  const hue = C.colour([0x28e04a, 0xffc02a, 0xff3524][2 - which]);
  const l = layout.lamps[which];
  C.box(l.x, l.y, l.z, l.x + 1, l.y + l.h, l.z + l.d, hue);
  return orNull(C);
};

/**
 * A vertical neon sign bolted to a wall.
 *
 * Deliberately thick — four cells of housing with the tube standing a cell
 * proud of it — because the whole point of the type is the glow, and a glow
 * with no object behind it reads as a decal.
 */
export function voxNeonSign(rng, pal, ctx = {}) {
  const h = 3.6 + rng.range(0, 1.4);
  const C = canvasFor(1.4, h + 0.6, 1.4, 0.4);
  const f = frame(C, 0.5, 0.5);
  const cBack = C.colour(0x14171c);
  const cRim = C.colour(0x3a4048);

  const top = C.c(h);
  C.box(f.cx, C.c(0.6), f.cz - 2, f.cx + 2, top, f.cz + 2, cBack);
  C.box(f.cx, C.c(0.6), f.cz - 3, f.cx + 1, top, f.cz - 2, cRim);
  C.box(f.cx, C.c(0.6), f.cz + 2, f.cx + 1, top, f.cz + 3, cRim);
  stash(C, ctx, 'neon_sign', {
    tube: { x: f.cx - 1, y: C.c(0.9), z: f.cz - 1, h: top - C.c(1.2), d: 2 },
  });
  return C.geometry();
}

voxNeonSign.glow = (rng, layout) => {
  if (!layout?.tube) return null;
  const C = glowCanvas(layout);
  const hue = C.colour([0xff2e88, 0x2ee8ff, 0xa8ff3a, 0xff8a1e, 0xc46bff][rng.int(0, 4)]);
  const t = layout.tube;
  C.box(t.x, t.y, t.z, t.x + 1, t.y + t.h, t.z + t.d, hue);
  return orNull(C);
};

/**
 * A billboard on two legs.
 *
 * The board is a frame with a recessed face, so the lit panel sits inside
 * something rather than floating in front of it, and a walkway and a row of
 * lamps hang under it the way they do on a real one.
 */
export function voxBillboard(rng, pal, ctx = {}) {
  const w = 9.2, bh = 4.4;
  const legH = 5.4 + rng.range(0, 1.4);
  const C = canvasFor(1.6, legH + bh + 0.8, w, 0.6);
  const f = frame(C, 0.8, w);
  const cFrame = C.colour(mix(pal.prop ?? 0x3a4048, 0x2a2f36, 0.5));
  const cFace = C.colour(0x0d1016);

  const y0 = C.c(legH);
  const y1 = y0 + C.c(bh);
  // Legs.
  for (const z of [f.z0 + 3, f.z1 - 5]) {
    C.box(f.cx - 1, 0, z, f.cx + 1, y0 + 2, z + 2, cFrame);
  }
  // The board: a frame, then the face cut into it.
  C.box(f.cx - 1, y0, f.z0, f.cx + 1, y1, f.z1, cFrame);
  C.box(f.cx - 2, y0 + 1, f.z0 + 1, f.cx, y1 - 1, f.z1 - 1, cFace);
  // A maintenance walkway and the lamps that light the face at night.
  C.box(f.cx - 3, y0 - 1, f.z0, f.cx + 1, y0, f.z1, cFrame);
  const lamps = [];
  for (let i = 0; i < 4; i++) {
    const z = Math.round(f.z0 + ((f.z1 - f.z0) * (i + 0.5)) / 4);
    C.box(f.cx - 4, y0 - 2, z - 1, f.cx - 3, y0 - 1, z + 1, cFrame);
    lamps.push({ x: f.cx - 4, y: y0 - 2, z: z - 1, d: 2 });
  }
  stash(C, ctx, 'billboard', {
    face: { x: f.cx - 2, y: y0 + 1, z: f.z0 + 1, h: (y1 - 1) - (y0 + 1), d: (f.z1 - 1) - (f.z0 + 1) },
    lamps,
  });
  return C.geometry();
}

voxBillboard.glow = (rng, layout) => {
  if (!layout?.face) return null;
  const C = glowCanvas(layout);
  const hue = C.colour([0xff4d6d, 0x38e0ff, 0xffc23a, 0x8b5cff, 0xfff0d2][rng.int(0, 4)]);
  const fc = layout.face;
  C.box(fc.x, fc.y, fc.z, fc.x + 1, fc.y + fc.h, fc.z + fc.d, hue);
  const warm = C.colour(0xfff2d0);
  for (const l of layout.lamps ?? []) C.box(l.x, l.y, l.z, l.x + 1, l.y + 1, l.z + l.d, warm);
  return orNull(C);
};

/**
 * A bus shelter.
 *
 * Open at the front, glazed at the back and the ends, with a bench inside and
 * a lit timetable at one end. Small enough that everything in it is one or two
 * cells, which is exactly the size at which this look works.
 */
export function voxBusStop(rng, pal, ctx = {}) {
  const w = 4.6, h = 2.6, d = 1.6;
  const C = canvasFor(d, h + 0.6, w, 0.5);
  const f = frame(C, d, w);
  const cFrame = C.colour(mix(pal.prop ?? 0x3a4048, 0x596270, 0.5));
  const cGlass = C.colour(0x1a2028);
  const cSeat = C.colour(shade(pal.accent ?? 0xc08040, 0.7));

  const top = C.c(h);
  // Roof, oversailing the front.
  C.box(f.x0 - 2, top, f.z0 - 1, f.x1, top + 1, f.z1 + 1, cFrame);
  // Back wall and ends, glazed between their posts.
  C.box(f.x1 - 1, 0, f.z0, f.x1, top, f.z1, cGlass);
  for (const z of [f.z0, f.z1 - 1]) C.box(f.x0 - 1, 0, z, f.x1, top, z + 1, cGlass);
  for (const z of [f.z0, f.z1 - 1]) C.box(f.x0 - 1, 0, z, f.x0, top, z + 1, cFrame);
  C.box(f.x1 - 1, 0, f.z0, f.x1, top, f.z0 + 1, cFrame);
  C.box(f.x1 - 1, 0, f.z1 - 1, f.x1, top, f.z1, cFrame);
  // The bench.
  C.box(f.x1 - 4, C.c(0.5), f.z0 + 2, f.x1 - 1, C.c(0.7), f.z1 - 2, cSeat);

  stash(C, ctx, 'bus_stop', {
    panel: { x: f.x0 - 1, y: C.c(0.8), z: f.z0, h: C.c(1.4), d: 1 },
    roof: { x: f.x0 - 1, y: top - 1, z: f.z0 + 1, w: f.x1 - f.x0, d: (f.z1 - 1) - (f.z0 + 1) },
  });
  return C.geometry();
}

voxBusStop.glow = (rng, layout) => {
  const C = glowCanvas(layout);
  const warm = C.colour(0xfff0d2);
  const r = layout.roof;
  // A strip under the roof, which is what a shelter actually gives off.
  if (r) C.box(r.x, r.y, r.z, r.x + 1, r.y + 1, r.z + r.d, warm);
  const p = layout.panel;
  if (p && rng.bool(0.7)) {
    C.box(p.x, p.y, p.z, p.x + 1, p.y + p.h, p.z + p.d, C.colour(0xbfe4ff));
  }
  return orNull(C);
};

/** A concrete barrier: a base, a batter, and a top. */
export function voxJerseyBarrier(rng, pal, ctx = {}) {
  const w = 3.0, h = 0.85, d = 0.6;
  const C = canvasFor(d, h + 0.3, w, 0.3);
  const f = frame(C, d, w);
  const c = C.colour(mix(0x9aa0a4, pal.prop ?? 0x8a9096, rng.next() * 0.5));
  const cScuff = C.colour(shade(pal.accent ?? 0xd05030, 0.85));
  const top = C.c(h);
  // The batter, one cell in per course, which is what the profile is.
  const steps = Math.max(2, Math.round(top / 2));
  for (let s = 0; s < steps; s++) {
    const y0 = Math.round((top * s) / steps);
    const y1 = Math.round((top * (s + 1)) / steps);
    const inset = Math.min(1, s);
    C.box(f.x0 + inset, y0, f.z0, f.x1 - inset, y1, f.z1, c);
  }
  // A scuffed band, because these get hit.
  C.box(f.x0, top - 2, f.z0 + 2, f.x0 + 1, top - 1, f.z1 - 2, cScuff);
  stash(C, ctx, 'jersey_barrier');
  return C.geometry();
}

/** A wheelie bin, lid and all. */
export function voxDumpster(rng, pal, ctx = {}) {
  const w = 2.4, h = 1.3, d = 1.3;
  const C = canvasFor(d, h + 0.5, w, 0.3);
  const f = frame(C, d, w);
  const body = mix([0x2f6b48, 0x3a5a7a, 0x6b3a3a, 0x5a5540][rng.int(0, 3)], 0x2a2f36, 0.25);
  const c = C.colour(body);
  const cLid = C.colour(shade(body, 0.7));
  const top = C.c(h);
  C.box(f.x0, C.c(0.2), f.z0, f.x1, top, f.z1, c);
  // A lid, slightly ajar on some of them.
  const tilt = rng.bool(0.35) ? 1 : 0;
  C.box(f.x0 - 1, top + tilt, f.z0 - 1, f.x1 + 1, top + tilt + 1, f.z1 + 1, cLid);
  // Wheels and a lifting bar.
  for (const z of [f.z0 + 1, f.z1 - 2]) {
    C.box(f.x0 + 1, 0, z, f.x0 + 2, C.c(0.2), z + 1, cLid);
    C.box(f.x1 - 2, 0, z, f.x1 - 1, C.c(0.2), z + 1, cLid);
  }
  C.box(f.x0 - 1, Math.round(top * 0.55), f.z0 + 1, f.x0, Math.round(top * 0.55) + 1, f.z1 - 1, cLid);
  stash(C, ctx, 'dumpster');
  return C.geometry();
}

/** A shipping container, corrugated. */
export function voxContainer(rng, pal, ctx = {}) {
  const w = 6.1, h = 2.6, d = 2.4;
  const C = canvasFor(d, h + 0.4, w, 0.3);
  const f = frame(C, d, w);
  const body = [0xa8452f, 0x2f5f8a, 0x3f7a52, 0xb08a2a, 0x8a8a8a][rng.int(0, 4)];
  const c = C.colour(mix(body, 0x3a3a3a, 0.15));
  const cRib = C.colour(shade(body, 0.82));
  const cEnd = C.colour(shade(body, 0.7));
  const top = C.c(h);

  C.box(f.x0, 0, f.z0, f.x1, top, f.z1, c);
  // Corrugation: a rib every other course, standing one cell proud on both
  // long sides. This is the whole reason a container is worth rebuilding — it
  // is the one trackside object whose surface is a repeating pattern at
  // exactly the size of a cell.
  for (let z = f.z0 + 1; z < f.z1 - 1; z += 2) {
    C.box(f.x0 - 1, 1, z, f.x0, top - 1, z + 1, cRib);
    C.box(f.x1, 1, z, f.x1 + 1, top - 1, z + 1, cRib);
  }
  // Corner castings and door furniture at one end.
  for (const x of [f.x0 - 1, f.x1]) {
    for (const z of [f.z0 - 1, f.z1]) {
      C.box(x, 0, z, x + 1, 2, z + 1, cEnd);
      C.box(x, top - 2, z, x + 1, top, z + 1, cEnd);
    }
  }
  C.box(f.x0 - 1, 1, f.z1 - 1, f.x1 + 1, top - 1, f.z1, cEnd);
  for (let i = 0; i < 4; i++) {
    const x = f.x0 + 1 + Math.round(((f.x1 - f.x0 - 2) * i) / 3);
    C.box(x, 2, f.z1, x + 1, top - 2, f.z1 + 1, cRib);
  }
  stash(C, ctx, 'container');
  return C.geometry();
}

/** A wooden crate, slats and all. */
export function voxCrate(rng, pal, ctx = {}) {
  const s = 0.9 + rng.range(0, 0.3);
  const C = canvasFor(s, s + 0.2, s, 0.2);
  const f = frame(C, s, s);
  const wood = mix(0x8a6a42, 0x6a5030, rng.next());
  const c = C.colour(wood);
  const cSlat = C.colour(shade(wood, 0.78));
  const top = C.c(s);
  C.box(f.x0, 0, f.z0, f.x1, top, f.z1, c);
  // Slats: a frame round every face, one cell proud, which at this size is
  // most of what the object is.
  for (const [ax, lo, hi] of [['x', f.x0 - 1, f.x1], ['z', f.z0 - 1, f.z1]]) {
    for (const v of [lo, hi]) {
      if (ax === 'x') {
        C.box(v, 0, f.z0, v + 1, 1, f.z1, cSlat);
        C.box(v, top - 1, f.z0, v + 1, top, f.z1, cSlat);
        C.box(v, 0, f.z0, v + 1, top, f.z0 + 1, cSlat);
        C.box(v, 0, f.z1 - 1, v + 1, top, f.z1, cSlat);
      } else {
        C.box(f.x0, 0, v, f.x1, 1, v + 1, cSlat);
        C.box(f.x0, top - 1, v, f.x1, top, v + 1, cSlat);
      }
    }
  }
  stash(C, ctx, 'crate');
  return C.geometry();
}

/** A marker board on a post. */
export function voxMarker(rng, pal, ctx = {}) {
  const h = 1.9;
  const C = canvasFor(0.6, h + 0.3, 1.4, 0.3);
  const f = frame(C, 0.3, 0.3);
  const cPost = C.colour(0x3a3f47);
  const a = C.colour(pal.accent ?? 0xd05030);
  const b = C.colour(0xe8e4dc);
  const top = C.c(h);
  C.box(f.cx - 1, 0, f.cz - 1, f.cx + 1, top, f.cz + 1, cPost);
  // Chevrons: alternating courses, which is a stripe said in cells.
  const bz0 = f.cz - C.c(0.6);
  const bz1 = f.cz + C.c(0.6);
  const y0 = Math.round(top * 0.42);
  for (let y = y0, i = 0; y < top; y += 2, i++) {
    C.box(f.cx - 2, y, bz0, f.cx, y + 2, bz1, i % 2 ? b : a);
  }
  stash(C, ctx, 'marker');
  return C.geometry();
}

voxStreetlight.glow.fromLayout = true;
voxTrafficLight.glow.fromLayout = true;
voxNeonSign.glow.fromLayout = true;
voxBillboard.glow.fromLayout = true;
voxBusStop.glow.fromLayout = true;
