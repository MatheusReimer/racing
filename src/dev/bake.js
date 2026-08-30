// Bake a body to a voxel grid, in the browser, and write it to disk.
//
// The plan was to port this to Node beside `decimate.mjs`, and that runs into
// `<canvas>`: three of the seven references keep their paint in a texture — the
// Quattro is 98% white without one — and Node has no canvas to sample it with.
//
// So it bakes here instead. Every visual probe in this project already drives a
// headless Chromium and Playwright is already a dependency, so running the bake
// in that browser costs nothing new and reuses the exact code that has been
// looked at on all seven cars. A port would be a second version of the one
// thing anyone has actually approved.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bake, voxel, voxelGrid, GLASS_RGB } from './styles.js';
import { loadHulls, HULLS } from '../data/bodies/index.js';

const params = new URLSearchParams(location.search);
const CAR = params.get('car') ?? 'roadster';
const CELLS = Number(params.get('cells') ?? 145);

const say = (t, bad = false) => {
  const el = document.getElementById('say');
  el.textContent = t;
  el.classList.toggle('bad', bad);
  if (bad) console.error(t); else console.info(t);
};

/**
 * The car's side view, as a coarse grid of how much car is where.
 *
 * Along the length *and* up the height, not just along the length. A bonnet is
 * long and low and a roof is short and high, and a one-dimensional profile
 * throws exactly that away — it scored the RX-7 at 0.57 against 0.55 deciding
 * which end was its nose, which is not a decision. Two dimensions is the same
 * data read properly.
 */
function profile(zs, ys, weights, bz = 24, by = 10) {
  let z0 = Infinity;
  let z1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < zs.length; i++) {
    if (zs[i] < z0) z0 = zs[i]; if (zs[i] > z1) z1 = zs[i];
    if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
  }
  const sz = (z1 - z0) || 1;
  const sy = (y1 - y0) || 1;
  const out = new Float64Array(bz * by);
  for (let i = 0; i < zs.length; i++) {
    const a = Math.min(bz - 1, Math.floor(((zs[i] - z0) / sz) * bz));
    const b = Math.min(by - 1, Math.floor(((ys[i] - y0) / sy) * by));
    out[b * bz + a] += weights[i];
  }
  let sum = 0;
  for (const v of out) sum += v;
  if (sum > 0) for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

const agreement = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return 1 - d / 2;   // 1 identical, 0 nothing in common
};

/**
 * Put the car in the game's frame: nose at +Z, right flank at +X, Y up, ground
 * at zero, centred across and along, scaled to the length the game uses.
 *
 * `decimate.mjs` did this for the `.bin` path and took the answers from flags
 * on the command line. Those flags are lost — which is a large part of why the
 * hulls cannot simply be re-baked — so the two that matter are measured here
 * instead: the long axis from the bounds, and which end is the nose by matching
 * the car's own shape against the hull the game already ships and trusts.
 */
