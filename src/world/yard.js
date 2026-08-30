import { VoxCanvas, disc, ring, lattice } from './canvas.js';
import { shade, mix } from './shapes.js';

// The industrial trackside: drums, tyres, poles, wrecks, sheds, and the
// structures that stand over the road.
//
// The last of the world still being sampled. These are the props a car passes
// within a metre of at two hundred kilometres an hour, which is the one place
// where the difference between a shape drawn for the grid and a shape sampled
// onto it is unmissable — a barrel's rim, a tyre's hole, the corrugations on a
// shed roof are all one cell, and a sampler either finds them or it does not.

/** Same twenty centimetres as the street furniture: they share a verge. */
const CELL = 0.2;
/** For the big structures, which are never within a few metres. */
const BIG_CELL = 0.32;
/**
 * And a finer one for the round things, which are small.
 *
 * The shared-cell argument — that neighbours must agree about how big a cube is
 * — holds between objects of comparable size and breaks completely here. An oil
 * drum is 0.58 m across. At twenty centimetres that is three cells, its hoops
 * cannot stand proud of it without doubling its width, and it came out a metre
 * and a fifth in diameter: twice the size of a real one and no longer readable
 * as a drum. A tyre could not have a hole in it at all.
 *
 * Twelve centimetres gives a drum five cells and a tyre its hole, and these are
 * the props a car passes closest to.
 */
const SMALL_CELL = 0.12;

function canvasFor(w, h, d, cell = CELL, pad = 0.6) {
  return new VoxCanvas(w + pad * 2, h + pad, d + pad * 2, cell);
}

