// Measure a 3D model of a car and print a `BODY_TYPES` entry for it.
//
//   node tools/silhouette.mjs <model> [name] [--length=4.06] [--belt=0.55] [--floor=0.22]
//
// Reads .glb, .obj and .stl, which between them cover what an accurate car model
// is actually distributed as.
//
// The model is a *ruler*, not an asset. Nothing from it is shipped or loaded at
// runtime: the tool slices it into cross-sections, works out the proportions,
// and prints the same table of numbers `chassis.js` has always lofted a car
// from. The reference stays on somebody's disk and the repository gains twenty
// lines of arithmetic — which is what keeps "no art assets" true while letting a
// real car drive the shape.
//
// Two things follow from that, and they are the whole reason to work this way:
//
//   - The reference can be as heavy as you like. A 200k-triangle scan and a
//     50-triangle game asset both reduce to fifteen rings, so the right
//     reference is the *accurate* one rather than the one that is already
//     low-poly. Measuring a stylised game car only copies somebody else's
//     stylisation, which is the problem, not the fix.
//   - The result is checkable. A hand-tuned profile is somebody's memory of a
//     car; a measured one is 4.06 m long because the thing it came from is.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------
//
// Each returns `[{ name, tris }]`, where `tris` is a flat list of 9 numbers per
// triangle already in world space. Triangles rather than vertices, because of
// what the sampler below has to do to them.

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGLB(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB`);

  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk in the GLB');

  const read = (index) => {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const Type = COMPONENT[acc.componentType];
    const n = COUNT[acc.type];
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? 0;
    if (!stride || stride === n * Type.BYTES_PER_ELEMENT) {
      return new Type(bin.buffer, bin.byteOffset + start, acc.count * n);
    }
    const out = new Type(acc.count * n);
    for (let i = 0; i < acc.count; i++) {
      out.set(new Type(bin.buffer, bin.byteOffset + start + i * stride, n), i * n);
    }
    return out;
  };

  const out = [];
  const nodes = json.nodes ?? [];
  const walk = (index, parent) => {
    const node = nodes[index];
    const local = new THREE.Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else {
      local.compose(
        new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
        new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
        new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
      );
    }
    const world = new THREE.Matrix4().multiplyMatrices(parent, local);

    if (node.mesh != null) {
      const tris = [];
      const v = new THREE.Vector3();
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.attributes?.POSITION == null) continue;
        const pos = read(prim.attributes.POSITION);
        const idx = prim.indices != null ? read(prim.indices) : null;
        const count = idx ? idx.length : pos.length / 3;
        for (let i = 0; i < count; i++) {
          const k = (idx ? idx[i] : i) * 3;
          v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(world);
          tris.push(v.x, v.y, v.z);
        }
      }
      if (tris.length) out.push({ name: node.name ?? json.meshes[node.mesh].name ?? '', tris });
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? nodes.map((_, i) => i)) walk(root, new THREE.Matrix4());
  return out;
}

function readOBJ(path) {
  const text = readFileSync(path, 'utf8');
  const vx = [];
  const groups = [{ name: '', tris: [] }];
  for (const line of text.split('\n')) {
    if (line[0] === 'v' && line[1] === ' ') {
      const p = line.split(/\s+/);
      vx.push(+p[1], +p[2], +p[3]);
    } else if ((line[0] === 'o' || line[0] === 'g') && line[1] === ' ') {
      groups.push({ name: line.slice(2).trim(), tris: [] });
    } else if (line[0] === 'f' && line[1] === ' ') {
      // Fan-triangulate whatever the face has; only the position index matters.
      const ix = line.trim().split(/\s+/).slice(1)
        .map((t) => { const i = parseInt(t, 10); return i < 0 ? vx.length / 3 + i : i - 1; });
      const g = groups[groups.length - 1];
      for (let i = 1; i + 1 < ix.length; i++) {
        for (const kk of [ix[0], ix[i], ix[i + 1]]) {
          g.tris.push(vx[kk * 3], vx[kk * 3 + 1], vx[kk * 3 + 2]);
        }
      }
    }
  }
  return groups.filter((g) => g.tris.length);
}

function readSTL(path) {
  const buf = readFileSync(path);
  // An ASCII STL starts with "solid", but so does many a binary one. The
  // triangle count matching the file length is the reliable tell.
  const binarySized = buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length;
  const ascii = buf.subarray(0, 5).toString('ascii') === 'solid' && !binarySized;

  const tris = [];
  if (ascii) {
    for (const m of buf.toString('utf8').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
      tris.push(+m[1], +m[2], +m[3]);
    }
  } else {
    const n = buf.readUInt32LE(80);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;      // past the facet normal
      for (let k = 0; k < 9; k++) tris.push(buf.readFloatLE(o + k * 4));
    }
  }
  // An STL is one anonymous soup, so no wheels can be told apart in it.
  return [{ name: '', tris }];
}

function readModel(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.glb') return readGLB(path);
  if (ext === '.obj') return readOBJ(path);
  if (ext === '.stl') return readSTL(path);
  throw new Error(`unsupported format ${ext} — this reads .glb, .obj and .stl`);
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/**
 * Wheels are measured, never drawn.
 *
 * `chassis.js` builds its own, so a reference's wheels are useful only as
 * numbers — but they are the most useful numbers in the file. The wheel is the
 * one part of a car whose real size the eye already knows, so its diameter sets
 * the scale everything beside it is read against. They also stand in front of
 * the bodywork, so they have to be separated out either way.
 */
// The second half is not pedantry: "wheel" also names the one in front of the
// driver. A steering wheel sits at about the height of a tyre's diameter, so
// letting it in stretches the wheel group from the tarmac to the dashboard and
// the car is measured as riding on metre-tall tyres.
const isWheel = (name) => /wheel|tyre|tire|rim|hub/i.test(name)
  && !/steer|fly ?wheel|arch|well|house|spare|cover/i.test(name);

function bounds(...lists) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const tris of lists) {
    for (let i = 0; i < tris.length; i += 3) {
      const x = tris[i], y = tris[i + 1], z = tris[i + 2];
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;
    }
  }
  return b;
}

/**
 * The outline of the car at `zc`, between two heights, by cutting the triangles
 * with the plane.
 *
 * Not by collecting the vertices near it, which is what this did first and is
 * wrong for exactly the models worth measuring. A flat panel has vertices only
 * at its corners — on a low-poly van the whole roof is one quad, so every
 * station between its two ends samples nothing and the roof measures as a hole.
 * A dense model fails the other way: a slab catches thousands of interior
 * vertices and the section becomes whatever is inside the shell.
 *
 * Intersecting the surface answers the question actually being asked — what is
 * the outline of this car, here — and answers it identically for a fifty
 * triangle asset and a two hundred thousand triangle scan. That is what lets the
 * reference be chosen for being accurate rather than for being conveniently
 * coarse.
 */
function sliceBand(tris, zc, lo, hi) {
  let w = 0, y0 = Infinity, y1 = -Infinity, hits = 0;
  for (let i = 0; i < tris.length; i += 9) {
    for (let e = 0; e < 3; e++) {
      const a = i + e * 3;
      const b = i + ((e + 1) % 3) * 3;
      const za = tris[a + 2], zb = tris[b + 2];
      if ((za < zc && zb < zc) || (za > zc && zb > zc) || za === zb) continue;
      const t = (zc - za) / (zb - za);
      const y = tris[a + 1] + (tris[b + 1] - tris[a + 1]) * t;
      if (y < lo || y > hi) continue;
      const ax = Math.abs(tris[a] + (tris[b] - tris[a]) * t);
      if (ax > w) w = ax;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      hits++;
    }
  }
  return hits ? { w: w * 2, y0, y1 } : null;
}

/** A light 1-2-1: the difference between a silhouette and a sawtooth. */
function smooth(rows) {
  if (rows.length < 3) return rows;
  const pass = (get) => rows.map((r, i) => {
    const a = rows[Math.max(0, i - 1)], b = rows[Math.min(rows.length - 1, i + 1)];
    return (get(a) + get(r) * 2 + get(b)) / 4;
  });
  const w = pass((r) => r.w), h = pass((r) => r.h), cy = pass((r) => r.cy);
  return rows.map((r, i) => ({ ...r, w: w[i], h: h[i], cy: cy[i], y0: cy[i] - h[i] / 2 }));
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
if (!positional.length) {
  console.log('usage: node tools/silhouette.mjs <model.glb|obj|stl> [name]'
    + ' [--length=4.06] [--flip] [--belt=0.55] [--floor=0.22] [--rings=15]');
  process.exit(1);
}
const file = positional[0];
const name = positional[1]
  ?? basename(file).replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
const flip = args.includes('--flip');
const belt = Number(args.find((a) => a.startsWith('--belt='))?.slice(7) ?? 0.55);
const RINGS = Number(args.find((a) => a.startsWith('--rings='))?.slice(8) ?? 15);
// A reference is rarely at real scale, and every number printed below is a ratio
// against a real car, so the measurement has to be brought to metres first.
// Length is the one dimension anybody can look up.
const TARGET_L = Number(args.find((a) => a.startsWith('--length='))?.slice(9) ?? 0);
// Where the bodywork starts, as a fraction of the model's height.
//
// Only needed when the reference has its wheels merged into the body mesh, which
// plenty do. Then the tyres are in every lower section: the silhouette grows
// arches it should not have and the ride height measures as the few centimetres
// between the tarmac and the bottom of a tyre. Cutting the model off at the
// sills throws the wheels away along with the axles and the exhaust, none of
// which chassis.js takes from a profile anyway.
const floorFrac = Number(args.find((a) => a.startsWith('--floor='))?.slice(8) ?? NaN);
// Mesh nodes to drop before measuring, by case-insensitive name substring.
//
// A reference is somebody's scene, not a specification, and scenes carry things
// that are not the car: a ground plane under it, a tailgate left open, a stand.
// They are excluded by name rather than worked around, so the reference and the
// twenty lines it produces stay traceable to each other — run tools/_nodes.mjs
// to see what a file actually contains.
const exclude = (args.find((a) => a.startsWith('--exclude='))?.slice(10) ?? '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
// Mesh nodes to treat as wheels even though nothing in their name says so.
//
// Half the references worth measuring name every node `Object_41`, and the
// wheels are then invisible to `isWheel` — which costs more than the wheel
// numbers themselves. With no wheels to separate, the tool falls back to slicing
// the model off at `--floor` to get the tyres out of the sections, and the ride
// height it reports afterwards is that fraction rather than a measurement.
// Naming them here buys back a measured ride height. tools/_findwheels.mjs
// picks the candidates out by shape: low, round in profile, four of a kind.
const asWheels = (args.find((a) => a.startsWith('--wheels='))?.slice(9) ?? '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

const meshes = readModel(file);
if (!meshes.length) throw new Error('no geometry in the file');

const wheelTris = [];
const bodyTris = [];
// Appended one at a time rather than with `push(...m.tris)`: a spread passes
// every element as an argument, so an accurate reference — the kind this tool
// asks for — overflows the call stack before it is ever measured.
let dropped = 0;
for (const m of meshes) {
  if (exclude.some((t) => m.name.toLowerCase().includes(t))) { dropped++; continue; }
  const wheel = isWheel(m.name)
    || asWheels.some((t) => m.name.toLowerCase().includes(t));
  const dst = wheel ? wheelTris : bodyTris;
  for (let i = 0; i < m.tris.length; i++) dst.push(m.tris[i]);
}
if (exclude.length && !dropped) throw new Error(`--exclude matched no mesh in ${basename(file)}`);
const hasWheels = wheelTris.length > 0;

const raw = bounds(bodyTris, wheelTris);
// Y-up, and length is whichever horizontal axis is longer. Everything below
// works in a frame with +Z at the nose, +X on the right flank and Y up.
const lengthIsZ = (raw.z1 - raw.z0) >= (raw.x1 - raw.x0);
const dir = flip ? -1 : 1;
const scale = TARGET_L > 0
  ? TARGET_L / (lengthIsZ ? raw.z1 - raw.z0 : raw.x1 - raw.x0)
  : 1;

const remap = (pts) => {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    out[i] = (lengthIsZ ? pts[i] : pts[i + 2]) * scale;
    out[i + 1] = pts[i + 1] * scale;
    out[i + 2] = (lengthIsZ ? pts[i + 2] : pts[i]) * dir * scale;
  }
  return out;
};

const body = remap(bodyTris);
const wheels = remap(wheelTris);
let bb = hasWheels ? bounds(body, wheels) : bounds(body);
// Slide the car onto x = 0 before anything measures it.
//
// `sliceBand` reads a section's width as the furthest |x| it reaches, doubled,
// which is true only of a car straddling the origin — and a reference is under
// no obligation to be modelled there. Left where it sat, a car parked ten metres
// off-axis measures ten metres wide in every ring, and because every width is
// then normalised against an equally wrong `bodyW`, the profile comes out flat
// instead of obviously broken. Centring first is what makes the mirroring
// assumption behind that doubling actually hold.
const xc = (bb.x0 + bb.x1) / 2;
if (xc !== 0) {
  for (let i = 0; i < body.length; i += 3) body[i] -= xc;
  for (let i = 0; i < wheels.length; i += 3) wheels[i] -= xc;
  bb = hasWheels ? bounds(body, wheels) : bounds(body);
}

const L = bb.z1 - bb.z0;
const W = bb.x1 - bb.x0;
const H = bb.y1 - bb.y0;
const ground = bb.y0;
const zMid = (bb.z0 + bb.z1) / 2;

// --- wheels ---------------------------------------------------------------
let wheelR = 0, wheelbase = 0, track = 0, tyreW = 0;
if (hasWheels) {
  const wb = bounds(wheels);
  wheelR = (wb.y1 - wb.y0) / 2;
  let fSum = 0, fN = 0, rSum = 0, rN = 0, maxAbsX = 0, tx0 = Infinity, tx1 = -Infinity;
  for (let i = 0; i < wheels.length; i += 3) {
    const z = wheels[i + 2] - zMid;
    if (z >= 0) { fSum += z; fN++; } else { rSum += z; rN++; }
    maxAbsX = Math.max(maxAbsX, Math.abs(wheels[i]));
    if (wheels[i] > 0) { tx0 = Math.min(tx0, wheels[i]); tx1 = Math.max(tx1, wheels[i]); }
  }
  wheelbase = (fN ? fSum / fN : 0) - (rN ? rSum / rN : 0);
  track = maxAbsX * 2;
  tyreW = Number.isFinite(tx0) ? tx1 - tx0 : 0;
}

// --- cross-sections -------------------------------------------------------
//
// `chassis.js` builds a car as a lower loft with a greenhouse sitting on it, so
// that is the split the measurement has to produce. The greenhouse is anchored
// at the beltline by definition: reporting the extent of whatever happens to be
// above it instead gives the roof panel alone, a thin slice a metre and a half
// in the air, and the loft then builds a cabin with no sides.
const beltY = ground + H * belt;
// With named wheels there is nothing down there to exclude, so the default floor
// is the ground itself.
const floorY = ground + H * (Number.isFinite(floorFrac) ? floorFrac : (hasWheels ? 0 : 0.22));
const lowerRows = [];
const upperRows = [];
for (let i = 0; i < RINGS; i++) {
  const t = i / (RINGS - 1);
  // Nudged off the extreme ends: a plane exactly at the nose cuts nothing.
  const zc = bb.z1 - (0.003 + t * 0.994) * L;
  const fz = (zc - zMid) / L;
  const lo = sliceBand(body, zc, floorY, beltY);
  const hi = sliceBand(body, zc, beltY, Infinity);
  if (lo) lowerRows.push({ fz, w: lo.w, y0: lo.y0, y1: Math.min(lo.y1, beltY) });
  if (hi) upperRows.push({ fz, w: hi.w, y0: beltY, y1: hi.y1 });
}
const finish = (rows) => smooth(rows.map((r) => ({ ...r, h: r.y1 - r.y0, cy: (r.y0 + r.y1) / 2 })));
const lower = finish(lowerRows);
const upper = finish(upperRows);
if (!lower.length) throw new Error('nothing below the beltline — try a different --belt');

const bodyH = Math.max(...lower.map((r) => r.h));
const bodyW = Math.max(...lower.map((r) => r.w));
const rideH = Math.max(Math.min(...lower.map((r) => r.y0)), floorY) - ground;
const yRef = ground + rideH + bodyH * 0.5;
// The crown of the lower silhouette — the highest point any section below the
// beltline reaches — which is what chassis.js anchors a measured cabin to.
// `rideH + bodyH` is not the same thing: those come from different rings.
const bodyTop = Math.max(...lower.map((r) => r.y1));

const profile = lower.map((r) => [
  +r.fz.toFixed(3), +(r.w / bodyW).toFixed(2), +(r.h / bodyH).toFixed(2),
  +((r.cy - yRef) / bodyH).toFixed(2),
]);
// Heights relative to `bodyH`, not in metres: the generator sizes the hull from
// the build, so a greenhouse fixed in metres lifts off a light car and sinks
// into a heavy one. See `cabUnit` in chassis.js.
const cabin = upper.map((r) => [
  +r.fz.toFixed(3), +(r.w / bodyW).toFixed(2),
  +(r.h / bodyH).toFixed(2), +((r.cy - bodyTop) / bodyH).toFixed(2),
]);

// --- the generator's scalars ----------------------------------------------
//
// `chassis.js` sizes a car from the build first and the body type second, so a
// body type's numbers are ratios against a reference build rather than metres.
// Solved here at a stock car — bulk and speed both 0.35 — so that what is
// printed comes out at the metres it was measured at.
const B = 0.35, S = 0.35;
const refL = (4.5 + (5.6 - 4.5) * B) + S * 0.55;
const refW = 1.95 + (2.65 - 1.95) * B;
const refRide = (0.34 + (0.46 - 0.34) * B) - S * 0.06;
const refBodyH = 0.62 + (0.78 - 0.62) * B;
const refWheelR = 0.44 + (0.58 - 0.44) * B;
const refTyre = 0.26 + (0.42 - 0.26) * B;

const fx = (v) => +v.toFixed(2);
const fmt = (rows) => rows.map((r) =>
  `        [${r.map((v) => v.toFixed(3).padStart(6)).join(', ')}],`).join('\n');

console.log(`\n// Measured from ${basename(file)} with tools/silhouette.mjs.`);
console.log(`// ${L.toFixed(2)} m long, ${W.toFixed(2)} m wide, ${H.toFixed(2)} m tall`
  + (hasWheels
    ? `, ${wheelbase.toFixed(2)} m wheelbase,\n// ${(wheelR * 2).toFixed(2)} m wheels on a ${track.toFixed(2)} m track.`
    : '.\n// No named wheel meshes, so wheel size and wheelbase are not measured.'));
console.log(`  ${name}: {
    length: ${fx(L / refL)}, width: ${fx(bodyW / refW)}, ride: ${fx(rideH / refRide)}, height: ${fx(bodyH / refBodyH)},`
  + (hasWheels
    ? `\n    wheel: ${fx(wheelR / refWheelR)}, tyre: ${fx(tyreW / refTyre)}, axle: ${fx(wheelbase / (2 * L))},`
    : ''));
console.log(`    cabin: {
      roof: true, rise: 1.0, width: 1.0, tall: 1.0, shift: 0, units: 'body',
      sections: [
${fmt(cabin)}
      ],
    },
    profile: [
${fmt(profile)}
    ],
  },`);