function normalise(geo, hull) {
  const pos = geo.attributes.position.array;
  let b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < b[k]) b[k] = pos[i + k];
      if (pos[i + k] > b[k + 3]) b[k + 3] = pos[i + k];
    }
  }
  const ex = b[3] - b[0];
  const ez = b[5] - b[2];
  const lengthIsZ = ez >= ex;
  const scale = hull.length / (lengthIsZ ? ez : ex);

  // Into (across, up, along), scaled.
  const n3 = pos.length;
  const out = new Float32Array(n3);
  for (let i = 0; i < n3; i += 3) {
    out[i] = (lengthIsZ ? pos[i] : pos[i + 2]) * scale;
    out[i + 1] = pos[i + 1] * scale;
    out[i + 2] = (lengthIsZ ? pos[i + 2] : pos[i]) * scale;
  }

  // Centre across and along, ground to zero.
  let c = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n3; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (out[i + k] < c[k]) c[k] = out[i + k];
      if (out[i + k] > c[k + 3]) c[k + 3] = out[i + k];
    }
  }
  const cx = (c[0] + c[3]) / 2;
  const cz = (c[2] + c[5]) / 2;
  for (let i = 0; i < n3; i += 3) {
    out[i] -= cx;
    out[i + 1] -= c[1];
    out[i + 2] -= cz;
  }

  // Which end is the nose.
  //
  // The cabin, first, because it is the strongest thing a car has to say about
  // its own direction: a greenhouse sits behind the middle on every car that
  // has ever been built, and `mesh-probe` already decides orientation this way
  // and is trusted to. `bake` asserts one colour for every window, so the glass
  // is findable in the merged geometry by that colour alone.
  //
  // Matching the shape against the shipped hull is the fallback. It works — it
  // flips the Impreza, which is the one the `.bin` bake needed `--flip` for —
  // but on a car whose ends are alike it comes down to a coin toss: 0.57
  // against 0.55 on the RX-7. A signal that thin will get one of these
  // backwards eventually, so it only answers when the cabin cannot.
  const col = geo.attributes.color?.array;
  let gz = 0;
  let gn = 0;
  if (col) {
    for (let i = 0, v = 0; i < n3; i += 3, v += 3) {
      if (Math.abs(col[v] - GLASS_RGB[0]) < 1e-3
        && Math.abs(col[v + 1] - GLASS_RGB[1]) < 1e-3
        && Math.abs(col[v + 2] - GLASS_RGB[2]) < 1e-3) { gz += out[i + 2]; gn++; }
    }
  }

  const hz = [];
  const hy = [];
  const hw = [];
  for (let i = 0; i < hull.positions.length; i += 3) {
    hz.push(hull.positions[i + 2]);
    hy.push(hull.positions[i + 1] - hull.ground);
    hw.push(Math.abs(hull.positions[i]));
  }
  const want = profile(hz, hy, hw);
  const mz = [];
  const my = [];
  const mw = [];
  for (let i = 0; i < n3; i += 3) {
    mz.push(out[i + 2]); my.push(out[i + 1]); mw.push(Math.abs(out[i]));
  }
  const asIs = agreement(want, profile(mz, my, mw));
  const flipped = agreement(want, profile(mz.map((v) => -v), my, mw));

  // Two tests, and the confident one wins.
  //
  // Neither is reliable alone. The cabin is the stronger idea — a greenhouse
  // sits behind the middle on every car ever built — but it depends on finding
  // the glass, and on the Impreza the glass is a guess: that file names all 86
  // of its materials `Meshpart12Mtl`, so the windows come from an opacity band
  // rather than from a name, and a wrong guess moves the centroid. It put the
  // car on the grid backwards, which a picture caught and the number did not.
  //
  // The shape match is the weaker idea and it got the Impreza right by a mile
  // — 0.86 against 0.47 — while being a coin toss on the RX-7 at 0.57 against
  // 0.55, whose ends are alike. So each states how sure it is and the surer one
  // decides. Both margins are reported, because a bake where they disagree and
  // neither is sure is a bake somebody should look at.
  const cabinZ = gn > 200 ? gz / gn : 0;
  const cabinMargin = gn > 200
    ? Math.min(1, Math.abs(cabinZ) / (hull.length * 0.25)) : 0;
  const shapeMargin = Math.abs(asIs - flipped);
  // Below this the cabin is not saying anything — the RX-7's greenhouse sits
  // dead centre, so the sign of its centroid is noise, and reading it as an
  // opinion made the report cry disagreement over nothing.
  const SILENT = 0.05;
  const byCabin = cabinMargin >= SILENT && cabinMargin >= shapeMargin;
  const flip = byCabin ? cabinZ > 0 : flipped > asIs;
  if (flip) for (let i = 2; i < n3; i += 3) out[i] = -out[i];

  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.attributes.position.needsUpdate = true;
  return {
    lengthIsZ,
    scale,
    flipped: flip,
    by: byCabin ? 'cabin' : 'shape',
    cabin: gn ? Number(cabinZ.toFixed(3)) : null,
    cabinMargin: Number(cabinMargin.toFixed(3)),
    glassVerts: gn,
    shapeMargin: Number(shapeMargin.toFixed(3)),
    agree: cabinMargin < SILENT || (cabinZ > 0) === (flipped > asIs),
    match: Math.max(asIs, flipped),
    other: Math.min(asIs, flipped),
  };
}

/**
 * A palette, and one index per occupied cell.
 *
 * Quantised to 5 bits a channel before anything is counted. A voxel car is a
 * shape, not a gradient — averaging a triangle's colours into a cell already
 * threw away more than this does — and it is what keeps the palette inside a
 * byte, which halves the file and lets the mesh read a colour without a lookup
 * table wider than a cache line.
 */
function palettise(grid) {
  const { nx, ny, nz, hits, acc, paint } = grid;
  const index = new Map();
  const palette = [];
  const cells = [];
  const paintable = [];
  for (let cell = 0; cell < hits.length; cell++) {
    const count = hits[cell];
    if (!count) continue;
    // Mostly paint, not merely touched by it. A cell on the seam between a
    // wing and a window belongs to whichever it is more of.
    paintable.push(paint ? (paint[cell] / count > 0.5 ? 1 : 0) : 0);
    const o = cell * 3;
    const q = (v) => Math.max(0, Math.min(31, Math.round((v / count) * 31)));
    const r = q(acc[o]);
    const g = q(acc[o + 1]);
    const b = q(acc[o + 2]);
    const key = (r << 10) | (g << 5) | b;
    let at = index.get(key);
    if (at === undefined) {
      at = palette.length;
      index.set(key, at);
      // Back to bytes, at the centre of the bucket rather than its floor.
      palette.push([
        Math.round((r / 31) * 255), Math.round((g / 31) * 255), Math.round((b / 31) * 255),
      ]);
    }
    cells.push(cell, at);
  }
  return { palette, cells, paintable, dims: [nx, ny, nz] };
}

