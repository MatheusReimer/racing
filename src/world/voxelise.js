import * as THREE from 'three';
import { voxGeometry } from '../vehicle/voxmesh.js';

// Any prop, on the grid.
//
// The world is built from six primitives in `shapes.js` — box, prism, cone,
// rock, extrusion, loft — with two hundred and forty-one calls to them in
// `props.js`. Rewriting each of those as a voxel builder would be a rewrite of
// the world; sampling what they already produce is a function.
//
// It is the same walk the car bake does, at a different scale, and it hands the
// result to the same greedy mesher. A prop is not a different problem from a
// car: it is a surface, sampled onto cells, with the buried faces dropped and
// the flat runs merged.
//
// The cell is **fixed in metres**, and that is the whole of the look. Cars
// derive theirs from their own length, because a car is always about four
// metres and its cubes come out the same size anyway. The world does not: a
// barrel is half a metre and a facade is forty, and a cell scaled to each would
// give them different-sized cubes and no style at all.

/** Metres. Small enough that a barrel is a barrel, large enough to afford. */
export const WORLD_CELL = 0.15;

/**
 * Not everything goes on the grid, and the measurement is why.
 *
 * A barrel comes out *cheaper* voxelised — 572 triangles to 402 — because a
 * cylinder's sides are flat runs and greedy meshing eats them. A shopping mall
 * goes from 292 to 191,874 and a hospital from 588 to 256,186, because a
 * building is a large flat box and a grid spends cells on volume it already
 * described with six quads. Those are instanced across a city, so it is not
 * memory, it is a quarter of a million triangles drawn per building.
 *
 * And it buys nothing: a building is already blocks. The grid changes what a
 * cylinder, a rock and a tree look like, and it does not change what a wall
 * looks like. So a prop the grid would multiply is left as it is.
 *
 * @param geo   any faceted prop geometry, indexed or not
 * @param cell  metres per cube
 * @param maxTris  give up above this and keep the original
 * @returns a new geometry, or the one passed in
 */
export function voxelise(geo, { cell = WORLD_CELL, maxCells = 6e6, maxTris = 20000 } = {}) {
  const posAttr = geo.attributes?.position;
  if (!posAttr) return geo;
  const pos = posAttr.array;
  const col = geo.attributes.color?.array ?? null;
  const idx = geo.index?.array ?? null;
  const faces = (idx ? idx.length : pos.length / 3) / 3;
  if (!faces) return geo;

  let b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < b[k]) b[k] = pos[i + k];
      if (pos[i + k] > b[k + 3]) b[k + 3] = pos[i + k];
    }
  }
  // A cell of margin either side, so a face flush with the bound still lands.
  const ox = b[0] - cell;
  const oy = b[1] - cell;
  const oz = b[2] - cell;
  const nx = Math.ceil((b[3] - b[0]) / cell) + 3;
  const ny = Math.ceil((b[4] - b[1]) / cell) + 3;
  const nz = Math.ceil((b[5] - b[2]) / cell) + 3;
  if (nx * ny * nz > maxCells) return geo;

  const acc = new Float32Array(nx * ny * nz * 3);
  const hits = new Uint32Array(nx * ny * nz);

  const at = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k) * 3;
  for (let t = 0; t < faces; t++) {
    const a = at(t, 0);
    const c1 = at(t, 1);
    const c2 = at(t, 2);
    const span = Math.max(
      Math.abs(pos[c1] - pos[a]) + Math.abs(pos[c1 + 1] - pos[a + 1]) + Math.abs(pos[c1 + 2] - pos[a + 2]),
      Math.abs(pos[c2] - pos[c1]) + Math.abs(pos[c2 + 1] - pos[c1 + 1]) + Math.abs(pos[c2 + 2] - pos[c1 + 2]),
      Math.abs(pos[a] - pos[c2]) + Math.abs(pos[a + 1] - pos[c2 + 1]) + Math.abs(pos[a + 2] - pos[c2 + 2]),
    );
    // Enough samples that no cell the triangle crosses is stepped over.
    const m = Math.min(64, Math.max(1, Math.ceil((span / cell) * 1.5)));
    for (let i = 0; i <= m; i++) {
      for (let j = 0; j <= m - i; j++) {
        const u = i / m;
        const v = j / m;
        const w = 1 - u - v;
        const x = ((pos[a] * w + pos[c1] * u + pos[c2] * v) - ox) / cell | 0;
        const y = ((pos[a + 1] * w + pos[c1 + 1] * u + pos[c2 + 1] * v) - oy) / cell | 0;
        const z = ((pos[a + 2] * w + pos[c1 + 2] * u + pos[c2 + 2] * v) - oz) / cell | 0;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const cellI = x + nx * (y + ny * z);
        hits[cellI]++;
        const o = cellI * 3;
        if (col) {
          acc[o] += col[a] * w + col[c1] * u + col[c2] * v;
          acc[o + 1] += col[a + 1] * w + col[c1 + 1] * u + col[c2 + 1] * v;
          acc[o + 2] += col[a + 2] * w + col[c1 + 2] * u + col[c2 + 2] * v;
        } else { acc[o] += 1; acc[o + 1] += 1; acc[o + 2] += 1; }
      }
    }
  }

  // A palette, so the mesher can carry a colour as an index. Quantised to five
  // bits a channel: a cube's colour is already the average of a triangle's, and
  // this is what keeps a prop's palette to a few dozen entries.
  const index = new Map();
  const palette = [];
  const grid = new Uint16Array(nx * ny * nz);
  let filled = 0;
  for (let c = 0; c < hits.length; c++) {
    const n = hits[c];
    if (!n) continue;
    filled++;
    const o = c * 3;
    const q = (v) => Math.max(0, Math.min(31, Math.round((v / n) * 31)));
    const key = (q(acc[o]) << 10) | (q(acc[o + 1]) << 5) | q(acc[o + 2]);
    let slot = index.get(key);
    if (slot === undefined) {
      slot = palette.length / 3;
      index.set(key, slot);
      palette.push(((key >> 10) & 31) / 31, ((key >> 5) & 31) / 31, (key & 31) / 31);
    }
    grid[c] = slot + 1;
  }
  if (!filled) return geo;

  const out = voxGeometry({
    nx, ny, nz, step: cell, ox, oy, oz,
    at: grid, palette: Float32Array.from(palette), paint: null, count: filled,
  });
  if (out.index.count / 3 > maxTris) { out.dispose(); return geo; }
  geo.dispose();
  return out;
}
