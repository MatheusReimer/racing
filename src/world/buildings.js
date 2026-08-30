import { VoxCanvas, cellFor } from './canvas.js';
import { shade, mix } from './shapes.js';

// Buildings, built as cells.
//
// The old ones were extrusions: a slab, a parapet, a plinth, and a grid of
// small boxes stuck to the front. They went through the voxeliser like
// everything else and came out looking exactly the same, because sampling a
// flat quad onto a grid gives back a flat quad. Seven thousand triangles to
// say what two hundred and twenty-eight had already said.
//
// So these are drawn on the grid instead of onto it. The difference that
// matters is *relief*: a window here is a hole two cells deep with glass at the
// bottom of it, not a pane glued to a wall. A ledge oversails by a cell and
// casts a real shadow line. A parapet is a ring you can see the inside of. None
// of that survives being sampled from smooth geometry, and all of it is one
// call to fill a range of cells.
//
// The whole street shares one cell ladder, which is the other half of the look:
// two buildings standing next to each other have cubes of the same size, so the
// street reads as one material rather than as a row of separately-modelled
// objects.

/**
 * How the cell coarsens with distance, and why not by doubling.
 *
 * The sampler's ladder doubled per level, which at the horizon put a
 * forty-metre building on five-metre cubes — coarser than the building's own
 * features, so the silhouette changed rather than the detail. These are the
 * levels the prop library builds: near, looked-at, mid-field, horizon. The
 * first two share a cell because both are close enough for a window to be a
 * hole, and the last two lose the windows instead of losing the shape.
 */
const LOD_CELL = [1, 1, 2, 3.2];

/**
 * How big each frontage is, in metres: width along the street, depth into the
 * block.
 *
 * Shared with the scatter, which places these by their front face and tiles
 * them into a continuous wall — so a row of mixed types only works while every
 * one of them agrees about the width. They live here rather than next to the
 * placement table because this is the file that decides them.
 */
export const FRONTAGE = {
  facade: { w: 22, d: 30 },
  mall: { w: 22, d: 34 },
  townhouse: { w: 22, d: 17 },
  tenement: { w: 22, d: 21 },
};

/** Below this level a window is a hole. Above it, the wall is just a wall. */
const FINE_LOD = 1;

/**
 * A canvas that will hold a building of this size, with room to oversail.
 *
 * Everything a building does at its edges — plinths, ledges, parapets,
 * canopies — sticks *out*, so the grid has to be bigger than the mass by the
 * largest of them. Four cells of margin covers every oversail here and costs a
 * shell of empty cells.
 */
function canvasFor(d, w, h, ctx) {
  const cell = cellFor(Math.max(d, w, h)) * LOD_CELL[Math.min(3, ctx.lod ?? 0)];
  const pad = cell * 4;
  return new VoxCanvas(d + pad * 2, h + pad, w + pad * 2, cell);
}

/**
 * A grid of windows, cut into a wall.
 *
 * Cut, not applied: each one carves `depth` cells out of the face and puts a
 * single course of glass at the back of the hole. That is what a window looks
 * like from a car — a dark rectangle set back behind a reveal, with the light
 * catching one jamb and not the other — and it is the single thing that
 * separates these from the painted slabs they replace.
 *
 * @param face  the x cell the wall's outer surface sits at
 * @param out   collects each pane's cell rect, so the lit-window pass can put
 *              its glow exactly where the hole is. The old one recomputed the
 *              layout from a different RNG stream and lit windows that were
 *              not there.
 */
function windowGrid(C, {
  face, y0, y1, z0, z1, floors, cols, glass, sill, band = null, back = null,
  depth = 2, rng, skip = 0.1,
}, out = null) {
  const pitch = (y1 - y0) / floors;
  const colPitch = (z1 - z0) / cols;
  const wh = Math.max(1, Math.round(pitch * 0.55));
  const ww = Math.max(1, Math.round(colPitch * 0.62));
  if (pitch < 3 || colPitch < 2) return;

  for (let f = 0; f < floors; f++) {
    const wy = Math.round(y0 + pitch * f + (pitch - wh) * 0.55);
    // A course at every floor line, oversailing by one. The strongest cue that
    // a wall has storeys behind it, and on a grid it costs one fill.
    // A string course at every floor line, right round the building.
    //
    // Round, not across the front: the sides and the back of these are seen
    // from every corner in the city and were the last flat slabs left in it. A
    // ring is one fill and four merged quads, and it gives three faces a
    // horizontal rhythm they had nothing else to get one from.
    if (sill != null) {
      C.box(face - 1, wy - 2, z0 - 1, (back ?? face + 1) + 1, wy - 1, z1 + 1, sill);
    }
    // The storey band itself, a shade off the wall. Two nearly-identical
    // colours in alternating courses is what stops thirty metres of wall being
    // one flat field: it gives the grid a horizontal rhythm without breaking
    // the vertical runs the mesher is merging.
    if (band != null && f % 2) {
      C.box(face, wy - 1, z0 - 1, face + 1, wy + Math.round(pitch) - 1, z1 + 1, band);
    }
    for (let c = 0; c < cols; c++) {
      if (rng.bool(skip)) continue;
      const wz = Math.round(z0 + colPitch * c + (colPitch - ww) * 0.5);
      C.box(face, wy, wz, face + depth, wy + wh, wz + ww, 0);
      C.box(face + depth, wy, wz, face + depth + 1, wy + wh, wz + ww, glass);
      out?.push({ gx: face + depth - 1, y: wy, z: wz, h: wh, w: ww });
    }
  }
}

