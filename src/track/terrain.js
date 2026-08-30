import * as THREE from 'three';
import { clamp01 } from '../core/math.js';

/**
 * The world's large-scale roll, in metres.
 *
 * Lives here rather than with the ribbon because both surfaces read it and the
 * blocks are now the larger of the two — and because a module that imports the
 * one importing it is a cycle waiting to be tripped over.
 */
export function terrainRoll(x, z) {
  return Math.sin((x + z) * 0.0075) * 1.30
    + Math.sin(x * 0.021) * Math.cos(z * 0.025) * 1.00
    + Math.sin(x * 0.047 - z * 0.033) * 0.42
    + Math.cos(x * 0.088 + z * 0.071) * 0.20;
}


// Ground, in blocks.
//
// The verge is a ribbon that follows the road out to five hundred metres, and
// that is the right shape for the ten metres either side of the asphalt — it
// has to meet the road exactly, at whatever height and width the road happens
// to be, and a grid cannot promise that. It is the wrong shape for everything
// beyond, where it is a vast smooth sheet standing behind a city of cubes.
//
// So the ribbon is cut back to the near band and this takes over outside it: a
// world-aligned heightfield, quantised in plan and in height, meshed as tops
// and the cliffs between them. Which is a voxel terrain — the columns simply
// go all the way down, so nothing under the surface is ever built.
//
// Two rules keep it from fighting the ribbon it hands over from:
//
//   * a column inside the near band is not built at all, so the two never
//     overlap and the road is never buried;
//   * heights are quantised *downward*, so a block at the boundary sits at or
//     below the smooth surface it meets and the seam is a small step down
//     rather than a wall poking through the verge.

/** Where the smooth verge stops and the blocks start, in metres. */
export const NEAR_BAND = 46;

/**
 * How wide a block is, and how tall a step.
 *
 * Six metres, which is the same argument the buildings make about cell size:
 * this is never seen closer than the near band and mostly seen at two hundred
 * metres, where a six-metre block subtends about what a forty-centimetre
 * building cube does at thirty. One and a quarter metres of rise, because the
 * relief out here is only a few metres deep and quantising it to anything
 * coarser gives one terrace and no terracing.
 */
const CELL = 8;

/**
 * How tall a step is, per biome.
 *
 * Fixed, this was wrong at both ends: a biome with two metres of relief got one
 * terrace and no terracing, and one with thirty got twenty-four terraces, every
 * boundary between them a row of cliff quads. Inferno cost a hundred and thirty
 * thousand triangles to say the same thing downtown said in ten.
 *
 * So the step is a fraction of the relief instead, which fixes the number of
 * terraces at about eight everywhere — enough to read as terracing, few enough
 * to merge into large plains.
 */
const TERRACES = 8;

export function riseFor(biome) {
  const elev = biome.elevation ?? 8;
  const relief = biome.city ? 0.06 : 0.42;
  // `terrainRoll` swings about ±2.9 either side of zero.
  return Math.max(0.6, (5.8 * elev * relief) / TERRACES);
}

/** How far out the blocks reach before the backdrop plane takes over. */
const REACH = 380;

/**
 * The ground height the verge would have had here.
 *
 * Deliberately the same expression, so the two surfaces agree about the shape
 * of the world and only disagree about how finely they say it.
 */
export function heightAt(track, biome, x, z) {
  const base = track.groundAt(x, z);
  const elev = biome.elevation ?? 8;
  const relief = biome.city ? 0.06 : 0.42;
  const drop = biome.city ? 0.8 : 4.0;
  return base - drop + terrainRoll(x, z) * elev * relief;
}

/**
 * Which cells the road and its verge already cover.
 *
 * Rasterised rather than solved: walking the path and stamping a disc at each
 * step is one pass over a few hundred samples, where asking every cell for its
 * distance to the centreline is fifty thousand nearest-point queries. The disc
 * is the near band plus the road's own half width, which varies.
 */
