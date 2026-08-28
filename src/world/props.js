import * as THREE from 'three';
import {
  boxOf, prism, cone, rock, extrude, loftSections,
  mergeFaceted, triCount, facetedMaterial, shade, mix,
} from './shapes.js';
import { RNG } from '../core/rng.js';
import { lerp, TAU } from '../core/math.js';

// The things that make a track a place.
//
// Every prop is generated, faceted, and vertex-coloured, so a whole type shares
// one material and draws as a single InstancedMesh however many are scattered.
// Each type declares a few geometry *variants*, because instancing shares
// geometry — variety within a type has to come from having several to choose
// between, plus per-instance scale and rotation.
//
// `radius` is the collision footprint the simulation uses; `toughness` is how
// much Impact is needed to drive through rather than bounce off, which is what
// makes Weight and Impact decide routes as the design brief asks.
// `toughness: null` means indestructible — scenery, not an obstacle.

const TRACKSIDE = 'trackside';  // close to the road, can be hit
const SCENERY = 'scenery';      // background, never collides

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------
//
// Detail is spent where it can be resolved. A barrel two metres from the racing
// line is looked at directly; a tower four hundred metres away is a silhouette
// against fog, and every triangle past the outline of it is wasted.
//
// Two knobs, because they fail differently. `sides` scales segment counts, so a
// far prism is a hexagon rather than an octadecagon — cheap and invisible at
// range. `fine` gates the small applied details (rivets, ribs, slats, spectators)
// entirely: halving the segments of a rivet still leaves a rivet nobody can see,
// so those are dropped rather than shrunk.

export const LODS = [
  { id: 0, sides: 1.00, fine: true },   // near the road, looked at
  { id: 1, sides: 0.60, fine: false },  // mid-field, read as shape
  { id: 2, sides: 0.40, fine: false },  // horizon, read as silhouette
];

/** Segment count for this detail level. */
function S(n, ctx) {
  return Math.max(3, Math.round(n * (ctx?.sides ?? 1)));
}

/** Subdivision level for `rock`, which counts differently. */
function Dt(n, ctx) {
  const k = ctx?.sides ?? 1;
  return k >= 0.95 ? n : k >= 0.55 ? Math.max(0, n - 1) : 0;
}

// ---------------------------------------------------------------------------
// Universal track furniture
// ---------------------------------------------------------------------------

function tyreStack(rng, pal, ctx = {}) {
  const fine = ctx.fine !== false;
  const parts = [];
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const r = 0.55 + rng.spread(0.05);
    parts.push(prism(S(18, ctx), r, r * 0.94, 0.30, i % 2 ? 0x1b1d21 : 0x24272c, {
      y: i * 0.28, rotY: rng.range(0, TAU), rng, variation: 0.1,
    }));
    // Tread blocks around the crown, and the wheel visible in the middle.
    for (let k = 0; fine && k < 12; k++) {
      const a = (k / 12) * TAU;
      parts.push(boxOf(0.1, 0.2, 0.07, 0x101216, {
        x: Math.cos(a) * (r + 0.02), z: Math.sin(a) * (r + 0.02),
        y: i * 0.28 + 0.15, rotY: -a, rng,
      }));
    }
    parts.push(prism(S(12, ctx), r * 0.42, r * 0.42, 0.16,
      shade(pal.accent, 0.5), { y: i * 0.28 + 0.07, rng }));
  }
  // A painted top tyre reads as deliberate rather than as litter.
  parts.push(prism(S(18, ctx), 0.5, 0.5, 0.12, pal.accent, { y: n * 0.28, rng }));
  return mergeFaceted(parts);
}

function barrel(rng, pal, ctx = {}) {
  const parts = [];
  // The vestigial `color` parameter that used to sit in this slot took the
  // context object instead, and `new THREE.Color({...})` returns white without
  // complaining — so every barrel on every track has been rendering white
  // rather than red or green. Nothing ever passed a colour; the parameter is
  // gone rather than reordered.
  const c = rng.bool(0.5) ? 0xb5462f : 0x4a6b52;
  parts.push(prism(S(18, ctx), 0.42, 0.42, 1.05, c, { rng, variation: 0.1 }));
  // Rolling hoops.
  for (const y of [0.26, 0.74]) {
    parts.push(prism(S(18, ctx), 0.46, 0.46, 0.08, shade(c, 0.6), { y, rng }));
  }
  parts.push(prism(S(18, ctx), 0.38, 0.34, 0.07, shade(c, 1.25), { y: 1.03, rng }));
  // Rim lip, bung, and a label band. A barrel is a cylinder until it has the
  // three things that say which way up it goes — and none of the three survive
  // a hundred metres, so they are built only for the near level.
  if (ctx.fine === false) return mergeFaceted(parts);
  parts.push(prism(S(18, ctx), 0.44, 0.44, 0.05, shade(c, 0.55), { y: 1.0, rng }));
  parts.push(prism(S(18, ctx), 0.44, 0.44, 0.05, shade(c, 0.55), { y: 0.0, rng }));
  parts.push(prism(S(8, ctx), 0.09, 0.09, 0.05, shade(c, 0.45), { x: 0.18, y: 1.09, rng }));
  parts.push(prism(S(18, ctx), 0.425, 0.425, 0.26, shade(c, 1.35), { y: 0.44, rng, variation: 0.05 }));
  for (let i = 0; i < 3; i++) {
    parts.push(boxOf(0.07, 0.16, 0.03, shade(c, 0.4), {
      x: -0.1 + i * 0.1, y: 0.57, z: 0.415, rng,
    }));
  }
  return mergeFaceted(parts);
}

function crate(rng, pal, ctx = {}) {
  const s = 0.9 + rng.spread(0.15);
  const wood = mix(0x8a6a42, 0x6b5133, rng.next());
  const parts = [boxOf(s, s * 0.85, s, wood, { y: s * 0.42, rng, variation: 0.1 })];
  // Bracing planks catch the light and read the shape at distance.
  for (const z of [-s / 2 - 0.02, s / 2 + 0.02]) {
    parts.push(boxOf(s * 1.02, 0.1, 0.04, shade(wood, 0.75), { y: s * 0.2, z, rng }));
    parts.push(boxOf(s * 1.02, 0.1, 0.04, shade(wood, 0.75), { y: s * 0.66, z, rng }));
  }
  // Corner posts and a stencil, so a crate is not just a cube.
  if (ctx.fine === false) return mergeFaceted(parts);
  for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
    parts.push(boxOf(0.09, s * 0.85, 0.09, shade(wood, 0.62), {
      x: ix * (s / 2 - 0.03), y: s * 0.42, z: iz * (s / 2 - 0.03), rng,
    }));
  }
  for (const ix of [-s / 2 - 0.02, s / 2 + 0.02]) {
    parts.push(boxOf(0.04, 0.1, s * 1.02, shade(wood, 0.75), { x: ix, y: s * 0.2, rng }));
    parts.push(boxOf(0.04, 0.1, s * 1.02, shade(wood, 0.75), { x: ix, y: s * 0.66, rng }));
  }
  parts.push(boxOf(s * 0.34, s * 0.22, 0.03, shade(wood, 1.35), {
    y: s * 0.44, z: s / 2 + 0.05, rng,
  }));
  return mergeFaceted(parts);
}

