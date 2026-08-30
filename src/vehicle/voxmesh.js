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
/**
 * How many pieces a body is cut into along its length.
 *
 * Rebuilding a whole car costs 91 to 237 ms, which is not a thing that can
 * happen when somebody hits a wall. Rebuilding an eighth of one is about
 * fifteen, and a car is only ever damaged in one place at a time — so the body
 * is meshed in slabs and a hit rebuilds the slab it landed in.
 *
 * The cost is draw calls: eight per car instead of one. Six racers is
 * forty-eight, which this renderer will not notice, and it is the price of a
 * panel that can lose pieces.
 */
export const CHUNKS = 8;

export function voxGeometry(vox, { body = null, accent = null, emitMask = false,
  chunk = -1, chunks = CHUNKS } = {}) {
  const { nx, ny, nz, step, ox, oy, oz, at, palette, paint } = vox;
  // The car's own colour, where the bake said the game may put one.
  //
  // A body's identity here comes from the build and not from the file: the
  // RX-7 is red because the game paints it red, and a crate can hand the
  // player a colour that has to land somewhere. Without this the palette wins
  // and every RX-7 is the white one its author modelled.
  const paintRGB = body ? [body.r, body.g, body.b] : null;
  // With no colour to substitute, `painted` still has to be computed, because
  // it is what the mask reports.
  const wantPaint = paintRGB || emitMask;
  const dim = [nx, ny, nz];
  const pos = [];
  const col = [];
  const idx = [];
  // Which vertices a per-instance colour is allowed to tint. Traffic needs it:
  // the cars share one geometry and are told apart by an instance colour, and
  // without a mask that colour lands on the glass and the lamps too.
  const msk = emitMask ? [] : null;

  const solid = (x, y, z) => (
    x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz
      ? 0 : at[x + nx * (y + ny * z)]);

  // Which slab this call is for, along z. -1 means the whole body.
  const zFrom = chunk < 0 ? 0 : Math.floor((nz * chunk) / chunks);
  const zTo = chunk < 0 ? nz : Math.floor((nz * (chunk + 1)) / chunks);

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const mask = new Int32Array(dim[u] * dim[v]);
    const cell = [0, 0, 0];
    const off = [0, 0, 0];

    for (let dir = -1; dir <= 1; dir += 2) {
      // The slab, expressed in whichever of this sweep's three indices happens
      // to be z. Masking out-of-slab cells is not enough on its own: the work
      // is in walking the grid, so the walk itself is what has to shrink.
      const lo = [0, 0, 0];
      const hi = [dim[0], dim[1], dim[2]];
      lo[2] = zFrom;
      hi[2] = zTo;
      const sliceFrom = axis === 2 ? zFrom : 0;
      const sliceTo = axis === 2 ? zTo : dim[axis];
      const aFrom = u === 2 ? zFrom : 0;
      const aTo = u === 2 ? zTo : dim[u];
      const bFrom = v === 2 ? zFrom : 0;
      const bTo = v === 2 ? zTo : dim[v];

      for (let slice = sliceFrom; slice < sliceTo; slice++) {
        // What is exposed on this slice, and in what colour.
        for (let b = bFrom; b < bTo; b++) {
          for (let a = aFrom; a < aTo; a++) {
            cell[axis] = slice; cell[u] = a; cell[v] = b;
            const here = solid(cell[0], cell[1], cell[2]);
            off[axis] = slice + dir; off[u] = a; off[v] = b;
            const there = solid(off[0], off[1], off[2]);
            mask[b * dim[u] + a] = here && !there ? here : 0;
          }
        }

        // And out of it, the biggest rectangles that are all one colour.
        for (let b = bFrom; b < bTo; b++) {
          for (let a = aFrom; a < aTo;) {
            const c = mask[b * dim[u] + a];
            if (!c) { a++; continue; }
            let w = 1;
            while (a + w < aTo && mask[b * dim[u] + a + w] === c) w++;
            let h = 1;
            grow: while (b + h < bTo) {
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
            const painted = !!(wantPaint && paint
              && paint[cell[0] + nx * (cell[1] + ny * cell[2])]);
            const rgb = painted && paintRGB
              ? paintRGB
              : [palette[(c - 1) * 3], palette[(c - 1) * 3 + 1], palette[(c - 1) * 3 + 2]];
            for (const q of quad) {
              pos.push(q[0], q[1], q[2]);
              col.push(rgb[0], rgb[1], rgb[2]);
              if (msk) msk.push(painted ? 1 : 0);
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
  if (msk) geo.setAttribute('paintMask', new THREE.BufferAttribute(new Float32Array(msk), 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A voxel body that can lose pieces.
 *
 * This is the thing the whole change of look is for. A decimated body could
 * only ever be *repainted* when it was hurt — scorch marks and a dimmer lamp —
 * because its triangles describe a surface and a surface cannot have a bite
 * taken out of it. A body of cells can simply stop having some, and the cells
 * it stops having are cubes that can fall on the road.
 *
 * Meshed in slabs so a hit costs one slab's rebuild — about 26 ms on the RX-7
 * — rather than the whole car's 91 to 237.
 */
export class VoxBody {
  /**
   * @param vox   parsed `.vox`
   * @param make  (geometry, chunkIndex) => Mesh, so the caller owns materials
   * @param opts  passed to `voxGeometry`; `body` is the paint colour
   */
  constructor(vox, make, opts = {}) {
    this.vox = vox;
    this.opts = opts;
    this.make = make;
    this.group = new THREE.Group();
    this.meshes = [];
    this.dirty = new Set();
    for (let c = 0; c < CHUNKS; c++) {
      const mesh = make(voxGeometry(vox, { ...opts, chunk: c }), c);
      this.meshes.push(mesh);
      if (mesh) this.group.add(mesh);
    }
  }

  /** Which slab a cell index belongs to. */
  chunkOf(cell) {
    const z = (cell / (this.vox.nx * this.vox.ny)) | 0;
    return Math.min(CHUNKS - 1, Math.floor((z * CHUNKS) / this.vox.nz));
  }

  /**
   * Knock a hole in the body around a point, in the body's own coordinates.
   *
   * The hole is every cell inside the radius, because a dent the size of one
   * cell is 2 cm across on a 4 m car and nobody will ever see it. The *debris*
   * is coarser than the hole: cells are grouped onto a lattice `clump` cells
   * wide and each group falls as one cube. A body cell is confetti; a block of
   * eight is a piece of bodywork, which is what a car sheds when it is hit.
   *
   * @param max    ceiling on cubes, not on cells — a big hit still opens a big
   *               hole, it just does not fill the screen with pieces
   * @returns the cubes that came off, as `{ x, y, z, r, g, b, size }` in body
   *          space, in the colour of the panel they came off rather than a
   *          generic grey chip
   */
  chip(px, py, pz, radius, max = 24, clump = 4) {
    const { nx, ny, nz, step, ox, oy, oz, at, palette, paint } = this.vox;
    // A chip off a painted panel is the colour the car is, not the colour its
    // author modelled. The same rule the body itself draws by.
    const body = this.opts.body;
    const gx = Math.floor((px - ox) / step);
    const gy = Math.floor((py - oy) / step);
    const gz = Math.floor((pz - oz) / step);
    const r = Math.max(1, Math.round(radius / step));

    // One bucket per lattice cell touched, keyed on the lattice coordinate.
    const groups = new Map();
    let gone = 0;
    const sweep = (reach) => {
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
            const x = gx + dx;
            const y = gy + dy;
            const z = gz + dz;
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
            const cell = x + nx * (y + ny * z);
            const c = at[cell];
            if (!c) continue;
            at[cell] = 0;
            gone++;
            this.dirty.add(this.chunkOf(cell));

            const lx = Math.floor(x / clump);
            const ly = Math.floor(y / clump);
            const lz = Math.floor(z / clump);
            const key = lx + 4096 * (ly + 4096 * lz);
            let g = groups.get(key);
            if (!g) {
              g = { n: 0, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 };
              groups.set(key, g);
            }
            const painted = body && paint && paint[cell];
            g.n++;
            g.x += x; g.y += y; g.z += z;
            g.r += painted ? body.r : palette[(c - 1) * 3];
            g.g += painted ? body.g : palette[(c - 1) * 3 + 1];
            g.b += painted ? body.b : palette[(c - 1) * 3 + 2];
          }
        }
      }
    };

    sweep(r);
    // A contact point is where two collision *volumes* met, and a car is not
    // its bounding box: a nose-in to a barrier can report a point that sits in
    // the air just past the bumper. Rather than have a hard knock do nothing at
    // all, reach further once. Twice the radius and no more — beyond that the
    // hole stops being where the hit was.
    if (!gone) sweep(r * 2);
    this.vox.count -= gone;

    // The fullest blocks first: a lattice cell that held two cells of bodywork
    // was a corner clipped, and if something has to be dropped it is that.
    const out = [];
    for (const g of groups.values()) {
      out.push({
        x: ox + (g.x / g.n + 0.5) * step,
        y: oy + (g.y / g.n + 0.5) * step,
        z: oz + (g.z / g.n + 0.5) * step,
        r: g.r / g.n, g: g.g / g.n, b: g.b / g.n,
        // A block that was only part full falls as the size it actually was.
        size: step * clump * Math.cbrt(g.n / (clump ** 3)),
        n: g.n,
      });
    }
    out.sort((a, b) => b.n - a.n);
    return out.slice(0, max);
  }

  /**
   * Rebuild whatever a chip dirtied. Separate from `chip` so several hits in
   * one step cost one rebuild, and so the caller decides when to pay it.
   *
   * @returns how many slabs were rebuilt
   */
  flush() {
    if (!this.dirty.size) return 0;
    const n = this.dirty.size;
    for (const c of this.dirty) {
      const old = this.meshes[c];
      const geo = voxGeometry(this.vox, { ...this.opts, chunk: c });
      if (old) {
        old.geometry.dispose();
        old.geometry = geo;
      } else {
        const mesh = this.make(geo, c);
        this.meshes[c] = mesh;
        if (mesh) this.group.add(mesh);
      }
    }
    this.dirty.clear();
    return n;
  }

  dispose() {
    for (const m of this.meshes) m?.geometry.dispose();
    this.group.clear();
  }
}
