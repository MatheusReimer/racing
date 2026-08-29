import * as THREE from 'three';
import { HULLS } from '../data/bodies/index.js';
import { clamp, clamp01, lerp, wrapAngle, angleDelta } from '../core/math.js';

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
export function visualProfile(stats, tags = new Set(), vehicleDef = {}, look = null) {
  const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
  return {
    bulk: norm(stats.weight, 60, 260),
    speed: norm(stats.topSpeed, 70, 260),
    armor: norm(stats.armor, 80, 300),
    ram: norm(stats.impact, 80, 280),
    tags,
    // The player's kit, where they have one. Overrides rather than defaults:
    // "factory" is a real choice, and it has to stay distinguishable from a
    // paint that happens to match the car it is on.
    baseColor: look?.baseColor ?? vehicleDef.color ?? '#c8452e',
    accentColor: look?.accentColor ?? vehicleDef.accent ?? '#ffb238',
    rimTint: look?.rimTint ?? null,
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

/**
 * Build a car from a hull traced off a real one by tools/lowpoly.mjs.
 *
 * Same stitch-and-cap as `loft`, and deliberately so: what changes is only
 * where a ring's points come from. `loft` evaluates a squircle, which is how
 * you draw a car nobody has ever seen; this reads the radii measured off one
 * that exists. The topology either way is a quad strip between consecutive
 * rings, so everything downstream — flat shading, merging, the shadow pass —
 * cannot tell the difference.
 *
 * The hull arrives in metres with the road at `ground` and the nose at +Z. It
 * is scaled onto the L and W the build asked for, with height following length
 * so a wide build widens the car instead of flattening it.
 */
// What each surface class from tools/decimate.mjs is painted as.
//
// The body file says where the windows and the bumpers are; this says what
// those look like in this game. Keeping the two apart is what lets six cars
// taken off six references still read as one grid: the paint class takes
// whatever colour the vehicle picked, and everything else is shared furniture.
// Not a dark blue-grey shaded like paint, which is what it was: a car's glass
// is the darkest thing on it from outside in almost any light, and the way to
// draw that is to stop asking the lighting. Near black, with just enough blue
// left in it to read as glass rather than as a hole.
const HULL_GLASS = 0x070a0f;

// --- damage ---------------------------------------------------------------
//
// Three states, and thresholds you can name. A bar sliding down is a number;
// "it lost a wing at half" is something you remember about a run.
//
// The fractions below are of remaining durability, so they read the way the
// player says them: knocked about at three quarters, in trouble at a half,
// wrecked at nothing.
// `paint` is the share of the bodywork that has stopped being paint. Calibrated
// by rendering the four side by side (`node tools/garage.mjs damage`) rather
// than by picking round numbers: at 0.48 the half-health car was already mostly
// bare metal, which is what a wreck should look like and not what half is.
// `paint` is the share of the bodywork that has stopped being paint. `bonnet`
// and `bumper` are radians: how far the panel has come away from the car, and
// zero means it has not. `smoke` is a rate the FX layer scales its emitter by.
// Three quarters is cosmetic — scuffed paint, a dimmed lamp — and nothing has
// come off yet, because a grey panel hanging off a car that has merely been
// scraped reads as a part someone bolted on. Panels start leaving at a half.
export const DAMAGE_STATES = [
  { at: 1.00, paint: 0.00, lamps: 1.00, bonnet: 0.00, bumper: 0.00, smoke: 0.0 },
  { at: 0.75, paint: 0.13, lamps: 0.72, bonnet: 0.00, bumper: 0.00, smoke: 0.0 },
  { at: 0.50, paint: 0.31, lamps: 0.34, bonnet: 0.17, bumper: 0.20, smoke: 0.5 },
  { at: 0.00, paint: 0.64, lamps: 0.00, bonnet: 0.34, bumper: 0.38, smoke: 1.0 },
];

// Bare metal under lost paint, and the scorch around the worst of it.
const HULL_PRIMER = 0x6b6560;
const HULL_SCORCH = 0x322d29;
// A torn panel shows its back, which never saw paint or daylight.
const HULL_TORN = 0x494440;
// What is behind a window. Not pure black — a cabin has a little light in it,
// and pure black against near-black glass makes the glass disappear.
const HULL_CABIN = 0x0b0e13;

// What paint turns into where the light does not reach it.
//
// Not simply darker. A shaded panel is lit by the sky rather than by the sun,
// so it goes cooler and loses a little saturation — and a car whose shadowed
// side is the same hue at half brightness is the clearest tell of a moulded toy.
//
// Derived from the car's own colour, not mixed toward one shade for every car.
// A fixed cool navy is invisible on a blue car and turns a red one the colour
// of cooked salmon, which is exactly the "melted plastic" some of the roster
// had and the rest did not — the ones whose paint was nowhere near the shade
// colour got wrecked by it and the ones near it did not.
const SHADOW_DARKEN = 0.62;      // of its own lightness
const SHADOW_DESATURATE = 0.82;  // of its own saturation
const SHADOW_HUE_SHIFT = 0.02;   // a nudge toward blue, in turns

/** The colour a surface takes on where the sky is all that reaches it. */
function shadeOf(colour) {
  const hsl = { h: 0, s: 0, l: 0 };
  colour.getHSL(hsl);
  return new THREE.Color().setHSL(
    (hsl.h + SHADOW_HUE_SHIFT) % 1,
    hsl.s * SHADOW_DESATURATE,
    hsl.l * SHADOW_DARKEN,
  );
}

/** Which of the four states a remaining-durability fraction is in. */
export function damageLevel(healthFrac) {
  const h = Number.isFinite(healthFrac) ? healthFrac : 1;
  for (let i = DAMAGE_STATES.length - 1; i > 0; i--) {
    if (h <= DAMAGE_STATES[i].at) return i;
  }
  return 0;
}
const HULL_DARK = 0x15181c;
const HULL_CHROME = 0xb9bec6;
// Lamp colours.
//
// A headlight has to be the brightest thing on the car or it is not a light.
// These are drawn unlit and `toneMapped: false`, so their value is clamped at
// one — while the bodywork goes through ACES and a white car lands just under
// it. That leaves a lamp no headroom at all to be brighter than the paint
// beside it, and at that point its warmth stops reading as warm light and
// starts reading as dirt: 0xfff0cc has its blue at eighty per cent, which
// against white paint is visibly tan, and on the pale cars it looked like
// masking tape over the lenses.
//
// Still warm, because a cold headlight reads as a highlight on paint — but
// warm by a fifth of what it was, which is the difference between a lamp and
// a stain.
const LAMP_HEAD = 0xfff6e8;
const LAMP_TAIL = 0x5a0f0a;      // running: present, not shouting
const LAMP_BRAKE = 0xff2a18;
const LAMP_REVERSE = 0xeef2ff;

/**
 * A *rear* lamp for a car whose reference never said where its lamps were.
 *
 * Rear only, and that is the whole of the justification. A car with no brake
 * light is worse than a car with an approximate one — it is the single thing
 * the driver behind you reads, and `LAMP_BRAKE` is live: a rival lifting off
 * ahead of you is information the game actually gives.
 *
 * There is no such argument at the front, and the front is where this did its
 * damage. Nobody reads your headlights from behind you, and the references
 * already draw whatever headlight the car has: the 205's are part of its front
 * panel, and the MX-5's are pop-ups the model has *raised*. Fitting a second
 * pair to the nose put two cream rectangles on the paint of a car that already
 * had headlights, and on a white or a yellow car that patch was the first
 * thing you saw. So the front is left to the reference, and if the reference
 * did not mark a lamp there, none is drawn.
 *
 * The patch is a *fitted mesh*, not a rectangle.
 *
 * It used to be one flat quad spanning the outboard third of the car's width,
 * pushed to the depth the bodywork reached anywhere across it. That cannot fit
 * a car: a nose and a tail are curved across exactly that span, so the quad
 * touched the panel at its foremost point and stood off it everywhere else —
 * on the roadster and the rally car the corners hung clear of the bumper and
 * read as two loose rectangles floating beside it, at both ends.
 *
 * So the patch is subdivided and every node is dropped onto the hull's own
 * surface: one pass over the reference builds the forward-most depth at each
 * node, and the mesh takes those depths. It follows the curvature because it
 * is made of the curvature. Nodes the bodywork never reaches have no depth,
 * and the quads around them are simply not emitted — which is what stops a
 * lamp wrapping around a corner that is not there.
 */
function synthLamps(hull) {
  const { positions, indices } = hull;
  const sign = -1;
  const endZ = sign * hull.length * 0.5;
  const band = hull.length * 0.14;

  // The tail panel, as faces rather than as points.
  //
  // Depth used to be the rearmost point of the *whole car* at each (x, y):
  // near a corner that is sometimes the tail panel and sometimes something
  // half a metre further forward, and the quads joined those two answers into
  // a zigzag that cut through the paint and poked out the other side. A lamp
  // sits on the panel that faces the way it shines, so only faces that
  // actually face that way get a say.
  const faces = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    if (Math.abs(cz - endZ) > band) continue;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nz = ux * vy - uy * vx;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    // Facing out of the back. Winding is not reliable across the references, so
    // the test is on the axis alone and either direction counts.
    if (Math.abs(nz / len) < 0.55) continue;
    faces.push([
      (positions[a] + positions[b] + positions[c]) / 3,
      (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
      cz,
    ]);
  }
  // Too little tail panel to sit a lamp on. Better nothing than a decal on the
  // paint: this is only worth having when it can lie flat.
  if (faces.length < 40) return null;

  let x1 = 0;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const f of faces) {
    x1 = Math.max(x1, Math.abs(f[0]));
    y0 = Math.min(y0, f[1]);
    y1 = Math.max(y1, f[1]);
  }
  if (!Number.isFinite(y0) || x1 <= 0) return null;

  // Where a lamp goes: outboard, in the band between a third and two thirds of
  // the way up the tail. Measured against the tail panel now, not against the
  // whole rear of the car — the old bound reached forward to the wheel arches,
  // so the outboard edge was past the corner and the patch ran off into air.
  // 0.40 to 0.62, which is where a tail light is and, measured, where the tail
  // panel is flattest: across the two references that need this the plane fits
  // to 16-23 mm rms there, against 26-29 mm a band lower and 84 mm a band
  // higher, where it starts climbing the boot lid.
  const loY = y0 + (y1 - y0) * 0.40;
  const hiY = y0 + (y1 - y0) * 0.62;
  const inX = x1 * 0.42;
  const outX = x1 * 0.88;

  // A hair proud, no more. What keeps the panel from drawing over the top of
  // this is the polygon offset on the lamp material, not distance.
  const LIFT = 0.004;
  // How far the panel may depart from flat before it is not a place to put a
  // lamp — as *rms*, not as the worst sample.
  //
  // The worst is the wrong question and gating on it rejected every car: a
  // panel that fits to 20 mm rms still has half a dozen faces 60 mm out where
  // it turns the corner into the bumper, and those are not what the lamp sits
  // on. 30 mm rms passes the two references that need a lamp fitted and would
  // reject a boot lid.
  const MAX_RMS = 0.030;

  const out = [];
  for (const side of [-1, 1]) {
    // The samples under this lamp, in the lamp's own frame.
    const pick = [];
    for (const f of faces) {
      const px = f[0] * side;
      if (px < inX || px > outX) continue;
      if (f[1] < loY || f[1] > hiY) continue;
      pick.push([px, f[1], f[2] * sign]);
    }
    // A lamp needs a panel under most of it, not a corner of one.
    if (pick.length < 12) continue;

    // Least squares z = a + b*x + c*y over those samples.
    //
    // A plane, not a depth per node. Fitting each node its own depth is what
    // made these come out as blobs: the shape stopped being a lamp and became
    // a drawing of which grid nodes happened to catch a vertex. A tail light
    // is a rectangle on a panel, so the panel is what gets measured and the
    // rectangle is what gets drawn.
    let n = 0;
    let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    for (const [px, py, pz] of pick) {
      n++; sx += px; sy += py; sz += pz;
      sxx += px * px; sxy += px * py; syy += py * py;
      sxz += px * pz; syz += py * pz;
    }
    // Solve the 3x3 normal equations by Cramer's rule.
    const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
    const rhs = [sz, sxz, syz];
    const det3 = (q) => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1])
      - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0])
      + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
    const D = det3(m);
    if (Math.abs(D) < 1e-12) continue;
    const sub = (col) => m.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)));
    const A = det3(sub(0)) / D;
    const B = det3(sub(1)) / D;
    const C = det3(sub(2)) / D;

    // Does the panel actually lie on that plane?
    let sq = 0;
    for (const [px, py, pz] of pick) {
      const e = pz - (A + B * px + C * py);
      sq += e * e;
    }
    if (Math.sqrt(sq / pick.length) > MAX_RMS) continue;

    // Stand the plane off the panel's high points.
    //
    // The mean plane runs *through* the surface by definition, so half the
    // bodywork under a lamp sitting on it is in front of it — and the panel
    // drew over the middle of the lens, which came out as a rectangle with a
    // bite taken out. The lamp is lifted to clear all but the highest few
    // per cent: clearing the single worst face would stand it off by as much
    // as the panel's worst fold, which is a lens floating on stalks.
    const above = pick
      .map(([px, py, pz]) => pz - (A + B * px + C * py))
      .sort((u, v) => u - v);
    const clear = Math.max(0, above[Math.floor(above.length * 0.95)] ?? 0);

    // A rectangle on the plane, two quads across so it still shades.
    const zAt = (px, py) => (A + B * px + C * py + clear + LIFT) * sign;
    const GX = 2;
    const GY = 1;
    for (let gy = 0; gy < GY; gy++) {
      for (let gx = 0; gx < GX; gx++) {
        const px0 = inX + ((outX - inX) * gx) / GX;
        const px1 = inX + ((outX - inX) * (gx + 1)) / GX;
        const py0 = loY + ((hiY - loY) * gy) / GY;
        const py1 = loY + ((hiY - loY) * (gy + 1)) / GY;
        const a = [side * px0, py0, zAt(px0, py0)];
        const b = [side * px1, py0, zAt(px1, py0)];
        const c = [side * px1, py1, zAt(px1, py1)];
        const d = [side * px0, py1, zAt(px0, py1)];
        // Wound so the lamp faces out of the end it is on.
        const quad = (side * sign > 0) ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
        for (const q of quad) out.push(q[0], q[1] - hull.ground, q[2]);
      }
    }
  }
  return out.length ? out : null;
}

