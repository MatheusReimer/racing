import { VoxCanvas, blob } from './canvas.js';
import { shade, mix } from './shapes.js';

// The living half of the scenery, as cells.
//
// These are the props that had the best case for staying sampled: a cone, a
// sphere and a cylinder all have curvature for a grid to bite into, so a
// voxelised pine really did come out looking like a voxel pine. The reason
// they are here anyway is that sampling only ever gives back the shape it was
// given, and the shape it was given was drawn for a smooth renderer — a
// perfect cone, an even sphere, fronds of equal length. Built as cells they can
// be drawn for this one instead: a canopy in four stepped tiers rather than a
// stepped cone, a rock whose lumps are one cell deep because a cell is the unit
// the lump was decided in.
//
// Which also makes them cheaper, because a shape authored on the grid has long
// flat runs and a shape sampled onto it has whatever its curvature left behind.

/**
 * Cell sizes, by how close the thing is ever seen.
 *
 * Trackside things share the street furniture's twenty centimetres — they
 * stand on the same verge, often touching. The landscape pieces are bigger and
 * further away and get a coarser cell, which keeps their cost flat and their
 * cubes about the same size on screen.
 */
const NEAR_CELL = 0.2;
const FAR_CELL = 0.35;

function canvasFor(w, h, d, cell = NEAR_CELL, pad = 0.6) {
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

/**
 * A rock, and the same function for a boulder.
 *
 * Size is the only difference between them in the placement table and it is
 * the only difference here — except that the bigger one gets more lobes,
 * because a two-metre stone reads as one lump and a five-metre one has to have
 * a shape.
 */
function stone(rng, pal, ctx, { size, base, cell }) {
  const r = size / 2;
  const C = canvasFor(size * 1.3, size, size * 1.3, cell, 0.4);
  const f = frame(C);
  const rock = mix(pal.prop ?? 0x6a6258, base, rng.next());
  const colours = [
    C.colour(shade(rock, 0.62)),
    C.colour(shade(rock, 0.82)),
    C.colour(rock),
    C.colour(shade(rock, 1.14)),
  ];
  // Centred at ground level, so only the top half is ever built.
  //
  // Two goes at this were wrong in opposite directions. Centring it at its own
  // radius and letting the lobes run all the way round gave a boulder standing
  // on legs — a wobbling radius does not care which way is up, so the lobes
  // underneath carved it out from beneath. Filling every column down to the
  // ground fixed the legs and gave a plinth: the widest ring is at mid-height,
  // so draping from it makes vertical walls.
  //
  // Sitting the centre on the ground makes the widest ring the *lowest* one,
  // which is what a stone half-buried in a verge actually looks like, and
  // undercutting becomes impossible below it because there is nothing below
  // it. The drape then only has the odd overhang left to fill.
  blob(C, f.cx, 1, f.cz, r / C.step, rng, colours, {
    lobes: size > 3 ? 5 : 3,
    // Measured, not guessed: at 0.48 a boulder came out 2.5 m against the 3.4
    // its placement declares, which is a pancake. Height above ground scales
    // with this directly.
    squash: 0.66 + rng.range(0, 0.16),
  });
  drape(C, colours[0]);
  stash(C, ctx, 'rock');
  return C.geometry();
}

export function voxRock(rng, pal, ctx = {}) {
  return stone(rng, pal, ctx, { size: 1.6 + rng.range(0, 1.6), base: 0x6a6258, cell: NEAR_CELL });
}

export function voxBoulder(rng, pal, ctx = {}) {
  return stone(rng, pal, ctx, { size: 3.2 + rng.range(0, 2.4), base: 0x585048, cell: FAR_CELL });
}

/**
 * A conifer.
 *
 * Four stepped tiers, each a square block wider than the one above and set
 * down into it, with the trunk showing between them. That is a voxel pine —
 * not a cone with stairs cut into it, which is what sampling gave, but a
 * silhouette made of the same rectangles everything else here is made of.
 */
export function voxPine(rng, pal, ctx = {}) {
  const h = 7.5 + rng.range(0, 3);
  const spread = 3.4;
  const C = canvasFor(spread, h + 0.6, spread, NEAR_CELL, 0.4);
  const f = frame(C);
  const needle = mix(pal.foliage ?? 0x2e4a32, 0x1c3a26, rng.next() * 0.6);
  const cTrunk = C.colour(mix(0x4a3a2a, pal.prop ?? 0x5a4a38, 0.4));
  const dark = C.colour(shade(needle, 0.72));
  const lit = C.colour(needle);

  const top = C.c(h);
  C.box(f.cx - 1, 0, f.cz - 1, f.cx + 1, top, f.cz + 1, cTrunk);
  // Roots flaring at the base, two cells of it.
  C.box(f.cx - 2, 0, f.cz - 2, f.cx + 2, 2, f.cz + 2, cTrunk);

  const tiers = 4;
  const start = Math.round(top * 0.22);
  for (let t = 0; t < tiers; t++) {
    const y = start + Math.round(((top - start) * t) / tiers);
    const next = start + Math.round(((top - start) * (t + 1)) / tiers);
    const r = Math.max(1, Math.round((C.c(spread / 2) * (tiers - t)) / tiers));
    // The skirt of the tier, one course deep, then the body tapering up. The
    // skirt is the shadow line that makes it read as branches.
    C.box(f.cx - r, y, f.cz - r, f.cx + r, y + 1, f.cz + r, dark);
    for (let s = 1; y + s < next; s++) {
      const rr = Math.max(1, r - Math.round((s * r) / Math.max(1, next - y)));
      C.box(f.cx - rr, y + s, f.cz - rr, f.cx + rr, y + s + 1, f.cz + rr, lit);
    }
  }
  C.box(f.cx - 1, top - 2, f.cz - 1, f.cx + 1, top + 1, f.cz + 1, lit);
  stash(C, ctx, 'pine');
  return C.geometry();
}

/**
 * A dead tree.
 *
 * All silhouette and no mass: a trunk that kinks, and three or four branches
 * that climb away from it a cell at a time. Stepping is the point — a smooth
 * branch tapering to nothing was a spike, and a spike is one of the things the
 * cars were cleaned up to stop having.
 */
export function voxDeadTree(rng, pal, ctx = {}) {
  const h = 4.6 + rng.range(0, 2);
  const C = canvasFor(4.2, h + 0.6, 4.2, NEAR_CELL, 0.4);
  const f = frame(C);
  const wood = mix(0x5a4a3a, pal.prop ?? 0x6a5a48, rng.next() * 0.5);
  const c = C.colour(wood);
  const cDark = C.colour(shade(wood, 0.74));

  const top = C.c(h);
  C.box(f.cx - 2, 0, f.cz - 2, f.cx + 2, 2, f.cz + 2, cDark);
  // The trunk, kinking once.
  const kink = Math.round(top * 0.55);
  const lean = rng.int(-1, 1);
  C.box(f.cx - 1, 0, f.cz - 1, f.cx + 1, kink, f.cz + 1, c);
  C.box(f.cx - 1 + lean, kink, f.cz - 1, f.cx + 1 + lean, top, f.cz + 1, c);

  const arms = 3 + rng.int(0, 1);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng.range(0, 1.2);
    const dx = Math.cos(a) > 0 ? 1 : -1;
    const dz = Math.sin(a) > 0 ? 1 : -1;
    let x = f.cx + lean;
    let z = f.cz;
    let y = Math.round(top * (0.5 + 0.12 * i));
    const len = 3 + rng.int(0, 4);
    for (let s = 0; s < len && y < C.ny - 1; s++) {
      // One cell out, one cell up, alternating which — a branch drawn the way
      // a line is drawn on a grid.
      if (s % 2) x += dx; else z += dz;
      y += (s % 3 === 0) ? 1 : 0;
      // Two cells thick near the trunk, one at the tip. A one-cell branch all
      // the way is a wire at any distance at all, and the taper is what makes
      // it a limb.
      const thick = s < len * 0.45 ? 2 : 1;
      C.box(x, y, z, x + thick, y + 1, z + thick, s > len - 3 ? cDark : c);
    }
  }
  stash(C, ctx, 'dead_tree');
  return C.geometry();
}