/**
 * Everything that hangs off a wall.
 *
 * The shapes were right and the walls were still reading as painted slabs, and
 * this is why: a building's cell-scale detail is not its geometry, it is its
 * *clutter*. Air conditioners, a satellite dish, a balcony, a stack of pipes,
 * a bracket somebody bolted on. Each is a box one or two cells proud of the
 * face, which is exactly the scale at which the grid becomes visible — a flat
 * wall gives the eye no cube to measure, and one air conditioner gives it a
 * ruler for the whole facade.
 *
 * Costs about a dozen triangles apiece and it is the cheapest thing in this
 * file per unit of look.
 */
function wallClutter(C, { face, y0, y1, z0, z1, colours, rng, n }) {
  for (let i = 0; i < n; i++) {
    const w = 1 + rng.int(0, 2);
    const hh = 1 + rng.int(0, 2);
    const out = 1 + rng.int(0, 1);
    const y = y0 + rng.int(0, Math.max(0, y1 - y0 - hh));
    const z = z0 + rng.int(0, Math.max(0, z1 - z0 - w));
    // Only where there is wall to bolt it to. A unit floating in a window
    // reveal reads as a mistake, and there is no cheaper test than asking.
    if (!C.solid(face, y, z)) continue;
    C.box(face - out, y, z, face, y + hh, z + w,
      colours[rng.int(0, colours.length - 1)]);
  }
}

/**
 * Tanks, vents and a stair head.
 *
 * A flat roof with nothing on it is the one surface that gives a building away
 * as a box, and it is the surface every tall thing in the game is seen from —
 * the track climbs, and the horizon band is all roofs. Cheap, and it is what
 * the eye reads as "a real building" without being able to say why.
 */
function roofClutter(C, { x0, x1, z0, z1, top, colour, rng, n = 4 }) {
  for (let i = 0; i < n; i++) {
    const w = 2 + rng.int(0, 4);
    const d = 2 + rng.int(0, 4);
    const hh = 2 + rng.int(0, 5);
    const x = x0 + 1 + rng.int(0, Math.max(0, x1 - x0 - w - 2));
    const z = z0 + 1 + rng.int(0, Math.max(0, z1 - z0 - d - 2));
    C.box(x, top, z, x + w, top + hh, z + d, colour);
  }
}

/**
 * A commercial frontage: the default building on a city street.
 *
 * Tall, flat-fronted, a shop at the bottom and forty metres of windows above
 * it. The silhouette work is at the top — a parapet, and a setback storey on
 * the tall ones — because along a street that is the only part of two adjacent
 * buildings that differs.
 */
