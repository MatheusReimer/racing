// Reduce a reference car to a triangle budget the game can carry, and keep
// everything else about it.
//
//   node tools/decimate.mjs <model> <name> --length=4.06 [--target=50000]
//                           [--exclude=a,b] [--wheels=a,b] [--flip]
//
// tools/hull.mjs traces a hull by walking cross-sections, which is the right
// shape of answer at a thousand triangles and the wrong one at fifty thousand.
// A section resampled onto N angles is star-shaped by construction: one radius
// per direction, so nothing that folds back under itself survives — not a wheel
// arch, not a grille, not a door shut, not a mirror. Raising N past the point
// where the outline is captured buys a smoother version of the same simplified
// car, never a more detailed one.
//
// Past that point the only way to keep the detail is to keep the mesh. So this
// collapses edges instead, cheapest-first by quadric error, until the budget is
// met. Every triangle left is one the reference had.
//
// That makes the output derivative in a way nothing in silhouette.mjs was. A
// measurement of a real car is a fact about the car; this is the reference's own
// surface with fewer vertices in it. The licence on the reference governs what
// comes out of here — see refs/README.txt — and `source` records which one.

import { writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readModel } from './lib/model.mjs';
import { CLS, RANK, classify, isWheelName, isWheelMaterial } from './lib/classify.mjs';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
if (pos.length < 2) {
  console.log('usage: node tools/decimate.mjs <model> <name> --length=4.06'
    + ' [--target=50000] [--exclude=a,b] [--wheels=a,b] [--flip]');
  process.exit(1);
}
const num = (k, d) => Number(args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d);
const list = (k) => (args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

const file = pos[0];
const NAME = pos[1];
const TARGET_L = num('length', 0);
const TARGET = num('target', 50000);
const flip = args.includes('--flip');
const exclude = list('exclude');
const asWheels = list('wheels');

// --- read and sort ---------------------------------------------------------

const meshes = readModel(file);
const body = [];          // flat xyz per corner, three corners per triangle
const bodyCls = [];       // one class per triangle
const wheelPts = [];
// Where the model's own glass would be, if it declared any.
//
// The last resort, for a file that names neither its materials nor its objects
// — the GC8 calls every object `Object_31` and every material `Meshpart12Mtl`,
// and its greenhouse was invented from a bounding box at load time as a result.
// What it *does* have is three small parts that are genuinely translucent and
// sit in the top third of the car, which is a windscreen and two side windows.
//
// Alpha alone is not enough and the classifier says so at length: this file
// declares its own bodywork fully transparent across eight thousand triangles.
// Alpha *and* being a small thing high up is enough — bodywork is neither.
const modelY = { lo: Infinity, hi: -Infinity };
let modelTris = 0;
for (const m of meshes) {
  modelTris += m.tris.length / 9;
  for (let i = 1; i < m.tris.length; i += 3) {
    if (m.tris[i] < modelY.lo) modelY.lo = m.tris[i];
    if (m.tris[i] > modelY.hi) modelY.hi = m.tris[i];
  }
}
const modelH = Math.max(1e-6, modelY.hi - modelY.lo);

function looksGlazed(m) {
  const a = m.alpha ?? 1;
  // Above 0.05 because a zero is a broken export, not a window; below 0.95
  // because anything else is opaque whatever the file claims.
  if (!(a > 0.05 && a < 0.95)) return false;
  if (m.tris.length / 9 > modelTris * 0.02) return false;    // not a panel
  let lo = Infinity;
  for (let i = 1; i < m.tris.length; i += 3) if (m.tris[i] < lo) lo = m.tris[i];
  return (lo - modelY.lo) / modelH > 0.55;                   // above the belt
}

let dropped = 0;
let inside = 0;
let glazed = 0;
for (const m of meshes) {
  const lower = (m.name ?? '').toLowerCase();
  if (exclude.some((t) => lower.includes(t))) { dropped++; continue; }
  if (isWheelName(m.name) || isWheelMaterial(m.mat) || asWheels.some((t) => lower.includes(t))) {
    for (let i = 0; i < m.tris.length; i++) wheelPts.push(m.tris[i]);
    continue;
  }
  let c = classify(m.mat, m, m.name);
  if (c === CLS.PAINT && looksGlazed(m)) { c = CLS.GLASS; glazed += m.tris.length / 9; }
  if (c === CLS.INSIDE) { inside += m.tris.length / 9; continue; }
  for (let i = 0; i < m.tris.length; i++) body.push(m.tris[i]);
  for (let i = 0; i < m.tris.length; i += 9) bodyCls.push(c);
}
if (exclude.length && !dropped) throw new Error(`--exclude matched no mesh in ${basename(file)}`);
if (!body.length) throw new Error('no bodywork left after --exclude/--wheels');

// --- normalise -------------------------------------------------------------

function bounds(...ls) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const t of ls) {
    for (let i = 0; i < t.length; i += 3) {
      if (t[i] < b.x0) b.x0 = t[i]; if (t[i] > b.x1) b.x1 = t[i];
      if (t[i + 1] < b.y0) b.y0 = t[i + 1]; if (t[i + 1] > b.y1) b.y1 = t[i + 1];
      if (t[i + 2] < b.z0) b.z0 = t[i + 2]; if (t[i + 2] > b.z1) b.z1 = t[i + 2];
    }
  }
  return b;
}
const raw = bounds(body, wheelPts);
const lengthIsZ = (raw.z1 - raw.z0) >= (raw.x1 - raw.x0);
const dir = flip ? -1 : 1;
const scale = TARGET_L > 0 ? TARGET_L / (lengthIsZ ? raw.z1 - raw.z0 : raw.x1 - raw.x0) : 1;