/** A saguaro: a ribbed column with two arms that elbow upward. */
export function voxCactus(rng, pal, ctx = {}) {
  const h = 3.2 + rng.range(0, 1.6);
  const C = canvasFor(3.0, h + 0.6, 2.0, NEAR_CELL, 0.4);
  const f = frame(C);
  const green = mix(pal.foliage ?? 0x3f6b3a, 0x2e5230, rng.next() * 0.7);
  const c = C.colour(green);
  const cRib = C.colour(shade(green, 0.8));
  const cTip = C.colour(shade(green, 1.12));

  const top = C.c(h);
  const r = 2;
  C.box(f.cx - r, 0, f.cz - r, f.cx + r, top, f.cz + r, c);
  C.box(f.cx - r, top - 1, f.cz - r + 1, f.cx + r, top, f.cz + r - 1, cTip);
  // Ribs: a darker column every other cell round the outside, which is the one
  // texture a cactus has and it happens to be exactly one cell wide.
  for (let z = f.cz - r; z < f.cz + r; z += 2) {
    C.box(f.cx - r - 1, 1, z, f.cx - r, top - 1, z + 1, cRib);
    C.box(f.cx + r, 1, z, f.cx + r + 1, top - 1, z + 1, cRib);
  }

  for (const side of [-1, 1]) {
    if (!rng.bool(0.8)) continue;
    const y = Math.round(top * (0.34 + rng.range(0, 0.2)));
    const reach = 2 + rng.int(1, 3);
    const rise = 3 + rng.int(0, 4);
    const x0 = side < 0 ? f.cx - r - reach : f.cx + r;
    C.box(x0, y, f.cz - 1, x0 + reach + 1, y + 2, f.cz + 1, c);
    const ax = side < 0 ? x0 : x0 + reach - 1;
    C.box(ax, y, f.cz - 1, ax + 2, y + rise, f.cz + 1, c);
    C.box(ax, y + rise - 1, f.cz - 1, ax + 2, y + rise, f.cz + 1, cTip);
  }
  stash(C, ctx, 'cactus');
  return C.geometry();
}