export function voxFacade(rng, pal, ctx = {}) {
  const { w: W, d: D } = FRONTAGE.facade;
  const h = 12 + rng.range(0, 30);
  const wall = mix(pal.prop ?? 0x2a3038, 0x3a4048, rng.next());
  const C = canvasFor(D, W, h + 8, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const cWall = C.colour(wall);
  const cTrim = C.colour(shade(wall, 0.80));
  const cPlinth = C.colour(shade(wall, 0.62));
  const cGlass = C.colour(0x0d1219);

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);

  // The mass, solid. Hollow would be cheaper to write and twice as expensive
  // to draw: the mesher drops a face between two filled cells and keeps the
  // one facing a cavity, so a shell renders its own inside.
  C.box(x0, 0, z0, x1, top, z1, cWall);

  // The plinth, oversailing. A building meets the pavement with something
  // heavier than its own wall.
  const plinth = C.c(4.2);
  C.box(x0 - 1, 0, z0 - 1, x1 + 1, plinth, z1 + 1, cPlinth);

  // Corner pilasters up the street face.
  for (const z of [z0, z1 - 2]) C.box(x0 - 1, 0, z, x0 + 1, top, z + 2, cTrim);

  const floors = Math.max(2, Math.floor((h - 5) / 3.4));
  const panes = [];
  if (fine) {
    windowGrid(C, {
      face: x0, y0: plinth + 2, y1: top - 2, z0: z0 + 2, z1: z1 - 2,
      floors, cols: 7, glass: cGlass, sill: cTrim, band: C.colour(shade(wall, 0.94)),
      back: x1, depth: 2, rng,
    }, panes);
    wallClutter(C, {
      face: x0, y0: plinth + 2, y1: top - 2, z0: z0 + 1, z1: z1 - 1,
      colours: [cTrim, C.colour(shade(wall, 0.55)), C.colour(0x8d9299)],
      rng, n: 14,
    });

    // The shopfront: a deep bite out of the plinth with glass at the back of
    // it, and a canopy over the pavement.
    const sz0 = z0 + 3, sz1 = z1 - 3;
    C.box(x0 - 1, C.c(0.6), sz0, x0 + 3, C.c(3.6), sz1, 0);
    C.box(x0 + 3, C.c(0.6), sz0, x0 + 4, C.c(3.6), sz1, cGlass);
    C.box(x0 - 4, C.c(3.6), sz0 - 1, x0 + 1, C.c(4.0), sz1 + 1, cTrim);
  }

  // A parapet ring, and whatever stands inside it.
  const par = Math.max(2, C.c(0.9));
  C.box(x0 - 2, top, z0 - 2, x1 + 2, top + par, z1 + 2, cTrim);
  C.box(x0, top, z0, x1, top + par, z1, 0);
  C.box(x0, top - 1, z0, x1, top, z1, cWall);
  if (fine) {
    roofClutter(C, { x0, x1, z0, z1, top, colour: cTrim, rng, n: 4 });
    // A setback storey on the tall ones: the whole point of a skyline.
    if (h > 26) {
      const uh = C.c(rng.range(4, 12));
      const ix = Math.round((x1 - x0) * 0.19);
      const iz = Math.round((z1 - z0) * 0.17);
      C.box(x0 + ix, top, z0 + iz, x1 - ix, top + uh, z1 - iz, cWall);
      C.box(x0 + ix - 1, top + uh, z0 + iz - 1, x1 - ix + 1, top + uh + 2, z1 - iz + 1, cTrim);
    }
  }

  ctx.layout = { kind: 'facade', h, panes, box: { x0, x1, z0, z1, top }, step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * A shopping centre: the one thing on the street that goes sideways.
 *
 * Low, wide, and mostly glass at the front under a canopy that runs its whole
 * width. It reads by silhouette against everything either side of it going up.
 */
export function voxMall(rng, pal, ctx = {}) {
  const { w: W, d: D } = FRONTAGE.mall;
  const h = 9 + rng.range(0, 4);
  const wall = mix(pal.prop ?? 0x2a3038, 0x4a5260, 0.35 + rng.next() * 0.4);
  const C = canvasFor(D, W, h + 6, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const cWall = C.colour(wall);
  const cTrim = C.colour(shade(wall, 0.72));
  const cDark = C.colour(shade(wall, 0.55));
  const cGlass = C.colour(0x0e131b);

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);

  C.box(x0, 0, z0, x1, top, z1, cWall);
  // A deep parapet: the profile of a big box is all it has.
  C.box(x0 - 2, top, z0 - 2, x1 + 2, top + C.c(1.1), z1 + 2, cTrim);

  const panes = [];
  if (fine) {
    // The glazed front, set back under the canopy, in mullioned bays rather
    // than one unbroken pane the width of the building.
    windowGrid(C, {
      face: x0, y0: C.c(0.8), y1: C.c(5.6), z0: z0 + 2, z1: z1 - 2,
      floors: 2, cols: 13, glass: cGlass, sill: null, depth: 2, rng, skip: 0,
    }, panes);
    windowGrid(C, {
      face: x0, y0: C.c(6.6), y1: top - 1, z0: z0 + 2, z1: z1 - 2,
      floors: 1, cols: 11, glass: C.colour(0x101720), sill: cTrim, depth: 1, rng, skip: 0.15,
    }, panes);

    // The canopy, and the columns holding it up.
    C.box(x0 - C.c(3.4), C.c(5.9), z0 - 1, x0 + 1, C.c(6.4), z1 + 1, cDark);
    for (let i = 0; i < 5; i++) {
      const z = Math.round(z0 + ((z1 - z0) * (i + 0.5)) / 5);
      C.box(x0 - C.c(3.2), 0, z - 1, x0 - C.c(3.2) + 2, C.c(5.9), z + 1, cTrim);
    }
    // The entrance, breaking the canopy line.
    const ez0 = Math.round((z0 + z1) / 2 - C.c(3.2));
    const ez1 = Math.round((z0 + z1) / 2 + C.c(3.2));
    C.box(x0 - C.c(2.4), 0, ez0, x0 + 1, C.c(7.4), ez1, cDark);
    C.box(x0 - C.c(2.4), C.c(0.8), ez0 + 1, x0 - C.c(2.4) + 1, C.c(6.2), ez1 - 1, cGlass);
    roofClutter(C, { x0, x1, z0, z1, top: top + C.c(1.1), colour: cTrim, rng, n: 5 });
  }

  ctx.layout = { kind: 'mall', h, panes, box: { x0, x1, z0, z1, top }, step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * A terrace of houses.
 *
 * Three narrow units across the width an office block gets, and the change of
 * grain is the whole point: a street of these has three times as many roof
 * lines, doors and windows per hundred metres as the commercial blocks do. The
 * pitched roofs are stepped, which on a grid is not a compromise — a stepped
 * roof is what a voxel roof looks like, and it is the most legible thing in
 * the biome from a distance.
 */
export function voxTownhouse(rng, pal, ctx = {}) {
  const { w: W, d: D } = FRONTAGE.townhouse;
  const units = 3;
  const base = [0x6b4a3c, 0x7d7062, 0x8a8478, 0x5c4c46][rng.int(0, 3)];
  const h = 8 + rng.range(0, 3);
  const C = canvasFor(D, W, h + 7, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const uw = (z1 - z0) / units;
  const panes = [];

  for (let u = 0; u < units; u++) {
    const uz0 = Math.round(z0 + uw * u);
    const uz1 = Math.round(z0 + uw * (u + 1));
    const wall = mix(base, 0xb0a89c, rng.next() * 0.35);
    const cWall = C.colour(wall);
    const cTrim = C.colour(shade(wall, 0.78));
    const cRoof = C.colour(shade(mix(base, 0x2a2622, 0.6), 0.9));
    const top = C.c(h) + rng.int(-1, 1);

    C.box(x0, 0, uz0, x1, top, uz1, cWall);
    // A stepped gable. Each course inset by one from the last, which is a
    // pitched roof said in cells.
    const steps = Math.max(2, Math.round(C.c(2.6)));
    for (let s = 0; s < steps; s++) {
      C.box(x0 + s, top + s, uz0 - 1, x1 - s, top + s + 1, uz1 + 1, cRoof);
    }
    // A party wall standing proud between units, which is what makes a terrace
    // read as separate houses rather than as one long shed.
    C.box(x0 - 1, 0, uz1 - 1, x1 + 1, top + steps, uz1 + 1, cTrim);

    if (fine) {
      windowGrid(C, {
        face: x0, y0: C.c(1.2), y1: top - 2, z0: uz0 + 2, z1: uz1 - 2,
        floors: 2, cols: 2, glass: C.colour(0x141a22), sill: cTrim, depth: 2, rng,
        skip: 0.05,
      }, panes);
      // A door, and a step up to it.
      const dz = Math.round((uz0 + uz1) / 2);
      C.box(x0, 0, dz - 1, x0 + 2, C.c(2.1), dz + 1, 0);
      C.box(x0 + 2, 0, dz - 1, x0 + 3, C.c(2.1), dz + 1, C.colour(shade(wall, 0.45)));
      C.box(x0 - 1, 0, dz - 2, x0 + 1, 1, dz + 2, cTrim);
      // A chimney.
      C.box(x1 - 4, top + steps, uz0 + 1, x1 - 2, top + steps + C.c(1.6), uz0 + 3, cTrim);
    }
  }

  ctx.layout = { kind: 'townhouse', h, panes, box: { x0, x1, z0, z1, top: C.c(h) }, step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * The cheap end of the street.
 *
 * Brick, a fire escape zigzagging down the front, and washing-line depth to the
 * windows. The fire escape is the reason this type exists: it is the one piece
 * of the city with something in front of the wall rather than in it, and on a
 * grid it costs a handful of fills.
 */
export function voxTenement(rng, pal, ctx = {}) {
  const { w: W, d: D } = FRONTAGE.tenement;
  const h = 14 + rng.range(0, 10);
  const brick = [0x7a3f34, 0x8a5a3c, 0x6a4a42, 0x5e5148][rng.int(0, 3)];
  const C = canvasFor(D, W, h + 6, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const cWall = C.colour(brick);
  const cTrim = C.colour(shade(brick, 0.76));
  const cIron = C.colour(0x22262b);
  const cGlass = C.colour(0x11161d);

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);

  C.box(x0, 0, z0, x1, top, z1, cWall);
  C.box(x0 - 1, 0, z0 - 1, x1 + 1, C.c(3.0), z1 + 1, C.colour(shade(brick, 0.6)));

  const floors = Math.max(3, Math.floor(h / 3.2));
  const panes = [];
  if (fine) {
    windowGrid(C, {
      face: x0, y0: C.c(3.4), y1: top - 2, z0: z0 + 2, z1: z1 - 2,
      floors, cols: 5, glass: cGlass, sill: cTrim,
      band: C.colour(shade(brick, 0.9)), back: x1, depth: 2, rng, skip: 0.08,
    }, panes);
    wallClutter(C, {
      face: x0, y0: C.c(3.4), y1: top - 2, z0: z0 + 1, z1: z1 - 1,
      colours: [cIron, C.colour(0x9aa0a6), C.colour(shade(brick, 0.55))],
      rng, n: 18,
    });

    // The fire escape: a landing at every floor, a ladder between them.
    const pitch = (top - 2 - C.c(3.4)) / floors;
    const fz0 = Math.round(z0 + (z1 - z0) * 0.55);
    const fz1 = fz0 + Math.max(3, C.c(2.4));
    for (let f = 1; f < floors; f++) {
      const y = Math.round(C.c(3.4) + pitch * f);
      C.box(x0 - C.c(1.6), y, fz0, x0, y + 1, fz1, cIron);
      // The rail, one cell proud of the landing.
      C.box(x0 - C.c(1.6), y + 1, fz0, x0 - C.c(1.6) + 1, y + 3, fz1, cIron);
      // And the ladder down to the one below, alternating side by side.
      const lz = f % 2 ? fz0 : fz1 - 1;
      C.box(x0 - C.c(1.2), Math.round(y - pitch), lz, x0 - C.c(1.2) + 1, y, lz + 1, cIron);
    }
  }

  C.box(x0 - 2, top, z0 - 2, x1 + 2, top + Math.max(2, C.c(0.8)), z1 + 2, cTrim);
  C.box(x0, top, z0, x1, top + Math.max(2, C.c(0.8)), z1, 0);
  C.box(x0, top - 1, z0, x1, top, z1, cWall);
  if (fine) roofClutter(C, { x0, x1, z0, z1, top, colour: cTrim, rng, n: 3 });

  ctx.layout = { kind: 'tenement', h, panes, box: { x0, x1, z0, z1, top }, step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * The horizon block.
 *
 * Never seen closer than a couple of hundred metres, so it is silhouette and
 * nothing else: a mass, a setback, a parapet, and enough roof clutter to break
 * the line. It gets no windows at any level — at that range a window grid is
 * noise, and this is the type there are most of.
 */
export function voxBlock(rng, pal, ctx = {}) {
  const w = 14 + rng.range(0, 16);
  const d = 14 + rng.range(0, 14);
  const h = 18 + rng.range(0, 26);
  const wall = mix(pal.prop ?? 0x2a3038, 0x39414d, rng.next());
  const C = canvasFor(d, w, h + 10, ctx);

  const cWall = C.colour(wall);
  const cTrim = C.colour(shade(wall, 0.82));

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);

  C.box(x0, 0, z0, x1, top, z1, cWall);
  C.box(x0 - 1, 0, z0 - 1, x1 + 1, C.c(2.4), z1 + 1, C.colour(shade(wall, 0.66)));

  // Two or three setbacks, each smaller than the last. A skyline is made of
  // the places where buildings stop.
  let y = top;
  let ax0 = x0, ax1 = x1, az0 = z0, az1 = z1;
  const stages = 1 + rng.int(0, 2);
  for (let s = 0; s < stages; s++) {
    C.box(ax0 - 2, y, az0 - 2, ax1 + 2, y + 2, az1 + 2, cTrim);
    const ix = Math.max(1, Math.round((ax1 - ax0) * 0.16));
    const iz = Math.max(1, Math.round((az1 - az0) * 0.16));
    ax0 += ix; ax1 -= ix; az0 += iz; az1 -= iz;
    if (ax1 - ax0 < 4 || az1 - az0 < 4) break;
    const sh = Math.round(C.c(rng.range(3, 9)));
    C.box(ax0, y, az0, ax1, y + sh, az1, cWall);
    y += sh;
  }
  C.box(ax0 - 2, y, az0 - 2, ax1 + 2, y + 2, az1 + 2, cTrim);
  // A mast, because one thing on a skyline should be thin.
  if (rng.bool(0.4)) {
    const cx = Math.round((ax0 + ax1) / 2);
    const cz = Math.round((az0 + az1) / 2);
    C.box(cx - 1, y, cz - 1, cx + 1, y + C.c(rng.range(4, 11)), cz + 1, cTrim);
  }
  roofClutter(C, { x0: ax0, x1: ax1, z0: az0, z1: az1, top: y + 2, colour: cTrim, rng, n: 2 });

  ctx.layout = { kind: 'block', h, panes: [], box: { x0, x1, z0, z1, top }, step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims };
  return C.geometry();
}

/** A second canvas on the same grid as a body, for whatever glows on it. */
function glowCanvas(layout) {
  // Loudly. Without the body's cell dimensions this builds a three-cell canvas
  // and clips every window away, and the failure looks exactly like a city
  // that has gone to bed — four frontage types went dark and the only way to
  // notice was to count the geometry.
  if (!layout?.cells) throw new Error('glow canvas needs the body\'s cell dimensions');
  return new VoxCanvas(1, 1, 1, layout.step, {
    origin: [layout.ox, layout.oy, layout.oz], cells: layout.cells,
  });
}

/**
 * Merge two grids' geometry without merging the grids.
 *
 * The lit windows and the shop sign are separate passes over the same canvas —
 * one walks the panes, the other draws a band — and a building has at most one
 * of each, so they can simply share a canvas. This exists because a caller that
 * has neither must get null rather than an empty geometry: the library counts
 * an empty glow as a glow and draws it.
 */
function glowOrNull(C) {
  return C.count ? C.geometry() : null;
}

/** Lit windows, and the shop sign that actually lights the pavement. */
export function voxFacadeGlow(rng, layout) {
  if (!layout) return null;
  const C = glowCanvas(layout);
  const hue = C.colour([0xffd9a0, 0xfff4de, 0xcfe6ff][rng.int(0, 2)]);
  for (const p of layout.panes ?? []) {
    if (!rng.bool(0.3)) continue;
    C.box(p.gx, p.y, p.z, p.gx + 1, p.y + p.h, p.z + p.w, hue);
  }
  const b = layout.box;
  if (b) {
    const neon = C.colour([0xff2e88, 0x2ee8ff, 0xa8ff3a, 0xff8a1e, 0xc46bff][rng.int(0, 4)]);
    const z0 = Math.round(b.z0 + (b.z1 - b.z0) * 0.22);
    const z1 = Math.round(b.z0 + (b.z1 - b.z0) * 0.78);
    C.box(b.x0 - 3, C.c(4.4), z0, b.x0 - 2, C.c(5.4), z1, neon);
  }
  return glowOrNull(C);
}

/** One saturated band the width of the building, and the spill off the glass. */
export function voxMallGlow(rng, layout) {
  if (!layout?.box) return null;
  const C = glowCanvas(layout);
  const b = layout.box;
  const hue = C.colour([0xff4d6d, 0x38e0ff, 0xffc23a, 0x8b5cff][rng.int(0, 3)]);
  const z0 = Math.round(b.z0 + (b.z1 - b.z0) * 0.15);
  const z1 = Math.round(b.z0 + (b.z1 - b.z0) * 0.85);
  C.box(b.x0 - C.c(2.1), C.c(6.6), z0, b.x0 - C.c(2.1) + 1, C.c(8.0), z1, hue);
  // The glazing itself, which is what lights the forecourt.
  const warm = C.colour(0xfff0d2);
  for (const p of layout.panes ?? []) {
    if (!rng.bool(0.55)) continue;
    C.box(p.gx, p.y, p.z, p.gx + 1, p.y + p.h, p.z + p.w, warm);
  }
  return glowOrNull(C);
}

/** A lamp over the door and a window or two. A house is not an office. */
export function voxTownhouseGlow(rng, layout) {
  if (!layout) return null;
  const C = glowCanvas(layout);
  const warm = C.colour(0xffd39a);
  for (const p of layout.panes ?? []) {
    if (!rng.bool(0.35)) continue;
    C.box(p.gx, p.y, p.z, p.gx + 1, p.y + p.h, p.z + p.w, warm);
  }
  return glowOrNull(C);
}

/** Bare bulbs, and more of them lit: somebody is in every one of these. */
export function voxTenementGlow(rng, layout) {
  if (!layout) return null;
  const C = glowCanvas(layout);
  const hue = C.colour([0xffcf8a, 0xfff0cc, 0x9fd8ff][rng.int(0, 2)]);
  for (const p of layout.panes ?? []) {
    if (!rng.bool(0.42)) continue;
    C.box(p.gx, p.y, p.z, p.gx + 1, p.y + p.h, p.z + p.w, hue);
  }
  return glowOrNull(C);
}

// Drawn on the body's grid, so the library hands them the layout rather than
// the palette. Both signatures are two arguments long, so this cannot be
// sniffed from the function.
voxFacadeGlow.fromLayout = true;
voxMallGlow.fromLayout = true;
voxTownhouseGlow.fromLayout = true;
voxTenementGlow.fromLayout = true;

/**
 * An industrial shed.
 *
 * Low, wide, and roofed with a saw-tooth — which is the one roof shape that
 * was never going to survive being an extrusion and is trivial as cells: a run
 * of steps up and a cliff back down, repeated. Roller doors down the front,
 * because a workshop is a building you drive into.
 */
export function voxWorkshop(rng, pal, ctx = {}) {
  const W = 24, D = 16;
  const h = 5.5 + rng.range(0, 1.5);
  const wall = mix(pal.prop ?? 0x4a4f57, 0x6a7079, rng.next() * 0.6);
  const C = canvasFor(D, W, h + 5, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const cWall = C.colour(wall);
  const cTrim = C.colour(shade(wall, 0.72));
  const cDoor = C.colour(shade(wall, 0.5));
  const cGlass = C.colour(0x18202a);

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);

  C.box(x0, 0, z0, x1, top, z1, cWall);
  C.box(x0 - 1, 0, z0 - 1, x1 + 1, 2, z1 + 1, cTrim);

  // Saw-tooth: each bay rises to a ridge and drops back, with the vertical
  // face glazed the way a real one is, so the roof is lit from the north.
  const bay = Math.max(4, C.c(4.2));
  const rise = Math.max(2, C.c(1.6));
  for (let x = x0; x < x1; x += bay) {
    const wide = Math.min(bay, x1 - x);
    for (let s = 0; s < rise; s++) {
      const from = x + Math.round((wide * s) / rise);
      C.box(from, top + s, z0, x + wide, top + s + 1, z1, cTrim);
    }
    if (fine) C.box(x, top, z0, x + 1, top + rise, z1, cGlass);
  }

  if (fine) {
    // Roller doors, and a personnel door beside them.
    const bays = 3;
    for (let i = 0; i < bays; i++) {
      const dz0 = Math.round(z0 + ((z1 - z0) * (i + 0.18)) / bays);
      const dz1 = Math.round(z0 + ((z1 - z0) * (i + 0.82)) / bays);
      C.box(x0, 0, dz0, x0 + 1, C.c(4.0), dz1, cDoor);
      C.box(x0 - 1, C.c(4.0), dz0 - 1, x0 + 1, C.c(4.4), dz1 + 1, cTrim);
    }
    wallClutter(C, {
      face: x0, y0: C.c(4.6), y1: top - 1, z0: z0 + 1, z1: z1 - 1,
      colours: [cTrim, cDoor], rng, n: 6,
    });
  }

  ctx.layout = {
    kind: 'workshop', h, panes: [], box: { x0, x1, z0, z1, top },
    step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * A hospital: a slab on a podium, with wings.
 *
 * The tallest thing that is not a tower, and the only one with continuous
 * banded glazing rather than a grid of holes — which on a grid is a different
 * cut, not a different texture: one long recess per storey instead of one per
 * window. Cheaper, and it is what the type actually looks like.
 */
export function voxHospital(rng, pal, ctx = {}) {
  const W = 34, D = 26;
  const h = 24 + rng.range(0, 10);
  const wall = mix(pal.prop ?? 0x5a6068, 0xa8b0b8, 0.5 + rng.next() * 0.4);
  const C = canvasFor(D, W, h + 8, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const cWall = C.colour(wall);
  const cTrim = C.colour(shade(wall, 0.84));
  const cGlass = C.colour(0x1b2836);

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);
  const podium = C.c(6.0);

  // The podium runs the full plan; the slab above it is narrower, so the type
  // reads as a hospital and not as another office block.
  C.box(x0, 0, z0, x1, podium, z1, cWall);
  C.box(x0 - 1, 0, z0 - 1, x1 + 1, 2, z1 + 1, cTrim);
  const sx0 = x0 + Math.round((x1 - x0) * 0.22);
  C.box(sx0, podium, z0 + 2, x1 - 2, top, z1 - 2, cWall);

  if (fine) {
    // Ribbon glazing: one recess per storey, right across the slab.
    const floors = Math.max(4, Math.floor((h - 7) / 3.4));
    const pitch = (top - podium - 2) / floors;
    for (let f = 0; f < floors; f++) {
      const y = Math.round(podium + 2 + pitch * f);
      const hh = Math.max(1, Math.round(pitch * 0.5));
      C.box(sx0, y, z0 + 3, sx0 + 2, y + hh, z1 - 3, 0);
      C.box(sx0 + 2, y, z0 + 3, sx0 + 3, y + hh, z1 - 3, cGlass);
    }
    // The entrance canopy, which is the one thing anybody photographs.
    const ez0 = Math.round((z0 + z1) / 2 - C.c(4));
    const ez1 = Math.round((z0 + z1) / 2 + C.c(4));
    C.box(x0 - C.c(3.5), C.c(4.4), ez0, x0 + 1, C.c(5.0), ez1, cTrim);
    C.box(x0, C.c(0.4), ez0 + 1, x0 + 2, C.c(4.2), ez1 - 1, 0);
    C.box(x0 + 2, C.c(0.4), ez0 + 1, x0 + 3, C.c(4.2), ez1 - 1, cGlass);
    for (const z of [ez0, ez1 - 1]) {
      C.box(x0 - C.c(3.3), 0, z, x0 - C.c(3.3) + 1, C.c(4.4), z + 1, cTrim);
    }
  }

  // A parapet on the podium roof, plant on the slab roof, and a helipad.
  C.box(x0 - 1, podium, z0 - 1, sx0, podium + 2, z1 + 1, cTrim);
  C.box(sx0 - 1, top, z0 + 1, x1 - 1, top + 2, z1 - 1, cTrim);
  if (fine) {
    roofClutter(C, { x0: sx0, x1, z0: z0 + 2, z1: z1 - 2, top: top + 2, colour: cTrim, rng, n: 4 });
    const px = Math.round((sx0 + x1) / 2);
    const pz = Math.round((z0 + z1) / 2);
    const pr = Math.max(3, C.c(3.2));
    C.box(px - pr, top + 2, pz - pr, px + pr, top + 3, pz + pr, C.colour(0x2a2f36));
  }

  ctx.layout = {
    kind: 'hospital', h, panes: [], box: { x0, x1, z0, z1, top },
    step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * A spire.
 *
 * The one tall thin thing in the world, and the shape a grid is best at:
 * a taper is a stack of squares each smaller than the last, which is what a
 * stepped stone spire actually is. It costs almost nothing and it is visible
 * from most of a lap.
 */
export function voxSpire(rng, pal, ctx = {}) {
  const h = 12 + rng.range(0, 6);
  const base = 3.4;
  const stone = mix(pal.prop ?? 0x6a6258, 0x8a8378, rng.next());
  const C = canvasFor(base + 2, base + 2, h + 4, ctx);

  const cStone = C.colour(stone);
  const cTrim = C.colour(shade(stone, 0.78));
  const cDark = C.colour(shade(stone, 0.5));

  const cx = Math.round(C.nx / 2);
  const cz = Math.round(C.nz / 2);
  let r = Math.max(2, C.c(base / 2));
  const shaft = C.c(h * 0.55);

  C.box(cx - r - 1, 0, cz - r - 1, cx + r + 1, 2, cz + r + 1, cTrim);
  C.box(cx - r, 0, cz - r, cx + r, shaft, cz + r, cStone);
  // Louvres near the top of the shaft: a belfry has holes in it.
  for (let i = 1; i <= 3; i++) {
    const y = shaft - Math.round((shaft * i) / 9);
    C.box(cx - r - 1, y, cz - Math.max(1, r - 2), cx + r + 1, y + 1, cz + Math.max(1, r - 2), cDark);
  }
  C.box(cx - r - 1, shaft, cz - r - 1, cx + r + 1, shaft + 2, cz + r + 1, cTrim);

  // The taper, one course inset at a time.
  let y = shaft + 2;
  while (r > 0 && y < C.ny - 2) {
    const step = Math.max(1, Math.round(C.c(h * 0.45) / Math.max(1, r)));
    C.box(cx - r, y, cz - r, cx + r, y + step, cz + r, cStone);
    y += step;
    r--;
  }
  C.box(cx - 1, y, cz - 1, cx + 1, y + Math.max(1, C.c(0.8)), cz + 1, cTrim);

  ctx.layout = {
    kind: 'spire', h, panes: [], box: { x0: cx - 2, x1: cx + 2, z0: cz - 2, z1: cz + 2, top: y },
    step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/**
 * A grandstand.
 *
 * Stepped seating, which is the other shape a grid gets for free: every tier is
 * a course inset from the one below. It faces the road, so the steps are what
 * you see, and a roof on posts over the back rows.
 */
export function voxGrandstand(rng, pal, ctx = {}) {
  const W = 26, D = 14;
  const h = 6;
  const shell = mix(pal.prop ?? 0x5a5f66, 0x7a828c, rng.next() * 0.5);
  const C = canvasFor(D, W, h + 10, ctx);
  const fine = (ctx.lod ?? 0) <= FINE_LOD;

  const cShell = C.colour(shell);
  const cSeat = C.colour(mix(pal.accent ?? 0xd05030, shell, 0.62));
  const cPost = C.colour(shade(shell, 0.6));

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;

  // Tiers, rising away from the road. The road is -x, so the front is lowest.
  // Deep steps, not a ramp. One cell of rise per tier over a two-metre run
  // reads as a slope from any distance at all; a row of seats is closer to
  // knee height and half a stride deep, and on a grid that is two cells up and
  // three across.
  // Chunky on purpose. A row of seats is really half a metre deep, and at that
  // pitch fourteen metres of stand is thirty steps of one cell — which from
  // anywhere on the track is a ramp with stripes painted on it. Grouped into
  // rows of three, the steps are a metre and a half deep and read as steps.
  const run = Math.max(3, C.c(1.5));
  const tiers = Math.max(4, Math.floor((x1 - x0) / run));
  const rise = Math.max(2, Math.round(C.c(h) / tiers));
  for (let t = 0; t < tiers; t++) {
    const tx = x0 + t * run;
    C.box(tx, 0, z0, x1, (t + 1) * rise, z1, cShell);
    // The seats themselves: a course of colour along the front of each tier.
    if (fine) C.box(tx, (t + 1) * rise, z0, tx + run - 1, (t + 1) * rise + 1, z1, cSeat);
  }

  if (fine) {
    // A roof over the back, on posts. The gap under it is the thing that says
    // "stand" rather than "embankment".
    const top = tiers * rise + C.c(3.2);
    const bx = x0 + Math.round((x1 - x0) * 0.45);
    for (let i = 0; i < 5; i++) {
      const z = Math.round(z0 + ((z1 - z0) * (i + 0.5)) / 5);
      C.box(bx, tiers * rise, z - 1, bx + 1, top, z + 1, cPost);
    }
    C.box(bx - 2, top, z0 - 1, x1 + 1, top + 2, z1 + 1, cShell);
    // Vomitories: two gaps cut clean through the seating.
    for (const f of [0.28, 0.72]) {
      const z = Math.round(z0 + (z1 - z0) * f);
      C.box(x0, 0, z - 1, x1, tiers * rise, z + 1, 0);
    }
  }

  ctx.layout = {
    kind: 'grandstand', h, panes: [], box: { x0, x1, z0, z1, top: tiers * rise },
    step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}

/** Strip lights over the doors, and whatever is still running at night. */
export function voxWorkshopGlow(rng, layout) {
  if (!layout?.box) return null;
  const C = glowCanvas(layout);
  const b = layout.box;
  const warm = C.colour(0xffe6b0);
  for (let i = 0; i < 3; i++) {
    const z0 = Math.round(b.z0 + ((b.z1 - b.z0) * (i + 0.18)) / 3);
    const z1 = Math.round(b.z0 + ((b.z1 - b.z0) * (i + 0.82)) / 3);
    if (!rng.bool(0.6)) continue;
    C.box(b.x0 - 2, C.c(4.5), z0, b.x0 - 1, C.c(4.8), z1, warm);
  }
  return glowOrNull(C);
}

/**
 * The cross, and a lit entrance.
 *
 * Drawn as cells on the building's own grid rather than as a quad floated in
 * front of it. The old one was a sign sized for the old hospital, and when the
 * building underneath it changed it stayed exactly where it was — a white
 * panel the size of a wall, hanging in the air.
 */
export function voxHospitalGlow(rng, layout) {
  if (!layout?.box) return null;
  const C = glowCanvas(layout);
  const b = layout.box;
  const red = C.colour(0xff2a2a);
  const warm = C.colour(0xfff2d0);

  // A cross: two bars, on the face, near the top of the slab.
  const arm = Math.max(2, C.c(1.4));
  const y = b.top - Math.max(4, C.c(4));
  const z = Math.round((b.z0 + b.z1) / 2);
  const x = b.x0 + Math.round((b.x1 - b.x0) * 0.22) - 1;
  C.box(x, y - arm, z - Math.round(arm / 2.5), x + 1, y + arm, z + Math.round(arm / 2.5), red);
  C.box(x, y - Math.round(arm / 2.5), z - arm, x + 1, y + Math.round(arm / 2.5), z + arm, red);

  // The entrance, which is the only part of a hospital lit all night.
  const ez0 = Math.round((b.z0 + b.z1) / 2 - C.c(3.4));
  const ez1 = Math.round((b.z0 + b.z1) / 2 + C.c(3.4));
  C.box(b.x0 + 1, C.c(0.5), ez0, b.x0 + 2, C.c(4.0), ez1, warm);
  return glowOrNull(C);
}

voxWorkshopGlow.fromLayout = true;
voxHospitalGlow.fromLayout = true;

/**
 * A ridge on the horizon.
 *
 * The one prop in the game that never went on the grid: the sampler gave it
 * back unchanged every time, so a smooth landform stood on a skyline of cubes.
 * Built as cells it is what it should always have been — a stepped mesa, which
 * is the same terracing the ground beyond the verge now has, at the scale of
 * the thing that closes the view.
 */
export function voxRidge(rng, pal, ctx = {}) {
  const W = 46, D = 26;
  const h = 16 + rng.range(0, 8);
  const rock = mix(pal.ground ?? 0x6a5c4a, pal.prop ?? 0x51483c, 0.35 + rng.next() * 0.4);
  const C = canvasFor(D, W, h + 4, ctx);

  const shades = [
    C.colour(rock),
    C.colour(shade(rock, 0.88)),
    C.colour(shade(rock, 1.08)),
    C.colour(shade(rock, 0.78)),
  ];

  const m = C.c(4 * C.step);
  const x0 = m, x1 = C.nx - m;
  const z0 = m, z1 = C.nz - m;
  const top = C.c(h);

  // A profile along the ridge, and the mass under it. Every column runs to the
  // ground, so what is built is a silhouette rather than a solid.
  const bumps = 3 + rng.int(0, 3);
  const phase = rng.next() * 6.283;
  const heightAtZ = (z) => {
    const t = (z - z0) / Math.max(1, z1 - z0);
    let k = 0.42 + 0.34 * Math.sin(phase + t * 6.283 * (bumps / 3));
    k += 0.18 * Math.sin(phase * 2 + t * 12.5);
    return Math.max(3, Math.round(top * Math.max(0.25, k)));
  };

  // Terraces: each course inset from the one below, so the flanks are steps.
  const courses = Math.max(3, Math.round(C.c(h / 4)));
  for (let z = z0; z < z1; z++) {
    const hz = heightAtZ(z);
    const bands = Math.max(1, Math.round(hz / courses));
    for (let b = 0; b < bands; b++) {
      const y0 = b * courses;
      const y1 = Math.min(hz, y0 + courses);
      if (y0 >= hz) break;
      // Wider at the bottom, and the inset jitters so the flank is not a
      // staircase of identical treads.
      const inset = Math.round((b * (x1 - x0) * 0.052) + (z % 3 === 0 ? 1 : 0));
      C.box(x0 + inset, y0, z, x1 - inset, y1, z + 1, shades[b % shades.length]);
    }
  }

  ctx.layout = {
    kind: 'ridge', h, panes: [], box: { x0, x1, z0, z1, top },
    step: C.step, ox: C.ox, oy: C.oy, oz: C.oz, cells: C.dims,
  };
  return C.geometry();
}