/**
 * The de-indexed hull, built once per reference and shared by every car that
 * uses it.
 *
 * Splitting fifty thousand indexed triangles into a hundred and fifty thousand
 * loose vertices, and computing a normal for each, is fifteen milliseconds —
 * the largest single cost in building a car, and it was paid again for every
 * car on the grid even though they are all the same shape. Positions and
 * normals do not depend on the paint or on how big the build made the car, so
 * they are cut once and every instance points at the same buffers: Three
 * uploads an attribute per attribute object, so sharing the object shares the
 * GPU memory too.
 *
 * Size is applied as a scale on the node, not baked into the vertices, which is
 * what lets the same buffers serve a car the build stretched and one it did
 * not. Only the colours are per car, and filling a colour array is a tenth of
 * the work of cutting the mesh.
 */
const hullCache = new WeakMap();

/**
 * Make the two halves of a car agree about what each face is.
 *
 * A car is symmetric. Cut it down the middle and the two halves are the same
 * car — so if a face on the left is a lamp and the face mirroring it is paint,
 * one of the two is wrong. That is not a guess about a particular reference; it
 * is true of every car there has ever been, which makes it the one rule strong
 * enough to clean noise up without knowing what any of it is.
 *
 * And measured, that noise is exactly where the complaints are. Mirrored faces
 * that disagree, per reference: 0.1% on the Quattro and 0.2% on the Impreza,
 * the two nobody has ever complained about — against 10% on the RX-7, whose
 * headlight has orange pixels cut through it, and 18% on the Beetle. The
 * biggest single disagreement on the RX-7 is 811 faces of paint facing lamp,
 * which *is* the orange in the headlight.
 *
 * Only disagreements are touched. A despeckle by neighbourhood was the first
 * attempt and it reassigned nine hundred faces on the Quattro — a car with
 * nothing wrong with it — because a local majority does not care whether the
 * car was already right. Pairing first means a symmetric car comes out
 * untouched, which is the only safe way to run this over every reference.
 *
 * Which side wins is decided by the surface around the pair, counting both
 * halves: a lone lamp face in the middle of a wing loses to the wing.
 */
export function symmetriseClasses(hull) {
  const { positions, indices, classes } = hull;
  const n = classes.length;

  // How close a face has to be to its mirror to count as its mirror, and how
  // far to look for the local opinion. Both in metres, and both a good deal
  // smaller than any feature on a car.
  const PAIR = 0.06;
  const VOTE = 0.05;

  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const cz = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      x += positions[v]; y += positions[v + 1]; z += positions[v + 2];
    }
    cx[t] = x / 3; cy[t] = y / 3; cz[t] = z / 3;
  }

  // A grid over the *folded* car — |x| — so a face and its mirror land in the
  // same cell and the pairing is a local lookup rather than a search.
  const bins = new Map();
  for (let t = 0; t < n; t++) {
    const k = `${Math.floor(Math.abs(cx[t]) / PAIR)},${Math.floor(cy[t] / PAIR)},${Math.floor(cz[t] / PAIR)}`;
    let a = bins.get(k);
    if (!a) { a = []; bins.set(k, a); }
    a.push(t);
  }

  const out = Uint8Array.from(classes);
  const tally = new Int32Array(6);
  for (let t = 0; t < n; t++) {
    if (cx[t] < 0) continue;
    const gx = Math.floor(cx[t] / PAIR);
    const gy = Math.floor(cy[t] / PAIR);
    const gz = Math.floor(cz[t] / PAIR);
    let best = -1;
    let bd = PAIR * PAIR;
    tally.fill(0);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = bins.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!list) continue;
          for (const u of list) {
            const ddx = Math.abs(cx[u]) - cx[t];
            const ddy = cy[u] - cy[t];
            const ddz = cz[u] - cz[t];
            const d = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d <= VOTE * VOTE) tally[classes[u]]++;
            if (cx[u] < 0 && d < bd) { bd = d; best = u; }
          }
        }
      }
    }
    if (best < 0) continue;
    const a = classes[t];
    const b = classes[best];
    if (a === b) continue;
    // Between a lens and a reflector, the lens wins, whatever the local count
    // says. That is a fact about cars rather than a thumb on the scale: what
    // you see of a headlight from outside it is its cover. Letting the vote
    // decide put the S15's reflector in front of its own lens on both sides at
    // once — symmetric, and a row of cream teeth in a black light.
    //
    // A tie otherwise goes to the lower class id, which is arbitrary but
    // stable: the same reference has to give the same car every load.
    const lens = (a === 1 && b === 4) || (a === 4 && b === 1);
    const win = lens ? 1
      : (tally[a] === tally[b] ? Math.min(a, b) : (tally[a] > tally[b] ? a : b));
    out[t] = win;
    out[best] = win;
  }

  return out;
}

