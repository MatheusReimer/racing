// Three ways to draw a car that is not the car's own triangles.
//
// The decimated hull failed as a *look* because decimation is compression: it
// answers "keep this shape with fewer triangles", and the answer always reads
// as a melted copy. These three answer a different question — what should the
// shape be — and each throws away something on purpose.
//
//   facetado    hard planes, flat shading, creases where the collapse put them
//   arredondado the same collapse, relaxed and inflated: volumes, no detail
//   voxel       the car on a grid, drawn as the cells it fills
//
// All three start from the reference merged into one geometry with the material
// colours baked onto the vertices, because none of them can carry 18 materials
// and a style has to decide colour per surface rather than per shader.
//
// Dev only. This reads refs/, which is nobody's to ship.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { CLS, classify } from '../../tools/lib/classify.mjs';

/** What a window is painted, whatever the reference thinks it is. */
const GLASS = new THREE.Color(0x2b3a52);
// Exported so the bake can find the windows again in the merged geometry: the
// colour is asserted, so it is also a label.
export const GLASS_RGB = [GLASS.r, GLASS.g, GLASS.b];

/** sRGB byte to linear float. A texture is sRGB; a vertex colour is not. */
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * A texture's pixels, once per texture.
 *
 * Half the references keep their paint in an image rather than in
 * baseColorFactor, and reading only the factor turns those cars white: the GC8
 * has 92 textures behind 86 materials that are all `1,1,1`, and came out a
 * featureless white lump with mint windows. glTF loads with `flipY` false, so
 * row zero of the image is v zero and no flip is wanted here.
 */
