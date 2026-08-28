import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math.js';

// Procedural vehicle geometry.
//
// The design brief asks that a specialised build *look* specialised — that an
// electric car read as electric before the player checks the stat panel. So the
// mesh is not a fixed model with a colour swap: it is assembled from a visual
// profile the build system computes from the equipped parts.
//
// Mass widens and lowers the hull, Impact grows a ram bar, Armor bolts on
// plating and a roll cage, Top Speed adds a wing, a roof scoop and canards, and
// elemental tags drive the emissive trim. Two cars at the same point in a run
// look different because they *are* different.
//
// The body is built by lofting between cross-sections rather than by stacking
// boxes. A car's silhouette is a sequence of rectangles whose width, height and
// ride height change along its length — nose, cowl, cabin, haunch, boat-tail —
// so lofting is the primitive that matches the shape. Stacked boxes cannot
// produce a tapered nose or a rounded tail at all, which is why the first
// version read as a brick.
//
// Everything opaque merges into one geometry, everything emissive into a
// second, glass into a third. Three draw calls per car, however much detail is
// added below.

/** Convert a build into the handful of numbers this file draws from. */
export function visualProfile(stats, tags = new Set(), vehicleDef = {}) {
  const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
  return {
    bulk: norm(stats.weight, 60, 260),
    speed: norm(stats.topSpeed, 70, 260),
    armor: norm(stats.armor, 80, 300),
    ram: norm(stats.impact, 80, 280),
    tags,
    baseColor: vehicleDef.color ?? '#c8452e',
    accentColor: vehicleDef.accent ?? '#ffb238',
    bodyType: vehicleDef.bodyType ?? 'coupe',
  };
}

/** Elemental identity picks the emissive palette. */
function glowFor(tags) {
  if (tags.has('Electric')) return { color: 0x4fd1ff, power: 1.0 };
  if (tags.has('Fire') || tags.has('Explosive')) return { color: 0xff6a2b, power: 0.9 };
  if (tags.has('Ice')) return { color: 0x9fe8ff, power: 0.7 };
  if (tags.has('Toxic')) return { color: 0x9dff5c, power: 0.8 };
  return { color: 0xffc266, power: 0.35 };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function paint(geo, color) {
  // Non-indexed throughout: shared vertices are what let normals average
  // across facets, and this whole file exists to avoid that.
  if (geo.index) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    geo = flat;
    geo.computeVertexNormals();
  }
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Axis-aligned box, positioned by centre. */
function box(w, h, d, x, y, z, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return paint(g, color);
}

/** Box rotated about X — angled panels: screens, diffusers, wings, canards. */
function panel(w, h, d, x, y, z, pitch, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(pitch);
  g.translate(x, y, z);
  return paint(g, color);
}

/**
 * A capped tube from a to b. Suspension members do not run along an axis, and
 * building them from axis-aligned cylinders means the arch is full of parts
 * that visibly do not connect to anything.
 */
function tube(x0, y0, z0, x1, y1, z1, r, color, segments = 8) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 0.001;
  const g = new THREE.CylinderGeometry(r, r, len, segments, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return paint(g, color);
}

function cylinder(r, h, x, y, z, color, segments = 10, axis = 'y') {
  const g = new THREE.CylinderGeometry(r, r, h, segments, 1);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return paint(g, color);
}

/**
 * Sample a rounded rectangle (a squircle) as `sides` points.
 *
 * A rectangular cross-section can only ever produce a box. Sampling a rounded
 * profile instead gives the body chamfered edges and a real shoulder line while
 * keeping every face flat — which is the whole point of the style: curvature
 * you can see the facets of.
 */
function sectionPoints(w, h, sides, roundness = 3.2) {
  const pts = [];
  const e = 2 / roundness;
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    pts.push([
      (w / 2) * Math.sign(ct) * Math.pow(Math.abs(ct), e),
      (h / 2) * Math.sign(st) * Math.pow(Math.abs(st), e),
    ]);
  }
  return pts;
}

/**
 * Loft a closed tube through a list of cross-sections.
 *
 * @param sections [{ z, w, h, y, sides?, roundness? }] front to back. `y` is
 *        the centre height of that ring, so the body gains a real profile
 *        rather than a constant-height extrusion.
 *
 * Emitted non-indexed so each face keeps its own normal: welding would let
 * Three average normals across the facet boundaries and turn the whole thing
 * into a soft blob.
 */
function loft(sections, color, opts = {}) {
  const sides = opts.sides ?? 12;
  const n = sections.length;
  const rings = sections.map((sec) => {
    const pts = sectionPoints(sec.w, sec.h, sec.sides ?? sides, sec.roundness ?? opts.roundness ?? 3.2);
    return pts.map(([px, py]) => [px, sec.y + py, sec.z]);
  });

  const verts = [];
  const push = (a, b, c) => { for (const p of [a, b, c]) verts.push(p[0], p[1], p[2]); };

  for (let i = 0; i < n - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    const m = Math.min(A.length, B.length);
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      push(A[k], B[k], A[k2]);
      push(A[k2], B[k], B[k2]);
    }
  }

  // Caps as fans from the ring centroid. Wound so the front faces +Z and the
  // back faces -Z; getting this backwards makes back-face culling throw the
  // nose and tail away and you can see into the car.
  const capFan = (ring, front) => {
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    cx /= ring.length; cy /= ring.length;
    const centre = [cx, cy, ring[0][2]];
    for (let k = 0; k < ring.length; k++) {
      const k2 = (k + 1) % ring.length;
      if (front) push(centre, ring[k], ring[k2]);
      else push(centre, ring[k2], ring[k]);
    }
  };
  capFan(rings[0], true);
  capFan(rings[n - 1], false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return paint(geo, color);
}