function hullShared(hull) {
  const cached = hullCache.get(hull);
  if (cached) return cached;
  const { positions, indices } = hull;
  const classes = symmetriseClasses(hull);
  const n = classes.length;

  const CENTRE_BIAS = 0.02;
  const bodyIdx = [];
  // Kept alongside, because the greenhouse rule below removes faces from the
  // body and the two have to stay in step: rebuilt separately, every remaining
  // face would come back as paint and the car would lose its trim.
  const bodyCls = [];
  const glassIdx = [];
  const front = [];
  const rear = [];
  for (let t = 0; t < n; t++) {
    const p0 = indices[t * 3];
    const p1 = indices[t * 3 + 1];
    const p2 = indices[t * 3 + 2];
    const midZ = (positions[p0 * 3 + 2] + positions[p1 * 3 + 2] + positions[p2 * 3 + 2]) / 3;
    if (classes[t] === 4) (midZ > hull.length * CENTRE_BIAS ? front : rear).push(p0, p1, p2);
    // Glass leaves the body.
    //
    // Painted into the body mesh it is shaded like the panel beside it, so it
    // catches the same highlight and reads as grey paint rather than as a
    // window. A car's glass is the darkest thing on it from outside in almost
    // any light, and the only reliable way to draw that is to stop asking the
    // lighting.
    else if (classes[t] === 1) glassIdx.push(p0, p1, p2);
    else { bodyIdx.push(p0, p1, p2); bodyCls.push(classes[t]); }
  }

  const cut = (idx) => {
    const a = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      a[i * 3] = positions[v];
      a[i * 3 + 1] = positions[v + 1] - hull.ground;
      a[i * 3 + 2] = positions[v + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    g.computeVertexNormals();
    return g;
  };

  const bodyGeo = cut(bodyIdx);
  const shared = {
    glass: glassIdx.length ? cut(glassIdx) : null,
    // The class of each surviving triangle, in the order they were cut, so a
    // per-car colour array can be filled without walking the hull again.
    bodyClasses: null,
    position: bodyGeo.getAttribute('position'),
    normal: bodyGeo.getAttribute('normal'),
    lampFront: null,
    lampRear: null,
  };
  // How many faces a reference has to mark before they count as a lamp rather
  // than as a stray transparent trim piece.
  const MIN_FACES = 24;
  const loose = (arr) => {
    if (!arr) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    g.computeVertexNormals();
    return g;
  };
  // A car with no glass at all.
  //
  // The GC8's eighty-six materials never say "window", so its cabin came out
  // painted the same colour as its wings — a saloon with the windows filled in.
  // Where the reference is silent the greenhouse is found by where it has to
  // be: the band of the body between the beltline and just under the roof,
  // inboard of the widest point, across the middle of the car. It is a coarse
  // rule and it is far better than bodywork where the windscreen goes.
  // Enough of it to be a greenhouse, not merely some.
  //
  // The FD's materials do name a transparent one, and it is the tail lamp
  // lens: seventy square centimetres at the back of the car, which satisfied
  // "has glass" and left the windscreen and every side window painted the same
  // colour as the wings. A car's greenhouse is two to five square metres, so
  // the question the synthesis should ask is how much, not whether.
  const GREENHOUSE_MIN = 1.2;   // m^2
  if (shared.glass && surfaceArea(shared.glass) < GREENHOUSE_MIN) {
    // What was found is real glazing, just not the windows — a lens, a sunroof
    // trim. Kept, and the greenhouse built alongside it.
    shared.strayGlass = shared.glass;
    shared.glass = null;
  }
  if (!shared.glass) {
    const bb = { y0: Infinity, y1: -Infinity, x: 0 };
    for (let i = 0; i < positions.length; i += 3) {
      bb.y0 = Math.min(bb.y0, positions[i + 1]);
      bb.y1 = Math.max(bb.y1, positions[i + 1]);
      bb.x = Math.max(bb.x, Math.abs(positions[i]));
    }
    const loY = bb.y0 + (bb.y1 - bb.y0) * 0.68;
    const hiY = bb.y0 + (bb.y1 - bb.y0) * 0.93;
    const keep = [];
    const rest = [];
    const removed = [];
    for (let t = 0; t < bodyIdx.length; t += 3) {
      // By the face's centre, not by all three of its corners.
      //
      // Requiring every corner to be inside leaves anything straddling the
      // edge painted, and a boundary made of the faces that half-qualify is a
      // row of white teeth down the middle of the window. The centre either is
      // in the greenhouse or is not.
      let cy = 0;
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < 3; k++) {
        const v = bodyIdx[t + k] * 3;
        cx += Math.abs(positions[v]);
        cy += positions[v + 1];
        cz += positions[v + 2];
      }
      cx /= 3; cy /= 3; cz /= 3;
      // 0.36 of the length, not 0.28. A windscreen's base runs further
      // forward than that, so the tighter band cut across it and left the
      // bottom of the screen painted.
      const inBand = cy >= loY && cy <= hiY
        && cx <= bb.x * 0.90 && Math.abs(cz) <= hull.length * 0.36;
      removed.push(inBand);
    }

    smoothRegion(bodyIdx, positions, removed);

    for (let t = 0, f = 0; t < bodyIdx.length; t += 3, f++) {
      (removed[f] ? keep : rest).push(bodyIdx[t], bodyIdx[t + 1], bodyIdx[t + 2]);
    }
    if (keep.length / 3 > 40) {
      shared.glass = cut(keep);
      const reCls = [];
      for (let t = 0, f = 0; t < bodyIdx.length; t += 3, f++) {
        if (!removed[f]) reCls.push(bodyCls[f]);
      }
      bodyIdx.length = 0;
      for (const v of rest) bodyIdx.push(v);
      const re = cut(bodyIdx);
      shared.position = re.getAttribute('position');
      shared.normal = re.getAttribute('normal');
      shared.bodyClasses = Uint8Array.from(reCls);
    }
  }

  if (shared.strayGlass) {
    shared.glass = shared.glass
      ? mergeGeometries([shared.glass, shared.strayGlass]) : shared.strayGlass;
    shared.strayGlass = null;
  }

  if (!shared.bodyClasses) shared.bodyClasses = Uint8Array.from(bodyCls);
  shared.damageRank = damageRanks(shared, hull);
  shared.ao = bakeCavity(shared);
  shared.bounds = hullBounds(shared);

  // Where the reference marked too few faces to be a lamp, fit a pair to the
  // bodywork. Built at native size like everything else here, because the node
  // carries the scale now.
  shared.lampFront = front.length / 3 >= MIN_FACES ? cut(front) : null;
  const markedRear = rear.length / 3 >= MIN_FACES;
  shared.lampRear = markedRear ? cut(rear) : loose(synthLamps(hull));
  // Which of them is a decal lying on the paint rather than geometry the
  // reference put where it belongs. Only a decal needs the depth bias, and the
  // bias is what made the reference lamps ragged.
  shared.lampRearFitted = !markedRear;
  hullCache.set(hull, shared);
  return shared;
}

/**
 * Tidy a region that was chosen by a plane, so it follows the surface instead.
 *
 * The greenhouse is picked by testing whether a face's centre falls inside a
 * box. A box is not the shape of a window, so the boundary comes out as a row
 * of teeth: long thin triangles the decimator left along a pillar stab into
 * the glass, and faces whose centres fell a centimetre outside stay painted in
 * the middle of a windscreen. Both were plainly visible on the two cars whose
 * references never named their glass — orange spikes across the screen.
 *
 * The fix is not a better box. Each face is made to agree with its neighbours:
 * a face surrounded by glass becomes glass, a lone piece of glass in the
 * bodywork goes back to being bodywork. Three passes, which is enough to close
 * a one- or two-face spike and not enough to eat a real pillar.
 */
function smoothRegion(idx, positions, flags) {
  const faces = flags.length;
  if (!faces) return;

  // Faces that share an edge, found by welding on position rather than on
  // index — the buffer is de-indexed, so two faces along a seam do not share a
  // vertex number even where they share a corner.
  const key = (i) => {
    const o = i * 3;
    return `${Math.round(positions[o] * 400)},${Math.round(positions[o + 1] * 400)},`
      + `${Math.round(positions[o + 2] * 400)}`;
  };
  const edges = new Map();
  for (let f = 0; f < faces; f++) {
    const a = key(idx[f * 3]);
    const b = key(idx[f * 3 + 1]);
    const c = key(idx[f * 3 + 2]);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const e = u < v ? `${u}|${v}` : `${v}|${u}`;
      let list = edges.get(e);
      if (!list) { list = []; edges.set(e, list); }
      list.push(f);
    }
  }
  const neighbours = Array.from({ length: faces }, () => []);
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    neighbours[list[0]].push(list[1]);
    neighbours[list[1]].push(list[0]);
  }

  for (let pass = 0; pass < 3; pass++) {
    const next = flags.slice();
    for (let f = 0; f < faces; f++) {
      const near = neighbours[f];
      if (near.length < 2) continue;
      let same = 0;
      for (const g of near) if (flags[g] === flags[f]) same++;
      // Outvoted by its own neighbours: it was on the wrong side of a plane,
      // not on the wrong side of a window.
      if (same * 2 < near.length) next[f] = !flags[f];
    }
    for (let f = 0; f < faces; f++) flags[f] = next[f];
  }
}

/**
 * The two panels that come away from a car, built as separate nodes.
 *
 * Added, never displaced. The hull's positions and normals are shared by every
 * car built from the same reference — that sharing is why a car assembles in
 * seven milliseconds rather than twenty-four — so bending the bonnet in the
 * vertex buffer would bend it on every car at once, and giving this car its own
 * copy of a fifty-thousand-triangle buffer to bend costs more than the whole
 * feature is worth.
 *
 * So these sit slightly proud of the bodywork that is still there and read as
 * the panel that has torn loose from it. Each is built around its own hinge, so
 * a state is one rotation rather than a position and a rotation that have to
 * agree.
 */
function tornPanels(bounds) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const len = bounds.maxZ - bounds.minZ;

  // Bonnet: hinged at its rear edge, so it lifts at the nose the way a bonnet
  // does when its catch has gone. Narrower than the car, because a panel as
  // wide as the bodywork reads as a slab laid on top of it.
  const bonnetLen = len * 0.19;
  const bonnetGeo = box(w * 0.44, 0.035, bonnetLen, 0, 0, bonnetLen / 2, HULL_TORN);
  const bonnet = new THREE.Mesh(bonnetGeo, null);
  bonnet.position.set(0, bounds.minY + h * 0.48, bounds.maxZ - bonnetLen * 1.5);

  // Bumper: hinged at one end, so it drops at the other and hangs across the
  // nose. Kept shallow — swung far it stops being a bumper and becomes a lance.
  const bumperW = w * 0.72;
  const bumperGeo = box(bumperW, 0.09, 0.12, -bumperW / 2, 0, 0, HULL_TORN);
  const bumper = new THREE.Mesh(bumperGeo, null);
  bumper.position.set(bumperW * 0.44, bounds.minY + h * 0.20, bounds.maxZ - 0.02);

  return { bonnet, bumper };
}

/**
 * Darken the folds. Baked once per reference, into a value per vertex.
 *
 * The cars are real ones decimated, so the creases are *in the geometry* — the
 * swage down a flank, the lip over an arch, the gap either side of a bonnet.
 * Nothing was darkening them, and a painted surface with no occlusion in its
 * folds is the thing that reads as moulded plastic rather than as a panel.
 *
 * Not ray traced. Cavity: for a vertex, look at the surface around it and ask
 * which side of its own tangent plane that surface sits on. Neighbours in
 * front of the plane mean the surface curls toward you — a crease — and a
 * crease collects less light from the sky than a bulge does. Neighbours behind
 * it mean a bulge, which is left alone: brightening highlights is a different
 * effect and a garish one.
 *
 * O(vertices x neighbours) with a hash grid, over welded positions rather than
 * the fifty thousand triangles' worth of duplicates, and shared by every car
 * built from the reference — the folds belong to the shape, not to the paint.
 */