// +Z at the nose, +X on the right flank, Y up — the frame chassis.js builds in.
const remap = (p) => {
  const o = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    o[i] = (lengthIsZ ? p[i] : p[i + 2]) * scale;
    o[i + 1] = p[i + 1] * scale;
    o[i + 2] = (lengthIsZ ? p[i + 2] : p[i]) * dir * scale;
  }
  return o;
};
const P = remap(body);
const Wh = remap(wheelPts);
// Centred in x and z: everything downstream assumes the car straddles the
// origin, and a reference is under no obligation to have been modelled there.
let bb = bounds(P, Wh);
const cx = (bb.x0 + bb.x1) / 2;
const cz = (bb.z0 + bb.z1) / 2;
for (let i = 0; i < P.length; i += 3) { P[i] -= cx; P[i + 2] -= cz; }
for (let i = 0; i < Wh.length; i += 3) { Wh[i] -= cx; Wh[i + 2] -= cz; }
bb = bounds(P, Wh);
const ground = bb.y0;

// --- weld ------------------------------------------------------------------
//
// A collapse needs to know which triangles share an edge, and a triangle soup
// does not say. Corners are snapped to a tenth of a millimetre and merged: fine
// enough that no shut line closes up, coarse enough that the float noise two
// exporters disagree on does not leave a seam welded shut on one side only.
const GRID = 1e4;
const index = new Uint32Array(P.length / 3);
const verts = [];
{
  const seen = new Map();
  for (let i = 0, v = 0; i < P.length; i += 3, v++) {
    const key = `${Math.round(P[i] * GRID)},${Math.round(P[i + 1] * GRID)},${Math.round(P[i + 2] * GRID)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      seen.set(key, id);
      verts.push(P[i], P[i + 1], P[i + 2]);
    }
    index[v] = id;
  }
}
const positions = new Float32Array(verts);
const triIn = index.length / 3;

// --- simplify --------------------------------------------------------------

await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;
const targetIdx = Math.min(triIn, TARGET) * 3;
// The error ceiling is deliberately enormous so that the triangle budget is the
// only thing that stops the collapse. At 1e-2 the Beetle halted at a hundred
// and eight thousand triangles — under its own error bound, nowhere near the
// number asked for. What a car should look like at fifty thousand triangles is
// the question being asked; how much quadric error that costs is the answer.
// No LockBorder. A reference is a car built out of dozens of separate shells —
// each wing, bumper and lamp its own island — and locking every island's rim
// leaves a floor the collapse cannot go below: the Beetle stopped dead at a
// hundred and seven thousand triangles, its own borders being most of them.
// Glass is told to hold its shape, because otherwise it does not.
//
// The collapse is blind to what a triangle is, and it spends its budget in
// proportion to what it is given: the GC8's windows are 522 of 146,000
// triangles, so they got a third of a per cent of fifty thousand and the frames
// around them were collapsed into faces that bridged the openings — pale
// wedges sitting in the middle of black windows.
//
// A per-vertex attribute the simplifier is told to preserve makes a collapse
// across the glass boundary expensive without locking anything, so the aperture
// keeps its shape and the rest of the car still spends the budget where the
// error is. One channel, one weight.
const glassAttr = new Float32Array(positions.length / 3);
{
  // A vertex is glass if any triangle wearing it is.
  let v = 0;
  for (let f = 0; f < bodyCls.length; f++) {
    for (let k = 0; k < 3; k++, v++) {
      if (bodyCls[f] === CLS.GLASS) glassAttr[index[v]] = 1;
    }
  }
}
const [outIdx, error] = MeshoptSimplifier.simplifyWithAttributes(
  index, positions, 3,
  glassAttr, 1, [3],   // one channel, weighted enough to hold a boundary
  null,                // nothing locked; see the note on LockBorder above
  targetIdx, 1,
);
const triOut = outIdx.length / 3;

// Vertices the collapse orphaned are still in the buffer; drop them so the file
// is not mostly unreferenced coordinates.
const used = new Int32Array(positions.length / 3).fill(-1);
let nv = 0;
for (let i = 0; i < outIdx.length; i++) if (used[outIdx[i]] < 0) used[outIdx[i]] = nv++;
const outPos = new Float32Array(nv * 3);
for (let i = 0; i < used.length; i++) {
  if (used[i] < 0) continue;
  outPos[used[i] * 3] = positions[i * 3];
  outPos[used[i] * 3 + 1] = positions[i * 3 + 1];
  outPos[used[i] * 3 + 2] = positions[i * 3 + 2];
}
const outIndices = new Uint32Array(outIdx.length);
for (let i = 0; i < outIdx.length; i++) outIndices[i] = used[outIdx[i]];

// One class per output triangle, taken from the nearest triangle of the
// original.
//
// Not carried on the vertices, which is what this did first and is wrong for a
// welded mesh: a black trim strip shares its corners with the panel it sits on,
// so the darker class takes those corners and then the per-triangle vote walks
// it outward across the bodywork. The Beetle came back eighty-five per cent
// black. Asking which original triangle a surviving one landed on cannot bleed,
// because it never looks at a neighbour.
const CELL = 0.05;
const gridKey = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
const buckets = new Map();
for (let t = 0; t < bodyCls.length; t++) {
  const o = t * 9;
  const x = (P[o] + P[o + 3] + P[o + 6]) / 3;
  const y = (P[o + 1] + P[o + 4] + P[o + 7]) / 3;
  const z = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
  const k = gridKey(x, y, z);
  let b = buckets.get(k);
  if (!b) { b = []; buckets.set(k, b); }
  b.push(x, y, z, bodyCls[t]);
}
const triCls = new Uint8Array(triOut);
for (let t = 0; t < triOut; t++) {
  const a = outIndices[t * 3] * 3;
  const b = outIndices[t * 3 + 1] * 3;
  const c = outIndices[t * 3 + 2] * 3;
  const x = (outPos[a] + outPos[b] + outPos[c]) / 3;
  const y = (outPos[a + 1] + outPos[b + 1] + outPos[c + 1]) / 3;
  const z = (outPos[a + 2] + outPos[b + 2] + outPos[c + 2]) / 3;
  let best = CLS.PAINT;
  let bestD = Infinity;
  const gx = Math.floor(x / CELL);
  const gy = Math.floor(y / CELL);
  const gz = Math.floor(z / CELL);
  for (let r = 0; r <= 2 && bestD === Infinity; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const bk = buckets.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!bk) continue;
          for (let i = 0; i < bk.length; i += 4) {
            const d = (bk[i] - x) ** 2 + (bk[i + 1] - y) ** 2 + (bk[i + 2] - z) ** 2;
            if (d < bestD) { bestD = d; best = bk[i + 3]; }
          }
        }
      }
    }
  }
  triCls[t] = best;
}

// --- wheels ----------------------------------------------------------------
//
// Measured and rebuilt by the game, never shipped: they are four identical
// objects the generator already draws, and spending the budget on the
// reference's would be paying twice for the same rim.
let wheel = null;
if (Wh.length) {
  const wb = bounds(Wh);
  let fS = 0; let fN = 0; let rS = 0; let rN = 0; let maxX = 0;
  for (let i = 0; i < Wh.length; i += 3) {
    if (Wh[i + 2] >= 0) { fS += Wh[i + 2]; fN++; } else { rS += Wh[i + 2]; rN++; }
    maxX = Math.max(maxX, Math.abs(Wh[i]));
  }
  // Track is centre to centre, so it is the outer reach less half a tyre.
  const halfTyre = maxX * 0.07;
  wheel = {
    radius: (wb.y1 - wb.y0) / 2,
    width: halfTyre * 2,
    front: fN ? fS / fN : 1,
    rear: rN ? rS / rN : -1,
    track: (maxX - halfTyre) * 2,
  };
}
const ov = (args.find((a) => a.startsWith('--wheel=')) ?? '').slice(8).split(',');
if (ov.length > 1) {
  const pick = (i, was) => (ov[i] && ov[i] !== '-' ? Number(ov[i]) : was);
  wheel = {
    radius: pick(0, (wheel?.radius ?? 0.3) * 2) / 2,
    width: pick(1, wheel?.width ?? 0.2),
    front: pick(2, wheel?.front ?? 1),
    rear: pick(3, wheel?.rear ?? -1),
    track: pick(4, wheel?.track ?? 1.4),
  };
}

// --- write -----------------------------------------------------------------
//
// Binary, not a .js module. Fifty thousand triangles is a megabyte of
// coordinates and printing them as decimal source would cost a third again in
// size and a parse of the whole thing at boot.

const HEADER = 64;
const buf = new ArrayBuffer(HEADER + outPos.byteLength + outIndices.byteLength
  + Math.ceil(triOut / 4) * 4);
const dv = new DataView(buf);
dv.setUint32(0, 0x524c4852, true);         // 'RHLR'
dv.setUint32(4, 2, true);                  // format version
dv.setUint32(8, nv, true);
dv.setUint32(12, triOut, true);
const bodyBB = bounds(P);
dv.setFloat32(16, bb.z1 - bb.z0, true);    // length
dv.setFloat32(20, bodyBB.x1 - bodyBB.x0, true);
dv.setFloat32(24, bb.y1 - ground, true);
dv.setFloat32(28, ground, true);
dv.setFloat32(32, wheel?.radius ?? 0, true);
dv.setFloat32(36, wheel?.width ?? 0, true);
dv.setFloat32(40, wheel?.front ?? 0, true);
dv.setFloat32(44, wheel?.rear ?? 0, true);
dv.setFloat32(48, wheel?.track ?? 0, true);
let off = HEADER;
new Float32Array(buf, off, outPos.length).set(outPos); off += outPos.byteLength;
new Uint32Array(buf, off, outIndices.length).set(outIndices); off += outIndices.byteLength;
new Uint8Array(buf, off, triOut).set(triCls);

mkdirSync('public/bodies', { recursive: true });
writeFileSync(`public/bodies/${NAME}.bin`, Buffer.from(buf));

const n = [0, 0, 0, 0, 0];
for (const c of triCls) n[c]++;
console.log(`${basename(file)} -> public/bodies/${NAME}.bin`);
console.log(`  ${triIn.toLocaleString()} tris in, ${triOut.toLocaleString()} out`
  + `${inside ? ` (${inside.toLocaleString()} interior dropped)` : ''}, error ${error.toExponential(1)}`);
console.log(`  ${(bb.z1 - bb.z0).toFixed(2)} x ${(bodyBB.x1 - bodyBB.x0).toFixed(2)} x ${(bb.y1 - ground).toFixed(2)} m`
  + (wheel ? `, wheels r=${wheel.radius.toFixed(3)} on a ${wheel.track.toFixed(2)} m track` : ', no wheels'));
console.log(`  paint ${n[0]}  glass ${n[1]}  dark ${n[2]}  chrome ${n[3]}  lamp ${n[4]}`
  + `  |  ${(buf.byteLength / 1048576).toFixed(2)} MB`);
