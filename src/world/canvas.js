import { voxGeometry } from '../vehicle/voxmesh.js';

// A grid you can draw on.
//
// The world was already going through the voxeliser and it did not look like
// it, and the reason is worth writing down because it took a measurement to
// see: a box sampled onto a grid is still a box. A barrel changed, a boulder
// changed, a pine changed — those have curvature for cells to bite into. A
// building is six flat quads, so the grid spent seven thousand triangles
// describing exactly the shape two hundred and twenty-eight already described,
// and nothing about the result read as cubes.
//
// The cars worked because they came from models with detail far finer than the
// cell. So the fix is not a better mesher. It is building things that have
// something to say at cell scale: a window is a recess two cells deep, a ledge
// is a course that oversails by one, a roof is a field of tanks and vents. All
// of which are easier to write as cells than as extrusions.
//
// This is that canvas. It is deliberately small — the only primitive is a
// filled cell range, because everything a building needs composes out of that
// — and it hands its result to the same greedy mesher the cars use.

/**
 * Colour, quantised.
 *
 * Five bits a channel, which is what the car bake settled on: fine enough that
 * two shades of concrete stay two shades, coarse enough that a facade's worth
 * of near-identical greys collapses to one palette entry and merges into one
 * flat run. A palette that never dedupes is a palette that defeats greedy
 * meshing, because two adjacent cells of imperceptibly different grey will not
 * merge.
 */
const QUANT = 31;

export class VoxCanvas {
  /**
   * @param w,h,d  size in metres — x, y (up), z
   * @param step   metres per cell
   * @param opts.origin  where the grid's corner sits, in the prop's own space.
   *                     Defaults to centred on x and z with its base at y=0,
   *                     which is how every prop in this game is built.
   * @param opts.cells   exact grid dimensions, overriding the metric size.
   *                     A second canvas that has to line up cell-for-cell with
   *                     a first one — a pass of lit windows over a wall that
   *                     already cut the holes — asks for the same numbers
   *                     rather than recomputing them from metres and landing a
   *                     cell out.
   */
  constructor(w, h, d, step, opts = {}) {
    this.step = step;
    this.nx = Math.max(1, Math.ceil(w / step));
    this.ny = Math.max(1, Math.ceil(h / step));
    this.nz = Math.max(1, Math.ceil(d / step));
    if (opts.cells) [this.nx, this.ny, this.nz] = opts.cells;
    const [ox, oy, oz] = opts.origin
      ?? [-(this.nx * step) / 2, 0, -(this.nz * step) / 2];
    this.ox = ox; this.oy = oy; this.oz = oz;
    this.at = new Uint16Array(this.nx * this.ny * this.nz);
    this.palette = [];
    this._index = new Map();
    this.count = 0;
  }

  /** Metres to cells, rounded — so a 1.4 m window is a whole number of cubes. */
  c(metres) { return Math.round(metres / this.step); }

  /**
   * A palette slot for this colour, deduped.
   *
   * @returns the value stored in a cell: an index plus one, because zero is
   *          empty and there is no way around that.
   */
  colour(hex) {
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    const qr = Math.round(r * QUANT);
    const qg = Math.round(g * QUANT);
    const qb = Math.round(b * QUANT);
    const key = (qr << 10) | (qg << 5) | qb;
    let i = this._index.get(key);
    if (i === undefined) {
      i = this.palette.length / 3;
      this.palette.push(qr / QUANT, qg / QUANT, qb / QUANT);
      this._index.set(key, i);
    }
    return i + 1;
  }

  /**
   * Fill a range of cells, half-open on the far side, clipped to the grid.
   *
   * Half-open because that is what makes ranges compose: a wall from 0 to 4
   * and one from 4 to 8 meet exactly once, and every off-by-one in a facade is
   * otherwise a doubled course or a missing one.
   *
   * @param v  a value from `colour`, or 0 to carve — carving is how a window
   *           gets its recess and how a doorway gets cut out of a wall
   */
  box(x0, y0, z0, x1, y1, z1, v) {
    const ax = Math.max(0, Math.min(x0, x1));
    const bx = Math.min(this.nx, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1));
    const by = Math.min(this.ny, Math.max(y0, y1));
    const az = Math.max(0, Math.min(z0, z1));
    const bz = Math.min(this.nz, Math.max(z0, z1));
    for (let z = az; z < bz; z++) {
      for (let y = ay; y < by; y++) {
        let o = ax + this.nx * (y + this.ny * z);
        for (let x = ax; x < bx; x++, o++) {
          if (this.at[o]) this.count--;
          this.at[o] = v;
          if (v) this.count++;
        }
      }
    }
    return this;
  }

  /** The grid's dimensions, for a second canvas that has to line up. */
  get dims() { return [this.nx, this.ny, this.nz]; }

  /** Is this cell filled? Bounds-safe, because callers walk off the edge. */
  solid(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return 0;
    return this.at[x + this.nx * (y + this.ny * z)];
  }

  /** The grid, in the shape the mesher reads. */
  get vox() {
    return {
      nx: this.nx, ny: this.ny, nz: this.nz, step: this.step,
      ox: this.ox, oy: this.oy, oz: this.oz,
      palette: this.palette, at: this.at, paint: null, count: this.count,
    };
  }

  /**
   * Mesh it.
   *
   * The same greedy mesher the cars use, and for the same reason: the flat
   * runs a building is mostly made of are the best case it has.
   */
  geometry() {
    return voxGeometry(this.vox, { chunk: -1 });
  }
}

/**
 * A canvas sized to hold a thing, at a cell that suits how far away it is seen.
 *
 * The cell is a compromise the whole look rests on. One size everywhere is the
 * ideal and the cost forbids it — a forty-metre facade at 15 cm is a grid of
 * thirty million cells — so it grows with the object. Not to a fixed count
 * across, which is what the sampler did: to a ladder of sizes, so that two
 * buildings of similar height share a cell and their cubes line up when they
 * stand next to each other. Cubes that disagree by a few centimetres between
 * neighbours is the thing that reads as sloppy rather than as style.
 */
export const CELL_LADDER = [0.15, 0.25, 0.4, 0.6];

export function cellFor(maxDim) {
  for (const c of CELL_LADDER) if (maxDim / c <= 110) return c;
  return CELL_LADDER[CELL_LADDER.length - 1];
}