/** A palm: a leaning stepped trunk with fronds that droop a cell at a time. */
export function voxPalm(rng, pal, ctx = {}) {
  const h = 7 + rng.range(0, 3);
  const C = canvasFor(6.4, h + 1.2, 6.4, NEAR_CELL, 0.5);
  const f = frame(C);
  const trunk = mix(0x6a5a42, pal.prop ?? 0x5a4c3a, rng.next() * 0.6);
  const c = C.colour(trunk);
  const cRing = C.colour(shade(trunk, 0.78));
  const frond = mix(pal.foliage ?? 0x3f7a4a, 0x2c5c38, rng.next() * 0.6);
  const cFrond = C.colour(frond);
  const cFrondDark = C.colour(shade(frond, 0.76));

  const top = C.c(h);
  const lean = rng.range(-0.35, 0.35);
  let tx = f.cx;
  for (let y = 0; y < top; y++) {
    // The lean applied a cell at a time, so the trunk is a staircase rather
    // than a sheared box.
    tx = f.cx + Math.round((y / top) * lean * C.c(2.4));
    C.box(tx - 1, y, f.cz - 1, tx + 1, y + 1, f.cz + 1, y % 4 === 0 ? cRing : c);
  }
  // The crown, and eight fronds stepping out and down.
  C.box(tx - 2, top, f.cz - 2, tx + 2, top + 2, f.cz + 2, cFrondDark);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng.range(0, 0.4);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const len = C.c(2.2) + rng.int(0, 3);
    for (let s = 1; s <= len; s++) {
      const x = tx + Math.round(dx * s);
      const z = f.cz + Math.round(dz * s);
      // Flat for the first half, then drooping — which on a grid is a step
      // down every other cell.
      const y = top + 1 - Math.max(0, Math.round((s - len * 0.45) * 0.8));
      if (y < 1) break;
      C.box(x, y, z, x + 1, y + 1, z + 1, s > len * 0.6 ? cFrondDark : cFrond);
      // A little width, so a frond is a leaf and not a wire.
      if (s < len * 0.7) {
        C.box(x - (dz > 0 ? 1 : 0), y, z - (dx > 0 ? 0 : 1),
          x + 1 + (dz > 0 ? 0 : 1), y + 1, z + 1 + (dx > 0 ? 1 : 0), cFrond);
      }
    }
  }
  stash(C, ctx, 'palm');
  return C.geometry();
}

/** A ribcage in the sand: a spine, ribs arching off it, and a skull. */
export function voxBones(rng, pal, ctx = {}) {
  const len = 5.4;
  const C = canvasFor(2.6, 1.8, len, NEAR_CELL, 0.4);
  const f = frame(C);
  const c = C.colour(0xd8cfb8);
  const cShade = C.colour(0xb0a68c);

  const z0 = f.cz - Math.round(C.c(len) / 2);
  const z1 = f.cz + Math.round(C.c(len) / 2);
  // Spine, half buried.
  C.box(f.cx - 1, 0, z0 + 3, f.cx + 1, 2, z1 - 2, cShade);
  // Ribs: an arch drawn a cell at a time, shorter toward the tail.
  for (let z = z0 + 4, i = 0; z < z1 - 4; z += 3, i++) {
    const rise = 4 + Math.round(3 * Math.sin((i / 5) * Math.PI));
    for (const side of [-1, 1]) {
      let x = f.cx;
      let y = 1;
      for (let s = 0; s < rise; s++) {
        if (s < rise * 0.55) y++; else x += side;
        C.box(x, y, z, x + 1, y + 1, z + 1, c);
      }
    }
  }
  // The skull, at one end, tipped over.
  C.box(f.cx - 2, 0, z0, f.cx + 2, 3, z0 + 4, c);
  C.box(f.cx - 1, 1, z0 - 2, f.cx + 1, 3, z0 + 1, cShade);
  stash(C, ctx, 'bones');
  return C.geometry();
}