function trackMask(track, w, h, minX, minZ) {
  const mask = new Uint8Array(w * h);
  const p = { x: 0, y: 0, z: 0 };
  const stepAlong = Math.max(2, CELL / 2);
  for (let s = 0; s < track.length; s += stepAlong) {
    track.path.pointAt(s, p);
    // A cell is claimed by its *centre*, so a disc measured in whole cells
    // from a whole cell falls short by up to a diagonal — which is how blocks
    // ended up two metres inside the near band, on the road. One more ring of
    // cells covers the rounding on both ends.
    const r = NEAR_BAND + track.halfWidthAt(s);
    const rc = Math.ceil(r / CELL) + 1;
    const cx = Math.floor((p.x - minX) / CELL);
    const cz = Math.floor((p.z - minZ) / CELL);
    for (let dz = -rc; dz <= rc; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= h) continue;
      for (let dx = -rc; dx <= rc; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= w) continue;
        if (dx * dx + dz * dz > rc * rc) continue;
        mask[x + w * z] = 1;
      }
    }
  }
  // The pit lane and any other branch is a road too.
  for (const br of track.branches ?? []) {
    for (let s = 0; s < br.path.length; s += stepAlong) {
      br.path.pointAt(s, p);
      const rc = Math.ceil((NEAR_BAND + br.halfWidth) / CELL) + 1;
      const cx = Math.floor((p.x - minX) / CELL);
      const cz = Math.floor((p.z - minZ) / CELL);
      for (let dz = -rc; dz <= rc; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= h) continue;
        for (let dx = -rc; dx <= rc; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= w) continue;
          if (dx * dx + dz * dz > rc * rc) continue;
          mask[x + w * z] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * The stepped ground beyond the verge.
 *
 * @param quality.drawDistance  blocks past the far plane are vertices nobody
 *                              sees, so the field stops there rather than at a
 *                              constant.
 */
export function buildBlockTerrain(track, biome, quality = {}) {
  const RISE = riseFor(biome);
  const reach = Math.min(REACH, Math.max(200, (quality.drawDistance ?? 900) * 0.75));

  // The circuit's own extent, plus the reach on every side.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const p = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < track.length; s += 12) {
    track.path.pointAt(s, p);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  minX = Math.floor((minX - reach) / CELL) * CELL;
  minZ = Math.floor((minZ - reach) / CELL) * CELL;
  const w = Math.ceil((maxX + reach - minX) / CELL);
  const h = Math.ceil((maxZ + reach - minZ) / CELL);

  const mask = trackMask(track, w, h, minX, minZ);

  // One quantised height per column, or null where the verge has it.
  const level = new Float32Array(w * h);
  const has = new Uint8Array(w * h);
  const elev = biome.elevation ?? 8;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = i + w * j;
      if (mask[k]) continue;
      const x = minX + (i + 0.5) * CELL;
      const z = minZ + (j + 0.5) * CELL;
      // Down, never up: a block that rounds up at the boundary is a block
      // standing proud of the verge it is supposed to hand over from.
      level[k] = Math.floor(heightAt(track, biome, x, z) / RISE) * RISE;
      has[k] = 1;
    }
  }

  const pos = [];
  const col = [];
  const idx = [];
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, shade) => {
    const start = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let v = 0; v < 4; v++) col.push(shade, shade, shade);
    idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };

  /**
   * How bright a terrace is, from how high it is.
   *
   * This used to read the roll at the cell, which meant two cells at the same
   * height were two different colours and would not merge — and merging is the
   * whole reason this is affordable. Off the level instead: one colour per
   * terrace, which is also what makes the terracing legible rather than a
   * dither of sand. Cost went from two hundred thousand triangles to a
   * fraction of it on exactly this line.
   */
  let loLevel = Infinity, hiLevel = -Infinity;
  for (let k = 0; k < level.length; k++) {
    if (!has[k]) continue;
    if (level[k] < loLevel) loLevel = level[k];
    if (level[k] > hiLevel) hiLevel = level[k];
  }
  const span = Math.max(RISE, hiLevel - loLevel);
  const shadeOf = (y) => {
    const t = clamp01((y - loLevel) / span);
    return biome.city ? 0.90 + t * 0.10 : 0.82 + t * 0.36;
  };

  // Tops, merged along x while the height and the shade band agree. Terrain
  // quantised to a metre and a quarter has long runs at the same level, and
  // merging them is most of the difference between this being affordable and
  // it being fifty thousand quads.
  const done = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = i + w * j;
      if (!has[k] || done[k]) continue;
      const y = level[k];
      let run = 1;
      while (i + run < w) {
        const kk = k + run;
        if (!has[kk] || done[kk] || level[kk] !== y) break;
        run++;
      }
      // And on into z while the whole run repeats: a terrace is a shape, not a
      // line, and a plain of one height is one quad rather than a thousand.
      let deep = 1;
      while (j + deep < h) {
        let same = true;
        for (let r = 0; r < run; r++) {
          const kk = k + r + w * deep;
          if (!has[kk] || done[kk] || level[kk] !== y) { same = false; break; }
        }
        if (!same) break;
        deep++;
      }
      for (let d = 0; d < deep; d++) {
        for (let r = 0; r < run; r++) done[k + r + w * d] = 1;
      }
      const x0 = minX + i * CELL;
      const z0 = minZ + j * CELL;
      push(x0, y, z0, x0, y, z0 + deep * CELL, x0 + run * CELL, y, z0 + deep * CELL,
        x0 + run * CELL, y, z0, shadeOf(y));
      i += run - 1;
    }
  }

  // Cliffs. A face wherever a column stands above its neighbour, and one at
  // the edge of the field so it is not a sheet of paper seen side-on.
  const EDGE = Math.max(3.0, RISE * 2);
  const at = (i, j) => {
    if (i < 0 || j < 0 || i >= w || j >= h) return null;
    const kk = i + w * j;
    return has[kk] ? level[kk] : null;
  };
  // A cliff face is a shade darker than the top it belongs to: without it a
  // terrace and its riser are the same colour and the steps vanish.
  const cliffShade = (y) => shadeOf(y) * 0.82;

  // West and east faces, merged along z; north and south along x. A step in a
  // heightfield runs for tens of cells before it turns, and one quad per cell
  // of it was most of what this cost.
  for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const along = di ? 'z' : 'x';
    const seen = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = i + w * j;
        if (!has[k] || seen[k]) continue;
        const y = level[k];
        const nb = at(i + di, j + dj);
        const low = nb == null ? y - EDGE : nb;
        if (low >= y) continue;
        // How far this same step runs.
        let run = 1;
        for (;;) {
          const i2 = along === 'z' ? i : i + run;
          const j2 = along === 'z' ? j + run : j;
          const k2 = i2 + w * j2;
          if (i2 >= w || j2 >= h || !has[k2] || seen[k2] || level[k2] !== y) break;
          const nb2 = at(i2 + di, j2 + dj);
          if ((nb2 == null ? y - EDGE : nb2) !== low) break;
          run++;
        }
        for (let r = 0; r < run; r++) {
          seen[(along === 'z' ? i : i + r) + w * (along === 'z' ? j + r : j)] = 1;
        }
        const x0 = minX + i * CELL;
        const z0 = minZ + j * CELL;
        const x1 = x0 + (along === 'x' ? run : 1) * CELL;
        const z1 = z0 + (along === 'z' ? run : 1) * CELL;
        const s = cliffShade(y);
        if (di === -1) push(x0, y, z0, x0, low, z0, x0, low, z1, x0, y, z1, s);
        else if (di === 1) push(x1, y, z1, x1, low, z1, x1, low, z0, x1, y, z0, s);
        else if (dj === -1) push(x0, y, z0, x1, y, z0, x1, low, z0, x0, low, z0, s);
        else push(x1, y, z1, x0, y, z1, x0, low, z1, x1, low, z1, s);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  // The ground material is textured, and a block terrain wants that texture
  // laid on in world space rather than stretched over each quad.
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let v = 0; v < pos.length / 3; v++) {
    uv[v * 2] = pos[v * 3] * 0.09;
    uv[v * 2 + 1] = pos[v * 3 + 2] * 0.09;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export const _internal = { CELL, heightAt, riseFor };

/**
 * The height of the ground actually drawn at a point, whichever surface draws
 * it.
 *
 * Props stand where the *road plane* is, extended sideways: a prop two hundred
 * metres out is placed at the height of the piece of road it was measured
 * from. The ground out there is nothing of the sort — it has dropped away by
 * `drop` and picked up several metres of roll — so scenery has been standing
 * in the air, by up to forty metres on the biomes with the most relief. It was
 * true against the smooth verge too and simply harder to see; terracing the
 * ground made it obvious.
 *
 * So this is the one place that answers "how high is the ground here", and the
 * two renderers and the scatter all read it. Near the road it is the ribbon's
 * blend; past the near band it is the block's quantised level, which is what
 * you would stand on.
 *
 * @param off  metres from the edge of the road, which is what the verge blends
 *             against and what the scatter already has to hand
 */
export function surfaceAt(track, biome, x, z, off, lateral = null) {
  const lat = Math.abs(lateral ?? off);
  if (lat >= NEAR_BAND) {
    const rise = riseFor(biome);
    return Math.floor(heightAt(track, biome, x, z) / rise) * rise;
  }
  // Inside the band, the same step the verge is built with — otherwise a prop
  // beside the road stands on the height the ground used to have rather than
  // the one it has.
  return vergeLevel(track, biome, x, z, off, lat, lat - off);
}

/**
 * One cell of the near band's height, quantised as the verge quantises it.
 *
 * Shared by the mesh and the scatter so a barrel is on the step it looks like
 * it is on. The step grows from nothing at the kerb to the biome's full
 * terrace by the time the world blocks take over: a two-metre riser beside the
 * racing line would be a wall, and the same riser two hundred metres out is
 * the landscape.
 */
export function vergeLevel(track, biome, x, z, off, lateral, hw) {
  const base = track.groundAt(x, z);
  const smooth = base - 0.30
    + (heightAt(track, biome, x, z) - (base - 0.30)) * clamp01(off / 70);
  const q = riseFor(biome) * clamp01((Math.abs(lateral) - (hw + 3)) / (NEAR_BAND - 8));
  return q < 0.05 ? smooth : Math.floor(smooth / q) * q;
}

/**
 * The near band, in blocks that follow the road.
 *
 * The far ground went on a world-aligned grid and the forty-six metres beside
 * the asphalt stayed a smooth sheet, because that band has a job the grid
 * cannot do: it has to meet the road exactly, at whatever height and width the
 * road happens to be, on a curve. A world grid cannot promise that — its cells
 * are eight metres of straight edge and the road is neither.
 *
 * So this is a grid in the *road's* space instead. Rings along the centreline,
 * columns out from it, and every cell flat at its own quantised height with a
 * riser to its neighbours. It hugs the road because its rows are the road's
 * rows, and it steps because every cell is level.
 *
 * Two details make the seams work at both ends:
 *
 *   * the innermost column is not quantised at all. It sits exactly where the
 *     old smooth verge put it, thirty centimetres under the road edge, so the
 *     asphalt still meets ground and not a cliff.
 *   * the step grows with distance — a few centimetres at the kerb, the
 *     biome's full terrace height by the time it hands over to the world
 *     blocks. A two-metre riser beside the racing line would be a wall; the
 *     same riser two hundred metres out is the landscape.
 */
export function buildBlockVerge(track, biome, quality = {}) {
  const L = track.length;
  const detail = quality.terrainDetail ?? 1;
  // About four metres of road per ring, which is the same order as the block
  // field's cell: the two grids disagree about direction, and there is no
  // hiding that, but they can at least agree about size.
  const along = detail >= 0.95 ? 4 : 6;
  const rings = Math.max(8, Math.round(L / along));
  const across = detail >= 0.95 ? 3.5 : 5;
  // Columns out to the near band on both sides, plus the centre pair that sit
  // against the road edge.
  const cols = [];
  for (let v = -NEAR_BAND; v <= NEAR_BAND + 0.001; v += across) cols.push(v);

  const pos = [];
  const col = [];
  const uv = [];
  const idx = [];
  const p = { x: 0, y: 0, z: 0 };
  const t = { x: 0, z: 0 };

  // One pass to find every cell's corner positions and height, then one to
  // emit. Heights are wanted before the risers can be built, and a cell needs
  // its neighbour's.
  const nx2 = rings, nz2 = cols.length;
  const px = new Float32Array(nx2 * nz2);
  const pz = new Float32Array(nx2 * nz2);
  const py = new Float32Array(nx2 * nz2);
  const sh = new Float32Array(nx2 * nz2);
  const uu = new Float32Array(nx2 * nz2);

  for (let i = 0; i < rings; i++) {
    const s = (i / rings) * L;
    track.path.pointAt(s, p);
    track.path.tangentAt(s, t);
    const nx = t.z, nz = -t.x;
    const hw = track.halfWidthAt(s);

    for (let j = 0; j < nz2; j++) {
      const want = cols[j];
      // Push the inner columns just past the road edge so the verge starts
      // where the asphalt ends, whatever the width is here.
      const lateral = Math.sign(want || 1) * Math.max(Math.abs(want), hw + 1.8);
      const off = Math.abs(lateral) - hw;
      const x = p.x + nx * lateral;
      const z = p.z + nz * lateral;

      const y = vergeLevel(track, biome, x, z, off, lateral, hw);

      const k = i * nz2 + j;
      px[k] = x; pz[k] = z; py[k] = y;
      uu[k] = lateral;
      const roll = terrainRoll(x, z);
      sh[k] = biome.city
        ? 0.90 + clamp01(0.5 + roll * 0.3) * 0.10
        : 0.82 + clamp01(0.5 + roll * 0.3) * 0.36;
    }
  }

  const vert = (x, y, z, u, v, shade) => {
    const at = pos.length / 3;
    pos.push(x, y, z);
    col.push(shade, shade, shade);
    uv.push(u * 0.09, v * 0.09);
    return at;
  };
  const quad = (a, b, c, d) => {
    idx.push(a, b, c, a, c, d);
  };

  for (let i = 0; i < rings; i++) {
    const i1 = (i + 1) % rings;
    const s0 = (i / rings) * L;
    const s1 = s0 + L / rings;
    for (let j = 0; j < nz2 - 1; j++) {
      const a = i * nz2 + j;
      const b = i * nz2 + j + 1;
      const c = i1 * nz2 + j;
      const d = i1 * nz2 + j + 1;
      // The top. Flat, at the mean of its corners' levels — which for cells
      // that quantised to the same step is exactly that step, and for the ones
      // straddling a step is the half-way surface a riser then covers.
      const shade = (sh[a] + sh[b]) * 0.5;
      const v0 = vert(px[a], py[a], pz[a], uu[a], s0, shade);
      const v1 = vert(px[b], py[b], pz[b], uu[b], s0, shade);
      const v2 = vert(px[d], py[d], pz[d], uu[d], s1, shade);
      const v3 = vert(px[c], py[c], pz[c], uu[c], s1, shade);
      quad(v0, v3, v2, v1);

      // The riser between this column and the next, where they differ. Drawn
      // as its own pair of triangles so the top stays level: a quad stretched
      // between two heights is a ramp, and a ramp is what this is replacing.
      if (py[a] !== py[b] || py[c] !== py[d]) {
        const dark = shade * 0.84;
        const r0 = vert(px[b], py[a], pz[b], uu[b], s0, dark);
        const r1 = vert(px[b], py[b], pz[b], uu[b], s0, dark);
        const r2 = vert(px[d], py[d], pz[d], uu[d], s1, dark);
        const r3 = vert(px[d], py[c], pz[d], uu[d], s1, dark);
        quad(r0, r1, r2, r3);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