function markerBoard(rng, pal, ctx = {}) {
  const parts = [];
  parts.push(prism(S(10, ctx), 0.07, 0.06, 1.5, 0x51565d, { rng }));
  parts.push(boxOf(1.05, 0.62, 0.06, 0xf2f2f0, { y: 1.55, rng, variation: 0.02 }));
  // Chevron, in the biome accent.
  for (let i = 0; i < 3; i++) {
    parts.push(boxOf(0.22, 0.5, 0.03, pal.accent, {
      x: -0.32 + i * 0.32, y: 1.55, z: 0.05, rng, variation: 0.03,
    }));
  }
  // Back brace and fixings: the board had no thickness from behind.
  if (ctx.fine === false) return mergeFaceted(parts);
  parts.push(boxOf(0.08, 0.08, 0.5, 0x51565d, { y: 1.35, z: -0.2, rng }));
  parts.push(boxOf(1.05, 0.07, 0.05, 0x3f4349, { y: 1.84, z: -0.05, rng }));
  parts.push(boxOf(1.05, 0.07, 0.05, 0x3f4349, { y: 1.26, z: -0.05, rng }));
  for (const ix of [-0.42, 0.42]) for (const iy of [1.32, 1.78]) {
    parts.push(prism(S(6, ctx), 0.045, 0.045, 0.04, 0x2e3238, { x: ix, y: iy, z: 0.06, rng }));
  }
  return mergeFaceted(parts);
}

function gantry(rng, pal, ctx = {}) {
  const fine = ctx.fine !== false;
  const parts = [];
  // Built to a nominal 11 m half-width and scaled per instance by PropsMesh,
  // because every builder receives the same (rng, palette, ctx) signature —
  // reading a third argument that is actually the context object produced NaN
  // geometry and a bounding-sphere warning with no other symptom.
  const NOMINAL_HALF_WIDTH = 11;
  const span = NOMINAL_HALF_WIDTH * 2 + 4;
  const h = 6.2;
  for (const side of [-1, 1]) {
    const x = side * (span / 2);
    parts.push(prism(S(10, ctx), 0.34, 0.26, h, 0x4a5057, { x, rng }));
    parts.push(boxOf(1.2, 0.3, 1.2, 0x3a4046, { x, y: 0.15, rng }));
  }
  // A truss, not a plank. This is the biggest structure over the road and it
  // was a single box spanning twenty-six metres.
  parts.push(boxOf(span, 0.22, 0.3, 0x565c64, { y: h + 0.42, rng }));
  parts.push(boxOf(span, 0.22, 0.3, 0x565c64, { y: h - 0.34, rng }));
  const bays = fine ? 22 : 8;
  for (let i = 0; i < bays; i++) {
    const x = lerp(-span / 2 + 0.4, span / 2 - 0.4, i / (bays - 1));
    parts.push(boxOf(0.12, 0.78, 0.16, 0x4d535a, { x, y: h + 0.04, rng }));
    // Built at the origin, rotated, then placed: `boxOf` applies its offset
    // before returning, so rotating the result swings it about the world
    // origin instead of about itself.
    const d = boxOf(0.1, 1.05, 0.14, 0x474d54, { rng });
    d.rotateZ(i % 2 ? 0.62 : -0.62);
    d.translate(x, h + 0.04, 0);
    parts.push(d);
  }
  parts.push(boxOf(span * 0.9, 0.7, 0.16, pal.accent, { y: h - 0.5, z: 0.3, rng }));
  // Lamp housings.
  for (let i = 0; i < 5; i++) {
    parts.push(boxOf(0.5, 0.34, 0.34, 0x2a2e33, {
      x: lerp(-span * 0.36, span * 0.36, i / 4), y: h - 0.95, rng,
    }));
  }
  return mergeFaceted(parts);
}

function grandstand(rng, pal, ctx = {}) {
  const fine = ctx.fine !== false;
  const parts = [];
  const w = 16 + rng.range(0, 8);
  const rows = 6;
  for (let i = 0; i < rows; i++) {
    const y = 0.7 + i * 0.62;
    const z = -i * 0.95;
    parts.push(boxOf(w, 0.5, 0.9, i % 2 ? 0x4b5359 : 0x565f66, { y, z, rng, variation: 0.05 }));
    // Spectators as coloured blocks: at this distance that is all they need to
    // be, and it makes the stand read as occupied rather than as furniture.
    const seats = fine ? Math.floor(w / 1.4) : 0;
    for (let k = 0; k < seats; k++) {
      if (rng.bool(0.42)) continue;
      parts.push(boxOf(0.36, 0.52, 0.3,
        [0xd05a4a, 0x4a7ad0, 0xe0c04a, 0xf0f0ee, 0x50b070][rng.int(0, 4)], {
          x: -w / 2 + 0.8 + k * 1.4, y: y + 0.5, z: z + 0.1, rng, variation: 0.12,
        }));
    }
  }
  // Roof and supports.
  parts.push(boxOf(w + 1.5, 0.3, rows * 1.1, shade(pal.accent, 0.55), {
    y: 0.7 + rows * 0.62 + 1.6, z: -rows * 0.5, rng,
  }));
  for (const side of [-1, 1]) {
    parts.push(prism(S(10, ctx), 0.22, 0.18, 0.7 + rows * 0.62 + 1.5, 0x3f464c, {
      x: side * (w / 2 - 0.4), z: -rows * 0.95, rng,
    }));
  }
  // Front railing, roof truss, and an access stair up one flank.
  const topY = 0.7 + rows * 0.62;
  if (fine) {
  parts.push(boxOf(w, 0.08, 0.08, 0x9aa2a8, { y: 1.35, z: 0.55, rng }));
  parts.push(boxOf(w, 0.08, 0.08, 0x9aa2a8, { y: 0.95, z: 0.55, rng }));
  for (let i = 0; i < Math.floor(w / 2); i++) {
    parts.push(boxOf(0.07, 0.75, 0.07, 0x8a9298, {
      x: -w / 2 + 1 + i * 2, y: 1.0, z: 0.55, rng,
    }));
  }
  for (let i = 0; i < 8; i++) {
    const d2 = boxOf(0.09, 1.5, 0.09, 0x3f464c, { rng });
    d2.rotateZ(i % 2 ? 0.6 : -0.6);
    d2.translate(-w / 2 + 1.2 + i * ((w - 2.4) / 7), topY + 0.9, -rows * 0.5);
    parts.push(d2);
  }
  for (let i = 0; i < rows * 2; i++) {
    parts.push(boxOf(1.1, 0.09, 0.4, 0x4b5359, {
      x: w / 2 + 0.7, y: 0.4 + i * 0.31, z: -i * 0.48, rng,
    }));
  }
  }
  return mergeFaceted(parts);
}

// ---------------------------------------------------------------------------
// Biome props
// ---------------------------------------------------------------------------