/**
 * Fill every column down to the ground, under whatever is standing in it.
 *
 * Cheap in triangles — the mesher drops every face between two filled cells,
 * so the added mass is invisible except where it shows at the sides — and it
 * is the difference between a rock and a rock on legs.
 */
function drape(C, v) {
  for (let z = 0; z < C.nz; z++) {
    for (let x = 0; x < C.nx; x++) {
      let hi = -1;
      for (let y = C.ny - 1; y >= 0; y--) if (C.solid(x, y, z)) { hi = y; break; }
      if (hi < 1) continue;
      for (let y = 0; y < hi; y++) if (!C.solid(x, y, z)) C.box(x, y, z, x + 1, y + 1, z + 1, v);
    }
  }
}

/** A slab of ice: chunky, chipped at the corners, banded by depth. */
export function voxIceBlock(rng, pal, ctx = {}) {
  const w = 2.4 + rng.range(0, 1.4);
  const h = 1.4 + rng.range(0, 0.8);
  const d = 1.8 + rng.range(0, 1.2);
  const C = canvasFor(w, h + 0.4, d, NEAR_CELL, 0.3);
  const f = frame(C);
  const ice = mix(pal.prop ?? 0x9fc8d8, 0xd8ecf4, rng.next());
  const bands = [
    C.colour(shade(ice, 0.72)), C.colour(shade(ice, 0.88)),
    C.colour(ice), C.colour(shade(ice, 1.1)),
  ];
  const x0 = f.cx - Math.round(C.c(w) / 2);
  const x1 = f.cx + Math.round(C.c(w) / 2);
  const z0 = f.cz - Math.round(C.c(d) / 2);
  const z1 = f.cz + Math.round(C.c(d) / 2);
  const top = C.c(h);
  // Faceted rather than boxy: each course steps in on one side and out on
  // another, so the block leans and reads as something broken off rather than
  // cut. A rectangular prism painted pale blue is a fridge.
  const tiltX = rng.int(-1, 1);
  const tiltZ = rng.int(-1, 1);
  for (let y = 0; y < top; y++) {
    const t = y / Math.max(1, top - 1);
    const ix = Math.round(tiltX * t * 2);
    const iz = Math.round(tiltZ * t * 2);
    const nip = Math.round(t * 1.5);
    C.box(x0 + ix + nip, y, z0 + iz + nip, x1 + ix - nip, y + 1, z1 + iz - nip,
      bands[Math.min(3, Math.floor(t * 4))]);
  }
  // Chips: corners knocked clean off, two cells at a time so they show.
  for (let i = 0; i < 5; i++) {
    const cx = rng.bool(0.5) ? x0 - 1 : x1 - 2;
    const cz = rng.bool(0.5) ? z0 - 1 : z1 - 2;
    const cy = rng.bool(0.6) ? top - 3 : 0;
    C.box(cx, cy, cz, cx + 3, cy + 3, cz + 3, 0);
  }
  stash(C, ctx, 'ice_block');
  return C.geometry();
}

/** A drift: a low mound, built as columns, so its surface is stepped. */
export function voxSnowBank(rng, pal, ctx = {}) {
  const w = 6.4, d = 3.4, h = 1.3;
  const C = canvasFor(w, h + 0.4, d, NEAR_CELL, 0.3);
  const f = frame(C);
  const snow = pal.groundAlt ?? 0xe8f0f6;
  const cTop = C.colour(snow);
  const cShade = C.colour(shade(snow, 0.86));

  const x0 = f.cx - Math.round(C.c(w) / 2);
  const x1 = f.cx + Math.round(C.c(w) / 2);
  const z0 = f.cz - Math.round(C.c(d) / 2);
  const z1 = f.cz + Math.round(C.c(d) / 2);
  const top = C.c(h);
  const ph = rng.next() * 6.283;
  for (let x = x0; x < x1; x++) {
    const u = (x - x0) / (x1 - x0);
    for (let z = z0; z < z1; z++) {
      const v = (z - z0) / (z1 - z0);
      // A ridge along its length, tapering at both ends, blown into lumps.
      const along = Math.sin(u * Math.PI);
      const across = Math.sin(v * Math.PI);
      const lump = 0.82 + 0.18 * Math.sin(ph + u * 9) * Math.cos(ph + v * 5);
      const hh = Math.round(top * along * across * lump);
      if (hh < 1) continue;
      C.box(x, 0, z, x + 1, hh, z + 1, cShade);
      C.box(x, hh - 1, z, x + 1, hh, z + 1, cTop);
    }
  }
  stash(C, ctx, 'snow_bank');
  return C.geometry();
}