/** The file. Little-endian, and shaped like `public/bodies/*.bin` beside it. */
function encode(grid, pal) {
  const [nx, ny, nz] = pal.dims;
  const n = pal.cells.length / 2;
  const wide = pal.palette.length > 256;
  const stride = 4 + (wide ? 2 : 1);
  const head = 4 + 4 + 6 + 4 + 12 + 2 + 1 + 1;
  // One bit per cell saying whether the game may paint it, as a run of bytes
  // after the cells. Nine kilobytes on the biggest body, against stealing a bit
  // from the palette index — which would work today and cap the palette at 127
  // on the narrow path, and the Impreza already wants 1,044 colours.
  const bits = Math.ceil(n / 8);
  const buf = new ArrayBuffer(head + pal.palette.length * 3 + n * stride + bits);
  const dv = new DataView(buf);
  let p = 0;
  dv.setUint32(p, 0x584f5652, true); p += 4;      // 'RVOX'
  dv.setUint32(p, 2, true); p += 4;
  dv.setUint16(p, nx, true); p += 2;
  dv.setUint16(p, ny, true); p += 2;
  dv.setUint16(p, nz, true); p += 2;
  dv.setFloat32(p, grid.step, true); p += 4;
  dv.setFloat32(p, grid.ox, true); p += 4;
  dv.setFloat32(p, grid.oy, true); p += 4;
  dv.setFloat32(p, grid.oz, true); p += 4;
  dv.setUint16(p, pal.palette.length, true); p += 2;
  dv.setUint8(p, wide ? 1 : 0); p += 1;
  dv.setUint8(p, 0); p += 1;                       // reserved, keeps it aligned
  for (const [r, g, b] of pal.palette) {
    dv.setUint8(p++, r); dv.setUint8(p++, g); dv.setUint8(p++, b);
  }
  for (let i = 0; i < pal.cells.length; i += 2) {
    dv.setUint32(p, pal.cells[i], true); p += 4;
    if (wide) { dv.setUint16(p, pal.cells[i + 1], true); p += 2; }
    else { dv.setUint8(p, pal.cells[i + 1]); p += 1; }
  }
  for (let i = 0; i < n; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8 && i + k < n; k++) if (pal.paintable[i + k]) byte |= 1 << k;
    dv.setUint8(p++, byte);
  }
  return buf;
}

const loader = new GLTFLoader();
say(`a carregar refs/${CAR}.glb…`);
const gltf = await new Promise((res, rej) =>
  loader.load(`/refs/${CAR}.glb`, res, undefined, rej));

say('a ler cores…');
const geo = await bake(gltf.scene);

say('a alinhar com o frame do jogo…');
await loadHulls();
const fit = normalise(geo, HULLS[CAR]);

say(`a amostrar a grelha ${CELLS}…`);
const grid = voxelGrid(geo, { cells: CELLS });
const pal = palettise(grid);
const buf = encode(grid, pal);

const res = await fetch(`/__vox?name=${encodeURIComponent(CAR)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: buf,
});
const out = await res.json().catch(() => ({ ok: false, error: 'resposta ilegível' }));

const report = {
  car: CAR,
  flipped: fit.flipped,
  by: fit.by,
  cabin: fit.cabin,
  cabinMargin: fit.cabinMargin,
  glassVerts: fit.glassVerts,
  shapeMargin: fit.shapeMargin,
  agree: fit.agree,
  match: Number(fit.match.toFixed(3)),
  other: Number(fit.other.toFixed(3)),
  cells: pal.cells.length / 2,
  palette: pal.palette.length,
  paintable: pal.paintable.reduce((a, b) => a + b, 0),
  dims: pal.dims,
  step: grid.step,
  bytes: buf.byteLength,
  ...out,
};
// A picture of what was baked, from a fixed angle, so somebody can confirm the
// car is facing the way the numbers claim. The nose test is measured, but a
// measurement that puts a car on the grid backwards is worth checking by eye
// once per body rather than discovering in a race.
if (params.get('show')) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11141a);
  scene.add(new THREE.HemisphereLight(0xa8c4ff, 0x14181f, 1.6));
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.0);
  sun.position.set(4, 6, 3);
  scene.add(sun);
  scene.add(voxel(geo, { cells: CELLS }));
  const cam = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.05, 60);
  // Straight down the right flank. With the camera on +X looking at the origin,
  // screen-right is -Z, so a car built to the game's frame shows its nose on
  // the *left* of the picture — every car, no interpretation needed.
  cam.position.set(9.5, 1.6, 0);
  cam.lookAt(0, 0.65, 0);
  const r = new THREE.WebGLRenderer({ antialias: true });
  r.setSize(innerWidth, innerHeight);
  document.body.appendChild(r.domElement);
  r.render(scene, cam);
  window.__shown = true;
}

window.__bake = report;
say(out.ok
  ? `${CAR}: ${report.cells} células, ${report.palette} cores, ${(buf.byteLength / 1024).toFixed(0)} KB`
  : `não gravou: ${out.error}`, !out.ok);