function wreck(rng, pal, ctx = {}) {
  // A stripped car body: the loft primitive, rusted and sagging.
  const L = 4.2 + rng.range(0, 0.8);
  const W = 1.9;
  const rust = mix(0x7a4a30, 0x59493f, rng.next());
  const parts = [];
  parts.push(loftSections([
    { z: L * 0.5, w: W * 0.6, h: 0.5, y: 0.55 },
    { z: L * 0.2, w: W * 0.95, h: 0.7, y: 0.6 },
    { z: -L * 0.15, w: W, h: 0.72, y: 0.58 },
    { z: -L * 0.5, w: W * 0.7, h: 0.5, y: 0.5 },
  ], rust, { rng, variation: 0.12 }));
  // Roof, sometimes caved in.
  if (rng.bool(0.6)) {
    parts.push(loftSections([
      { z: L * 0.1, w: W * 0.6, h: 0.1, y: 0.95 },
      { z: -L * 0.25, w: W * 0.62, h: 0.45, y: 1.05 + rng.spread(0.12) },
    ], shade(rust, 0.8), { rng }));
  }
  // Whatever wheels are left.
  for (const [ix, iz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    if (rng.bool(0.3)) continue;
    parts.push(prism(S(14, ctx), 0.34, 0.34, 0.24, 0x1a1c20, {
      x: ix * (W * 0.5 - 0.05), y: 0.34, z: iz * L * 0.3, rng,
    }));
  }
  // Bumpers, an exposed chassis rail, and a stripped engine bay. A wreck is
  // read by what is missing from it.
  if (ctx.fine === false) return mergeFaceted(parts);
  for (const iz of [1, -1]) {
    parts.push(boxOf(W * 0.92, 0.16, 0.14, shade(rust, 0.7), {
      y: 0.5, z: iz * (L * 0.5 + 0.05), rng, variation: 0.16,
    }));
  }
  for (const ix of [-1, 1]) {
    parts.push(boxOf(0.12, 0.14, L * 0.86, shade(rust, 0.62), {
      x: ix * W * 0.3, y: 0.34, rng,
    }));
  }
  parts.push(boxOf(W * 0.55, 0.35, 0.8, 0x2e2a26, { y: 0.62, z: L * 0.24, rng }));
  for (let i = 0; i < 4; i++) {
    parts.push(prism(S(8, ctx), 0.09, 0.09, 0.3, 0x3a352f, {
      x: -W * 0.2 + i * (W * 0.4 / 3), y: 0.8, z: L * 0.24, rng,
    }));
  }
  parts.push(boxOf(W * 0.86, 0.1, 0.1, shade(rust, 0.55), { y: 0.92, z: L * 0.02, rng }));
  return mergeFaceted(parts);
}

function shack(rng, pal, ctx = {}) {
  const w = 3.4 + rng.range(0, 2);
  const d = 3.0 + rng.range(0, 1.6);
  const h = 2.4 + rng.range(0, 0.8);
  const wall = mix(pal.prop, 0x6b5a48, rng.next());
  const parts = [boxOf(w, h, d, wall, { y: h / 2, rng, variation: 0.1 })];
  // Lean-to roof.
  parts.push(extrude([[-w / 2 - 0.3, -d / 2 - 0.3], [w / 2 + 0.3, -d / 2 - 0.3],
    [w / 2 + 0.3, d / 2 + 0.3], [-w / 2 - 0.3, d / 2 + 0.3]], 0.18,
    shade(wall, 0.65), { y: h, rng }));
  // Corrugation, and a door.
  if (ctx.fine === false) return mergeFaceted(parts);
  for (let i = 0; i < 6; i++) {
    parts.push(boxOf(0.1, h, 0.06, shade(wall, 0.82), {
      x: -w / 2 + 0.4 + i * (w / 6), z: d / 2 + 0.02, y: h / 2, rng,
    }));
  }
  parts.push(boxOf(0.9, 1.8, 0.08, 0x2b2622, { y: 0.9, z: d / 2 + 0.05, rng }));
  // A window, a flue, and ribs across the roof. Silhouette does most of the
  // work at this distance and a plain box has none.
  parts.push(boxOf(0.7, 0.6, 0.06, 0x14181c, { x: w * 0.28, y: h * 0.62, z: d / 2 + 0.04, rng }));
  parts.push(boxOf(0.8, 0.07, 0.07, shade(wall, 0.6), { x: w * 0.28, y: h * 0.62, z: d / 2 + 0.07, rng }));
  parts.push(prism(S(10, ctx), 0.16, 0.14, 1.2, 0x33302c, { x: -w * 0.3, y: h, z: -d * 0.2, rng }));
  parts.push(prism(S(10, ctx), 0.22, 0.22, 0.12, 0x26241f, { x: -w * 0.3, y: h + 1.2, z: -d * 0.2, rng }));
  for (let i = 0; i < 7; i++) {
    parts.push(boxOf(0.08, 0.06, d + 0.6, shade(wall, 0.52), {
      x: -w / 2 + 0.3 + i * ((w - 0.6) / 6), y: h + 0.2, rng,
    }));
  }
  for (const ix of [-1, 1]) {
    parts.push(boxOf(0.12, h, 0.12, shade(wall, 0.58), {
      x: ix * (w / 2 - 0.06), y: h / 2, z: d / 2 - 0.06, rng,
    }));
  }
  return mergeFaceted(parts);
}

function pole(rng, pal, withLamp, ctx = {}) {
  const h = 7 + rng.range(0, 3);
  const parts = [prism(S(10, ctx), 0.16, 0.11, h, 0x4c4740, { rng, variation: 0.08 })];
  parts.push(boxOf(2.2, 0.14, 0.14, 0x4c4740, { y: h - 0.6, rng }));
  parts.push(boxOf(1.6, 0.12, 0.12, 0x4c4740, { y: h - 1.3, rng }));
  // Insulators on each cross-arm, and a brace under the top one.
  for (const y of [h - 0.6, h - 1.3]) {
    const reach = y > h - 1 ? 1.0 : 0.7;
    for (const ix of [-reach, 0, reach]) {
      parts.push(prism(S(8, ctx), 0.075, 0.055, 0.18, 0x8f9aa2, { x: ix, y: y + 0.07, rng }));
    }
  }
  for (const ix of [-1, 1]) {
    const b = boxOf(0.7, 0.08, 0.08, 0x4c4740, { rng });
    b.rotateZ(ix * 0.7);
    b.translate(ix * 0.45, h - 0.95, 0);
    parts.push(b);
  }
  if (withLamp) {
    parts.push(boxOf(0.5, 0.2, 0.9, 0x33383e, { x: 0.9, y: h - 0.85, rng }));
    parts.push(prism(S(10, ctx), 0.3, 0.26, 0.7, 0x3b4046, { x: -0.35, y: h * 0.45, rng }));
  }
  return mergeFaceted(parts);
}

function deadTree(rng, pal, ctx = {}) {
  const h = 3.5 + rng.range(0, 2.5);
  const bark = mix(0x4a3c30, 0x3a2f26, rng.next());
  const parts = [prism(S(10, ctx), 0.28, 0.14, h, bark, { rng, variation: 0.12 })];
  const branches = rng.int(3, 6);
  for (let i = 0; i < branches; i++) {
    const g = prism(S(9, ctx), 0.09, 0.04, 1.2 + rng.range(0, 1.2), bark, { rng });
    g.rotateZ(rng.range(0.6, 1.2) * (rng.bool() ? 1 : -1));
    g.rotateY(rng.range(0, TAU));
    g.translate(0, h * rng.range(0.5, 0.92), 0);
    parts.push(g);
  }
  // Twigs, and roots flaring into the ground so the trunk is not a peg.
  for (let i = 0; (ctx.fine !== false) && i < 7; i++) {
    const t = prism(S(5, ctx), 0.04, 0.015, 0.5 + rng.range(0, 0.5), bark, { rng });
    t.rotateZ(rng.range(0.9, 1.5) * (rng.bool() ? 1 : -1));
    t.rotateY(rng.range(0, TAU));
    t.translate(0, h * rng.range(0.6, 0.98), 0);
    parts.push(t);
  }
  for (let i = 0; (ctx.fine !== false) && i < 5; i++) {
    const a = (i / 5) * TAU + rng.spread(0.3);
    const r = prism(S(5, ctx), 0.11, 0.04, 0.55, bark, { rng });
    r.rotateZ(1.25);
    r.rotateY(a);
    r.translate(0, 0.08, 0);
    parts.push(r);
  }
  return mergeFaceted(parts);
}

function pine(rng, pal, ctx = {}) {
  const h = 6 + rng.range(0, 5);
  const trunk = 0x3d3228;
  const needle = mix(0x24503a, 0x1b3d2c, rng.next());
  const parts = [prism(S(10, ctx), 0.24, 0.16, h * 0.35, trunk, { rng })];
  // Stacked cones, narrowing upward.
  const tiers = rng.int(3, 5);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    parts.push(cone(S(12, ctx), lerp(1.9, 0.5, t), h * 0.34, needle, {
      y: h * (0.22 + t * 0.62), rng, variation: 0.1,
    }));
    // Sprigs breaking the cone's outline, so it is a tree and not a party hat.
    const sprigs = ctx.fine === false ? 0 : 5;
    for (let k = 0; k < sprigs; k++) {
      const a = rng.range(0, TAU);
      const rr = lerp(1.9, 0.5, t) * rng.range(0.75, 1.05);
      const g = cone(S(6, ctx), 0.3, 0.9, shade(needle, 1.12), { rng, variation: 0.12 });
      g.rotateZ(1.15);
      g.rotateY(a);
      g.translate(Math.cos(a) * rr, h * (0.24 + t * 0.62), Math.sin(a) * rr);
      parts.push(g);
    }
  }
  return mergeFaceted(parts);
}