function bakeCavity(shared) {
  const pos = shared.position.array;
  const nor = shared.normal.array;
  const count = pos.length / 3;

  const RADIUS = 0.09;          // metres of surface a vertex asks about
  // Gently. At 2.6 the response was a step: half the bodywork sat at exactly
  // 1.0 and everything the test caught went straight to the floor, so creases
  // read as black lines rather than as shading.
  const STRENGTH = 1.35;        // how hard a crease is taken down
  const FLOOR = 0.62;           // and how dark it is allowed to get

  // Weld, then grid, both on integer keys.
  //
  // The first version keyed two Maps on strings — `"12,-4,88"` — and took nine
  // hundred milliseconds per reference, which is six seconds of boot across the
  // roster for a value that never changes. Same algorithm on packed integers
  // and a counting sort instead of a Map of arrays.
  const QUANT = 200;            // weld tolerance: 5 mm
  const pack = (x, y, z) =>
    (Math.round(x * QUANT) & 0x1fffff) * 4398046511104
    + (Math.round(y * QUANT) & 0x1fffff) * 2097152
    + (Math.round(z * QUANT) & 0x1fffff);

  const welded = new Map();
  const ofVertex = new Int32Array(count);
  const px = new Float32Array(count);
  const py = new Float32Array(count);
  const pz = new Float32Array(count);
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  const nz = new Float32Array(count);
  let unique = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const k = pack(pos[o], pos[o + 1], pos[o + 2]);
    let id = welded.get(k);
    if (id === undefined) {
      id = unique++;
      welded.set(k, id);
      px[id] = pos[o]; py[id] = pos[o + 1]; pz[id] = pos[o + 2];
    }
    ofVertex[i] = id;
    nx[id] += nor[o]; ny[id] += nor[o + 1]; nz[id] += nor[o + 2];
  }
  // Orient every normal outward before measuring anything with it.
  //
  // None of the references are consistently wound — measured, they run from 39%
  // to 76% of faces facing out — which is why the body material draws double
  // sided in the first place. Rendering survives it because Three flips the
  // normal for a back face on its way into the shader. This did not: a vertex
  // whose normal pointed into the car saw every neighbour "in front of" its
  // tangent plane, called that a crease, and occluded it. On two of the six
  // cars that was *every vertex on the body*, so the whole car came out a flat
  // wash — which is what melted plastic looks like.
  //
  // A car is roughly star-shaped about the line running through it, so the way
  // out is away from that line. Good enough to get the sign right, which is all
  // this needs.
  let midY = 0;
  for (let i = 0; i < unique; i++) midY += py[i];
  midY /= Math.max(1, unique);
  for (let i = 0; i < unique; i++) {
    const l = Math.hypot(nx[i], ny[i], nz[i]) || 1;
    nx[i] /= l; ny[i] /= l; nz[i] /= l;
    const ox = px[i];
    const oy = py[i] - midY;
    const ol = Math.hypot(ox, oy) || 1;
    if ((nx[i] * ox + ny[i] * oy) / ol < 0) {
      nx[i] = -nx[i]; ny[i] = -ny[i]; nz[i] = -nz[i];
    }
  }

  // A uniform grid over the car's own extents, as a counting sort: `start`
  // indexes into `items`, so a cell's members are a contiguous run.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < unique; i++) {
    if (px[i] < minX) minX = px[i]; if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i]; if (py[i] > maxY) maxY = py[i];
    if (pz[i] < minZ) minZ = pz[i]; if (pz[i] > maxZ) maxZ = pz[i];
  }
  const gx = Math.max(1, Math.ceil((maxX - minX) / RADIUS));
  const gy = Math.max(1, Math.ceil((maxY - minY) / RADIUS));
  const gz = Math.max(1, Math.ceil((maxZ - minZ) / RADIUS));
  const cellOf = new Int32Array(unique);
  const counts = new Int32Array(gx * gy * gz + 1);
  const clampi = (v, hi) => (v < 0 ? 0 : (v > hi ? hi : v));
  for (let i = 0; i < unique; i++) {
    const cx = clampi(Math.floor((px[i] - minX) / RADIUS), gx - 1);
    const cy = clampi(Math.floor((py[i] - minY) / RADIUS), gy - 1);
    const cz = clampi(Math.floor((pz[i] - minZ) / RADIUS), gz - 1);
    const c = (cz * gy + cy) * gx + cx;
    cellOf[i] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < counts.length - 1; c++) counts[c + 1] += counts[c];
  const start = counts;
  const items = new Int32Array(unique);
  const cursor = Int32Array.from(start.subarray(0, start.length - 1));
  for (let i = 0; i < unique; i++) items[cursor[cellOf[i]]++] = i;

  const cavity = new Float32Array(unique);
  const r2 = RADIUS * RADIUS;
  for (let i = 0; i < unique; i++) {
    const cx = clampi(Math.floor((px[i] - minX) / RADIUS), gx - 1);
    const cy = clampi(Math.floor((py[i] - minY) / RADIUS), gy - 1);
    const cz = clampi(Math.floor((pz[i] - minZ) / RADIUS), gz - 1);
    let sum = 0;
    let seen = 0;
    for (let a = Math.max(0, cx - 1); a <= Math.min(gx - 1, cx + 1); a++) {
      for (let b = Math.max(0, cy - 1); b <= Math.min(gy - 1, cy + 1); b++) {
        for (let c = Math.max(0, cz - 1); c <= Math.min(gz - 1, cz + 1); c++) {
          const cell = (c * gy + b) * gx + a;
          for (let m = start[cell]; m < start[cell + 1]; m++) {
            const j = items[m];
            if (j === i) continue;
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            const dz = pz[j] - pz[i];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2 || d2 < 1e-8) continue;
            // Positive: that neighbour lies on the side the normal points, so
            // the surface is closing in front of this vertex.
            sum += (dx * nx[i] + dy * ny[i] + dz * nz[i]) / Math.sqrt(d2);
            seen++;
          }
        }
      }
    }
    cavity[i] = seen ? Math.max(0, sum / seen) : 0;
  }

  const ao = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    ao[i] = Math.max(FLOOR, 1 - cavity[ofVertex[i]] * STRENGTH);
  }
  return ao;
}

/** The reference's own extents, so torn panels can be placed against it. */
function hullBounds(shared) {
  const p = shared.position.array;
  const b = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < b.minX) b.minX = p[i];
    if (p[i] > b.maxX) b.maxX = p[i];
    if (p[i + 1] < b.minY) b.minY = p[i + 1];
    if (p[i + 1] > b.maxY) b.maxY = p[i + 1];
    if (p[i + 2] < b.minZ) b.minZ = p[i + 2];
    if (p[i + 2] > b.maxZ) b.maxZ = p[i + 2];
  }
  return b;
}

/**
 * The order the panels lose their paint in, per triangle, once per reference.
 *
 * Not random. A car is hit at its corners and along its flanks, and hardly ever
 * on the roof, so the rank is mostly *where a panel is* with enough hash mixed
 * in to speckle the boundary — a clean band of primer across a wing reads as a
 * decal, and the point is that it reads as damage.
 *
 * Shared with every car built from this reference, like the positions are: it
 * depends on the geometry and not on the paint, and recomputing it per car
 * would undo the whole reason `hullShared` exists.
 */
function damageRanks(shared, hull) {
  const pos = shared.position.array;
  const tris = shared.bodyClasses.length;
  const rank = new Float32Array(tris);

  let maxX = 1e-6, maxZ = 1e-6, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (Math.abs(pos[i]) > maxX) maxX = Math.abs(pos[i]);
    if (Math.abs(pos[i + 2]) > maxZ) maxZ = Math.abs(pos[i + 2]);
    if (pos[i + 1] < minY) minY = pos[i + 1];
    if (pos[i + 1] > maxY) maxY = pos[i + 1];
  }
  const height = Math.max(1e-6, maxY - minY);

  for (let t = 0; t < tris; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 3;
      cx += pos[o]; cy += pos[o + 1]; cz += pos[o + 2];
    }
    cx /= 3; cy /= 3; cz /= 3;

    // Exposure: 1 at a corner of the car, 0 in the middle of the roof.
    const lateral = Math.abs(cx) / maxX;
    const longitudinal = Math.abs(cz) / maxZ;
    const low = 1 - (cy - minY) / height;
    const exposure = Math.max(lateral, longitudinal) * 0.72 + low * 0.28;

    // A cheap hash of the centroid, so the boundary is speckled rather than a
    // contour line, and so it is the same speckle every time this car is built.
    const h = Math.sin(cx * 12.9898 + cy * 78.233 + cz * 37.719) * 43758.5453;
    const noise = h - Math.floor(h);

    rank[t] = 1 - Math.min(1, exposure * 0.75 + noise * 0.25);
  }

  // Turn the score into a quantile of painted *area*, over the triangles that
  // can lose paint.
  //
  // Two things this fixes. A raw threshold is a threshold on a score whose
  // distribution piles up in the middle — two variables added together — so
  // `paint: 0.13` took a tenth of a per cent of one car's body and a twentieth
  // of another's. And a quantile by *count* is not what an eye reads: the
  // decimator spends its triangles where the detail is, so a sill or a grille
  // is hundreds of small ones and a door skin is a dozen large ones. By count,
  // two thirds of a wrecked car's triangles could lose their paint and the car
  // still look red. By area the constant means what its name says: this much
  // of the bodywork you can see has stopped being paint.
  const paintable = [];
  let total = 0;
  for (let t = 0; t < tris; t++) {
    if (shared.bodyClasses[t] !== 0 && shared.bodyClasses[t] !== 3) continue;
    const o = t * 9;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    const area = Math.hypot(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x,
    ) / 2;
    paintable.push({ t, area });
    total += area;
  }
  paintable.sort((a, b) => rank[a.t] - rank[b.t]);

  const out = new Float32Array(tris).fill(1);
  let run = 0;
  for (const { t, area } of paintable) {
    run += area;
    out[t] = total > 0 ? run / total : 0;
  }
  return out;
}