function frame(C) {
  return { cx: Math.round(C.nx / 2), cz: Math.round(C.nz / 2) };
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
 * An oil drum.
 *
 * A stack of discs with two rolling hoops standing a cell proud, and a rim at
 * the top. The hoops are the whole object: they are what says "drum" from ten
 * metres, and they are one cell of radius.
 */
export function voxBarrel(rng, pal, ctx = {}) {
  const h = 0.95 + rng.range(0, 0.2);
  const rad = 0.29;
  const C = canvasFor(rad * 2 + 0.4, h + 0.3, rad * 2 + 0.4, SMALL_CELL, 0.2);
  const f = frame(C);
  const body = [0xc4552e, 0x2f6b8a, 0x4a7a3a, 0xb0902a, 0x8a8a90][rng.int(0, 4)];
  const c = C.colour(mix(body, pal.prop ?? 0x5a5a5a, 0.2));
  const cHoop = C.colour(shade(body, 0.72));
  const cTop = C.colour(shade(body, 1.12));

  const r = Math.max(2, C.c(rad));
  const top = C.c(h);
  disc(C, f.cx, f.cz, r, 0, top, c);
  // Hoops at a third and two thirds, and the rolled edges top and bottom.
  for (const t of [0.3, 0.68]) {
    const y = Math.round(top * t);
    disc(C, f.cx, f.cz, r + 1, y, y + 1, cHoop);
  }
  disc(C, f.cx, f.cz, r + 1, 0, 1, cHoop);
  disc(C, f.cx, f.cz, r + 1, top - 1, top, cHoop);
  disc(C, f.cx, f.cz, r - 1, top, top + 1, cTop);
  stash(C, ctx, 'barrel');
  return C.geometry();
}

/** A stack of tyres: rings, each turned a little from the one below. */
export function voxTyreStack(rng, pal, ctx = {}) {
  const n = 3 + rng.int(0, 2);
  const rad = 0.36;
  const each = 0.26;
  const C = canvasFor(rad * 2 + 0.4, n * each + 0.4, rad * 2 + 0.4, SMALL_CELL, 0.2);
  const f = frame(C);
  const cTyre = C.colour(0x22242a);
  const cWorn = C.colour(0x33363d);
  const r = Math.max(2, C.c(rad));
  const th = Math.max(1, C.c(each));

  for (let i = 0; i < n; i++) {
    // Each one nudged off centre, because a stack nobody has straightened is
    // the only kind there is at the side of a track.
    const ox = rng.int(-1, 1);
    const oz = rng.int(-1, 1);
    const y = i * th;
    ring(C, f.cx + ox, f.cz + oz, r, Math.max(1, r - 2), y, y + th, cTyre);
    // The tread band, a shade lighter, one course round the middle.
    ring(C, f.cx + ox, f.cz + oz, r, r - 1, y + Math.floor(th / 2), y + Math.floor(th / 2) + 1, cWorn);
  }
  stash(C, ctx, 'tyre_stack');
  return C.geometry();
}

/** A utility pole: a crossarm, insulators, and sometimes a transformer. */
export function voxPole(rng, pal, ctx = {}) {
  const h = 7.5 + rng.range(0, 1.5);
  const C = canvasFor(3.4, h + 0.6, 1.2, CELL, 0.4);
  const f = frame(C);
  const wood = mix(0x5a4a38, pal.prop ?? 0x4a4238, 0.4);
  const c = C.colour(wood);
  const cArm = C.colour(shade(wood, 0.78));
  const cIns = C.colour(0x6a7a6a);

  const top = C.c(h);
  C.box(f.cx - 1, 0, f.cz - 1, f.cx + 1, top, f.cz + 1, c);
  // Two crossarms, the lower one shorter.
  for (const [t, half] of [[0.86, C.c(1.5)], [0.72, C.c(1.0)]]) {
    const y = Math.round(top * t);
    C.box(f.cx - half, y, f.cz - 1, f.cx + half, y + 1, f.cz + 1, cArm);
    // Insulators, standing a cell above the arm at each end and the middle.
    for (const x of [f.cx - half + 1, f.cx, f.cx + half - 2]) {
      C.box(x, y + 1, f.cz - 1, x + 1, y + 2, f.cz + 1, cIns);
    }
  }
  if (rng.bool(0.4)) {
    const y = Math.round(top * 0.55);
    C.box(f.cx + 1, y, f.cz - 2, f.cx + 3, y + C.c(0.9), f.cz + 2, C.colour(0x4a5058));
  }
  stash(C, ctx, 'pole');
  return C.geometry();
}

/**
 * A burnt-out car.
 *
 * The one prop that gets to be made by *removing* cells: a body, a cabin, and
 * then holes knocked through the panels and a wheel or two taken off. Which is
 * the same operation a live car now suffers when something hits it, and it
 * makes the wreck look like the end state of that rather than a different kind
 * of object.
 */
export function voxWreck(rng, pal, ctx = {}) {
  const L = 4.0, W = 1.8, H = 1.15;
  const C = canvasFor(W, H + 0.4, L, CELL, 0.3);
  const f = frame(C);
  const paint = mix([0x6a3a30, 0x3a4a5a, 0x5a5240, 0x4a3a4a][rng.int(0, 3)], 0x2a2622, 0.45);
  const c = C.colour(paint);
  const cBurn = C.colour(0x24211f);
  const cRust = C.colour(shade(paint, 0.6));

  const x0 = f.cx - Math.round(C.c(W) / 2);
  const x1 = f.cx + Math.round(C.c(W) / 2);
  const z0 = f.cz - Math.round(C.c(L) / 2);
  const z1 = f.cz + Math.round(C.c(L) / 2);
  const sill = C.c(0.42);
  const roof = C.c(H);

  C.box(x0, sill, z0, x1, sill + C.c(0.35), z1, c);
  // The cabin, set in, and burnt out on top.
  const cz0 = z0 + Math.round((z1 - z0) * 0.28);
  const cz1 = z0 + Math.round((z1 - z0) * 0.72);
  C.box(x0 + 1, sill, cz0, x1 - 1, roof, cz1, cBurn);
  C.box(x0 + 2, sill + 2, cz0 + 1, x1 - 2, roof, cz1 - 1, 0);

  // Wheels: two or three of four, the missing one leaving the corner down.
  const wheels = [[x0, z0 + 2], [x1 - 2, z0 + 2], [x0, z1 - 4], [x1 - 2, z1 - 4]];
  const gone = rng.int(0, 3);
  wheels.forEach(([wx, wz], i) => {
    if (i === gone) return;
    C.box(wx - 1, 0, wz, wx + 3, sill, wz + 3, cBurn);
  });

  // Holes through the panels, and rust round them.
  for (let i = 0; i < 5; i++) {
    const hx = rng.bool(0.5) ? x0 : x1 - 2;
    const hz = z0 + 1 + rng.int(0, Math.max(1, z1 - z0 - 3));
    const hy = sill + rng.int(0, 2);
    C.box(hx - 1, hy, hz, hx + 3, hy + 2, hz + 2, i % 2 ? cRust : 0);
  }
  stash(C, ctx, 'wreck');
  return C.geometry();
}

/**
 * A shack.
 *
 * A lean-to with a corrugated roof — corrugation being a rib every other cell,
 * which is the cheapest strong texture on the grid and the reason a shed reads
 * as tin rather than as a wedge.
 */
export function voxShack(rng, pal, ctx = {}) {
  const w = 3.6 + rng.range(0, 1.2);
  const d = 3.0 + rng.range(0, 1.0);
  const hi = 2.9, lo = 2.1;
  const C = canvasFor(d, hi + 0.6, w, CELL, 0.4);
  const f = frame(C);
  const board = mix(0x6a5a48, pal.prop ?? 0x5a5248, rng.next() * 0.6);
  const c = C.colour(board);
  const cPlank = C.colour(shade(board, 0.8));
  const cRoof = C.colour(mix(0x7a7266, 0x4a4a48, rng.next()));
  const cDoor = C.colour(shade(board, 0.55));

  const x0 = f.cx - Math.round(C.c(d) / 2);
  const x1 = f.cx + Math.round(C.c(d) / 2);
  const z0 = f.cz - Math.round(C.c(w) / 2);
  const z1 = f.cz + Math.round(C.c(w) / 2);

  // Walls, raked from the high side to the low.
  for (let x = x0; x < x1; x++) {
    const t = (x - x0) / (x1 - x0);
    const top = Math.round(C.c(hi) + (C.c(lo) - C.c(hi)) * t);
    C.box(x, 0, z0, x + 1, top, z1, c);
  }
  // Vertical planking: every third cell a shade off, which is board-and-batten
  // said in one fill each.
  for (let z = z0; z < z1; z += 3) {
    C.box(x0 - 1, 0, z, x0, C.c(hi), z + 1, cPlank);
  }
  // The roof, oversailing on all four sides, corrugated along its fall.
  for (let x = x0 - 2; x < x1 + 2; x++) {
    const t = (x - x0) / (x1 - x0);
    const top = Math.round(C.c(hi) + (C.c(lo) - C.c(hi)) * t);
    const rib = (x % 2 === 0) ? 1 : 0;
    C.box(x, top, z0 - 2, x + 1, top + 1 + rib, z1 + 2, cRoof);
  }
  // A door and a window, cut in rather than added on.
  const dz = Math.round((z0 + z1) / 2);
  C.box(x0 - 1, 0, dz - 2, x0 + 1, C.c(2.0), dz + 2, cDoor);
  C.box(x0 - 1, C.c(1.3), z0 + 2, x0 + 1, C.c(1.9), z0 + 5, C.colour(0x1a1f26));
  // A stovepipe.
  C.box(x0 + 2, C.c(hi), z1 - 4, x0 + 4, C.c(hi) + C.c(1.1), z1 - 2, cRoof);
  stash(C, ctx, 'shack');
  return C.geometry();
}

/** A burning drum. The fire is the glow pass; this is the drum and the fuel. */
export function voxBrazier(rng, pal, ctx = {}) {
  const h = 0.9;
  const rad = 0.32;
  const C = canvasFor(rad * 2 + 0.6, h + 1.2, rad * 2 + 0.6, SMALL_CELL, 0.3);
  const f = frame(C);
  const cDrum = C.colour(0x4a3a30);
  const cRust = C.colour(0x6a4a32);
  const cAsh = C.colour(0x2a2622);
  const r = Math.max(2, C.c(rad));
  const top = C.c(h);

  ring(C, f.cx, f.cz, r, r - 1, 0, top, cDrum);
  // Rust runs and a ragged rim: a drum somebody cut the top off with an axe.
  for (let i = 0; i < 5; i++) {
    const a = rng.next() * 6.283;
    const x = f.cx + Math.round(Math.cos(a) * r);
    const z = f.cz + Math.round(Math.sin(a) * r);
    C.box(x, Math.round(top * rng.range(0.2, 0.7)), z, x + 1, top, z + 1, cRust);
    C.box(x, top - 1, z, x + 1, top, z + 1, 0);
  }
  disc(C, f.cx, f.cz, r - 1, 1, 2, cAsh);
  // Logs poking out of the top.
  for (let i = 0; i < 3; i++) {
    const a = rng.next() * 6.283;
    const x = f.cx + Math.round(Math.cos(a) * (r - 1));
    const z = f.cz + Math.round(Math.sin(a) * (r - 1));
    C.box(x, top - 2, z, x + 1, top + 1 + rng.int(0, 1), z + 1, cRust);
  }
  stash(C, ctx, 'brazier', { fire: { x: f.cx, z: f.cz, y: top - 2, r: r - 1 } });
  return C.geometry();
}

voxBrazier.glow = (rng, layout) => {
  if (!layout?.fire) return null;
  const C = glowCanvas(layout);
  const fi = layout.fire;
  const hot = C.colour(0xffd24a);
  const flame = C.colour(0xff6a1e);
  disc(C, fi.x, fi.z, fi.r, fi.y, fi.y + 1, hot);
  // A couple of tongues, each one cell, stepping in as they rise.
  for (let i = 0; i < 4; i++) {
    const a = rng.next() * 6.283;
    const x = fi.x + Math.round(Math.cos(a) * (fi.r - 1));
    const z = fi.z + Math.round(Math.sin(a) * (fi.r - 1));
    C.box(x, fi.y + 1, z, x + 1, fi.y + 2 + rng.int(0, 2), z + 1, flame);
  }
  C.box(fi.x - 1, fi.y + 1, fi.z - 1, fi.x + 1, fi.y + 4, fi.z + 1, flame);
  return orNull(C);
};
voxBrazier.glow.fromLayout = true;

/**
 * The gantry over the road.
 *
 * Built to a nominal eleven-metre half width and scaled per instance by
 * `PropsMesh` — every builder gets the same three arguments and reading a
 * fourth as the span once produced NaN geometry and a bounding-sphere warning
 * with nothing else to show for it. The truss is a lattice: a box with its
 * middle punched out on a pitch, which is closed, is one piece, and is a truss.
 */
export function voxGantry(rng, pal, ctx = {}) {
  const NOMINAL_HALF_WIDTH = 11;
  const span = NOMINAL_HALF_WIDTH * 2 + 4;
  const h = 6.2;
  const C = canvasFor(1.6, h + 1.6, span, BIG_CELL, 0.6);
  const f = frame(C);
  const cSteel = C.colour(0x565c64);
  const cDark = C.colour(0x3a4046);

  const top = C.c(h);
  const z0 = f.cz - Math.round(C.c(span) / 2);
  const z1 = f.cz + Math.round(C.c(span) / 2);
  for (const z of [z0, z1 - 3]) {
    C.box(f.cx - 2, 0, z - 1, f.cx + 2, 2, z + 4, cDark);
    C.box(f.cx - 1, 0, z, f.cx + 1, top, z + 3, cSteel);
  }
  // The truss itself, and a signal box hung under the middle of it.
  lattice(C, f.cx - 1, top, z0, f.cx + 1, top + Math.max(3, C.c(1.1)), z1, cSteel, 5);
  C.box(f.cx - 2, top - 3, f.cz - 4, f.cx + 2, top, f.cz + 4, cDark);
  stash(C, ctx, 'gantry');
  return C.geometry();
}

/** A tower crane: a lattice mast, a jib, and a counterweight. */
export function voxCrane(rng, pal, ctx = {}) {
  const h = 18 + rng.range(0, 5);
  const jib = 14;
  const C = canvasFor(jib + 8, h + 3, 2.6, BIG_CELL, 0.8);
  const f = frame(C);
  const cSteel = C.colour(mix(pal.accent ?? 0xd8a03a, 0x8a7a4a, 0.45));
  const cDark = C.colour(0x3a4046);

  const top = C.c(h);
  const r = 2;
  C.box(f.cx - r - 2, 0, f.cz - r - 2, f.cx + r + 2, 2, f.cz + r + 2, cDark);
  lattice(C, f.cx - r, 0, f.cz - r, f.cx + r, top, f.cz + r, cSteel, 6);
  // The slewing platform, the jib out one side and the counterweight the other.
  C.box(f.cx - r - 1, top, f.cz - r - 1, f.cx + r + 1, top + 3, f.cz + r + 1, cDark);
  const j0 = f.cx + r;
  const j1 = j0 + C.c(jib);
  lattice(C, j0, top + 1, f.cz - 1, j1, top + 3, f.cz + 1, cSteel, 5);
  const c0 = f.cx - r - C.c(4.5);
  C.box(c0, top + 1, f.cz - 2, f.cx - r, top + 3, f.cz + 2, cSteel);
  C.box(c0, top, f.cz - 2, c0 + 3, top + 3, f.cz + 2, cDark);
  // The hoist, hanging somewhere along the jib.
  const hx = j0 + Math.round((j1 - j0) * rng.range(0.4, 0.9));
  C.box(hx, top - C.c(rng.range(3, 9)), f.cz - 1, hx + 1, top + 1, f.cz + 1, cDark);
  stash(C, ctx, 'crane');
  return C.geometry();
}

/** A pipe run on trestles, with a couple of valves and an elbow. */
export function voxPipes(rng, pal, ctx = {}) {
  const len = 20;
  const h = 2.4;
  const C = canvasFor(2.4, h + 0.8, len, BIG_CELL, 0.6);
  const f = frame(C);
  const steel = mix(0x7a7268, pal.prop ?? 0x5a5a5a, rng.next() * 0.6);
  const c = C.colour(steel);
  const cRust = C.colour(mix(steel, 0x8a4a2a, 0.5));
  const cTrestle = C.colour(shade(steel, 0.66));

  const z0 = f.cz - Math.round(C.c(len) / 2);
  const z1 = f.cz + Math.round(C.c(len) / 2);
  const runs = [
    { y: C.c(h), r: 2, x: f.cx - 2 },
    { y: C.c(h) - 1, r: 1, x: f.cx + 2 },
    { y: C.c(h * 0.55), r: 1, x: f.cx },
  ];
  for (const run of runs) {
    for (let z = z0; z < z1; z++) {
      disc(C, run.x, z, run.r, run.y, run.y + 1, c);
    }
    // Flanges: a wider ring every few metres, which is all the detail a pipe
    // has and all it needs.
    for (let z = z0 + 4; z < z1; z += Math.max(4, C.c(4.5))) {
      disc(C, run.x, z, run.r + 1, run.y, run.y + 1, cRust);
    }
  }
  // Trestles under them.
  for (let z = z0 + 2; z < z1; z += Math.max(4, C.c(5))) {
    C.box(f.cx - 3, 0, z, f.cx + 3, 1, z + 2, cTrestle);
    for (const x of [f.cx - 3, f.cx + 2]) C.box(x, 0, z, x + 1, C.c(h), z + 2, cTrestle);
    C.box(f.cx - 3, C.c(h), z, f.cx + 3, C.c(h) + 1, z + 2, cTrestle);
  }
  // An elbow turning one run up and over at the far end.
  const eb = runs[0];
  for (let y = eb.y; y < eb.y + C.c(1.4); y++) disc(C, eb.x, z1 - 2, 2, y, y + 1, c);
  stash(C, ctx, 'pipes');
  return C.geometry();
}