function cactus(rng, pal, ctx = {}) {
  const green = mix(0x4a7a4a, 0x3a6238, rng.next());
  const h = 2.6 + rng.range(0, 2);
  const parts = [prism(S(14, ctx), 0.36, 0.30, h, green, { rng, variation: 0.1 })];
  // Flutes down the trunk. A saguaro is ribbed, and it is the ribs that catch
  // the low sun this biome is lit by.
  for (let i = 0; (ctx.fine !== false) && i < 10; i++) {
    const a = (i / 10) * TAU;
    parts.push(boxOf(0.07, h * 0.94, 0.07, shade(green, 0.78), {
      x: Math.cos(a) * 0.33, z: Math.sin(a) * 0.33, y: h * 0.47, rotY: -a, rng,
    }));
  }
  const arms = rng.int(1, 3);
  for (let i = 0; i < arms; i++) {
    const side = rng.bool() ? 1 : -1;
    const ay = h * rng.range(0.4, 0.7);
    parts.push(prism(S(12, ctx), 0.2, 0.18, 0.9, green, { x: side * 0.5, y: ay, rng }));
    parts.push(prism(S(12, ctx), 0.19, 0.17, 1.0 + rng.range(0, 0.6), green, {
      x: side * 0.75, y: ay + 0.4, rng,
    }));
  }
  return mergeFaceted(parts);
}

function container(rng, pal, ctx = {}) {
  const fine = ctx.fine !== false;
  const L = 6.1, W = 2.44, H = 2.6;
  const c = [0xa8442e, 0x2e5aa8, 0x4a7a3a, 0xb08a2e, 0x8a8a90][rng.int(0, 4)];
  const parts = [boxOf(L, H, W, c, { y: H / 2, rng, variation: 0.07 })];
  // Ribbing along both flanks: this is the whole visual identity of a container.
  const ribs = fine ? 16 : 0;
  for (let i = 0; i < ribs; i++) {
    const x = -L / 2 + 0.3 + i * ((L - 0.6) / (ribs - 1));
    for (const z of [-W / 2 - 0.02, W / 2 + 0.02]) {
      parts.push(boxOf(0.11, H * 0.9, 0.05, shade(c, 0.86), { x, y: H / 2, z, rng }));
    }
  }
  // Doors and corner castings.
  if (!fine) return mergeFaceted(parts);
  parts.push(boxOf(0.06, H * 0.92, W * 0.96, shade(c, 0.7), { x: L / 2 + 0.02, y: H / 2, rng }));
  // Locking bars and hinges — the end that reads as a door.
  for (const z of (fine ? [-0.75, -0.25, 0.25, 0.75] : [])) {
    parts.push(prism(S(8, ctx), 0.05, 0.05, H * 0.86, shade(c, 0.5), {
      x: L / 2 + 0.07, y: H * 0.07, z: z * W * 0.5, rng,
    }));
    parts.push(boxOf(0.14, 0.16, 0.1, 0x2e3135, { x: L / 2 + 0.09, y: H * 0.5, z: z * W * 0.5, rng }));
  }
  for (let i = 0; fine && i < 9; i++) {
    parts.push(boxOf(0.09, 0.06, W * 0.94, shade(c, 0.9), {
      x: -L / 2 + 0.5 + i * ((L - 1) / 8), y: H + 0.03, rng,
    }));
  }
  for (const ix of [-1, 1]) for (const iz of [-1, 1]) for (const iy of [0, 1]) {
    parts.push(boxOf(0.3, 0.3, 0.3, 0x35383c, {
      x: ix * (L / 2 - 0.15), y: iy ? H - 0.15 : 0.15, z: iz * (W / 2 - 0.15), rng,
    }));
  }
  return mergeFaceted(parts);
}

function crane(rng, pal, ctx = {}) {
  const h = 14 + rng.range(0, 8);
  const parts = [];
  // Lattice tower: four legs plus cross-bracing, which is what makes it read.
  for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
    parts.push(prism(S(6, ctx), 0.16, 0.12, h, 0xc4a02e, { x: ix * 0.8, z: iz * 0.8, rng }));
  }
  const braceStep = ctx.fine === false ? 4 : 2;
  for (let i = 0; i < Math.floor(h / braceStep); i++) {
    const y = 1 + i * braceStep;
    // Build at the origin, rotate, then place. This previously offset the box
    // first and rotated it about the world origin, then translated by `y` again
    // through `y - (y - 0)` — which is `y` written so it looks like a
    // correction. The bracing landed nowhere near the legs it braces.
    for (const iz of [-1, 1]) {
      const g = boxOf(2.3, 0.1, 0.1, 0xa8882a, { rng });
      g.rotateZ(i % 2 ? 0.72 : -0.72);
      g.translate(0, y, iz * 0.8);
      parts.push(g);
    }
    for (const ix of [-1, 1]) {
      const g = boxOf(0.1, 0.1, 2.3, 0xa8882a, { rng });
      g.rotateX(i % 2 ? -0.72 : 0.72);
      g.translate(ix * 0.8, y, 0);
      parts.push(g);
    }
    parts.push(boxOf(1.72, 0.09, 0.09, 0x9c7f26, { y: y + 1, z: 0.8, rng }));
    parts.push(boxOf(1.72, 0.09, 0.09, 0x9c7f26, { y: y + 1, z: -0.8, rng }));
  }
  // Jib and counterweight.
  parts.push(boxOf(16, 0.22, 0.28, 0xc4a02e, { x: 4, y: h + 0.3, rng }));
  parts.push(boxOf(16, 0.22, 0.28, 0xc4a02e, { x: 4, y: h - 0.3, rng }));
  for (let i = 0; (ctx.fine !== false) && i < 16; i++) {
    const x = -4 + i * (16 / 15);
    const d = boxOf(0.08, 0.85, 0.12, 0xa8882a, { rng });
    d.rotateZ(i % 2 ? 0.55 : -0.55);
    d.translate(x, h, 0);
    parts.push(d);
  }
  parts.push(boxOf(3, 1.2, 1.6, 0x53575c, { x: -3.5, y: h - 0.2, rng }));
  parts.push(boxOf(0.16, 3.2, 0.16, 0x33363a, { x: 9, y: h - 1.7, rng }));
  parts.push(boxOf(0.7, 0.7, 0.7, 0x8a8f95, { x: 9, y: h - 3.4, rng }));
  return mergeFaceted(parts);
}