/**
 * Fill a car's colour buffer, with `damage` of its paint gone.
 *
 * Colour is the one thing that is per-car — positions and normals are shared —
 * so this is where damage can be shown for free. Moving a vertex would end the
 * sharing and with it the reason a car builds in seven milliseconds instead of
 * twenty-four, which is why dents are a later, additive job and this is not.
 */
function paintHull(shared, byClass, col, damage = 0) {
  const cls = shared.bodyClasses;
  const ao = shared.ao;
  // One shade per class, worked out once rather than per vertex.
  const shadows = byClass.map((c) => shadeOf(c));
  const shaded = new THREE.Color();
  const rank = shared.damageRank;
  const primer = new THREE.Color(HULL_PRIMER);
  const scorch = new THREE.Color(HULL_SCORCH);

  for (let t = 0; t < cls.length; t++) {
    let c = byClass[cls[t]] ?? byClass[0];
    if (damage > 0 && rank && (cls[t] === 0 || cls[t] === 3)) {
      const r = rank[t];
      // The worst third of what has gone is burnt rather than merely bare.
      if (r < damage * 0.34) c = scorch;
      else if (r < damage) c = primer;
    }
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      // Per vertex, not per face: the whole point is that a crease shades
      // across a panel rather than switching at its edge.
      const shade = ao ? ao[t * 3 + k] : 1;
      // Paint and chrome only. The shade colour is lighter than glass is, so
      // tinting a window toward it would make the creases in a windscreen
      // *brighter* — and black glass took two goes to get right already.
      if (shade < 1 && (cls[t] === 0 || cls[t] === 3)) {
        // Toward its own shade first, then down. Doing only the second is what
        // makes a dark panel read as the same plastic under less light.
        shaded.copy(c).lerp(shadows[cls[t]] ?? c, 1 - shade);
        col[o] = shaded.r;
        col[o + 1] = shaded.g;
        col[o + 2] = shaded.b;
      } else {
        col[o] = c.r * shade;
        col[o + 1] = c.g * shade;
        col[o + 2] = c.b * shade;
      }
    }
  }
}

/**
 * Build a car from a body decimated off a real one by tools/decimate.mjs.
 *
 * De-indexed on the way in. The file is indexed because that is half the bytes,
 * but a class belongs to a triangle rather than to a corner — a windscreen and
 * the pillar beside it share vertices and are not the same surface — and an
 * indexed buffer can only colour corners. Splitting them costs memory this
 * budget has and buys panel edges that are lines rather than zigzags. It is
 * also what `flatShading` wants: one normal per face, not an average of the
 * faces a corner happens to touch.
 *
 * The body arrives in metres with the road at `ground` and the nose at +Z, and
 * is scaled onto the L and W the build asked for, height following length so a
 * wide build widens the car instead of flattening it.
 */
function hullGeometry(hull, L, W, color, accent) {
  const byClass = [color, HULL_GLASS, HULL_DARK, HULL_CHROME, accent ?? 0xfff2d0]
    .map((c) => new THREE.Color(c));

  const shared = hullShared(hull);
  const col = new Float32Array(shared.bodyClasses.length * 9);
  paintHull(shared, byClass, col, 0);

  // Its own geometry object, pointing at the shared buffers. Only the colours
  // belong to this car.
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', shared.position);
  body.setAttribute('normal', shared.normal);
  body.setAttribute('color', new THREE.BufferAttribute(col, 3));

  return {
    body,
    bounds: shared.bounds,
    glass: shared.glass,
    lampFront: shared.lampFront,
    lampRear: shared.lampRear,
    lampRearFitted: shared.lampRearFitted,
    // What `setDamage` needs to repaint this car without rebuilding it.
    repaint: (damage) => {
      paintHull(shared, byClass, col, damage);
      body.getAttribute('color').needsUpdate = true;
    },
    // Size is a scale on the node rather than baked into the vertices, which is
    // what lets one set of buffers serve a car the build stretched and one it
    // did not.
    scale: [W / hull.width, L / hull.length, L / hull.length],
  };
}

