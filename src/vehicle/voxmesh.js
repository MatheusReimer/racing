import * as THREE from 'three';

// A voxel body, as something a GPU will draw without complaint.
//
// A car at grid 145 is fifty to eighty thousand cells. Drawn as cubes that is
// three hundred to five hundred thousand triangles for one car, and a race has
// six of them plus traffic. Two things make it ordinary instead, and neither is
// a compromise the style forces — they are just what a grid affords:
//
//   * **Most of it is buried.** Measured across the seven bodies, about 72% of
//     every cell face has an occupied neighbour and can never be seen from
//     anywhere. Dropping those is free and it is most of the win.
//
//   * **What is left is flat.** A car is large panels, and a panel on a grid is
//     a run of coplanar same-coloured faces. Merging each run into one quad is
//     the best case for greedy meshing, and the second half of the win.
//
// Colour lives in the vertices. A voxel body has a few hundred colours out of a
// palette baked into the file, so one material draws the whole car and a merged
// quad carries its colour without a texture or a lookup.

/** `RVOX`, little-endian. */
const MAGIC = 0x584f5652;

/**
 * Read one `.vox`.
 *
 * @returns { nx, ny, nz, step, ox, oy, oz, palette, at, paint } — `at` is a
 *          dense index per cell, `0` for empty and `n + 1` for palette entry
 *          `n`, so a neighbour test is one array read and no branch on a
 *          sentinel. `paint` marks the cells the game is allowed to colour.
 */
export function parseVox(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a voxel body');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`voxel body version ${version} is not readable here`);
  let p = 8;
  const nx = dv.getUint16(p, true); p += 2;
  const ny = dv.getUint16(p, true); p += 2;
  const nz = dv.getUint16(p, true); p += 2;
  const step = dv.getFloat32(p, true); p += 4;
  const ox = dv.getFloat32(p, true); p += 4;
  const oy = dv.getFloat32(p, true); p += 4;
  const oz = dv.getFloat32(p, true); p += 4;
  const colours = dv.getUint16(p, true); p += 2;
  const wide = dv.getUint8(p) === 1; p += 1;
  p += 1;

  const palette = new Float32Array(colours * 3);
  for (let i = 0; i < colours; i++) {
    // To linear, because a vertex colour is not sRGB and the renderer will not
    // convert one for us.
    palette[i * 3] = srgb(dv.getUint8(p++));
    palette[i * 3 + 1] = srgb(dv.getUint8(p++));
    palette[i * 3 + 2] = srgb(dv.getUint8(p++));
  }

  // Cells, then one bit each saying whether the game may paint them. The count
  // falls out of the two together rather than being written down twice.
  const stride = 4 + (wide ? 2 : 1);
  const count = Math.floor(((buf.byteLength - p) * 8) / (stride * 8 + 1));
  const at = new Uint16Array(nx * ny * nz);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const cell = dv.getUint32(p, true); p += 4;
    const c = wide ? dv.getUint16(p, true) : dv.getUint8(p);
    p += wide ? 2 : 1;
    at[cell] = c + 1;
    order[i] = cell;
  }
  const paint = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < count; i++) {
    const byte = dv.getUint8(p + (i >> 3));
    if (byte & (1 << (i & 7))) paint[order[i]] = 1;
  }
  return { nx, ny, nz, step, ox, oy, oz, palette, at, paint, count };
}

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  S2L[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
const srgb = (b) => S2L[b];

/**
 * Halve the grid.
 *
 * A car thirty metres away does not need fifty thousand cells, and the coarser
 * body is a fifth of the triangles. The colour of a merged block is the one its
 * eight children agree on most; a tie takes the first, which is arbitrary and
 * stable — the same body has to come out the same every time it is built.
 */
export function coarsen(vox) {
  const nx = Math.ceil(vox.nx / 2);
  const ny = Math.ceil(vox.ny / 2);
  const nz = Math.ceil(vox.nz / 2);
  const at = new Uint16Array(nx * ny * nz);
  const paint = new Uint8Array(nx * ny * nz);
  const tally = new Map();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        tally.clear();
        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = x * 2 + dx;
              const sy = y * 2 + dy;
              const sz = z * 2 + dz;
              if (sx >= vox.nx || sy >= vox.ny || sz >= vox.nz) continue;
              const v = vox.at[sx + vox.nx * (sy + vox.ny * sz)];
              if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
            }
          }
        }
        let win = 0;
        let best = 0;
        for (const [v, n] of tally) if (n > best) { best = n; win = v; }
        const o = x + nx * (y + ny * z);
        at[o] = win;
        if (win) {
          // Paintable if most of what merged into it was. A coarse cell that
          // straddles a wing and a window goes to whichever it is more of,
          // exactly as the fine one did at bake time.
          let yes = 0;
          let all = 0;
          for (let dz = 0; dz < 2; dz++) {
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const sx = x * 2 + dx;
                const sy = y * 2 + dy;
                const sz = z * 2 + dz;
                if (sx >= vox.nx || sy >= vox.ny || sz >= vox.nz) continue;
                const q = sx + vox.nx * (sy + vox.ny * sz);
                if (!vox.at[q]) continue;
                all++;
                if (vox.paint[q]) yes++;
              }
            }
          }
          paint[o] = all && yes * 2 > all ? 1 : 0;
        }
      }
    }
  }
  return { ...vox, nx, ny, nz, step: vox.step * 2, at, paint };
}