function pipes(rng, pal, ctx = {}) {
  const parts = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const r = 0.3 + rng.range(0, 0.25);
    const len = 8 + rng.range(0, 10);
    const g = prism(S(14, ctx), r, r, len, mix(0x6a6f76, 0x55595f, rng.next()), { rng });
    g.rotateZ(Math.PI / 2);
    g.translate(0, 0.7 + i * (r * 2 + 0.25), 0);
    parts.push(g);
    // Saddle supports.
    for (const sx of [-len * 0.35, len * 0.35]) {
      parts.push(boxOf(0.3, 0.7 + i * 0.7, 0.3, 0x4a4e53, { x: sx, y: (0.7 + i * 0.7) / 2, rng }));
      // Saddle strap over the pipe it carries.
      const strap = prism(S(14, ctx), r + 0.06, r + 0.06, 0.12, 0x3f4348, { rng });
      strap.rotateZ(Math.PI / 2);
      strap.translate(sx, 0.7 + i * (r * 2 + 0.25), 0);
      parts.push(strap);
    }
    // Flanges at both ends, and a valve wheel on one pipe.
    for (const sx of [-len / 2, len / 2]) {
      const flange = prism(S(16, ctx), r + 0.12, r + 0.12, 0.14, 0x7a8088, { rng });
      flange.rotateZ(Math.PI / 2);
      flange.translate(sx, 0.7 + i * (r * 2 + 0.25), 0);
      parts.push(flange);
    }
    if (i === 0) {
      parts.push(prism(S(10, ctx), 0.09, 0.09, 0.55, 0x8a9098, {
        y: 0.7 + r, rng,
      }));
      parts.push(prism(S(16, ctx), 0.34, 0.34, 0.07, 0xb5462f, { y: 1.25 + r, rng }));
    }
  }
  return mergeFaceted(parts);
}

function spire(rng, pal, ctx = {}) {
  const h = 9 + rng.range(0, 9);
  const stone = mix(0x3a1e1a, 0x2a1512, rng.next());
  const parts = [];
  const tiers = rng.int(3, 5);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    parts.push(prism(S(rng.int(5, 7), ctx), lerp(1.5, 0.4, t), lerp(1.2, 0.3, t),
      h / tiers, stone, { y: (h / tiers) * i, rotY: rng.range(0, TAU), rng, variation: 0.12 }));
  }
  parts.push(cone(S(10, ctx), 0.5, 2.2, shade(stone, 1.3), { y: h, rng }));
  // Buttresses at the base and banding between tiers: a stack of prisms reads
  // as a stack of prisms until something ties it together.
  if (ctx.fine === false) return mergeFaceted(parts);
  const spurs = rng.int(4, 6);
  for (let i = 0; i < spurs; i++) {
    const a = (i / spurs) * TAU + rng.spread(0.4);
    const g = cone(S(8, ctx), 0.55 + rng.range(0, 0.3), h * rng.range(0.3, 0.5),
      shade(stone, 0.85), { rng, variation: 0.14 });
    g.translate(Math.cos(a) * 1.25, 0, Math.sin(a) * 1.25);
    parts.push(g);
  }
  for (let i = 1; i < tiers; i++) {
    const t = i / tiers;
    parts.push(prism(S(10, ctx), lerp(1.62, 0.5, t), lerp(1.58, 0.48, t), 0.16,
      shade(stone, 1.45), { y: (h / tiers) * i - 0.08, rng, variation: 0.1 }));
  }
  return mergeFaceted(parts);
}

function brazier(rng, pal, ctx = {}) {
  const parts = [];
  parts.push(prism(S(10, ctx), 0.5, 0.34, 1.6, 0x2e2320, { rng }));
  parts.push(prism(S(14, ctx), 0.8, 0.95, 0.7, 0x3d2d26, { y: 1.5, rng }));
  // Coals: emissive is added separately by the renderer, so this is the shape.
  parts.push(prism(S(14, ctx), 0.8, 0.7, 0.2, 0xff5a1e, { y: 2.0, rng, variation: 0.2 }));
  // Splayed legs, a rim, and rivets — an iron object, not a stack of discs.
  if (ctx.fine === false) return mergeFaceted(parts);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const g = prism(S(6, ctx), 0.11, 0.07, 1.7, 0x241b19, { rng });
    g.rotateZ(0.18);
    g.rotateY(a);
    parts.push(g);
  }
  parts.push(prism(S(14, ctx), 0.98, 0.98, 0.12, 0x33261f, { y: 2.12, rng }));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    parts.push(prism(S(6, ctx), 0.06, 0.06, 0.05, 0x26201c, {
      x: Math.cos(a) * 0.92, z: Math.sin(a) * 0.92, y: 1.78, rng,
    }));
  }
  for (let i = 0; i < 6; i++) {
    const a = rng.range(0, TAU);
    const r = rng.range(0, 0.5);
    const coal = rock(0.16 + rng.range(0, 0.1), 0xff7a2e, rng, { detail: Dt(0, ctx), squash: 0.8 });
    coal.translate(Math.cos(a) * r, 2.1, Math.sin(a) * r);
    parts.push(coal);
  }
  return mergeFaceted(parts);
}

function iceBlock(rng, pal, ctx = {}) {
  const s = 1.2 + rng.range(0, 1.6);
  const g = rock(s, mix(0xa8cadb, 0x8fb4c9, rng.next()), rng, {
    detail: Dt(1, ctx), jitter: 0.4, squash: 0.9,
  });
  return g;
}

function snowBank(rng, pal, ctx = {}) {
  const parts = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    parts.push(rock(1.4 + rng.range(0, 1.4), mix(0xe8f2f8, 0xcbdde8, rng.next()), rng, {
      detail: Dt(1, ctx), jitter: 0.28, squash: 0.42,
    }));
    const g = parts[parts.length - 1];
    g.translate(rng.spread(2.2), 0, rng.spread(2.2));
  }
  return mergeFaceted(parts);
}

function bones(rng, pal, ctx = {}) {
  const parts = [];
  const bone = 0xd8d0bc;
  // Ribcage: an arc of tapering prisms.
  const ribs = rng.int(4, 7);
  for (let i = 0; i < ribs; i++) {
    const t = i / (ribs - 1);
    const g = prism(S(9, ctx), 0.11, 0.07, 1.6 + Math.sin(t * Math.PI) * 1.2, bone, { rng });
    g.rotateZ(lerp(-0.5, 0.5, t));
    g.translate(0, 0, -1.8 + t * 3.6);
    parts.push(g);
  }
  parts.push(prism(S(10, ctx), 0.22, 0.18, 4.0, shade(bone, 0.92), { rotY: 0, y: 0.2, rng })
    .rotateZ(Math.PI / 2));
  // A skull and a couple of scattered limbs turn an arc of sticks into a
  // carcass, which is the only reason this prop exists.
  if (ctx.fine === false) return mergeFaceted(parts);
  const skull = prism(S(12, ctx), 0.42, 0.30, 0.75, bone, { rng, variation: 0.06 });
  skull.rotateZ(Math.PI / 2);
  skull.translate(0, 0.42, 2.3);
  parts.push(skull);
  const snout = prism(S(10, ctx), 0.26, 0.16, 0.6, shade(bone, 0.88), { rng });
  snout.rotateZ(Math.PI / 2);
  snout.translate(0, 0.3, 2.85);
  parts.push(snout);
  for (const [dz, ang] of [[-2.3, 0.5], [-1.6, -0.9], [2.0, 1.2]]) {
    const g = prism(S(9, ctx), 0.13, 0.09, 1.5 + rng.range(0, 0.6), bone, { rng });
    // Lay it flat, then spin it in the ground plane. Adding the angle to the Z
    // rotation instead tips the bone out of horizontal and buries one end —
    // it sank 1.8 m under the map.
    g.rotateZ(Math.PI / 2);
    g.rotateY(ang);
    g.translate(rng.spread(0.8), 0.14, dz);
    parts.push(g);
    const knuckle = prism(S(8, ctx), 0.19, 0.19, 0.22, bone, { rng });
    knuckle.translate(rng.spread(0.8), 0.16, dz + 0.7);
    parts.push(knuckle);
  }
  return mergeFaceted(parts);
}

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------
//
// Built to be seen from four hundred metres through fog, which is a different
// job from everything above. All the work goes into the outline: setbacks,
// differing heights, a mast or two. Windows and trim exist only at the near
// detail level, and nothing out here is ever placed near enough to use it.

