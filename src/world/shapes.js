import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { clamp01, lerp, TAU } from '../core/math.js';

// Low-poly primitives.
//
// Everything the world is built from, in a deliberately faceted style: flat
// shading, visible edges, colour carried in vertex attributes so a whole prop
// type is one material and one draw call.
//
// The important rule is that normals are **never smoothed across a facet
// boundary**. `computeVertexNormals()` averages the normals of every face
// sharing a vertex, which is what you want for a curved surface and exactly
// wrong here — it turns a faceted rock into a soft blob and loses the style.
// So these builders emit non-indexed geometry: every triangle owns its three
// vertices, and Three computes one normal per face.
//
// Non-indexed costs roughly 3x the vertices of an indexed mesh. That is the
// price of the look, and at these triangle counts it is not close to mattering.

/** Assign a flat colour, with optional per-face variation. */
function paint(geo, color, variation = 0, rng = null) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const tmp = new THREE.Color();
  // Non-indexed: three consecutive vertices are one triangle, so varying per
  // triangle rather than per vertex keeps every facet a flat single colour.
  for (let i = 0; i < n; i += 3) {
    tmp.copy(c);
    if (variation > 0) {
      const k = 1 + (rng ? rng.spread(variation) : (Math.random() - 0.5) * variation * 2);
      tmp.multiplyScalar(clamp01(k));
    }
    for (let v = 0; v < 3; v++) {
      const o = (i + v) * 3;
      col[o] = tmp.r; col[o + 1] = tmp.g; col[o + 2] = tmp.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Strip indices so every face gets its own normal. */
function facet(geo) {
  const out = geo.index ? geo.toNonIndexed() : geo;
  if (out !== geo) geo.dispose();
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function boxOf(w, h, d, color, opts = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (opts.y !== undefined || opts.x || opts.z) {
    g.translate(opts.x || 0, opts.y || 0, opts.z || 0);
  }
  if (opts.rotY) g.rotateY(opts.rotY);
  return paint(facet(g), color, opts.variation ?? 0.06, opts.rng);
}

/** n-gon prism. The workhorse: barrels, poles, trunks, pipes, drums. */
export function prism(sides, rBottom, rTop, height, color, opts = {}) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, sides, 1, false);
  g.translate(0, height / 2, 0);
  if (opts.rotY) g.rotateY(opts.rotY);
  if (opts.x || opts.y || opts.z) g.translate(opts.x || 0, opts.y || 0, opts.z || 0);
  return paint(facet(g), color, opts.variation ?? 0.08, opts.rng);
}

/** n-sided cone. Pines, spires, spikes. */
export function cone(sides, radius, height, color, opts = {}) {
  const g = new THREE.ConeGeometry(radius, height, sides, 1);
  g.translate(0, height / 2, 0);
  if (opts.x || opts.y || opts.z) g.translate(opts.x || 0, opts.y || 0, opts.z || 0);
  return paint(facet(g), color, opts.variation ?? 0.1, opts.rng);
}

/**
 * A rock: a subdivided icosahedron with its vertices pushed around, flattened
 * on the bottom so it sits on the ground rather than floating.
 */
export function rock(radius, color, rng, opts = {}) {
  const detail = opts.detail ?? 1;
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const pos = g.attributes.position;
  const jitter = opts.jitter ?? 0.32;
  const squash = opts.squash ?? 0.62;

  // Displace along each vertex's own direction so the silhouette stays convex
  // and readable, then squash vertically and clamp to the ground plane.
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const k = 1 + rng.spread(jitter);
    pos.setX(i, (x / len) * radius * k);
    pos.setY(i, Math.max(0, (y / len) * radius * k * squash));
    pos.setZ(i, (z / len) * radius * k);
  }
  g.computeBoundingSphere();
  return paint(facet(g), color, 0.14, rng);
}

/** Extrude a 2-D outline vertically. Roofs, signs, ramps, angular scenery. */
export function extrude(points, height, color, opts = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, height, 0);
  if (opts.rotY) g.rotateY(opts.rotY);
  if (opts.x || opts.y || opts.z) g.translate(opts.x || 0, opts.y || 0, opts.z || 0);
  return paint(facet(g), color, opts.variation ?? 0.07, opts.rng);
}

/**
 * Loft between rectangular cross-sections, faceted. Same primitive the vehicle
 * body uses; useful for anything with a silhouette that changes along its run.
 */
export function loftSections(sections, color, opts = {}) {
  const n = sections.length;
  const verts = [];
  const push = (a, b, c) => {
    for (const p of [a, b, c]) verts.push(p[0], p[1], p[2]);
  };
  const corner = (s, k) => {
    const hw = s.w / 2, hh = s.h / 2;
    const c = [
      [-hw, s.y - hh, s.z], [hw, s.y - hh, s.z],
      [hw, s.y + hh, s.z], [-hw, s.y + hh, s.z],
    ];
    return c[k];
  };

  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const a = corner(sections[i], k), b = corner(sections[i + 1], k);
      const c = corner(sections[i], k2), d = corner(sections[i + 1], k2);
      push(a, b, c);
      push(c, b, d);
    }
  }
  // Caps, wound outward: front faces +Z, back faces -Z.
  const f = sections[0], l = sections[n - 1];
  push(corner(f, 0), corner(f, 1), corner(f, 2));
  push(corner(f, 0), corner(f, 2), corner(f, 3));
  push(corner(l, 0), corner(l, 2), corner(l, 1));
  push(corner(l, 0), corner(l, 3), corner(l, 2));

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.computeVertexNormals();
  if (opts.rotY) g.rotateY(opts.rotY);
  if (opts.x || opts.y || opts.z) g.translate(opts.x || 0, opts.y || 0, opts.z || 0);
  return paint(g, color, opts.variation ?? 0.07, opts.rng);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge non-indexed, vertex-coloured geometries. Deliberately does not weld or
 * re-index: welding would let Three average normals across facets on the next
 * `computeVertexNormals`, which is the one thing this whole module avoids.
 */
/**
 * Whether the world is being built on the grid.
 *
 * Set once at boot, the same way the cars are: the caller decides and nothing
 * below here has to carry a style flag. `mergeFaceted` is the single funnel
 * every prop's parts pass through on their way to being one geometry, so it is
 * the one place this has to be asked.
 */
let voxelWorld = null;
export function useVoxelWorld(fn) { voxelWorld = fn; }

export function mergeFaceted(list) {
  const live = list.filter(Boolean);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  let total = 0;
  for (const g of live) total += g.attributes.position.count;

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);

  let o = 0;
  for (const g of live) {
    const p = g.attributes.position;
    const nAttr = g.attributes.normal;
    const c = g.attributes.color;
    pos.set(p.array.subarray(0, p.count * 3), o * 3);
    if (nAttr) nor.set(nAttr.array.subarray(0, nAttr.count * 3), o * 3);
    if (c) col.set(c.array.subarray(0, c.count * 3), o * 3);
    else col.fill(1, o * 3, (o + p.count) * 3);
    o += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  for (const g of live) g.dispose();
  return voxelWorld ? voxelWorld(out) : out;
}

export function triCount(geo) {
  if (!geo) return 0;
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}

/** Shared material for every faceted prop: one draw call per prop type. */
export function facetedMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Belt and braces: the geometry is already non-indexed, and this guarantees
    // per-face normals even if something upstream re-indexes it.
    flatShading: true,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.05,
    ...opts,
  });
}

/** A tint helper for building biome palettes without hand-writing every hex. */
export function shade(hex, k) {
  return new THREE.Color(hex).multiplyScalar(k).getHex();
}

export function mix(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}