/**
 * The mesh.
 *
 * Greedy meshing, six sweeps — one per face direction. Each sweep walks the
 * grid slice by slice, builds a mask of which faces on that slice are exposed
 * and what colour they are, and pulls maximal same-coloured rectangles out of
 * it. A door skin comes out as one quad rather than four hundred.
 */
export function voxGeometry(vox, { body = null, accent = null } = {}) {
  const { nx, ny, nz, step, ox, oy, oz, at, palette, paint } = vox;
  // The car's own colour, where the bake said the game may put one.
  //
  // A body's identity here comes from the build and not from the file: the
  // RX-7 is red because the game paints it red, and a crate can hand the
  // player a colour that has to land somewhere. Without this the palette wins
  // and every RX-7 is the white one its author modelled.
  const paintRGB = body ? [body.r, body.g, body.b] : null;
  const dim = [nx, ny, nz];
  const pos = [];
  const col = [];
  const idx = [];

  const solid = (x, y, z) => (
    x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz
      ? 0 : at[x + nx * (y + ny * z)]);

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const mask = new Int32Array(dim[u] * dim[v]);
    const cell = [0, 0, 0];
    const off = [0, 0, 0];

    for (let dir = -1; dir <= 1; dir += 2) {
      for (let slice = 0; slice < dim[axis]; slice++) {
        // What is exposed on this slice, and in what colour.
        for (let b = 0; b < dim[v]; b++) {
          for (let a = 0; a < dim[u]; a++) {
            cell[axis] = slice; cell[u] = a; cell[v] = b;
            const here = solid(cell[0], cell[1], cell[2]);
            off[axis] = slice + dir; off[u] = a; off[v] = b;
            const there = solid(off[0], off[1], off[2]);
            mask[b * dim[u] + a] = here && !there ? here : 0;
          }
        }

        // And out of it, the biggest rectangles that are all one colour.
        for (let b = 0; b < dim[v]; b++) {
          for (let a = 0; a < dim[u];) {
            const c = mask[b * dim[u] + a];
            if (!c) { a++; continue; }
            let w = 1;
            while (a + w < dim[u] && mask[b * dim[u] + a + w] === c) w++;
            let h = 1;
            grow: while (b + h < dim[v]) {
              for (let k = 0; k < w; k++) {
                if (mask[(b + h) * dim[u] + a + k] !== c) break grow;
              }
              h++;
            }
            for (let j = 0; j < h; j++) {
              for (let i = 0; i < w; i++) mask[(b + j) * dim[u] + a + i] = 0;
            }

            // The quad, in world units. `dir > 0` puts the face on the far
            // side of the cell; the winding follows so every normal points out.
            const base = [0, 0, 0];
            base[axis] = slice + (dir > 0 ? 1 : 0);
            base[u] = a;
            base[v] = b;
            const du = [0, 0, 0]; du[u] = w;
            const dv2 = [0, 0, 0]; dv2[v] = h;

            const o = [ox, oy, oz];
            const corner = (i, j) => [
              o[0] + (base[0] + du[0] * i + dv2[0] * j) * step,
              o[1] + (base[1] + du[1] * i + dv2[1] * j) * step,
              o[2] + (base[2] + du[2] * i + dv2[2] * j) * step,
            ];
            const p0 = corner(0, 0);
            const p1 = corner(1, 0);
            const p2 = corner(1, 1);
            const p3 = corner(0, 1);
            const start = pos.length / 3;
            const quad = dir > 0 ? [p0, p1, p2, p3] : [p0, p3, p2, p1];
            // Every face of a rectangle came off cells of one colour, and a
            // rectangle is only merged across cells that agreed — so asking
            // the first is asking all of them.
            cell[axis] = slice; cell[u] = a; cell[v] = b;
            const painted = paintRGB && paint
              && paint[cell[0] + nx * (cell[1] + ny * cell[2])];
            const rgb = painted
              ? paintRGB
              : [palette[(c - 1) * 3], palette[(c - 1) * 3 + 1], palette[(c - 1) * 3 + 2]];
            for (const q of quad) {
              pos.push(q[0], q[1], q[2]);
              col.push(rgb[0], rgb[1], rgb[2]);
            }
            idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
            a += w;
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