function building(rng, pal, ctx = {}) {
  const fine = ctx.fine !== false;
  const parts = [];
  const w = 9 + rng.range(0, 16);
  const d = 9 + rng.range(0, 14);
  const h = 14 + rng.range(0, 34);
  const wall = mix(pal.prop ?? 0x6a6258, 0x4a4e56, rng.next());

  // Two or three stacked masses. A single box is a box; a setback is a
  // building, and it costs twelve triangles.
  const stacks = rng.int(2, 3);
  let cw = w, cd = d, cy = 0;
  for (let i = 0; i < stacks; i++) {
    const sh = h * (i === 0 ? 0.55 : 0.45 / (stacks - 1));
    parts.push(boxOf(cw, sh, cd, shade(wall, 1 - i * 0.08), {
      y: cy + sh / 2, rng, variation: 0.05,
    }));
    cy += sh;
    cw *= rng.range(0.62, 0.86);
    cd *= rng.range(0.62, 0.86);
  }
  // Roof furniture: the thing that stops a skyline being a bar chart.
  parts.push(boxOf(cw * 0.5, 1.2, cd * 0.5, shade(wall, 0.8), { y: cy + 0.6, rng }));
  if (rng.bool(0.5)) {
    parts.push(prism(S(6, ctx), 0.22, 0.14, h * 0.28, 0x4a4e53, { y: cy + 1.2, rng }));
  }

  if (fine) {
    // Window bands, only ever built for the near level.
    const floors = Math.floor(h * 0.55 / 3.2);
    for (let f = 1; f < floors; f++) {
      for (const dz of [-d / 2 - 0.03, d / 2 + 0.03]) {
        parts.push(boxOf(w * 0.86, 1.5, 0.06, 0x1a2028, { y: f * 3.2, z: dz, rng }));
      }
      for (const dx of [-w / 2 - 0.03, w / 2 + 0.03]) {
        parts.push(boxOf(0.06, 1.5, d * 0.86, 0x1a2028, { x: dx, y: f * 3.2, rng }));
      }
    }
  }
  return mergeFaceted(parts);
}

function ridge(rng, pal, ctx = {}) {
  const parts = [];
  const n = rng.int(3, 5);
  let x = 0;
  for (let i = 0; i < n; i++) {
    const r = 9 + rng.range(0, 16);
    parts.push(rock(r, mix(pal.prop ?? 0x6a6258, 0x50565e, rng.next()), rng, {
      detail: Dt(1, ctx), jitter: 0.36, squash: rng.range(0.5, 0.95),
    }));
    // No bedding into the ground: `rock` already flattens its underside, so a
    // negative offset just buries up to six metres of geometry that then hangs
    // in the air the moment the terrain slopes away.
    parts[parts.length - 1].translate(x, 0, rng.spread(r * 0.7));
    x += r * rng.range(0.9, 1.4);
  }
  return mergeFaceted(parts);
}

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------
//
// Underground's street furniture. These sit close to the road because that is
// what a street circuit is — the walls are right there — so they are built at
// the near detail level far more often than the wasteland's scenery is.

function streetlight(rng, pal, ctx = {}) {
  const h = 8 + rng.range(0, 2.5);
  const parts = [
    prism(S(10, ctx), 0.19, 0.13, h, 0x33383f, { rng, variation: 0.05 }),
    prism(S(12, ctx), 0.32, 0.28, 0.35, 0x2a2e34, { rng }),
  ];
  // Curved boom, as three shortening segments.
  let x = 0, y = h;
  for (let i = 0; i < 3; i++) {
    const seg = boxOf(0.9, 0.13, 0.13, 0x33383f, { rng });
    seg.rotateZ(-0.30 - i * 0.22);
    seg.translate(x + 0.45, y - i * 0.06, 0);
    parts.push(seg);
    x += 0.85;
  }
  parts.push(boxOf(0.95, 0.16, 0.42, 0x3a4048, { x: x + 0.2, y: y - 0.42, rng }));
  return mergeFaceted(parts);
}

streetlight.glow = (rng, pal, ctx = {}) => mergeFaceted([
  boxOf(0.80, 0.07, 0.34, 0xfff3d2, { x: 2.75, y: 8.6, rng }),
]);

function trafficLight(rng, pal, ctx = {}) {
  const h = 5.4;
  const parts = [
    prism(S(10, ctx), 0.16, 0.12, h, 0x2b3037, { rng }),
    boxOf(2.6, 0.12, 0.12, 0x2b3037, { x: 1.3, y: h - 0.15, rng }),
    boxOf(0.42, 1.15, 0.34, 0x1d2127, { x: 2.35, y: h - 0.75, rng }),
  ];
  return mergeFaceted(parts);
}

trafficLight.glow = (rng, pal, ctx = {}) => {
  // One of the three lit, chosen per variant, so a junction is not a row of
  // identical greens.
  const which = rng.int(0, 2);
  const colours = [0xff3020, 0xffc020, 0x30ff70];
  return mergeFaceted([
    boxOf(0.20, 0.20, 0.06, colours[which], { x: 2.35, y: 5.4 - 0.35 - which * 0.33, z: 0.19 }),
  ]);
};

function neonSign(rng, pal, ctx = {}) {
  const h = 3.2 + rng.range(0, 2.4);
  const w = 1.1 + rng.range(0, 1.6);
  return mergeFaceted([
    prism(S(8, ctx), 0.13, 0.11, h, 0x24282e, { rng }),
    boxOf(w, h * 0.42, 0.16, 0x16191e, { y: h * 0.78, rng }),
  ]);
}

neonSign.glow = (rng, pal, ctx = {}) => {
  const h = 3.2 + rng.range(0, 2.4);
  const w = 1.1 + rng.range(0, 1.6);
  const hue = [0xff2e88, 0x2ee8ff, 0xa8ff3a, 0xff8a1e, 0xc46bff][rng.int(0, 4)];
  const parts = [boxOf(w * 0.86, h * 0.30, 0.06, hue, { y: h * 0.78, z: 0.10 })];
  // A bar under the sign, which is what actually paints the road below it.
  parts.push(boxOf(w * 0.94, 0.09, 0.09, hue, { y: h * 0.56, z: 0.08 }));
  return mergeFaceted(parts);
};

function jerseyBarrier(rng, pal, ctx = {}) {
  const l = 3.0;
  return mergeFaceted([
    boxOf(l, 0.30, 0.62, 0xb9b6ae, { y: 0.15, rng, variation: 0.05 }),
    boxOf(l, 0.44, 0.34, 0xc2bfb7, { y: 0.52, rng, variation: 0.05 }),
    boxOf(l, 0.14, 0.24, 0xa8a49c, { y: 0.81, rng, variation: 0.05 }),
  ]);
}