const PIXELS = new WeakMap();
function texels(tex) {
  let got = PIXELS.get(tex);
  if (got) return got;
  const img = tex.image;
  if (!img?.width) return null;
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  got = { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
  PIXELS.set(tex, got);
  return got;
}

/**
 * Every mesh under `root`, flattened into one indexed geometry carrying only
 * position and colour.
 *
 * Welded on the way out, and that is not optional: a collapse needs to know
 * which triangles share an edge, and glTF splits a vertex at every seam where
 * a normal or a UV changes. Dropping those attributes does not put the corners
 * back together — the index still names two vertices — so the simplifier sees
 * a boundary at every crease and refuses to cross it. Unwelded, the MX-5 asked
 * for fourteen hundred triangles and stopped at forty-two thousand.
 *
 * Welded on position *and* colour, so the corner where black trim meets paint
 * stays two vertices. That boundary is the thing `collapse` is then told to
 * hold, and it cannot hold what was already averaged away.
 */
export function bake(root) {
  root.updateMatrixWorld(true);

  // Two passes, because what a window is on one car is decided by what the
  // whole car said. First read every mesh's class from its names.
  const list = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const c = m?.color ?? new THREE.Color(0.8, 0.8, 0.8);
    list.push({
      o, m, c,
      cls: classify(m?.name, { rgb: [c.r, c.g, c.b], metallic: m?.metalness ?? 0 }, o.name),
    });
  });

  // Then, only if nothing on this car was *called* a window, fall back to what
  // glTF says to honour. One reference gives the names nothing to read — the
  // GC8 calls all 86 of its materials `Meshpart12Mtl` and names no node — and
  // came out a white lump with mint panes.
  //
  // The band is the whole trick, and it is why this is not the alpha test the
  // classifier refuses to make. That file declares 49 materials BLEND
  // including `Body2Mtl`, its own bodywork — at alpha 0.00, along with the
  // hubs, the springs and both wishbones. Everything the file lies about is
  // fully transparent; everything that is actually glass sits between 0.30 and
  // 0.55. Rejecting the ends keeps the lie out and the glass in, and a car that
  // named its windows never reaches this at all.
  if (!list.some((e) => e.cls === CLS.GLASS)) {
    for (const e of list) {
      if (e.m?.transparent && e.m.opacity > 0.2 && e.m.opacity < 0.8) e.cls = CLS.GLASS;
    }
  }

  const parts = [];
  for (const { o, m, c, cls } of list) {
    const src = o.geometry;
    const g = new THREE.BufferGeometry();
    const pos = src.attributes.position.clone();
    g.setAttribute('position', pos);
    g.setIndex(src.index
      ? src.index.clone()
      : new THREE.BufferAttribute(Uint32Array.from({ length: pos.count }, (_, i) => i), 1));

    // And whether this is bodywork the game is allowed to paint.
    //
    // A car's identity in this game comes from the build, not from the file:
    // the RX-7 is red because the game paints it red, and a crate can hand the
    // player a colour that has to land somewhere. So the bake records which
    // cells are paint and which are the car — glass, trim, lamps, tyres — and
    // the mesh decides at build time. Without this the palette wins and every
    // RX-7 is the white one its author modelled.
    const paint = new Float32Array(pos.count).fill(cls === CLS.PAINT ? 1 : 0);

    // Colour, per vertex, from whichever of the three places this file keeps it.
    const col = new Float32Array(pos.count * 3);
    const tex = cls === CLS.GLASS ? null : (m?.map ? texels(m.map) : null);
    const uv = src.attributes.uv;

    for (let i = 0; i < pos.count; i++) {
      const w = i * 3;
      if (cls === CLS.GLASS) {
        // Asserted, not read. What each author tints their glass is their own
        // decision — mint on one car, near-black on another — and the point of
        // this is that a window looks like a window on all seven.
        col[w] = GLASS.r; col[w + 1] = GLASS.g; col[w + 2] = GLASS.b;
      } else if (tex && uv) {
        // Wrapped rather than clamped: a UV outside the unit square means the
        // texture repeats, which is what these files assume.
        const u = uv.getX(i) - Math.floor(uv.getX(i));
        const v = uv.getY(i) - Math.floor(uv.getY(i));
        const x = Math.min(tex.w - 1, (u * tex.w) | 0);
        const y = Math.min(tex.h - 1, (v * tex.h) | 0);
        const o2 = (y * tex.w + x) * 4;
        col[w] = S2L[tex.d[o2]] * c.r;
        col[w + 1] = S2L[tex.d[o2 + 1]] * c.g;
        col[w + 2] = S2L[tex.d[o2 + 2]] * c.b;
      } else {
        col[w] = c.r; col[w + 1] = c.g; col[w + 2] = c.b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('paint', new THREE.BufferAttribute(paint, 1));

    g.applyMatrix4(o.matrixWorld);
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();

  // A tenth of a millimetre, in whatever units this file is drawn in. The
  // seven references disagree — the MX-5 is 397 units long and the Impreza
  // 17 — so the snap is a fraction of the car rather than a constant.
  const box = new THREE.Box3().setFromBufferAttribute(merged.attributes.position);
  const snap = box.getSize(new THREE.Vector3()).length() / 40000;

  const pos = merged.attributes.position.array;
  const col = merged.attributes.color.array;
  const pnt = merged.attributes.paint.array;
  const src = merged.index.array;
  const seen = new Map();
  const map = new Int32Array(pos.length / 3);
  const P = [], C = [], N = [];
  for (let v = 0; v < map.length; v++) {
    const o = v * 3;
    // Paint is part of the identity of a vertex, not a passenger on it: a
    // point where a painted panel meets a rubber seal is two vertices, and
    // welding them would hand the seal to the paint or the other way about.
    const key = `${Math.round(pos[o] / snap)},${Math.round(pos[o + 1] / snap)},`
      + `${Math.round(pos[o + 2] / snap)},${Math.round(col[o] * 255)},`
      + `${Math.round(col[o + 1] * 255)},${Math.round(col[o + 2] * 255)},${pnt[v]}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = P.length / 3;
      seen.set(key, id);
      P.push(pos[o], pos[o + 1], pos[o + 2]);
      C.push(col[o], col[o + 1], col[o + 2]);
      N.push(pnt[v]);
    }
    map[v] = id;
  }
  const idx = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) idx[i] = map[src[i]];

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
  g.setAttribute('paint', new THREE.BufferAttribute(new Float32Array(N), 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  merged.dispose();
  return g;
}

/**
 * Collapse to a triangle budget, holding colour boundaries.
 *
 * The colour is fed to the simplifier as an attribute rather than left to ride
 * along: a collapse that does not know where the black trim ends will walk it
 * across the wing, and at a thousand triangles there is nothing left to hide
 * that behind.
 *
 * `Permissive` is what makes the budget reachable at all. A reference car is
 * dozens of separate shells, and a collapse that refuses to change topology
 * runs out of legal moves long before it runs out of budget: the MX-5 asked for
 * fourteen hundred triangles and stopped dead at twenty-six thousand, at eight
 * times the error the permissive run reaches. `Prune` then drops the shells too
 * small to survive at this size — on its own it is far too eager, taking the
 * car down to three hundred triangles, but behind `Permissive` there is a car
 * left for it to trim.
 */
export async function collapse(geo, tris) {
  await MeshoptSimplifier.ready;
  MeshoptSimplifier.useExperimentalFeatures = true;
  const index = geo.index.array instanceof Uint32Array
    ? geo.index.array : new Uint32Array(geo.index.array);
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;
  const [out] = MeshoptSimplifier.simplifyWithAttributes(
    index, pos, 3,
    col, 3, [1.5, 1.5, 1.5],
    null,
    Math.min(index.length, tris * 3), 1,
    ['Permissive', 'Prune'],
  );

  // Drop the vertices the collapse orphaned.
  const used = new Int32Array(pos.length / 3).fill(-1);
  let nv = 0;
  for (let i = 0; i < out.length; i++) if (used[out[i]] < 0) used[out[i]] = nv++;
  const p = new Float32Array(nv * 3);
  const c = new Float32Array(nv * 3);
  for (let i = 0; i < used.length; i++) {
    const j = used[i];
    if (j < 0) continue;
    p[j * 3] = pos[i * 3]; p[j * 3 + 1] = pos[i * 3 + 1]; p[j * 3 + 2] = pos[i * 3 + 2];
    c[j * 3] = col[i * 3]; c[j * 3 + 1] = col[i * 3 + 1]; c[j * 3 + 2] = col[i * 3 + 2];
  }
  const idx = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) idx[i] = used[out[i]];

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// ---------------------------------------------------------------------------
// facetado
// ---------------------------------------------------------------------------
//
// The collapse, de-indexed and flat shaded. Same triangles the failed hull was
// made of — the difference is entirely that nobody pretends they are a smooth
// surface. A crease reads as a crease instead of as an artefact, so the budget
// can go an order of magnitude lower than the hull's and still look deliberate.

export function facetado(collapsed) {
  const g = collapsed.toNonIndexed();
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0.0,
  });
  return new THREE.Mesh(g, mat);
}

// ---------------------------------------------------------------------------
// arredondado
// ---------------------------------------------------------------------------
//
// The same collapse with the detail relaxed out of it: volumes, and no line
// anywhere that has to be right.
//
// Plain Laplacian smoothing destroys this. A car model is not a solid — every
// panel is an infinitely thin shell with an open rim — and pulling each vertex
// toward the average of its neighbours walks a thin shell into its own middle.
// Six passes turned the MX-5 into red shreds hanging in the air.
//
// Taubin's fix is to alternate: a positive pass that smooths and shrinks, then
// a negative pass slightly larger that pushes back out. High-frequency detail
// does not survive the pair; volume does. The rims of the shells are pinned on
// top of that, so the window openings and panel gaps stay where they were cut
// rather than creeping shut.

export function arredondado(collapsed, { pairs = 8, lambda = 0.55, mu = -0.58 } = {}) {
  const box = new THREE.Box3().setFromBufferAttribute(collapsed.attributes.position);
  const reach = box.getSize(new THREE.Vector3()).length();
  const g = mergeVertices(collapsed.clone(), reach / 40000);
  const idx = g.index.array;
  const n = g.attributes.position.count;

  // Neighbours, as a flat adjacency built once.
  const deg = new Uint32Array(n);
  for (let i = 0; i < idx.length; i += 3) {
    deg[idx[i]] += 2; deg[idx[i + 1]] += 2; deg[idx[i + 2]] += 2;
  }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = start.slice(0, n);
  const adj = new Uint32Array(start[n]);

  // An edge carried by one triangle is a rim. Both its ends are held still.
  const rim = new Uint8Array(n);
  const once = new Map();
  const seen = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    once.set(key, (once.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    adj[fill[a]++] = b; adj[fill[b]++] = a;
    adj[fill[b]++] = c; adj[fill[c]++] = b;
    adj[fill[c]++] = a; adj[fill[a]++] = c;
    seen(a, b); seen(b, c); seen(c, a);
  }
  for (const [key, count] of once) {
    if (count !== 1) continue;
    const [a, b] = key.split(',');
    rim[+a] = 1; rim[+b] = 1;
  }

  let a = Float32Array.from(g.attributes.position.array);
  let b = new Float32Array(a.length);
  const pass = (step) => {
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      if (rim[v]) { b[o] = a[o]; b[o + 1] = a[o + 1]; b[o + 2] = a[o + 2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      const s = start[v], e = start[v + 1];
      for (let k = s; k < e; k++) {
        const w = adj[k] * 3;
        sx += a[w]; sy += a[w + 1]; sz += a[w + 2];
      }
      const c = e - s;
      if (!c) { b[o] = a[o]; b[o + 1] = a[o + 1]; b[o + 2] = a[o + 2]; continue; }
      b[o] = a[o] + step * (sx / c - a[o]);
      b[o + 1] = a[o + 1] + step * (sy / c - a[o + 1]);
      b[o + 2] = a[o + 2] + step * (sz / c - a[o + 2]);
    }
    [a, b] = [b, a];
  };
  for (let p = 0; p < pairs; p++) { pass(lambda); pass(mu); }

  g.attributes.position.array.set(a);
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.34, metalness: 0.0,
  });
  return new THREE.Mesh(g, mat);
}

// ---------------------------------------------------------------------------
// voxel
// ---------------------------------------------------------------------------
//
// Which cells of a grid the car passes through, drawn as cubes. Nothing of the
// surface survives: a cell is on or off, and its colour is the average of
// everything that crossed it.
//
// Fed the merged reference rather than a collapse, unlike the other two. A
// collapse is a budget on triangles and this is a budget on cells — putting one
// in front of the other only means the grid samples somebody's approximation
// instead of the car. A million triangles cost about a second here because
// almost all of them are smaller than a cell and take three samples each.
//
// Cell count grows with the square of the resolution, not the cube: this is a
// shell, so 46 cells along the car is about 4,700 cubes and 145 is about ten
// times that.

/**
 * The grid itself, without a mesh around it.
 *
 * Split out so the same walk serves the viewer and the offline bake. The bake
 * wants occupancy and colour; the viewer wants cubes. Making the bake reproduce
 * this walk in another language would mean two versions of the one thing anyone
 * has actually looked at.
 *
 * @returns { nx, ny, nz, step, ox, oy, oz, hits, acc } — `acc` is summed colour
 *          per cell and `hits` the sample count, so a colour is `acc / hits`.
 */
export function voxelGrid(geo, { cells = 145 } = {}) {
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;
  const idx = geo.index.array;

  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const size = box.getSize(new THREE.Vector3());
  const step = Math.max(size.x, size.y, size.z) / cells;
  const nx = Math.floor(size.x / step) + 1;
  const ny = Math.floor(size.y / step) + 1;
  const nz = Math.floor(size.z / step) + 1;
  const ox = box.min.x, oy = box.min.y, oz = box.min.z;

  // Flat rather than a Map. At this resolution the grid is a couple of million
  // cells and the surface touches a fiftieth of them, but the walk below runs
  // three million times and a typed array index is the cheap end of that.
  const acc = new Float32Array(nx * ny * nz * 3);
  const hits = new Uint32Array(nx * ny * nz);
  // How much of each cell came off paintable bodywork, so the bake can say
  // whether the game may colour it.
  const pnt = geo.attributes.paint?.array ?? null;
  const paint = pnt ? new Float32Array(nx * ny * nz) : null;

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    // Enough samples that no cell the triangle crosses is stepped over.
    const span = Math.max(
      Math.abs(bx - ax) + Math.abs(by - ay) + Math.abs(bz - az),
      Math.abs(cx - bx) + Math.abs(cy - by) + Math.abs(cz - bz),
      Math.abs(ax - cx) + Math.abs(ay - cy) + Math.abs(az - cz),
    );
    // Enough samples that no cell the triangle crosses is stepped over — and the
    // ceiling matters far more than it looks. At 64 a shopping mall's wall, two
    // triangles thirty-seven metres across, was sampled every 58 cm onto a
    // 15 cm grid: the shell came out full of holes, and a hole isolates every
    // cell around it, so nothing merges and every face is exposed. That mall
    // meshed to 220,656 triangles. At 256 it is 1,040. The greedy mesher was
    // never the problem. Higher is not better either — at 1,024 it is 3,358,
    // because the extra samples catch stray cells at the edges of triangles
    // and those fragment the runs the merge depends on.
    const m = Math.min(256, Math.max(1, Math.ceil((span / step) * 1.5)));
    for (let i = 0; i <= m; i++) {
      for (let j = 0; j <= m - i; j++) {
        const u = i / m, v = j / m, w = 1 - u - v;
        const x = (ax * w + bx * u + cx * v - ox) / step | 0;
        const y = (ay * w + by * u + cy * v - oy) / step | 0;
        const z = (az * w + bz * u + cz * v - oz) / step | 0;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const cell = x + nx * (y + ny * z);
        hits[cell]++;
        const o = cell * 3;
        acc[o] += col[a] * w + col[b] * u + col[c] * v;
        acc[o + 1] += col[a + 1] * w + col[b + 1] * u + col[c + 1] * v;
        acc[o + 2] += col[a + 2] * w + col[b + 2] * u + col[c + 2] * v;
        if (paint) {
          paint[cell] += pnt[idx[t]] * w + pnt[idx[t + 1]] * u + pnt[idx[t + 2]] * v;
        }
      }
    }
  }

  return { nx, ny, nz, step, ox, oy, oz, hits, acc, paint };
}

/** Cubes, for looking at. */
export function voxel(geo, { cells = 145, shrink = 0.94 } = {}) {
  const { nx, ny, nz, step, ox, oy, oz, hits, acc } = voxelGrid(geo, { cells });

  let filled = 0;
  for (let i = 0; i < hits.length; i++) if (hits[i]) filled++;

  const cube = new THREE.BoxGeometry(step * shrink, step * shrink, step * shrink);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.0 });
  const mesh = new THREE.InstancedMesh(cube, mat, filled);
  const at = new THREE.Object3D();
  const tint = new THREE.Color();
  let n = 0;
  for (let cell = 0; cell < hits.length; cell++) {
    const count = hits[cell];
    if (!count) continue;
    const x = cell % nx;
    const y = ((cell / nx) | 0) % ny;
    const z = (cell / (nx * ny)) | 0;
    at.position.set(ox + (x + 0.5) * step, oy + (y + 0.5) * step, oz + (z + 0.5) * step);
    at.updateMatrix();
    mesh.setMatrixAt(n, at.matrix);
    const o = cell * 3;
    mesh.setColorAt(n, tint.setRGB(acc[o] / count, acc[o + 1] / count, acc[o + 2] / count));
    n++;
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}