function mergeGeometries(list) {
  const live = list.filter(Boolean);
  if (live.length === 0) return null;

  let vTotal = 0, iTotal = 0;
  for (const g of live) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = new Uint32Array(iTotal);

  let vo = 0, io = 0;
  for (const g of live) {
    const p = g.attributes.position;
    const nAttr = g.attributes.normal;
    const c = g.attributes.color;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (nAttr) nor.set(nAttr.array.subarray(0, nAttr.count * 3), vo * 3);
    if (c) col.set(c.array.subarray(0, c.count * 3), vo * 3);
    else col.fill(1, vo * 3, (vo + p.count) * 3);
    for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
    io += p.count;
    vo += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  for (const g of live) g.dispose();
  return out;
}

const DARK = 0x1a1d22;

// ---------------------------------------------------------------------------
// Body types
// ---------------------------------------------------------------------------
//
// Six silhouettes. Each `profile` entry is a ring along the body as
// [z fraction, width fraction, height fraction, y offset fraction] from nose to
// tail, so the shape of the car lives in a table that can be read rather than
// in constants scattered through the builder.
//
// What actually distinguishes them at distance is the roofline and the tail:
// a hatch stops abruptly, a coupe tapers, a saloon has a separate boot. Width
// and ride height do the rest.

const BODY_TYPES = {
  // Small front-drive hatchback. Short, upright, tall glass, cut-off tail.
  hatch: {
    length: 0.86, width: 0.94, ride: 1.10, height: 1.06,
    cabin: { roof: true, rise: 1.18, width: 1.02, tall: 1.16, shift: -0.02 },
    profile: [
      [0.500, 0.62, 0.46, -0.14],
      [0.455, 0.78, 0.60, -0.09],
      [0.400, 0.90, 0.74, -0.04],
      [0.330, 0.96, 0.86, -0.01],
      [0.250, 0.99, 0.94, 0.01],
      [0.150, 1.00, 1.00, 0.02],
      [0.040, 1.00, 1.02, 0.03],
      [-0.080, 1.00, 1.02, 0.03],
      [-0.190, 0.99, 1.00, 0.03],
      [-0.290, 0.97, 0.96, 0.02],
      [-0.370, 0.95, 0.90, 0.01],
      [-0.430, 0.92, 0.82, 0.00],
      [-0.470, 0.86, 0.72, -0.02],
      [-0.500, 0.78, 0.62, -0.05],
    ],
  },

  // Rear-drive coupe. Long bonnet, fastback tail falling away to a short deck.
  coupe: {
    length: 1.00, width: 1.00, ride: 1.00, height: 1.00,
    cabin: { roof: true, rise: 1.0, width: 1.0, tall: 1.0, shift: 0 },
    profile: [
      [0.500, 0.56, 0.38, -0.18],
      [0.455, 0.70, 0.50, -0.13],
      [0.410, 0.82, 0.62, -0.08],
      [0.350, 0.90, 0.72, -0.04],
      [0.280, 0.95, 0.82, -0.01],
      [0.200, 0.97, 0.88, 0.00],
      [0.110, 0.99, 0.96, 0.01],
      [0.020, 1.00, 1.00, 0.02],
      [-0.070, 1.00, 1.00, 0.02],
      [-0.150, 1.00, 1.00, 0.02],
      [-0.230, 0.99, 0.98, 0.02],
      [-0.310, 0.97, 0.90, 0.01],
      [-0.380, 0.95, 0.82, 0.00],
      [-0.440, 0.88, 0.70, -0.03],
      [-0.480, 0.78, 0.60, -0.06],
      [-0.500, 0.68, 0.52, -0.08],
    ],
  },

  // Rotary sports car. The lowest and widest thing on the grid, with almost no
  // overhang at either end — it is nearly all wheelbase.
  rotary: {
    length: 0.94, width: 1.07, ride: 0.80, height: 0.86,
    cabin: { roof: true, rise: 0.84, width: 0.98, tall: 0.82, shift: -0.03 },
    profile: [
      [0.500, 0.66, 0.44, -0.16],
      [0.450, 0.82, 0.58, -0.10],
      [0.390, 0.92, 0.72, -0.05],
      [0.310, 0.98, 0.86, -0.01],
      [0.220, 1.00, 0.96, 0.01],
      [0.120, 1.00, 1.00, 0.02],
      [0.010, 1.00, 1.02, 0.02],
      [-0.100, 1.00, 1.02, 0.02],
      [-0.210, 1.00, 1.00, 0.02],
      [-0.300, 0.99, 0.96, 0.01],
      [-0.380, 0.96, 0.88, 0.00],
      [-0.440, 0.90, 0.76, -0.03],
      [-0.480, 0.82, 0.62, -0.07],
      [-0.500, 0.72, 0.52, -0.10],
    ],
  },

  // All-wheel-drive GT. Long, wide, square-shouldered, high flat tail.
  gt: {
    length: 1.08, width: 1.06, ride: 1.04, height: 1.02,
    cabin: { roof: true, rise: 1.04, width: 1.04, tall: 1.02, shift: -0.02 },
    profile: [
      [0.500, 0.70, 0.52, -0.12],
      [0.450, 0.84, 0.66, -0.07],
      [0.390, 0.93, 0.78, -0.03],
      [0.310, 0.98, 0.88, 0.00],
      [0.220, 1.00, 0.96, 0.01],
      [0.120, 1.00, 1.00, 0.02],
      [0.010, 1.00, 1.02, 0.02],
      [-0.100, 1.00, 1.02, 0.02],
      [-0.200, 1.00, 1.02, 0.02],
      [-0.290, 1.00, 1.00, 0.02],
      [-0.370, 0.99, 0.96, 0.02],
      [-0.440, 0.97, 0.90, 0.01],
      [-0.480, 0.93, 0.82, 0.00],
      [-0.500, 0.88, 0.74, -0.02],
    ],
  },

  // Open two-seater. Tiny, very low, no roof — the cabin builder swaps to a
  // windscreen frame and a roll hoop.
  roadster: {
    length: 0.80, width: 0.90, ride: 0.86, height: 0.88,
    cabin: { roof: false, rise: 0.86, width: 0.94, tall: 0.80, shift: -0.04 },
    profile: [
      [0.500, 0.60, 0.42, -0.16],
      [0.450, 0.76, 0.58, -0.10],
      [0.380, 0.90, 0.74, -0.04],
      [0.300, 0.97, 0.88, 0.00],
      [0.200, 1.00, 0.98, 0.02],
      [0.090, 1.00, 1.02, 0.03],
      [-0.030, 1.00, 1.02, 0.03],
      [-0.150, 1.00, 1.00, 0.02],
      [-0.260, 0.98, 0.94, 0.01],
      [-0.350, 0.95, 0.86, 0.00],
      [-0.420, 0.90, 0.74, -0.03],
      [-0.470, 0.82, 0.62, -0.07],
      [-0.500, 0.72, 0.52, -0.11],
    ],
  },

  // Rally saloon: three boxes. The separate boot deck is the whole read.
  rally: {
    length: 1.02, width: 0.98, ride: 1.16, height: 1.04,
    cabin: { roof: true, rise: 1.12, width: 1.02, tall: 1.10, shift: 0.01 },
    profile: [
      [0.500, 0.66, 0.50, -0.13],
      [0.450, 0.82, 0.64, -0.08],
      [0.390, 0.92, 0.78, -0.03],
      [0.310, 0.97, 0.88, 0.00],
      [0.220, 1.00, 0.96, 0.01],
      [0.110, 1.00, 1.00, 0.02],
      [0.000, 1.00, 1.02, 0.02],
      [-0.110, 1.00, 1.02, 0.02],
      [-0.220, 1.00, 1.00, 0.02],
      [-0.310, 0.99, 0.98, 0.02],
      [-0.380, 0.98, 0.94, 0.01],
      [-0.440, 0.96, 0.88, 0.00],
      [-0.478, 0.92, 0.80, -0.01],
      [-0.500, 0.86, 0.72, -0.03],
    ],
  },
};
const METAL = 0x6b7178;
const RUBBER = 0x121418;

// ---------------------------------------------------------------------------

export class VehicleMesh {
  constructor(profile, quality) {
    this.profile = profile;
    this.group = new THREE.Group();
    this.glow = glowFor(profile.tags);

    const { bulk, speed, armor, ram } = profile;

    // Which car this is, before any stat touches it.
    //
    // Stats used to be the only thing shaping the mesh, so every vehicle was
    // one silhouette stretched — a heavy car was a long version of a light one.
    // On a street grid the roster has to be readable at thirty metres, so the
    // body type sets the proportions and the profile, and the stats then push
    // that shape around rather than defining it.
    const BT = BODY_TYPES[profile.bodyType] ?? BODY_TYPES.coupe;

    const L = (lerp(4.5, 5.6, bulk) + speed * 0.55) * BT.length;
    const W = lerp(1.95, 2.65, bulk) * BT.width;
    const rideH = (lerp(0.34, 0.46, bulk) - speed * 0.06) * BT.ride;
    const bodyH = lerp(0.62, 0.78, bulk) * BT.height;
    this.length = L;
    this.width = W;
    this.height = rideH + bodyH;
    // The collision footprint comes from the mesh, so visual and physical size
    // cannot drift apart as parts change the car's proportions.
    this.radius = Math.max(W, L * 0.62) * 0.5;

    const body = profile.baseColor;
    const accent = profile.accentColor;
    const roofCol = new THREE.Color(body).multiplyScalar(0.70).getHex();

    const opaque = [];
    const emissive = [];
    const glass = [];

    // --- lower body ---------------------------------------------------------
    const y = rideH + bodyH * 0.5;
    // Sixteen rings rather than seven, and sixteen sides rather than four. The
    // silhouette is where a car is recognised, so this is the one place extra
    // geometry is unambiguously worth spending.
    const BODY_PROFILE = BT.profile ?? [
      [0.500, 0.56, 0.38, -0.18],
      [0.455, 0.70, 0.50, -0.13],
      [0.410, 0.82, 0.62, -0.08],
      [0.350, 0.90, 0.72, -0.04],
      [0.280, 0.95, 0.82, -0.01],
      [0.200, 0.97, 0.88, 0.00],
      [0.110, 0.99, 0.96, 0.01],
      [0.020, 1.00, 1.00, 0.02],
      [-0.070, 1.00, 1.00, 0.02],
      [-0.150, 1.00, 1.00, 0.02],
      [-0.230, 0.99, 0.98, 0.02],
      [-0.310, 0.97, 0.90, 0.01],
      [-0.380, 0.95, 0.82, 0.00],
      [-0.440, 0.88, 0.70, -0.03],
      [-0.480, 0.78, 0.60, -0.06],
      [-0.500, 0.68, 0.52, -0.08],
    ];
    // Resample the profile to a finer ring spacing. Catmull-like smoothing on
    // an already-hand-shaped curve would drift; plain interpolation adds rings
    // without moving the silhouette the profile describes.
    const BODY_RINGS = 72;
    const sampleProfile = (u) => {
      const x = u * (BODY_PROFILE.length - 1);
      const i = Math.min(BODY_PROFILE.length - 2, Math.floor(x));
      const t = x - i;
      const a = BODY_PROFILE[i], b = BODY_PROFILE[i + 1];
      return [lerp(a[0], b[0], t), lerp(a[1], b[1], t),
        lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
    };
    const bodySections = [];
    for (let i = 0; i < BODY_RINGS; i++) {
      const [fz, fw, fh, fy] = sampleProfile(i / (BODY_RINGS - 1));
      bodySections.push({ z: L * fz, w: W * fw, h: bodyH * fh, y: y + bodyH * fy });
    }
    opaque.push(loft(bodySections, body, { sides: 44, roundness: 3.6 }));

    /**
     * Half-width of the bodywork at a length fraction and a world height.
     *
     * Anything meant to sit *on* the car asks this rather than assuming the
     * body is a full-width box: the profile tapers toward both ends and the
     * cross-section is a squircle, so a flank at `W / 2` is in mid air
     * everywhere except the widest ring's waistline.
     */
    const bodyHalfWidth = (fz, worldY) => {
      let a = BODY_PROFILE[0];
      let b = BODY_PROFILE[BODY_PROFILE.length - 1];
      for (let i = 0; i < BODY_PROFILE.length - 1; i++) {
        if (fz <= BODY_PROFILE[i][0] && fz >= BODY_PROFILE[i + 1][0]) {
          a = BODY_PROFILE[i]; b = BODY_PROFILE[i + 1];
          break;
        }
      }
      const span = a[0] - b[0];
      const t = span === 0 ? 0 : clamp01((a[0] - fz) / span);
      const w = lerp(a[1], b[1], t) * W;
      const h = lerp(a[2], b[2], t) * bodyH;
      const cy = y + lerp(a[3], b[3], t) * bodyH;
      // Invert the squircle |x|^n + |v|^n = 1 used by `sectionPoints`.
      const v = Math.min(0.999, Math.abs((worldY - cy) / (h * 0.5 || 1)));
      const n = 3.6;
      return (w * 0.5) * Math.pow(Math.max(0, 1 - Math.pow(v, n)), 1 / n);
    };

    // --- cabin --------------------------------------------------------------
    const cabY = rideH + bodyH + 0.30 * BT.cabin.rise;
    if (BT.cabin.roof) opaque.push(loft([
      { z: L * 0.115, w: W * 0.52, h: 0.08, y: cabY - 0.26 },
      { z: L * 0.060, w: W * 0.58, h: 0.24, y: cabY - 0.16 },
      { z: L * 0.010, w: W * 0.63, h: 0.42, y: cabY - 0.04 },
      { z: -L * 0.050, w: W * 0.66, h: 0.52, y: cabY },
      { z: -L * 0.130, w: W * 0.66, h: 0.53, y: cabY + 0.02 },
      { z: -L * 0.210, w: W * 0.65, h: 0.52, y: cabY + 0.02 },
      { z: -L * 0.275, w: W * 0.60, h: 0.38, y: cabY - 0.06 },
      { z: -L * 0.330, w: W * 0.52, h: 0.18, y: cabY - 0.19 },
    ].map((r) => ({
      ...r,
      z: r.z + L * BT.cabin.shift,
      w: r.w * BT.cabin.width,
      h: r.h * BT.cabin.tall,
      y: cabY + (r.y - cabY) * BT.cabin.tall,
    })), roofCol, { sides: 24, roundness: 4.0 }));
    else {
      // Open-topped: a windscreen frame, a roll hoop behind the driver, and the
      // rear deck closed off so you are not looking into a hollow shell.
      opaque.push(box(W * 0.60, 0.06, L * 0.20, 0, cabY - 0.24, -L * 0.16, roofCol));
      for (const side of [-1, 1]) {
        const a = box(0.07, 0.46, 0.07, side * W * 0.28, cabY - 0.05, L * 0.075, roofCol);
        a.rotateX(0);
        opaque.push(a);
      }
      opaque.push(box(W * 0.60, 0.07, 0.08, 0, cabY + 0.16, L * 0.075, roofCol));
      for (const side of [-1, 1]) {
        opaque.push(box(0.10, 0.34, 0.14, side * W * 0.24, cabY - 0.10, -L * 0.20, 0x2b3037));
      }
    }

    // --- interior, visible through the glass -----------------------------
    // Cheap, and it is the whole difference between a cockpit and a tinted void.
    const iy = rideH + bodyH * 0.55;
    for (const side of [-1, 1]) {
      opaque.push(box(0.44, 0.10, 0.46, side * W * 0.17, iy + 0.16, -L * 0.10, 0x1e2126));
      opaque.push(panel(0.44, 0.10, 0.52, side * W * 0.17, iy + 0.42, -L * 0.17, 0.22, 0x24282e));
      opaque.push(box(0.30, 0.16, 0.10, side * W * 0.17, iy + 0.66, -L * 0.20, 0x2a2f35));
    }
    opaque.push(panel(W * 0.52, 0.12, 0.30, 0, iy + 0.34, L * 0.030, -0.35, 0x191c20));
    opaque.push(cylinder(0.16, 0.05, -W * 0.17, iy + 0.44, -L * 0.005, 0x14171a, 12, 'z'));
    opaque.push(box(0.05, 0.14, 0.05, -W * 0.17, iy + 0.36, -L * 0.01, 0x14171a));
    // A driver as three blocks. At racing distance that is all it needs to be.
    opaque.push(box(0.30, 0.36, 0.24, -W * 0.17, iy + 0.44, -L * 0.10, 0x2f3a4a));
    opaque.push(box(0.22, 0.22, 0.22, -W * 0.17, iy + 0.74, -L * 0.11, 0xc9a07a));
    opaque.push(box(0.26, 0.12, 0.26, -W * 0.17, iy + 0.85, -L * 0.11, 0x1c1f24));
    // Harness straps, gearshift, pedals, and a gauge cluster. All small, all
    // behind glass, and together they are the difference between a cockpit and
    // a dark box with a head in it.
    for (const sx of [-1, 1]) {
      opaque.push(tube(-W * 0.17 + sx * 0.11, iy + 0.72, -L * 0.135,
        -W * 0.17 + sx * 0.05, iy + 0.30, -L * 0.085, 0.022, 0xc23b2b, 6));
    }
    opaque.push(tube(-W * 0.17, iy + 0.30, -L * 0.08, -W * 0.17, iy + 0.18, -L * 0.05, 0.02, 0xc23b2b, 6));
    opaque.push(cylinder(0.028, 0.20, -W * 0.02, iy + 0.30, -L * 0.06, 0x15181c, 8));
    opaque.push(cylinder(0.05, 0.05, -W * 0.02, iy + 0.41, -L * 0.06, 0xd8d2c6, 8));
    for (let i = 0; i < 3; i++) {
      opaque.push(cylinder(0.045, 0.03, -W * 0.17 + (i - 1) * 0.09, iy + 0.50,
        L * 0.005, i === 1 ? 0xd8d2c6 : 0x2a2e33, 10, 'z'));
    }
    for (let i = 0; i < 3; i++) {
      opaque.push(box(0.05, 0.11, 0.03, -W * 0.24 + i * 0.07, iy + 0.14, L * 0.02, 0x4a5058));
    }

    glass.push(panel(W * 0.52, 0.05, 0.52, 0, cabY - 0.05, L * 0.055, -0.60, 0x0d1520));
    glass.push(panel(W * 0.50, 0.05, 0.38, 0, cabY - 0.04, -L * 0.295, 0.68, 0x0d1520));
    // Quarter lights, and the frames between the panes. Splitting the glazing
    // is what stops the cabin reading as one dark lozenge.
    for (const side of [-1, 1]) {
      glass.push(box(0.035, 0.26, L * 0.075, side * W * 0.332, cabY + 0.06, L * 0.005, 0x0d1520));
      glass.push(box(0.035, 0.22, L * 0.06, side * W * 0.322, cabY + 0.02, -L * 0.255, 0x0d1520));
    }
    for (const side of [-1, 1]) {
      glass.push(box(0.04, 0.32, L * 0.19, side * W * 0.325, cabY + 0.03, -L * 0.11, 0x0d1520));
      // Window frame and door mirror stalk root, in body colour.
      opaque.push(box(0.05, 0.045, L * 0.20, side * W * 0.330, cabY - 0.14, -L * 0.11, DARK));
      opaque.push(box(0.05, 0.045, L * 0.20, side * W * 0.330, cabY + 0.20, -L * 0.11, DARK));
      opaque.push(box(0.05, 0.30, 0.05, side * W * 0.330, cabY + 0.03, -L * 0.205, DARK));
    }
    // Wipers and washer jets.
    for (const side of [-1, 1]) {
      opaque.push(tube(side * W * 0.05, cabY - 0.27, L * 0.145,
        side * W * 0.28, cabY - 0.20, L * 0.115, 0.016, 0x15181c, 6));
      opaque.push(box(0.035, 0.03, 0.035, side * W * 0.14, cabY - 0.30, L * 0.16, 0x15181c));
    }

    // --- wheel arches -------------------------------------------------------
    const wheelR = lerp(0.44, 0.58, bulk);
    const wheelT = lerp(0.26, 0.42, bulk);
    const wheelbase = L * 0.33;
    // Tuck the wheels under the body. Pushing the track wider than the
    // bodywork makes them read as bolted on rather than fitted.
    const trackW = W * 0.5 - wheelT * 0.30;

    // A single tight lip per wheel. Separate multi-segment arches read as black
    // clumps proud of the bodywork, and the loft already flares at the
    // wheelbase, so the lip only has to suggest the edge.
    for (const iz of [1, -1]) {
      for (const ix of [-1, 1]) {
        opaque.push(box(wheelT + 0.10, 0.09, wheelR * 1.55,
          ix * (trackW + 0.02), rideH + bodyH * 0.30 + wheelR * 0.62,
          iz * wheelbase, roofCol));
      }
    }

    // --- nose ---------------------------------------------------------------
    opaque.push(box(W * 0.52, bodyH * 0.32, 0.10, 0, rideH + bodyH * 0.30, L * 0.503, DARK));
    for (let i = 0; i < 4; i++) {
      opaque.push(box(W * 0.47, 0.032, 0.13,
        0, rideH + bodyH * 0.18 + i * 0.072, L * 0.507, METAL));
    }
    opaque.push(box(W * 0.86, 0.06, 0.26, 0, rideH * 0.55, L * 0.455, DARK));
    for (const side of [-1, 1]) {
      emissive.push(box(0.26, 0.11, 0.06,
        side * W * 0.30, rideH + bodyH * 0.64, L * 0.49, 0xfff2d0));
    }

    // --- tail ---------------------------------------------------------------
    for (const side of [-1, 1]) {
      emissive.push(box(W * 0.22, 0.09, 0.05,
        side * W * 0.24, rideH + bodyH * 0.60, -L * 0.503, 0xff3b30));
    }
    opaque.push(panel(W * 0.70, 0.06, 0.30, 0, rideH * 0.70, -L * 0.465, 0.35, DARK));
    for (const side of [-1, 1]) {
      opaque.push(cylinder(0.085, 0.26, side * W * 0.24, rideH * 0.92, -L * 0.50, METAL, 8, 'z'));
    }

    // --- sides --------------------------------------------------------------
    for (const side of [-1, 1]) {
      opaque.push(box(0.07, 0.14, L * 0.42, side * (W * 0.5 + 0.01), rideH * 0.78, -L * 0.04, DARK));
      for (let i = 0; i < 3; i++) {
        opaque.push(box(0.05, 0.032, 0.20,
          side * (W * 0.5 + 0.015), rideH + bodyH * 0.58 + i * 0.052, L * 0.06, DARK));
      }
      opaque.push(box(0.05, 0.04, 0.12, side * W * 0.40, cabY - 0.16, L * 0.05, DARK));
      opaque.push(box(0.14, 0.10, 0.05, side * W * 0.47, cabY - 0.14, L * 0.042, roofCol));
    }

    opaque.push(box(W * 0.16, 0.02, L * 0.34, 0, rideH + bodyH + 0.005, L * 0.24, accent));

    // --- Impact -------------------------------------------------------------
    if (ram > 0.12) {
      const barW = W * lerp(0.92, 1.16, ram);
      const barH = lerp(0.18, 0.40, ram);
      opaque.push(box(barW, barH, lerp(0.20, 0.42, ram),
        0, rideH + barH * 0.55, L * 0.50 + 0.16, METAL));
      for (const side of [-1, 1]) {
        opaque.push(box(0.10, barH * 0.8, 0.34,
          side * barW * 0.44, rideH + barH * 0.55, L * 0.44, METAL));
      }
      if (ram > 0.5) {
        const teeth = 5;
        for (let i = 0; i < teeth; i++) {
          const tx = lerp(-barW * 0.40, barW * 0.40, i / (teeth - 1));
          opaque.push(box(0.11, barH * 0.85, 0.34,
            tx, rideH + barH * 0.62, L * 0.50 + 0.34, 0x9aa1a9));
        }
      }
    }

    // --- Armor --------------------------------------------------------------
    if (armor > 0.15) {
      const th = lerp(0.06, 0.19, armor);
      for (const side of [-1, 1]) {
        opaque.push(box(th, lerp(0.26, 0.46, armor), L * 0.66,
          side * (W * 0.5 + th * 0.5), rideH + bodyH * 0.60, -L * 0.03, 0x596068));
        for (let i = 0; i < 4; i++) {
          opaque.push(box(th * 0.6, 0.05, 0.05,
            side * (W * 0.5 + th), rideH + bodyH * 0.60,
            lerp(-L * 0.30, L * 0.24, i / 3), METAL));
        }
      }
      if (armor > 0.5) {
        for (const side of [-1, 1]) {
          opaque.push(box(0.06, 0.50, 0.06, side * W * 0.30, cabY + 0.02, -L * 0.02, METAL));
          opaque.push(box(0.06, 0.50, 0.06, side * W * 0.30, cabY + 0.02, -L * 0.28, METAL));
        }
        opaque.push(box(W * 0.62, 0.06, 0.06, 0, cabY + 0.27, -L * 0.02, METAL));
        opaque.push(box(W * 0.62, 0.06, 0.06, 0, cabY + 0.27, -L * 0.28, METAL));
        opaque.push(box(0.06, 0.06, L * 0.28, 0, cabY + 0.27, -L * 0.15, METAL));
      }
    }

    // --- Top Speed ----------------------------------------------------------
    if (speed > 0.22) {
      const wingW = W * lerp(0.86, 1.02, speed);
      const wingY = rideH + bodyH + lerp(0.26, 0.52, speed);
      const wingZ = -L * 0.50 - 0.04;
      opaque.push(panel(wingW, 0.05, lerp(0.24, 0.40, speed), 0, wingY, wingZ, 0.16, accent));
      for (const side of [-1, 1]) {
        opaque.push(box(0.07, Math.max(0.1, wingY - (rideH + bodyH) + 0.06), 0.22,
          side * wingW * 0.43, (wingY + rideH + bodyH) * 0.5, wingZ, DARK));
        opaque.push(panel(0.22, 0.03, 0.14,
          side * W * 0.44, rideH + bodyH * 0.34, L * 0.44, 0.22, accent));
      }
      opaque.push(loft([
        { z: -L * 0.04, w: W * 0.22, h: 0.12, y: cabY + 0.30 },
        { z: -L * 0.20, w: W * 0.30, h: 0.20, y: cabY + 0.32 },
      ], DARK));
    }

    // --- surface detail -----------------------------------------------------
    // The body loft gives a silhouette; this is what makes it read as a car up
    // close. Every piece is positioned by querying `bodyHalfWidth`, so nothing
    // here can float the way the hand-placed trim used to.
    {
      // No arch lips here on purpose: the loft already flares at the wheelbase
      // and there is a single tight lip per wheel further down. A second
      // multi-segment arch on top of that reads as a black clump standing proud
      // of the bodywork, which is the artifact that lip replaced.

      // Door shut lines and a shoulder crease, laid on the flank.
      for (const side of [-1, 1]) {
        for (const [fz, len] of [[0.16, 0.03], [-0.06, 0.03], [-0.24, 0.03]]) {
          const yy = rideH + bodyH * 0.55;
          opaque.push(box(0.02, bodyH * 0.44, len * L,
            side * (bodyHalfWidth(fz, yy) - 0.01), yy, L * fz, DARK));
        }
        // Cooling gills behind the front arch.
        for (let i = 0; i < 4; i++) {
          const fz = 0.20 - i * 0.035;
          const yy = rideH + bodyH * 0.46;
          opaque.push(panel(0.05, 0.11, 0.03,
            side * (bodyHalfWidth(fz, yy) - 0.02), yy, L * fz, 0.35, DARK));
        }
        // Mirror: stalk plus housing.
        const my = rideH + bodyH * 0.92;
        const mx = bodyHalfWidth(0.02, my) + 0.10;
        opaque.push(cylinder(0.025, 0.20, side * (mx - 0.08), my, L * 0.02, DARK, 8, 'x'));
        opaque.push(box(0.09, 0.11, 0.16, side * mx, my + 0.04, L * 0.02, accent));
        // Exhaust tip, tucked under the rear valance where the body actually is.
        opaque.push(cylinder(0.075, 0.26,
          side * bodyHalfWidth(-0.46, rideH + bodyH * 0.20) * 0.62,
          rideH + bodyH * 0.16, -L * 0.485, 0x44494f, 14, 'z'));
      }

      // Bonnet louvres.
      for (let i = 0; i < 5; i++) {
        const fz = 0.30 - i * 0.045;
        opaque.push(panel(W * 0.34, 0.055, 0.035, 0,
          rideH + bodyH * 0.90, L * fz, 0.42, DARK));
      }

      // Roll cage, seen through the glass.
      const cageY = rideH + bodyH + 0.30;
      // Kept below the roofline: the hoop was at cageY + 0.28 with the cabin
      // topping out at cageY + 0.285, so it broke the surface and read as bars
      // stuck through the roof rather than a cage inside the car.
      for (const side of [-1, 1]) {
        opaque.push(cylinder(0.036, 0.50, side * W * 0.30, cageY - 0.06, -L * 0.15, 0x8a9098, 10, 'y'));
        opaque.push(cylinder(0.036, W * 0.58, 0, cageY + 0.17, -L * 0.15, 0x8a9098, 10, 'x'));
        opaque.push(cylinder(0.032, 0.42, side * W * 0.28, cageY - 0.02, L * 0.02, 0x8a9098, 10, 'y'));
      }

      // Front splitter and rear diffuser fins, sized so they sit *under* the
      // overhangs rather than hanging out past them. At 0.42 deep centred on
      // -0.47L the fins reached almost a metre behind the tail, which from
      // behind the car is a row of slabs trailing in mid air.
      opaque.push(panel(W * 0.92, 0.05, 0.22, 0, rideH + 0.05, L * 0.455, 0.10, DARK));
      for (let i = -2; i <= 2; i++) {
        opaque.push(box(0.05, 0.15, 0.26, i * W * 0.17, rideH + 0.09, -L * 0.42, DARK));
      }

      // Headlight housings, sunk into the nose rather than stuck on it.
      for (const side of [-1, 1]) {
        const hy = rideH + bodyH * 0.72;
        opaque.push(cylinder(0.13, 0.10,
          side * bodyHalfWidth(0.44, hy) * 0.66, hy, L * 0.455, 0x1b1e22, 14, 'z'));
      }

      // Suspension, visible up inside the arches.
      //
      // An arch with nothing behind it is a hole in the car, and it is the
      // first thing the eye finds when the wheels are this detailed. Five
      // members per corner is enough to fill it convincingly.
      const axles = [[L * 0.32, 1], [-L * 0.30, -1]];
      for (const [zc] of axles) {
        for (const side of [-1, 1]) {
          // Terminate at the wheel centre, not outside it. `W * 0.5 + 0.06` put
          // every arm, upright and coilover *beyond* the wheels — which are
          // tucked in at `trackW` — so the suspension stood proud of the
          // bodywork as a row of grey blocks along the flank. Exactly the
          // floating-slab artifact this pass was meant to remove.
          const hubX = side * trackW;
          const inX = side * W * 0.16;
          const armY = rideH + 0.16;
          const topY = rideH + bodyH * 0.44;
          // Lower and upper wishbones, as pairs of angled tubes.
          for (const dz of [-0.26, 0.26]) {
            opaque.push(tube(inX, armY, zc + dz * 0.4, hubX, armY + 0.04, zc + dz, 0.035, 0x24282d));
            opaque.push(tube(inX, topY, zc + dz * 0.4, hubX, topY - 0.06, zc + dz, 0.028, 0x24282d));
          }
          // Coilover.
          opaque.push(tube(inX + side * 0.05, topY + 0.10, zc, hubX - side * 0.10, armY, zc, 0.055, 0xb5462f));
          // Upright.
          opaque.push(box(0.07, 0.34, 0.12, hubX - side * 0.02, (armY + topY) * 0.5, zc, 0x2b3037));
          // Driveshaft.
          opaque.push(tube(inX, armY + 0.16, zc, hubX, armY + 0.16, zc, 0.032, 0x33383e));
        }
      }

      // Underfloor tray, so the car is not hollow when it leaves the ground.
      opaque.push(box(W * 0.86, 0.05, L * 0.82, 0, rideH + 0.03, -L * 0.02, 0x1a1d21));

      // Radiator grille, as an actual lattice.
      {
        const gy = rideH + bodyH * 0.46;
        const ghw = bodyHalfWidth(0.46, gy) * 0.82;
        for (let i = 0; i < 11; i++) {
          const t = (i / 10) * 2 - 1;
          opaque.push(box(0.035, bodyH * 0.30, 0.05, t * ghw, gy, L * 0.470, 0x15181c));
        }
        for (let i = 0; i < 4; i++) {
          opaque.push(box(ghw * 2, 0.03, 0.05, 0,
            gy - bodyH * 0.12 + i * bodyH * 0.08, L * 0.468, 0x15181c));
        }
      }

      // Tow hooks, jacking points, aerial — the small hard things that tell the
      // eye how big the car is.
      for (const side of [-1, 1]) {
        opaque.push(cylinder(0.04, 0.10,
          side * (bodyHalfWidth(-0.20, rideH + bodyH * 0.08) - 0.05),
          rideH + bodyH * 0.08, -L * 0.20, 0x3a4046, 8, 'x'));
      }
      opaque.push(cylinder(0.05, 0.14, bodyHalfWidth(0.42, rideH + bodyH * 0.30) * 0.5,
        rideH + bodyH * 0.30, L * 0.46, accent, 10, 'z'));
      opaque.push(tube(-W * 0.22, rideH + bodyH + 0.34, -L * 0.30,
        -W * 0.24, rideH + bodyH + 0.66, -L * 0.34, 0.014, 0x2a2e33, 6));
    }

    // --- emissive trim ------------------------------------------------------
    // Placed *on* the body, by asking the profile where the body actually is.
    //
    // These were positioned with hand-guessed constants — the sill strip at
    // `rideH * 0.52`, which is below the floor, and `W * 0.5` wide, which is
    // wider than the tapered flank. The result was a lit slab hovering in mid
    // air beside and under the car, and a tail bar floating above the deck.
    // Constants cannot track a profile that changes; a query can.
    for (const side of [-1, 1]) {
      const sillY = rideH + bodyH * 0.16;
      emissive.push(box(0.03, 0.025, L * 0.40,
        side * (bodyHalfWidth(-0.02, sillY) - 0.015), sillY, -L * 0.02, 0xffffff));
    }
    {
      const fz = -0.455;
      emissive.push(box(bodyHalfWidth(fz, rideH + bodyH * 0.62) * 1.05, 0.05, 0.05,
        0, rideH + bodyH * 0.62, L * fz - 0.02, 0xffffff));
    }

    // --- assemble -----------------------------------------------------------
    this.bodyGeo = mergeGeometries(opaque);
    this.bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // Faceted. The loft averages normals across its cross-sections, which
      // reads as a soft curve; flat shading puts the panel edges back and is
      // what makes the silhouette legible at speed.
      flatShading: true,
      roughness: lerp(0.42, 0.78, armor),
      metalness: lerp(0.30, 0.58, armor),
    });
    this.bodyMesh = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    this.bodyMesh.castShadow = !!quality?.shadows;
    this.group.add(this.bodyMesh);

    this.glassGeo = mergeGeometries(glass);
    this.glassMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.10, metalness: 0.55, flatShading: true,
      transparent: true, opacity: 0.70,
    });
    this.glassMesh = new THREE.Mesh(this.glassGeo, this.glassMat);
    this.group.add(this.glassMesh);

    // Emissive parts carry their hue in vertex colours — white headlights, red
    // tail lights, element-coloured trim — and the material tints all of them,
    // so heat can push the lot toward white-hot in a single draw call.
    this.trimGeo = mergeGeometries(emissive);
    this.trimMat = new THREE.MeshBasicMaterial({
      vertexColors: true, color: this.glow.color, toneMapped: false,
    });
    this.trimMesh = new THREE.Mesh(this.trimGeo, this.trimMat);
    this.group.add(this.trimMesh);

    // --- wheels -------------------------------------------------------------
    this.wheels = [];
    this.wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelT, 48, 1);
    this.wheelGeo.rotateZ(Math.PI / 2);
    this.wheelMat = new THREE.MeshStandardMaterial({
      color: RUBBER, roughness: 0.95, flatShading: true,
    });

    // Tread blocks, so wheel rotation stays legible at speed.
    const tread = [];
    const blocks = 54;
    for (let i = 0; i < blocks; i++) {
      const a = (i / blocks) * Math.PI * 2;
      // Two staggered rows: it is the stagger that makes rotation legible when
      // the wheel is a blur.
      for (const [phase, xOff] of [[0.0, -wheelT * 0.22], [0.5, wheelT * 0.22]]) {
        const aa = a + (phase * Math.PI * 2) / blocks;
        const g = new THREE.BoxGeometry(wheelT * 0.40, 0.05, 0.12);
        g.translate(xOff, Math.cos(aa) * wheelR, Math.sin(aa) * wheelR);
        tread.push(paint(g, 0x0a0c0f));
      }
    }
    // Shoulder blocks: the outer row is what you actually see of a tyre from
    // the side of the car, and it is what makes the contact patch read.
    for (let i = 0; i < blocks; i++) {
      const a = ((i + 0.25) / blocks) * Math.PI * 2;
      for (const sx of [-1, 1]) {
        const g = new THREE.BoxGeometry(wheelT * 0.16, 0.06, 0.10);
        g.translate(sx * wheelT * 0.42,
          Math.cos(a) * wheelR * 0.99, Math.sin(a) * wheelR * 0.99);
        tread.push(paint(g, 0x111418));
      }
    }
    // Sidewall lettering and bead ring.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const sx of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.015, 0.05, 0.05);
        g.translate(sx * (wheelT / 2 + 0.005),
          Math.cos(a) * wheelR * 0.78, Math.sin(a) * wheelR * 0.78);
        tread.push(paint(g, 0x2e3237));
      }
      for (const sx of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.02, 0.07, 0.07);
        g.translate(sx * (wheelT / 2 - 0.01),
          Math.cos(a) * wheelR * 0.92, Math.sin(a) * wheelR * 0.92);
        tread.push(paint(g, 0x191d21));
      }
    }
    this.treadGeo = mergeGeometries(tread);
    this.treadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98 });

    // Rim face: an accent disc just proud of the tyre on both sides, with dark
    // spokes contained inside its radius. Anything wider than the tyre reads as
    // a spike sticking through the wheel.
    const hub = [];
    hub.push(cylinder(wheelR * 0.58, wheelT * 1.04, 0, 0, 0, accent, 20, 'x'));
    // Paired spokes, so the rim reads as a wheel rather than a disc.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI;
      for (const off of [-0.055, 0.055]) {
        const g = new THREE.BoxGeometry(wheelT * 1.08, wheelR * 0.86, wheelR * 0.09);
        g.rotateX(a);
        g.translate(0, 0, off);
        hub.push(paint(g, 0x2b3038));
      }
    }
    // Centre nut, brake disc, caliper.
    hub.push(cylinder(wheelR * 0.17, wheelT * 1.10, 0, 0, 0, 0x3a4048, 16, 'x'));
    hub.push(cylinder(wheelR * 0.50, wheelT * 0.30, 0, 0, 0, 0x54595f, 28, 'x'));
    hub.push(cylinder(wheelR * 0.20, wheelT * 0.34, 0, 0, 0, 0x74797f, 16, 'x'));
    hub.push(box(wheelT * 0.30, wheelR * 0.30, wheelR * 0.22, 0, wheelR * 0.40, 0, 0xb5462f));

    // Rim barrel and lip: without these the wheel is a disc floating inside a
    // tyre, which is exactly what it looked like from any angle but dead side-on.
    hub.push(cylinder(wheelR * 0.72, wheelT * 0.86, 0, 0, 0, 0x23272c, 28, 'x'));
    for (const sx of [-1, 1]) {
      hub.push(cylinder(wheelR * 0.76, wheelT * 0.06, sx * wheelT * 0.46, 0, 0, accent, 28, 'x'));
    }
    // Lug nuts.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      hub.push(cylinder(wheelR * 0.055, wheelT * 0.10,
        wheelT * 0.50, Math.cos(a) * wheelR * 0.20, Math.sin(a) * wheelR * 0.20,
        0x8d949c, 8, 'x'));
    }
    // Drilled brake disc.
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      hub.push(cylinder(wheelR * 0.045, wheelT * 0.34,
        0, Math.cos(a) * wheelR * 0.36, Math.sin(a) * wheelR * 0.36,
        0x2a2e33, 8, 'x'));
    }
    this.hubGeo = mergeGeometries(hub);
    this.hubMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.35, metalness: 0.75, flatShading: true,
    });

    for (const [ix, iz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(ix * trackW, wheelR, iz * wheelbase);

      const spin = new THREE.Group();
      const tyre = new THREE.Mesh(this.wheelGeo, this.wheelMat);
      tyre.castShadow = !!quality?.shadows;
      spin.add(tyre);
      spin.add(new THREE.Mesh(this.treadGeo, this.treadMat));
      spin.add(new THREE.Mesh(this.hubGeo, this.hubMat));

      pivot.add(spin);
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, steered: iz > 0, radius: wheelR });
    }

    // --- underglow ----------------------------------------------------------
    const glowGeo = new THREE.PlaneGeometry(W * 1.25, L * 0.95);
    glowGeo.rotateX(-Math.PI / 2);
    this.underglowMat = new THREE.MeshBasicMaterial({
      color: this.glow.color, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.underglow = new THREE.Mesh(glowGeo, this.underglowMat);
    this.underglow.position.y = 0.05;
    this.underglow.renderOrder = 5;
    this.group.add(this.underglow);

    this._wheelSpin = 0;
    this._hotColor = new THREE.Color(0xff3a1a);
    this._baseColor = new THREE.Color(this.glow.color);
  }

  /**
   * @param body   VehicleBody
   * @param state  { heatPct, energyFrac, boosting, steer }
   */
  update(dt, body, state = {}) {
    const g = this.group;
    g.position.set(body.x, body.y, body.z);
    g.rotation.set(0, body.yaw, 0);
    // Pitch and roll come off the physics body, so squat under acceleration and
    // lean in a corner are driven by real quantities.
    g.rotateX(body.pitch);
    g.rotateZ(body.roll);

    this._wheelSpin += (body.forwardSpeed / Math.max(0.1, this.wheels[0].radius)) * dt;
    // Negated because a positive rotation.y turns the wheel toward +X, which is
    // the car's left — the same convention the yaw rate has to respect.
    const steerAngle = clamp(-(state.steer ?? 0) * 0.42 + body.slipAngle * 0.5, -0.6, 0.6);
    for (const w of this.wheels) {
      w.spin.rotation.x = this._wheelSpin;
      w.pivot.rotation.y = w.steered ? steerAngle : 0;
    }

    // Heat drives the trim toward white-hot; a cool car sits at its element's
    // colour. This is the "you can see the build" feedback loop.
    const heat = clamp01((state.heatPct ?? 0) / 100);
    this.trimMat.color.copy(this._baseColor).lerp(this._hotColor, heat * 0.85);

    const glowStrength = this.glow.power * (0.2 + heat * 0.5
      + (state.boosting ? 0.5 : 0)
      + (body.drifting ? body.driftQuality * 0.4 : 0));
    this.underglowMat.opacity = clamp01(glowStrength) * 0.16;
    this.underglowMat.color.copy(this.trimMat.color);
  }

  addTo(scene) {
    scene.add(this.group);
    return this;
  }

  dispose() {
    for (const geo of [this.bodyGeo, this.glassGeo, this.trimGeo,
      this.wheelGeo, this.treadGeo, this.hubGeo, this.underglow.geometry]) {
      geo?.dispose();
    }
    for (const mat of [this.bodyMat, this.glassMat, this.trimMat,
      this.wheelMat, this.treadMat, this.hubMat, this.underglowMat]) {
      mat?.dispose();
    }
    this.group.parent?.remove(this.group);
  }
}
