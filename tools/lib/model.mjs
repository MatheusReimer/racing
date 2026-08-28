// Model readers shared by tools/silhouette.mjs and tools/lowpoly.mjs.
//
// Lifted verbatim out of silhouette.mjs when a second tool needed to read the
// same files. Between them .glb, .obj and .stl cover what an accurate car model
// is actually distributed as.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import * as THREE from 'three';

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
      const v = new THREE.Vector3();
      // One entry per primitive rather than per node. A node's glass and its
      // paint are different primitives with different materials, and merging
      // them loses the only reliable signal for which part of a car a triangle
      // belongs to — plenty of references name every node `Object_41`.
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.attributes?.POSITION == null) continue;
        const pos = read(prim.attributes.POSITION);
        const idx = prim.indices != null ? read(prim.indices) : null;
        const count = idx ? idx.length : pos.length / 3;
        const tris = [];
        for (let i = 0; i < count; i++) {
          const k = (idx ? idx[i] : i) * 3;
          v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(world);
          tris.push(v.x, v.y, v.z);
        }
        if (!tris.length) continue;
        const m = prim.material != null ? json.materials?.[prim.material] : null;
        out.push({
          name: node.name ?? json.meshes[node.mesh].name ?? '',
          mat: m?.name ?? '',
          // glTF ignores baseColorFactor's alpha unless alphaMode says to use
          // it. Reading it regardless makes every material a window on files
          // that park unrelated data in that channel — the GC8 has several at
          // zero that are opaque bodywork.
          alpha: (m?.alphaMode === 'BLEND' || m?.alphaMode === 'MASK')
            ? (m?.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1) : 1,
          tris,
        });
      }
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
  return groups.filter((g) => g.tris.length).map((g) => ({ ...g, mat: '', alpha: 1 }));
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
  return [{ name: '', mat: '', alpha: 1, tris }];
}

export function readModel(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.glb') return readGLB(path);
  if (ext === '.obj') return readOBJ(path);
  if (ext === '.stl') return readSTL(path);
  throw new Error(`unsupported format ${ext} — this reads .glb, .obj and .stl`);
}