function dumpster(rng, pal, ctx = {}) {
  const c = [0x2f5f3a, 0x2a4a6b, 0x6b3a2a][rng.int(0, 2)];
  const parts = [
    boxOf(2.1, 1.15, 1.25, c, { y: 0.72, rng, variation: 0.08 }),
    boxOf(2.16, 0.10, 1.30, shade(c, 0.7), { y: 1.32, rng }),
  ];
  if (ctx.fine !== false) {
    for (const ix of [-1, 1]) {
      parts.push(prism(S(8, ctx), 0.16, 0.16, 0.14, 0x1a1d21, { rng })
        .rotateZ(Math.PI / 2));
      parts[parts.length - 1].translate(ix * 0.9, 0.16, 0.55);
      parts.push(boxOf(0.1, 0.28, 0.1, shade(c, 0.6), { x: ix * 1.0, y: 1.0, z: 0.6, rng }));
    }
  }
  return mergeFaceted(parts);
}

function palm(rng, pal, ctx = {}) {
  const h = 6 + rng.range(0, 4);
  const trunk = 0x5a4c3a;
  const parts = [];
  // Leaning trunk, in segments.
  const segs = ctx.fine === false ? 3 : 6;
  let lean = 0;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    lean += rng.spread(0.05);
    parts.push(prism(S(8, ctx), 0.26 - t * 0.12, 0.24 - t * 0.12, h / segs, trunk, {
      x: lean * h * 0.35, y: (h / segs) * i, rng, variation: 0.08,
    }));
  }
  const frondN = ctx.fine === false ? 5 : 9;
  for (let i = 0; i < frondN; i++) {
    const a = (i / frondN) * TAU;
    const f = boxOf(2.4, 0.08, 0.42, 0x2f5a34, { rng, variation: 0.14 });
    f.rotateZ(-0.42);
    f.rotateY(a);
    f.translate(lean * h * 0.35 + Math.cos(a) * 1.0, h - 0.2, Math.sin(a) * 1.0);
    parts.push(f);
  }
  return mergeFaceted(parts);
}

/**
 * A street frontage: one building in a continuous row.
 *
 * Built to be placed *against* the road rather than scattered near it. Local X
 * is depth into the block and local Z is width along the street, which is the
 * orientation `alignToTrack` produces — so a row of these laid end to end is a
 * wall, and the street becomes a canyon instead of a ribbon in a field.
 *
 * The scatter places them at a fixed setback, so the footprint has to be
 * predictable: depth and width are near-constant and the variety is in height,
 * colour and what is stuck on the front.
 */
const FACADE_W = 22;   // along the street
const FACADE_D = 30;   // into the block

function facade(rng, pal, ctx = {}) {
  const fine = ctx.fine !== false;
  const parts = [];
  const h = 12 + rng.range(0, 30);
  const wall = mix(pal.prop ?? 0x2a3038, 0x3a4048, rng.next());

  parts.push(boxOf(FACADE_D, h, FACADE_W, wall, {
    y: h / 2, rng, variation: 0.05,
  }));
  // A parapet, and a setback upper storey on the taller ones. Silhouette is
  // what separates a street from a row of identical boxes at this distance.
  parts.push(boxOf(FACADE_D + 0.6, 0.7, FACADE_W + 0.6, shade(wall, 0.8), {
    y: h + 0.35, rng,
  }));
  if (h > 26) {
    const uh = rng.range(4, 12);
    parts.push(boxOf(FACADE_D * 0.62, uh, FACADE_W * 0.66, shade(wall, 0.92), {
      y: h + uh / 2, rng, variation: 0.04,
    }));
  }
  // Ground floor: a darker plinth and a recessed shopfront facing the street.
  parts.push(boxOf(FACADE_D + 0.4, 4.2, FACADE_W + 0.4, shade(wall, 0.62), {
    y: 2.1, rng,
  }));

  if (fine) {
    // Window grid on the street face only — the other three are never seen.
    const floors = Math.floor((h - 5) / 3.4);
    const cols = 5;
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        if (rng.bool(0.12)) continue;
        parts.push(boxOf(0.25, 1.7, 1.5, 0x0d1219, {
          x: -FACADE_D / 2 - 0.1,
          y: 6.2 + f * 3.4,
          z: -FACADE_W * 0.38 + c * (FACADE_W * 0.76 / (cols - 1)),
          rng,
        }));
      }
    }
    // Shopfront glazing and a canopy over the pavement.
    parts.push(boxOf(0.3, 2.6, FACADE_W * 0.78, 0x11161f, {
      x: -FACADE_D / 2 - 0.15, y: 2.4, rng,
    }));
    parts.push(boxOf(1.6, 0.22, FACADE_W * 0.84, shade(wall, 0.5), {
      x: -FACADE_D / 2 - 0.8, y: 4.3, rng,
    }));
  }
  return mergeFaceted(parts);
}

/** Lit windows and a shop sign. Unlit pass — see `buildPropLibrary`. */
facade.glow = (rng, pal, ctx = {}) => {
  const h = 12 + rng.range(0, 30);
  const parts = [];
  const floors = Math.floor((h - 5) / 3.4);
  const cols = 5;
  const hue = [0xffd9a0, 0xfff4de, 0xcfe6ff][rng.int(0, 2)];
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      // Most windows are dark. A fully lit block reads as a lightbox, and it is
      // the scattering of lit ones that says people live here.
      if (!rng.bool(0.30)) continue;
      parts.push(boxOf(0.12, 1.5, 1.3, hue, {
        x: -FACADE_D / 2 - 0.22,
        y: 6.2 + f * 3.4,
        z: -FACADE_W * 0.38 + c * (FACADE_W * 0.76 / (cols - 1)),
      }));
    }
  }
  // The shop sign, which is what actually lights the pavement.
  const neon = [0xff2e88, 0x2ee8ff, 0xa8ff3a, 0xff8a1e, 0xc46bff][rng.int(0, 4)];
  parts.push(boxOf(0.16, 1.0, FACADE_W * 0.55, neon, {
    x: -FACADE_D / 2 - 0.35, y: 5.4,
  }));
  return mergeFaceted(parts);
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every prop type. `build(rng, pal, ctx)` returns one geometry variant.
 *
 * `radius`/`toughness` describe the collision the simulation runs. Toughness is
 * roughly the Impact needed to smash through instead of bouncing off, so a
 * Truck routes through a barrel stack that stops a Rocket — which is how Weight
 * and Impact come to decide navigation, as the design brief asks.
 */