/** Total area of a triangle soup, in square metres. */
function surfaceArea(geo) {
  const p = geo.getAttribute('position');
  const ix = geo.index;
  const n = ix ? ix.count : p.count;
  let area = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t + 2 < n; t += 3) {
    const i0 = ix ? ix.getX(t) : t;
    const i1 = ix ? ix.getX(t + 1) : t + 1;
    const i2 = ix ? ix.getX(t + 2) : t + 2;
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1).sub(a);
    c.fromBufferAttribute(p, i2).sub(a);
    area += b.cross(c).length() / 2;
  }
  return area;
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
  // The people's car. Rear engine, running boards, separate wings.
  //
  // Measured from an early-fifties VW Beetle with tools/silhouette.mjs, scaled to
  // 4.06 m, with the reference's ground plane excluded. The hand-written entry
  // this replaces claimed four wings standing clear of a narrow body while the
  // numbers under it drew one smooth arc that did no such thing. The measured
  // profile has the rhythm the sentence promised: a crown over each wing near
  // ±0.28 and a waist between them where the running board is.
  beetle: {
    length: 0.8, width: 0.71, ride: 1.16, height: 1.05,
    wheel: 0.64, tyre: 0.57, axle: 0.3,
    fenders: { out: 0.055, frontOut: 0.05, radius: 1.34, thickness: 0.92, stretch: 1.30, lift: 1.00 },
    cabin: {
      roof: true, rise: 1.0, width: 1.0, tall: 1.0, shift: 0, units: 'body',
      sections: [
        [ 0.355,  0.590,  0.140,  0.070],
        [ 0.284,  0.680,  0.200,  0.100],
        [ 0.213,  0.760,  0.300,  0.150],
        [ 0.142,  0.820,  0.510,  0.260],
        [ 0.071,  0.870,  0.770,  0.390],
        [ 0.000,  0.900,  0.900,  0.450],
        [-0.071,  0.910,  0.910,  0.460],
        [-0.142,  0.890,  0.870,  0.440],
        [-0.213,  0.880,  0.770,  0.390],
        [-0.284,  0.830,  0.570,  0.290],
        [-0.355,  0.710,  0.360,  0.180],
      ],
    },
    profile: [
        [ 0.497,  0.590,  0.330, -0.110],
        [ 0.426,  0.820,  0.670, -0.030],
        [ 0.355,  0.960,  0.990, -0.010],
        [ 0.284,  0.990,  1.000,  0.020],
        [ 0.213,  0.980,  0.860,  0.080],
        [ 0.142,  0.970,  0.810,  0.110],
        [ 0.071,  0.970,  0.820,  0.110],
        [ 0.000,  0.980,  0.810,  0.110],
        [-0.071,  0.980,  0.800,  0.110],
        [-0.142,  0.990,  0.840,  0.100],
        [-0.213,  1.000,  0.950,  0.040],
        [-0.284,  1.000,  0.920,  0.060],
        [-0.355,  0.970,  0.670,  0.150],
        [-0.426,  0.770,  0.440,  0.060],
        [-0.497,  0.470,  0.230, -0.110],
    ],
  },

  // Small front-drive hatchback. Short, upright, tall glass, cut-off tail.
  //
  // Measured from a 1997 Peugeot 205 GTI with tools/silhouette.mjs, scaled to
  // 3.71 m, with the tailgate excluded: the reference has it modelled open, and
  // left in it stands 27 cm above the roof and drags the beltline up after it.
  // `ride` stays hand-set — the tyres are merged into the bodywork, so the
  // lowest thing the tool can find down there is a contact patch.
  hatch: {
    length: 0.73, width: 0.72, ride: 1.10, height: 0.97,
    wheel: 0.59, tyre: 0.59,
    axle: 0.32,
    cabin: {
      roof: true, rise: 1.0, width: 1.0, tall: 1.0, shift: 0, units: 'body',
      sections: [
        [ 0.426,  0.520,  0.030,  0.010],
        [ 0.355,  0.770,  0.090,  0.040],
        [ 0.284,  0.920,  0.170,  0.090],
        [ 0.213,  0.940,  0.320,  0.160],
        [ 0.142,  0.950,  0.530,  0.270],
        [ 0.071,  0.950,  0.740,  0.370],
        [ 0.000,  0.960,  0.860,  0.430],
        [-0.071,  0.960,  0.890,  0.450],
        [-0.142,  0.960,  0.900,  0.450],
        [-0.213,  0.960,  0.900,  0.450],
        [-0.284,  0.950,  0.840,  0.420],
        [-0.355,  0.930,  0.650,  0.320],
        [-0.426,  0.910,  0.430,  0.220],
      ],
    },
    profile: [
        [ 0.497,  0.560,  0.300,  0.080],
        [ 0.426,  0.840,  0.690,  0.060],
        [ 0.355,  0.990,  0.980,  0.010],
        [ 0.284,  1.000,  1.000,  0.000],
        [ 0.213,  0.990,  0.900,  0.050],
        [ 0.142,  0.980,  0.840,  0.080],
        [ 0.071,  0.990,  0.830,  0.080],
        [ 0.000,  0.990,  0.830,  0.080],
        [-0.071,  0.990,  0.830,  0.090],
        [-0.142,  0.990,  0.840,  0.080],
        [-0.213,  0.990,  0.880,  0.060],
        [-0.284,  1.000,  0.970,  0.020],
        [-0.355,  0.990,  0.970,  0.010],
        [-0.426,  0.820,  0.690,  0.100],
        [-0.497,  0.520,  0.350,  0.180],
    ],
  },

  // Rear-drive coupe. Long bonnet, fastback tail falling away to a short deck.
  //
  // Measured from a 1999 Nissan Silvia S15 Spec-S Aero with tools/silhouette.mjs,
  // scaled to 4.45 m. The reference names its wheel meshes, so the wheelbase and
  // ride height here are measured rather than assumed: 2.53 m against the 2.525 m
  // the car is built to.
  coupe: {
    length: 0.88, width: 0.78, ride: 1.00, height: 0.86,
    wheel: 0.67, tyre: 0.86, axle: 0.28,
    cabin: {
      roof: true, rise: 1.0, width: 1.0, tall: 1.0, shift: 0, units: 'body',
      sections: [
        [ 0.426,  0.680,  0.090,  0.040],
        [ 0.355,  0.850,  0.170,  0.090],
        [ 0.284,  0.960,  0.260,  0.130],
        [ 0.213,  0.970,  0.350,  0.170],
        [ 0.142,  0.970,  0.520,  0.260],
        [ 0.071,  0.970,  0.750,  0.370],
        [ 0.000,  0.980,  0.920,  0.460],
        [-0.071,  0.980,  0.980,  0.490],
        [-0.142,  0.980,  0.960,  0.480],
        [-0.213,  0.990,  0.860,  0.430],
        [-0.284,  0.990,  0.700,  0.350],
        [-0.355,  0.970,  0.590,  0.290],
        [-0.426,  0.930,  0.570,  0.280],
      ],
    },
    profile: [
        [ 0.497,  0.420,  0.350,  0.140],
        [ 0.426,  0.770,  0.710,  0.090],
        [ 0.355,  0.970,  0.910,  0.050],
        [ 0.284,  0.990,  0.930,  0.040],
        [ 0.213,  0.990,  0.970,  0.020],
        [ 0.142,  0.990,  1.000,  0.010],
        [ 0.071,  0.980,  1.000,  0.000],
        [ 0.000,  0.990,  1.000,  0.000],
        [-0.071,  0.990,  0.990,  0.000],
        [-0.142,  0.990,  0.950,  0.000],
        [-0.213,  1.000,  0.930,  0.010],
        [-0.284,  1.000,  0.910,  0.040],
        [-0.355,  0.980,  0.840,  0.070],
        [-0.426,  0.820,  0.640,  0.120],
        [-0.497,  0.540,  0.380,  0.220],
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
  //
  // Lower loft measured from a 1989 Mazda MX-5 (NA) with tools/silhouette.mjs,
  // scaled to 3.95 m. Only the lower loft: the reference wears its soft top, so
  // everything measured above the beltline describes a roof this body type does
  // not have, and the cabin scalars below stay hand-set.
  roadster: {
    length: 0.78, width: 0.77, ride: 0.86, height: 0.87,
    wheel: 0.61, tyre: 0.6, axle: 0.29,
    cabin: { roof: false, rise: 0.86, width: 0.94, tall: 0.80, shift: -0.04 },
    profile: [
        [ 0.497,  0.420,  0.330,  0.110],
        [ 0.426,  0.740,  0.660,  0.090],
        [ 0.355,  0.950,  0.940,  0.030],
        [ 0.284,  0.990,  1.000,  0.000],
        [ 0.213,  1.000,  0.880,  0.060],
        [ 0.142,  1.000,  0.790,  0.100],
        [ 0.071,  0.990,  0.780,  0.100],
        [ 0.000,  0.990,  0.780,  0.100],
        [-0.071,  0.980,  0.780,  0.110],
        [-0.142,  0.980,  0.810,  0.090],
        [-0.213,  0.970,  0.930,  0.030],
        [-0.284,  0.950,  0.970,  0.010],
        [-0.355,  0.900,  0.810,  0.100],
        [-0.426,  0.700,  0.570,  0.160],
        [-0.497,  0.390,  0.320,  0.160],
    ],
  },

  // Rally saloon: three boxes. The separate boot deck is the whole read.
  //
  // Measured from a Subaru Impreza WRX STi Version VI (GC8) with
  // tools/silhouette.mjs, scaled to 4.35 m. `ride` stays hand-set — nothing in
  // the reference names a wheel, so the tool cut the model off at --floor to get
  // the tyres out of the sections, and what it reports as a ride height
  // afterwards is that fraction rather than a measurement.
  rally: {
    length: 0.86, width: 0.79, ride: 1.16, height: 0.67,
    wheel: 0.62, tyre: 0.65,
    cabin: {
      roof: true, rise: 1.0, width: 1.0, tall: 1.0, shift: 0, units: 'body',
      sections: [
        [ 0.426,  0.900,  0.840,  0.420],
        [ 0.355,  0.940,  0.740,  0.370],
        [ 0.284,  0.960,  0.910,  0.460],
        [ 0.213,  0.970,  1.200,  0.600],
        [ 0.142,  0.970,  1.340,  0.670],
        [ 0.071,  0.960,  1.340,  0.670],
        [ 0.000,  0.960,  1.270,  0.630],
        [-0.071,  0.990,  1.070,  0.540],
        [-0.142,  1.020,  0.760,  0.380],
        [-0.213,  0.970,  0.460,  0.230],
        [-0.284,  0.900,  0.280,  0.140],
        [-0.355,  0.730,  0.160,  0.080],
        [-0.426,  0.460,  0.070,  0.040],
      ],
    },
    profile: [
        [ 0.497,  0.510,  0.330, -0.340],
        [ 0.426,  0.800,  0.710, -0.110],
        [ 0.355,  0.980,  0.900,  0.010],
        [ 0.284,  1.000,  0.950,  0.010],
        [ 0.213,  1.000,  1.000,  0.000],
        [ 0.142,  0.990,  1.000,  0.000],
        [ 0.071,  0.980,  0.990,  0.000],
        [ 0.000,  0.980,  0.980, -0.010],
        [-0.071,  0.980,  0.990, -0.010],
        [-0.142,  0.970,  1.000,  0.000],
        [-0.213,  0.980,  1.000,  0.000],
        [-0.284,  0.990,  1.000,  0.000],
        [-0.355,  0.970,  1.000,  0.000],
        [-0.426,  0.810,  0.810, -0.030],
        [-0.497,  0.550,  0.420, -0.090],
    ],
  },
};
const METAL = 0x6b7178;
const RUBBER = 0x121418;

// ---------------------------------------------------------------------------

/**
 * Cut every hull before the first race asks for one.
 *
 * The cut is cached per reference and shared by every car of that shape, so it
 * is paid once — but "once" would otherwise be in the frame where six cars are
 * created, which is the frame the player is watching. Called at boot, right
 * after the bodies are fetched, it lands in the load instead.
 */
export function warmHulls(hulls) {
  for (const hull of Object.values(hulls ?? {})) hullShared(hull);
}

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

    // A traced hull, when this body type has a real car behind it. Everything
    // the generator would otherwise draw — the lofted body, the greenhouse and
    // every bolt-on between them — is replaced by it at assembly, so the shape
    // on screen is the shape that was measured rather than an approximation
    // wearing its accessories.
    const hull = HULLS[profile.bodyType] ?? null;

    // How big the car is.
    //
    // With a body taken off a real car, the real car settles it. The generated
    // route had to invent a size from the build, and `BT.length` was a ratio
    // against an invented reference; keeping that with a measured body threw the
    // scale away again — the Quattro came out 5.52 m against the 4.40 m it is,
    // and the roster spread from 3.36 m to 5.52 m with no car in it that size.
    //
    // The build still moves it, by about a tenth either way, so a heavy machine
    // is visibly a heavier one. It no longer decides what car this is.
    const L = hull
      ? hull.length * (1 + (bulk - 0.35) * 0.16 + speed * 0.04)
      : (lerp(4.5, 5.6, bulk) + speed * 0.55) * BT.length;
    const W = hull
      ? hull.width * (1 + (bulk - 0.35) * 0.10)
      : lerp(1.95, 2.65, bulk) * BT.width;
    const rideH = (lerp(0.34, 0.46, bulk) - speed * 0.06) * BT.ride;
    // What this car takes up on the road, for anything that needs to know
    // without measuring geometry — the group's bounding box includes an
    // underglow plane wider than the car and answers the wrong question.
    this.footprint = { length: L, width: W };
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

    // The wheels, in numbers. Hoisted above the generated body because they are
    // the only things it declares that the rest of the build needs — which is
    // what lets the whole of it be skipped for a car that has a real hull.
    //
    // Wheels are rebuilt, never traced: one radius per angle cannot describe an
    // arch that curls under itself, so `decimate.mjs` measures them instead and
    // the numbers land here. Scaled with the car, so a build that stretches the
    // body does not leave its wheels behind.
    const hw = hull?.wheel ?? null;
    const hs = hull ? L / hull.length : 1;
    const wheelR = hw ? hw.radius * hs : lerp(0.44, 0.58, bulk);
    const wheelT = hw ? hw.width * hs : lerp(0.26, 0.42, bulk);
    const wheelbase = hw ? (hw.front - hw.rear) * hs * 0.5 : L * 0.33;
    // Where the wheels sit across the car. Taken from the reference when there
    // is one, because the car's own width cannot give it: a hull's width is
    // measured over the mirrors and a wheel arch is nowhere near that far out.
    const trackW = hull?.wheel?.track
      ? (hull.wheel.track * 0.5) * (W / hull.width)
      : W * 0.5 - wheelT * 0.30;

    // Everything from here to the assembly is the car this project draws when
    // it has no real one to go on, and a body type with a hull does not need a
    // line of it.
    //
    // It used to run anyway and be thrown away at assembly — a deliberate trade
    // when the alternative was threading a condition through four hundred lines
    // that all declare things each other depend on. The bill came to ten
    // milliseconds a car and seventy across a grid, spent building geometry
    // nobody ever sees, in the one frame where every car is created at once.
    // The four wheel scalars are the only things past here that the rest of the
    // build needs, so they are hoisted above it and this becomes one condition
    // after all.
    if (!hull) {
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
      // Wheels are rebuilt, never traced: one radius per angle cannot describe an
      // arch that curls under itself, so `lowpoly.mjs` measures them instead and
      // the numbers land here. Scaled with the car, so a build that stretches the
      // body does not leave its wheels behind.

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

    }

    // --- assemble -----------------------------------------------------------
    //
    // With a hull, everything above is discarded rather than skipped. Skipping
    // it would mean threading a condition through four hundred lines that all
    // declare things each other depend on; discarding costs a few thousand
    // triangles that are built and dropped once per car, at mesh build, and
    // keeps the two paths from tangling. The generated route is still the one
    // any body type without a reference takes.
    let hullLampGeo = null;
    if (hull) {
      opaque.length = 0;
      glass.length = 0;
      emissive.length = 0;
      const built = hullGeometry(hull, L, W, body, accent);
      opaque.push(built.body);
      hullLampGeo = built;
    }

    this.bodyGeo = hull ? hullLampGeo.body : mergeGeometries(opaque);
    // Authored with y = 0 on the road, and now hanging off a node raised to the
    // axle line — so everything inside it drops by exactly that, leaving the car
    // where it was and the pivot where it belongs.
    //
    // Only the generated route can be moved this way: a hull's buffers are
    // shared with every other car of the same shape, so translating them would
    // move all of them. Those are carried on a node instead, which is also
    // where their size comes from.
    if (!hull) this.bodyGeo?.translate(0, -wheelR, 0);
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      // A car built out of boxes is watertight and can be culled from behind. A
      // car decimated off a reference is not: real models are dozens of open
      // shells, and some of them are wound inconsistently to begin with, so
      // back-face culling turns those into holes you can see the far side of
      // the car through. Drawing both sides costs fill rate and fixes it
      // outright, which is the right trade for geometry nobody here authored.
      side: hull ? THREE.DoubleSide : THREE.FrontSide,
      // Faceted. The loft averages normals across its cross-sections, which
      // reads as a soft curve; flat shading puts the panel edges back and is
      // what makes the silhouette legible at speed.
      flatShading: true,
      // Car paint is two layers, and modelling it as one is what reads as
      // plastic.
      //
      // Underneath is pigment with a little metallic flake in it: mostly
      // diffuse, tinted, fairly rough. Over it is clear lacquer: a hard, almost
      // mirror-smooth dielectric whose highlight is *white* rather than the
      // colour of the paint, and which goes bright at a grazing angle. A single
      // MeshStandard layer can be one or the other. It cannot be both, and a
      // flank lit only by a broad diffuse term is one flat colour from nose to
      // tail — which is exactly what a moulded toy looks like.
      //
      // The base metalness comes down because the lacquer is now supplying the
      // shine; leaving it where it was made the paint look like foil.
      roughness: lerp(0.44, 0.80, armor),
      metalness: lerp(0.22, 0.46, armor),
      // Not a full coat. At 1.0 against a bright sky the lacquer covered the
      // whole panel rather than catching its edges, and a saturated blue came
      // out of it the pale blue of a bathroom fitting. Half a coat still breaks
      // the flank up and leaves the paint its colour.
      clearcoat: 0.55,
      // Not zero either. A perfect mirror on a road car reads as a show-stand
      // render; real lacquer has been through a car wash.
      clearcoatRoughness: lerp(0.11, 0.26, armor),
    });

    // No back-face darkening here, and it is worth saying why not.
    //
    // "A back face is inside the car" is true of a consistently wound mesh and
    // these are not: measured, the references run from 39% to 76% of faces
    // pointing outward, which is the reason this material draws double sided in
    // the first place. Darkening back faces took the WRC — 42% outward — and
    // painted well over half of its bodywork the colour of a cabin. The problem
    // it was aimed at is solved below instead, by putting something dark inside
    // the car rather than by guessing which side of a triangle you are on.
    // Everything that pitches and rolls hangs off `chassis`; the wheels do not.
    //
    // Pitch used to be applied to the whole car about the group's origin, which
    // sits on the road surface — so five degrees of it swung the front wheels
    // ten centimetres, and the car spent most of its time either hovering above
    // the tarmac or buried in it. A real one pitches about its suspension while
    // its tyres stay down. Rotating a child group whose origin is the axle line
    // is that, and it costs one node in the graph.
    this.chassis = new THREE.Group();
    this.chassis.position.y = wheelR;
    this.group.add(this.chassis);

    // Hull geometry hangs off its own node, which carries the size and undoes
    // the axle-line lift. Nothing here may be baked into the vertices: they
    // belong to every car built from the same reference.
    this.hullRoot = null;
    if (hull) {
      this.hullRoot = new THREE.Group();
      this.hullRoot.scale.set(...hullLampGeo.scale);
      this.hullRoot.position.y = -wheelR;
      this.chassis.add(this.hullRoot);
    }
    const attach = (m) => {
      if (!m) return;
      (this.hullRoot ?? this.chassis).add(m);
    };

    this.bodyMesh = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    this.bodyMesh.castShadow = !!quality?.shadows;
    attach(this.bodyMesh);

    this.glassGeo = mergeGeometries(glass);
    this.glassGeo?.translate(0, -wheelR, 0);
    this.glassMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.10, metalness: 0.55, flatShading: true,
      transparent: true, opacity: 0.70,
    });
    // A traced hull carries no separate glass or lamp geometry yet, so this can
    // legitimately be empty — `mergeGeometries` answers null for an empty list.
    this.glassMesh = this.glassGeo ? new THREE.Mesh(this.glassGeo, this.glassMat) : null;
    if (this.glassMesh) attach(this.glassMesh);

    // Emissive parts carry their hue in vertex colours — white headlights, red
    // tail lights, element-coloured trim — and the material tints all of them,
    // so heat can push the lot toward white-hot in a single draw call.
    this.trimGeo = mergeGeometries(emissive);
    this.trimGeo?.translate(0, -wheelR, 0);
    this.trimMat = new THREE.MeshBasicMaterial({
      vertexColors: true, color: this.glow.color, toneMapped: false,
    });
    // A traced hull carries no separate glass or lamp geometry yet, so this can
    // legitimately be empty — `mergeGeometries` answers null for an empty list.
    this.trimMesh = this.trimGeo ? new THREE.Mesh(this.trimGeo, this.trimMat) : null;
    if (this.trimMesh) attach(this.trimMesh);

    // --- lamps --------------------------------------------------------------
    //
    // Unlit, so they are light rather than a pale patch, and separate front from
    // rear so they can say different things. Headlights burn steadily; the rear
    // pair is a dim running red that goes hard red under braking and white in
    // reverse. One reference in seven marks its reversing lamps apart from its
    // tail lights, so both come off the same faces and the colour carries the
    // meaning — which is what a driver behind you reads anyway.
    // Hull glass: unlit, so no highlight can turn a window into a grey panel.
    this.hullGlassMat = hull
      ? new THREE.MeshBasicMaterial({ color: HULL_GLASS, toneMapped: false })
      : null;
    this.hullGlass = hullLampGeo?.glass
      ? new THREE.Mesh(hullLampGeo.glass, this.hullGlassMat) : null;
    if (this.hullGlass) attach(this.hullGlass);

    // Damage. Repainting walks every triangle, so it happens when the state
    // changes and not per frame — which is three times in a bad race.
    this._repaint = hullLampGeo?.repaint ?? null;
    this._damageLevel = 0;
    // How hard the engine bay should be smoking, for the FX layer to read.
    this.damageSmoke = 0;

    // The cabin, blanked.
    //
    // A decimated shell has no interior: through a side window you see the back
    // of the far door skin, lit as though it were bodywork in the sun, and on
    // a car whose glass is sparse you can see straight through the greenhouse
    // to the scenery. So something dark has to sit behind the glass.
    //
    // A box was the first answer and it was the wrong shape. Sized to fit
    // inside the cabin it is smaller than the greenhouse, so its top edge is
    // visible *through* the windscreen as a hard horizontal band — near-black
    // against near-black glass, which reads as a ridge on the screen that
    // nothing on the car explains. Sized to cover the greenhouse it comes out
    // through the doors instead. There is no box that does both, because a
    // cabin is not a box.
    //
    // So it is the glass itself, moved inward along its own normals. It cannot
    // poke through the window it is hiding behind — it is that window, eight
    // centimetres in — and it has no edge to show, because its edge is exactly
    // where the glass stops and the bodywork starts.
    this.cabin = null;
    // Whichever glass this car has: a hull carries its own (`hullGlass`), and a
    // procedural body builds boxes (`glassGeo`). Taking only the second one
    // meant every real car quietly lost its blank altogether — and the ridge
    // did go away, because there was nothing left in the cabin to show.
    const glassSrc = this.hullGlass?.geometry ?? this.glassGeo;
    if (glassSrc) {
      const src = glassSrc.getAttribute('position');
      const nrm = glassSrc.getAttribute('normal');
      const n = src.count;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color(HULL_CABIN);

      // Which way is in.
      //
      // The glass is cut from the hull with computed normals, and those point
      // outward — but not reliably on every reference, so the direction is
      // measured rather than trusted. Against the greenhouse's own centroid,
      // not against the car's: a pane near the car's centre line, which a
      // sunroof is, has almost no signal in `n . p` about the car's origin and
      // was being pushed *outward* on the strength of rounding.
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let i = 0; i < n; i++) { cx += src.getX(i); cy += src.getY(i); cz += src.getZ(i); }
      cx /= n; cy /= n; cz /= n;

      const INSET = 0.08;
      // A floor on the clearance, on every axis.
      //
      // The clamp below leaves a vertex standing still wherever the normal
      // would push it outward, and standing still means sitting *on* the pane
      // it is meant to be behind, which z-fights. A percentage shrink does not
      // fix it either: on the two cars whose limiting pane is the roof, the
      // extreme vertex is barely off the centroid and a percentage of nothing
      // is nothing.
      const GAP = 0.02;
      for (let i = 0; i < n; i++) {
        const px = src.getX(i);
        const py = src.getY(i);
        const pz = src.getZ(i);
        let nx = nrm.getX(i);
        let ny = nrm.getY(i);
        let nz = nrm.getZ(i);
        if (nx * (px - cx) + ny * (py - cy) + nz * (pz - cz) < 0) {
          nx = -nx; ny = -ny; nz = -nz;
        }
        // Inward along the normal, but never outward on any axis.
        //
        // A vertex on the boundary between two panes has a normal averaged
        // across both, which can point mostly along y while the vertex sits at
        // the widest point of a side window — and the dot product above, being
        // dominated by y, then leaves the x component pointing the wrong way
        // and the shell comes out 4 cm wider than the glass it is hiding
        // behind. Whatever the normal says, a blank may move toward the middle
        // of the cabin and not away from it.
        const toward = (v, cv, nv) => {
          const moved = v - nv * INSET;
          const held = Math.abs(moved - cv) > Math.abs(v - cv) ? v : moved;
          const d = held - cv;
          return cv + Math.sign(d) * Math.max(0, Math.abs(d) - GAP);
        };
        pos[i * 3] = toward(px, cx, nx);
        pos[i * 3 + 1] = toward(py, cy, ny);
        pos[i * 3 + 2] = toward(pz, cz, nz);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      this.cabinMat = new THREE.MeshBasicMaterial({
        vertexColors: true, toneMapped: false, side: THREE.DoubleSide,
      });
      this.cabin = new THREE.Mesh(geo, this.cabinMat);
      attach(this.cabin);
    }

    this.torn = null;
    if (hullLampGeo?.bounds) {
      // One material for both, and both start hidden — Three skips an invisible
      // mesh entirely, so an undamaged car pays nothing for carrying them.
      this.tornMat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0.12,
        side: THREE.DoubleSide,
      });
      this.torn = tornPanels(hullLampGeo.bounds);
      for (const piece of [this.torn.bonnet, this.torn.bumper]) {
        piece.material = this.tornMat;
        piece.visible = false;
        piece.castShadow = !!quality?.shadows;
        attach(piece);
      }
    }

    // Offset in depth rather than in space.
    //
    // A lamp is a patch lying on the bodywork, and the bodywork curves under
    // it: however finely the patch is fitted, the panel bulges above the flat
    // of each quad somewhere and punches through, which reads as a lamp with
    // holes torn in it. Lifting the patch further off the panel trades that
    // for a lamp visibly standing proud. Polygon offset is the tool meant for
    // exactly this — the patch keeps its true position and simply wins the
    // depth test against the surface it is lying on.
    // The depth bias belongs to the fitted patch and to nothing else.
    //
    // A lamp fitted to the tail panel lies four millimetres off the paint and
    // needs a nudge or the panel draws over it. A lamp the reference modelled
    // is already where it goes, and biasing it pulls its rim in front of the
    // bodywork around it — per pixel, so the light came out with a ragged
    // cream fringe all the way round, which is the thing on the screenshots.
    const decal = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
    this.lampFrontMat = new THREE.MeshBasicMaterial({
      color: LAMP_HEAD, toneMapped: false,
    });
    this.lampRearMat = new THREE.MeshBasicMaterial({
      color: LAMP_TAIL, toneMapped: false,
      ...(hullLampGeo?.lampRearFitted ? decal : {}),
    });
    this.lampFront = hullLampGeo?.lampFront
      ? new THREE.Mesh(hullLampGeo.lampFront, this.lampFrontMat) : null;
    this.lampRear = hullLampGeo?.lampRear
      ? new THREE.Mesh(hullLampGeo.lampRear, this.lampRearMat) : null;
    for (const m of [this.lampFront, this.lampRear]) {
      if (!m) continue;
      if (!this.hullRoot) m.geometry.translate(0, -wheelR, 0);
      attach(m);
    }

    // --- wheels -------------------------------------------------------------
    this.wheels = [];
    // How far the wheel actually reaches, measured off the geometry rather than
    // assumed to be `wheelR`.
    //
    // The tread blocks stand proud of the tyre by design — that is what makes
    // the contact patch read — so the outermost thing on a wheel is about
    // twenty-seven millimetres beyond its nominal radius. Parking the axle at
    // `wheelR` therefore drove that much of every tyre into the tarmac, on every
    // car, at rest. On a real tyre the tread is the part that touches the road,
    // so that is the radius the axle has to sit at. Measured, so it stays true
    // if the tread ever changes.
    // Specifically the lowest point, not the furthest. Taking the greatest
    // radius at any angle picks the diagonal corner of a tread block, which is
    // never the part underneath — set the axle to that and the car floats by
    // the difference. What touches the road is whatever is at the bottom, so
    // that is what is measured.
    const wheelReach = (geo) => {
      if (!geo) return 0;
      const a = geo.attributes.position.array;
      let lowest = 0;
      for (let i = 1; i < a.length; i += 3) if (a[i] < lowest) lowest = a[i];
      return -lowest;
    };
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
    // A rim finish is a tint, not new geometry. The hub's own colours are in
    // its vertex buffer and this material multiplies them, so one colour turns
    // a whole wheel bronze — and a wheel is small enough on screen that a
    // change of metal reads where a change of spoke count does not.
    if (profile.rimTint) this.hubMat.color.set(profile.rimTint);

    const contactR = Math.max(wheelR,
      wheelReach(this.treadGeo), wheelReach(this.hubGeo), wheelReach(this.wheelGeo));

    for (const [ix, iz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(ix * trackW, contactR, iz * wheelbase);

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
    //
    // A pool, not a panel.
    //
    // This was one flat quad in a single colour, which additively blended over
    // tarmac is a glowing rectangle with four corners on it — and that is what
    // it read as: a square drawn around the car. Light under a car does not
    // have an edge. Subdividing it and fading the vertex colour out to black
    // gives the falloff, and costs nothing extra to draw: under additive
    // blending black *is* transparent, so the same one pass ends softly instead
    // of stopping.
    const glowGeo = new THREE.PlaneGeometry(W * 2.0, L * 1.6, 12, 18);
    glowGeo.rotateX(-Math.PI / 2);
    {
      const pos = glowGeo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      const hw = W * 1.0;
      const hl = L * 0.8;
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) / hw;
        const v = pos.getZ(i) / hl;
        // Squared falloff on an ellipse: bright under the car, gone by the edge.
        const r = Math.min(1, Math.hypot(u, v));
        const f = (1 - r * r) ** 2;
        col[i * 3] = f; col[i * 3 + 1] = f; col[i * 3 + 2] = f;
      }
      glowGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    this.underglowMat = new THREE.MeshBasicMaterial({
      color: this.glow.color, vertexColors: true, transparent: true, opacity: 0,
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
  /**
   * Show the car as `healthFrac` of its durability, in four named states.
   *
   * Repainting is O(triangles) and a car is fifty thousand of them, so this
   * only does the work when the state index moves. It is idempotent: calling
   * it every frame with an unchanged fraction costs one comparison.
   */
  setDamage(healthFrac) {
    const level = damageLevel(healthFrac);
    if (level === this._damageLevel) return;
    this._damageLevel = level;
    const st = DAMAGE_STATES[level];

    this._repaint?.(st.paint);
    // Headlights dim, then go out. The rear lamps are left to the brake logic,
    // which writes their colour every frame and would undo anything set here.
    this.lampFrontMat?.color.setHex(LAMP_HEAD).multiplyScalar(st.lamps);
    if (this.lampFront) this.lampFront.visible = st.lamps > 0;

    if (this.torn) {
      // Negative about X lifts the far edge of a panel hinged at its near one.
      this.torn.bonnet.visible = st.bonnet > 0;
      this.torn.bonnet.rotation.x = -st.bonnet;
      // Rolled about Z, so the free end drops across the nose, and pitched a
      // little so it is not a bar lying flat in front of an intact car.
      this.torn.bumper.visible = st.bumper > 0;
      this.torn.bumper.rotation.set(st.bumper * 0.22, 0, -st.bumper);
    }

    this.damageSmoke = st.smoke;
  }

  update(dt, body, state = {}, alpha = 1) {
    const g = this.group;
    if (state.healthFrac !== undefined) this.setDamage(state.healthFrac);

    // Drawn between the last two simulated poses, not at the newest one.
    //
    // The simulation is a fixed 60 Hz and the display is not, and no amount of
    // frame rate makes them line up — so at the last pose alone, a car at two
    // hundred an hour repeats one frame and then jumps ninety centimetres. The
    // loop has always handed the renderer the fraction of a step it is ahead
    // by; this is the first thing to use it.
    const a = clamp01(alpha);
    const px = body.px ?? body.x;
    const py = body.py ?? body.y;
    const pz = body.pz ?? body.z;
    g.position.set(lerp(px, body.x, a), lerp(py, body.y, a), lerp(pz, body.z, a));
    // Heading takes the short way round, or a car crossing north spins on the
    // spot for one frame.
    const pyaw = body.pyaw ?? body.yaw;
    g.rotation.set(0, wrapAngle(pyaw + angleDelta(body.yaw, pyaw) * a), 0);
    // A slope turns the whole car, tyres and all: that is what standing on a
    // hill is, and the wheels have to lie along it.
    g.rotateX(lerp(body.pterrainPitch ?? 0, body.terrainPitch ?? 0, a));
    // Squat, dive and lean turn the body on its springs while the tyres stay
    // put. Applied to `group` instead, they pivoted the car about a point on the
    // tarmac and swung the wheels off it — ten centimetres at five degrees,
    // which is why it was forever hovering or buried.
    this.chassis.rotation.set(
      lerp(body.pbodyPitch ?? 0, body.bodyPitch ?? 0, a), 0,
      lerp(body.proll ?? 0, body.roll, a),
    );

    this._wheelSpin += (body.forwardSpeed / Math.max(0.1, this.wheels[0].radius)) * dt;
    // Negated because a positive rotation.y turns the wheel toward +X, which is
    // the car's left — the same convention the yaw rate has to respect.
    const steerAngle = clamp(-(state.steer ?? 0) * 0.42 + body.slipAngle * 0.5, -0.6, 0.6);
    for (const w of this.wheels) {
      w.spin.rotation.x = this._wheelSpin;
      w.pivot.rotation.y = w.steered ? steerAngle : 0;
    }

    // Lamps. What the car behind you can read: dim red always, hard red the
    // instant you touch the brake, white when you are backing up.
    if (this.lampRear) {
      const reversing = body.forwardSpeed < -0.4;
      const braking = !reversing && (state.brake ?? 0) > 0.05;
      this.lampRearMat.color.setHex(
        reversing ? LAMP_REVERSE : (braking ? LAMP_BRAKE : LAMP_TAIL),
      );
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
    this.cabinMat?.dispose();
    this.cabin?.geometry.dispose();
    this.tornMat?.dispose();
    this.torn?.bonnet.geometry.dispose();
    this.torn?.bumper.geometry.dispose();
    this.lampFrontMat?.dispose();
    this.lampRearMat?.dispose();
    this.hullGlassMat?.dispose();

    // Hull geometry outlives the car.
    //
    // Positions, normals and lamps are cut once per reference and every car of
    // that shape points at the same buffers, so disposing them here would take
    // the shape away from every other car on the grid — and from the next race,
    // since the cache is keyed on the body itself. Only what this car owns is
    // released: its colour attribute goes with `bodyGeo`, which is its own
    // object even when its positions are not.
    const shared = !!this.hullRoot;
    const own = [this.glassGeo, this.trimGeo, this.wheelGeo, this.treadGeo,
      this.hubGeo, this.underglow.geometry];
    if (!shared) {
      own.push(this.bodyGeo, this.lampFront?.geometry, this.lampRear?.geometry);
    } else {
      // Its own container, holding borrowed attributes: disposing the container
      // is right and does not touch them.
      this.bodyGeo?.deleteAttribute('position');
      this.bodyGeo?.deleteAttribute('normal');
      own.push(this.bodyGeo);
    }
    for (const geo of own) {
      geo?.dispose();
    }
    for (const mat of [this.bodyMat, this.glassMat, this.trimMat,
      this.wheelMat, this.treadMat, this.hubMat, this.underglowMat]) {
      mat?.dispose();
    }
    this.group.parent?.remove(this.group);
  }
}