export const PROP_TYPES = {
  tyre_stack: { build: tyreStack, place: TRACKSIDE, radius: 0.75, toughness: 60, height: 1.4 },
  barrel: { build: barrel, place: TRACKSIDE, radius: 0.5, toughness: 40, height: 1.1 },
  crate: { build: crate, place: TRACKSIDE, radius: 0.6, toughness: 55, height: 0.9 },
  marker: { build: markerBoard, place: TRACKSIDE, radius: 0.35, toughness: 25, height: 2.2 },

  gantry: { build: gantry, place: SCENERY, radius: 0, toughness: null, height: 6.5, spanning: true },
  grandstand: { build: grandstand, place: SCENERY, radius: 0, toughness: null, height: 6 },

  wreck: { build: wreck, place: TRACKSIDE, radius: 1.6, toughness: 190, height: 1.2 },
  shack: { build: shack, place: SCENERY, radius: 2.4, toughness: null, height: 3 },
  pole: {
    build: (r, p, c) => pole(r, p, r.bool(0.4), c),
    place: SCENERY, radius: 0.3, toughness: null, height: 8,
  },
  dead_tree: { build: deadTree, place: SCENERY, radius: 0.4, toughness: 140, height: 5 },
  rock: {
    build: (r, p, c) => rock(1.1 + r.range(0, 1.8), mix(p.prop, 0x6a6258, r.next()), r,
      { detail: Dt(1, c) }),
    place: TRACKSIDE, radius: 1.3, toughness: null, height: 1.6,
  },
  boulder: {
    build: (r, p, c) => rock(2.6 + r.range(0, 2.2), mix(p.prop, 0x585048, r.next()), r,
      { detail: Dt(2, c) }),
    place: SCENERY, radius: 3.0, toughness: null, height: 3.4,
  },

  pine: { build: pine, place: SCENERY, radius: 0.6, toughness: 150, height: 9 },
  ice_block: { build: iceBlock, place: TRACKSIDE, radius: 1.2, toughness: 80, height: 1.8 },
  snow_bank: { build: snowBank, place: SCENERY, radius: 2.2, toughness: null, height: 1.2 },

  cactus: { build: cactus, place: TRACKSIDE, radius: 0.45, toughness: 35, height: 4 },
  bones: { build: bones, place: SCENERY, radius: 1.8, toughness: null, height: 1.4 },

  container: { build: container, place: TRACKSIDE, radius: 3.1, toughness: 320, height: 2.6 },
  crane: { build: crane, place: SCENERY, radius: 1.6, toughness: null, height: 20 },
  pipes: { build: pipes, place: SCENERY, radius: 1.0, toughness: null, height: 2.5 },

  spire: { build: spire, place: SCENERY, radius: 1.6, toughness: null, height: 14 },
  streetlight: {
    build: streetlight, glow: streetlight.glow,
    place: TRACKSIDE, radius: 0.3, toughness: null, height: 9,
  },
  traffic_light: {
    build: trafficLight, glow: trafficLight.glow,
    place: TRACKSIDE, radius: 0.25, toughness: null, height: 5.4,
  },
  neon_sign: {
    build: neonSign, glow: neonSign.glow,
    place: TRACKSIDE, radius: 0.3, toughness: null, height: 5,
  },
  jersey_barrier: {
    build: jerseyBarrier, place: TRACKSIDE, radius: 1.6, toughness: 260, height: 1,
  },
  dumpster: { build: dumpster, place: TRACKSIDE, radius: 1.2, toughness: 90, height: 1.4 },
  palm: { build: palm, place: SCENERY, radius: 0.4, toughness: 120, height: 9 },

  facade: {
    build: facade, glow: facade.glow,
    place: SCENERY, radius: 0, toughness: null, height: 42,
    frontage: { width: FACADE_W, depth: FACADE_D },
  },

  building: { build: building, place: SCENERY, radius: 0, toughness: null, height: 40, horizon: true },
  ridge: { build: ridge, place: SCENERY, radius: 0, toughness: null, height: 22, horizon: true },

  brazier: { build: brazier, place: TRACKSIDE, radius: 0.9, toughness: 90, height: 2.2, emissive: 0xff5a1e },
};

/** Which types each biome uses, and how heavily. */
export const BIOME_PROPS = {
  wasteland: {
    trackside: { barrel: 3, tyre_stack: 3, crate: 2, wreck: 2, marker: 3, rock: 2 },
    scenery: { pole: 3, dead_tree: 2, shack: 2, boulder: 1, grandstand: 0.5 },
    horizon: { building: 2, ridge: 2, crane: 1 },
  },
  industrial: {
    trackside: { container: 3, barrel: 3, crate: 3, tyre_stack: 2, marker: 3 },
    scenery: { crane: 2, pipes: 3, pole: 3, shack: 1, grandstand: 0.8 },
    horizon: { building: 4, crane: 2, ridge: 1 },
  },
  desert: {
    trackside: { rock: 3, cactus: 3, barrel: 1, marker: 3 },
    scenery: { boulder: 3, bones: 2, dead_tree: 1, pole: 1 },
    horizon: { ridge: 4, building: 1 },
  },
  frozen: {
    trackside: { ice_block: 3, tyre_stack: 2, marker: 3, barrel: 1 },
    scenery: { pine: 4, snow_bank: 3, pole: 2, shack: 1 },
    horizon: { ridge: 3, building: 1 },
  },
  downtown: {
    trackside: {
      streetlight: 4, neon_sign: 3, traffic_light: 2,
      jersey_barrier: 3, dumpster: 2, marker: 1,
    },
    scenery: { building: 4, palm: 2, pole: 1, shack: 1 },
    horizon: { building: 5, crane: 1 },
  },

  inferno: {
    trackside: { brazier: 3, rock: 2, barrel: 2, marker: 2 },
    scenery: { spire: 3, bones: 2, boulder: 2 },
    horizon: { ridge: 3, spire: 2 },
  },
};

const VARIANTS = 3;

/**
 * Build the geometry variants and shared material for every type a biome uses.
 * Called once per race.
 */
export function buildPropLibrary(biome, seed = 1) {
  const pal = biome.palette;
  const spec = BIOME_PROPS[biome.id] || BIOME_PROPS.wasteland;
  const used = new Set([
    ...Object.keys(spec.trackside), ...Object.keys(spec.scenery),
    ...Object.keys(spec.horizon ?? {}),
    'gantry',
  ]);
  // Frontages are placed by a dedicated pass rather than drawn from a weighted
  // table, so they have to be asked for explicitly.
  if (biome.city) used.add('facade');

  const library = {};
  let totalTris = 0;

  for (const name of used) {
    const def = PROP_TYPES[name];
    if (!def) continue;
    // One set of variants per detail level. Variety is worth paying for close
    // up and worth nothing at the horizon, so the far levels get a single
    // variant: at that range the difference between three silhouettes and one
    // is not visible, and three buckets is three draw calls.
    const levels = LODS.map((lod) => {
      const rng = new RNG(`${seed}:prop:${name}`);
      const count = def.spanning ? 1 : (lod.id === 0 ? VARIANTS : lod.id === 1 ? 2 : 1);
      const variants = [];
      for (let v = 0; v < count; v++) {
        const geo = def.build(rng, pal, { biome, sides: lod.sides, fine: lod.fine });
        if (geo) {
          variants.push(geo);
          totalTris += triCount(geo);
        }
      }
      return variants;
    });
    if (levels[0].length === 0) continue;

    // Optional second geometry, drawn unlit.
    //
    // A lamp head that responds to scene lighting is not a lamp, it is pale
    // paint — and at night that is the difference between a street that reads
    // as lit and one that reads as grey. Built per level like the body so a
    // distant sign is still a glow without being a modelled sign.
    const glowLevels = def.glow ? LODS.map((lod) => {
      const rng = new RNG(`${seed}:glow:${name}`);
      const count = lod.id === 0 ? VARIANTS : lod.id === 1 ? 2 : 1;
      const out = [];
      for (let v = 0; v < count; v++) {
        const g = def.glow(rng, pal, { biome, sides: lod.sides, fine: lod.fine });
        if (g) out.push(g);
      }
      return out;
    }) : null;

    library[name] = {
      def,
      levels,
      glowLevels,
      variants: levels[0],
      material: facetedMaterial({
        roughness: name === 'ice_block' ? 0.25 : 0.86,
        metalness: name === 'container' || name === 'crane' ? 0.25 : 0.04,
      }),
    };
  }

  library.__stats = { types: Object.keys(library).length, tris: totalTris };
  return library;
}

export function disposePropLibrary(library) {
  for (const [name, entry] of Object.entries(library)) {
    if (name.startsWith('__')) continue;
    if (entry.levels) {
      for (const level of entry.levels) for (const g of level) g.dispose();
      if (entry.glowLevels) for (const level of entry.glowLevels) for (const g of level) g.dispose();
      entry.material?.dispose();
      continue;
    }
    for (const g of entry.variants) g.dispose();
    entry.material.dispose();
  }
}
