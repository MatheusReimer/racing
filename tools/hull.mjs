// Rebuild a car as a traced hull from an accurate reference.
//
// Superseded by the voxel bake — the game builds its cars from `.vox` grids now
// — and kept because `?smooth` still loads these hulls, and because the class
// pass in `lib/classify.mjs` is shared with tools/decimate.mjs.
//
//   node tools/hull.mjs <model> <name> --length=4.06 [--rings=28] [--radial=16]
//                          [--exclude=a,b] [--wheels=a,b] [--flip]
//
// Where tools/silhouette.mjs measures a reference down to twenty numbers a
// generator can be steered by, this reads the same file and keeps the shape.
//
// It works in cross-sections, like the silhouette tool, but keeps the whole
// outline of each one instead of its width and height. A section is cut by
// intersecting the surface with a plane — never by collecting nearby vertices,
// which samples nothing on a flat panel and samples the interior on a dense one
// — and the outline that falls out is resampled onto a fixed number of angles
// around the section's own centre. Stitching consecutive rings then gives a
// closed hull with quad-strip topology: predictable triangle count, no holes,
// and normals that behave.
//
// Two consequences worth stating plainly:
//
//   - This is a derivative of the reference in a way a table of proportions is
//     not. A measurement of a real car is a fact about the car; a hull traced
//     off somebody's mesh carries their modelling. The licence on the reference
//     applies to what comes out of here, and `source` below records which one.
//   - Undercuts are lost. One radius per angle cannot express a wheel arch that
//     curls back under itself, so arches read as recesses rather than tunnels.
//     That is the trade a single-radius hull makes, and it is why wheels are
//     measured and rebuilt rather than traced.

import { writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { readModel } from './lib/model.mjs';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
if (pos.length < 2) {
  console.log('usage: node tools/hull.mjs <model> <name> --length=4.06'
    + ' [--rings=28] [--radial=16] [--exclude=a,b] [--wheels=a,b] [--flip]');
  process.exit(1);
}
const num = (k, d) => Number(args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d);
const list = (k) => (args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

const file = pos[0];
const NAME = pos[1];
const TARGET_L = num('length', 0);
const RINGS = num('rings', 56);
const RADIAL = num('radial', 32);
const flip = args.includes('--flip');
const exclude = list('exclude');
const asWheels = list('wheels');

const isWheelName = (n) => /wheel|tyre|tire|rim|hub/i.test(n)
  && !/steer|fly ?wheel|arch|well|house|spare|cover/i.test(n);

/**
 * Which part of a car a triangle belongs to, from the material it wears.
 *
 * A hull in one colour is a bar of soap. What stops it being one is knowing
 * that this face is a windscreen and that one is a bumper — and the reference
 * already knows, because whoever built it assigned materials. The names differ
 * per author (`Carro_Vidro`, `NGlassMtl1`, `Headlight_Glass`) but the vocabulary
 * is small and it survives translation, which is more than can be said for the
 * node names: half these files call every node `Object_41`.
 *
 * A class, not a colour. Shipping the reference's own paint would fight the
 * game, where each vehicle picks its own; shipping "this is glass" lets the
 * game paint it and keep the layout.
 */
export const CLS = { PAINT: 0, GLASS: 1, DARK: 2, CHROME: 3, LAMP: 4, INSIDE: 5 };

// Seats, carpet, dashboard, the wheel in front of the driver. Not the outside
// of a car, and so not part of a hull of it — but a ray fired at the greenhouse
// goes straight through the window opening and lands on the upholstery, which
// is how a Beetle came out forty percent black. Dropped before the outline is
// traced, the way wheels are.
const INTERIOR = /interior|\bint_|seat|banco|cloth|carpet|leather|couro|dash|painel|steer|volante|gauge|pedal|belt|cinto/;
function classify(matName) {
  const n = matName.toLowerCase();
  // Not the alpha channel. glTF only honours it when alphaMode says to, and
  // these files disagree about that so thoroughly that the GC8 declares its own
  // bodywork fully transparent across eight thousand triangles. The names are
  // the signal that survived every reference tried: authors differ on spelling
  // but not on vocabulary.
  //
  // A number-plate lamp is not a headlight, and on the GC8 it is the name
  // attached to fifty thousand triangles of car, so the plate words are ruled
  // out before the lamp words are looked for.
  if (/plate|number|placa|licen/.test(n)) return CLS.PAINT;
  if (INTERIOR.test(n)) return CLS.INSIDE;
  if (/light|lamp|farol|lanterna|blink|indicat/.test(n)) return CLS.LAMP;
  if (/glass|vidro|window|janela|screen|glazing|windshield/.test(n)) return CLS.GLASS;
  if (/tire|tyre|pneu|rubber|borracha|interior|\bint_|plastic|plastico|preto|black|seal|rim|roda|wheel|caliper|disc|grille|grelha|trim|espelho|mirror|carpet|cloth|seat|leather/.test(n)) return CLS.DARK;
  if (/chrome|crom|alumin|steel|inox|badge|emblem|bumper|parachoque/.test(n)) return CLS.CHROME;
  return CLS.PAINT;
}

// --- load, split, normalise ------------------------------------------------

const meshes = readModel(file);
const bodyTris = [];
const bodyCls = [];          // one class per triangle, so nine floats to one entry
const wheelTris = [];
let dropped = 0;
for (const m of meshes) {
  const lower = m.name.toLowerCase();
  if (exclude.some((t) => lower.includes(t))) { dropped++; continue; }
  if (isWheelName(m.name) || asWheels.some((t) => lower.includes(t))) {
    for (let i = 0; i < m.tris.length; i++) wheelTris.push(m.tris[i]);
    continue;
  }
  const c = classify(m.mat ?? '');
  if (c === CLS.INSIDE) continue;
  for (let i = 0; i < m.tris.length; i++) bodyTris.push(m.tris[i]);
  for (let i = 0; i < m.tris.length; i += 9) bodyCls.push(c);
}
if (exclude.length && !dropped) throw new Error(`--exclude matched no mesh in ${basename(file)}`);
if (!bodyTris.length) throw new Error('no bodywork left after --exclude/--wheels');

function bounds(...lists) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const t of lists) {
    for (let i = 0; i < t.length; i += 3) {
      if (t[i] < b.x0) b.x0 = t[i]; if (t[i] > b.x1) b.x1 = t[i];
      if (t[i + 1] < b.y0) b.y0 = t[i + 1]; if (t[i + 1] > b.y1) b.y1 = t[i + 1];
      if (t[i + 2] < b.z0) b.z0 = t[i + 2]; if (t[i + 2] > b.z1) b.z1 = t[i + 2];
    }
  }
  return b;
}

const raw = bounds(bodyTris, wheelTris);
const lengthIsZ = (raw.z1 - raw.z0) >= (raw.x1 - raw.x0);
const dir = flip ? -1 : 1;
const scale = TARGET_L > 0
  ? TARGET_L / (lengthIsZ ? raw.z1 - raw.z0 : raw.x1 - raw.x0) : 1;

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
const body = remap(bodyTris);
const wheels = remap(wheelTris);

// Centre on x = 0 and z = 0. Everything downstream assumes the car straddles
// the origin in both, and a reference is under no obligation to have been
// modelled there: the GC8 sits four metres off in x and three in z. Left alone,
// x makes every section measure its distance from the origin instead of its own
// width, and z parks the hull away from the wheels the game puts at the middle.
let bb = bounds(body, wheels);
const xc = (bb.x0 + bb.x1) / 2;
const zc0 = (bb.z0 + bb.z1) / 2;
if (xc !== 0 || zc0 !== 0) {
  for (let i = 0; i < body.length; i += 3) { body[i] -= xc; body[i + 2] -= zc0; }
  for (let i = 0; i < wheels.length; i += 3) { wheels[i] -= xc; wheels[i + 2] -= zc0; }
  bb = bounds(body, wheels);
}
const ground = bb.y0;
const L = bb.z1 - bb.z0;

// --- cross-sections --------------------------------------------------------

/** Every segment where the surface crosses the plane z = zc, as flat [x,y,x,y]. */
function sliceSegments(tris, zc) {
  const out = [];   // x,y, x,y, class  per crossing triangle
  const hit = [];
  for (let i = 0; i < tris.length; i += 9) {
    hit.length = 0;
    for (let e = 0; e < 3; e++) {
      const a = i + e * 3;
      const b = i + ((e + 1) % 3) * 3;
      const za = tris[a + 2];
      const zb = tris[b + 2];
      if ((za < zc && zb < zc) || (za > zc && zb > zc) || za === zb) continue;
      const t = (zc - za) / (zb - za);
      hit.push(tris[a] + (tris[b] - tris[a]) * t, tris[a + 1] + (tris[b + 1] - tris[a + 1]) * t);
    }
    if (hit.length >= 4) out.push(hit[0], hit[1], hit[2], hit[3], bodyCls[i / 9]);
  }
  return out;
}

/**
 * One ring: the outline at `zc`, resampled onto RADIAL fixed angles.
 *
 * Rays are cast from the section's own centre rather than a fixed height, so a
 * bonnet section and a roof section are each sampled across their own extent
 * instead of one of them being squashed into a couple of bins.
 *
 * Segments are walked rather than their endpoints taken: a section of a flat
 * panel is two points a metre apart, and binning only endpoints leaves every
 * angle between them empty.
 */
function ring(zc) {
  const seg = sliceSegments(body, zc);
  if (!seg.length) return null;

  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < seg.length; i += 5) {
    if (seg[i] < y0) y0 = seg[i];
    if (seg[i] > y1) y1 = seg[i];
    if (seg[i + 2] < y0) y0 = seg[i + 2];
    if (seg[i + 2] > y1) y1 = seg[i + 2];
  }
  const cy = (y0 + y1) / 2;

  const r = new Float64Array(RADIAL);
  const cls = new Int8Array(RADIAL).fill(-1);
  // Furthest reach of each class separately, so a surface that loses the radius
  // contest by a centimetre can still win the material one.
  const perClass = Array.from({ length: 5 }, () => new Float64Array(RADIAL));
  const step = (Math.PI * 2) / RADIAL;
  const put = (x, y, c) => {
    const dy = y - cy;
    const rad = Math.hypot(x, dy);
    if (rad <= 0) return;
    let k = Math.round(Math.atan2(dy, x) / step);
    k = ((k % RADIAL) + RADIAL) % RADIAL;
    if (rad > r[k]) r[k] = rad;
    if (rad > perClass[c][k]) perClass[c][k] = rad;
  };
  for (let i = 0; i < seg.length; i += 5) {
    const ax = seg[i];
    const ay = seg[i + 1];
    const bx = seg[i + 2];
    const by = seg[i + 3];
    const c = seg[i + 4];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.008));
    for (let t = 0; t <= n; t++) put(ax + (bx - ax) * (t / n), ay + (by - ay) * (t / n), c);
  }

  // Resolve each angle to one material.
  //
  // Not simply the outermost surface: on a real car the glass is set inboard of
  // the pillars that frame it and a headlight sits behind the bodywork line, so
  // taking the furthest thing at each angle paints a car with no windows. Any
  // class reaching within a couple of centimetres of the outermost surface is
  // treated as being at that angle too, and the more particular one wins —
  // paint is what the rest of a car is, so it only takes an angle nothing else
  // claims.
  // Five centimetres, not one. A windscreen sits behind its pillars, a side
  // window behind the drip rail and the door top, and a headlight behind the
  // bodywork around it — on a real car these are not flush and the recess is
  // several centimetres, so a tight tolerance paints a car with no windows.
  const TOL = 0.05;
  const PRIORITY = [CLS.LAMP, CLS.GLASS, CLS.CHROME, CLS.DARK, CLS.PAINT];
  for (let k = 0; k < RADIAL; k++) {
    if (r[k] <= 0) continue;
    for (const c of PRIORITY) {
      if (perClass[c][k] > 0 && perClass[c][k] >= r[k] - TOL) { cls[k] = c; break; }
    }
  }

  // A car is symmetric; a scan of one is not quite. Taking the wider side of
  // each mirrored pair keeps the silhouette and drops the asymmetry.
  for (let k = 0; k < RADIAL; k++) {
    const m = ((RADIAL / 2 - k) % RADIAL + RADIAL) % RADIAL;
    if (r[k] >= r[m]) { r[m] = r[k]; cls[m] = cls[k]; } else { r[k] = r[m]; cls[k] = cls[m]; }
  }
  // Angles the outline never reached — fill from whichever neighbours did.
  for (let k = 0; k < RADIAL; k++) {
    if (r[k] > 0) continue;
    let a = k;
    let b = k;
    for (let t = 1; t < RADIAL; t++) {
      if (r[(k - t + RADIAL) % RADIAL] > 0) { a = (k - t + RADIAL) % RADIAL; break; }
    }
    for (let t = 1; t < RADIAL; t++) {
      if (r[(k + t) % RADIAL] > 0) { b = (k + t) % RADIAL; break; }
    }
    r[k] = (r[a] + r[b]) / 2 || 0.01;
    cls[k] = cls[a] >= 0 ? cls[a] : 0;
  }
  for (let k = 0; k < RADIAL; k++) if (cls[k] < 0) cls[k] = 0;

  // A light 1-2-1 around the ring. At sixteen radii the bins were wide enough
  // to average their own noise; at thirty-two a single stray triangle owns a
  // bin outright and the hull grows a tooth. Smoothing is what buys the extra
  // resolution back as detail instead of as sawtooth.
  const sm = new Float64Array(RADIAL);
  for (let k = 0; k < RADIAL; k++) {
    const a = r[(k - 1 + RADIAL) % RADIAL];
    const b = r[(k + 1) % RADIAL];
    sm[k] = (a + r[k] * 2 + b) / 4;
  }

  // Classes get a majority vote over the same neighbourhood, so a lone face of
  // chrome in the middle of a door does not stipple the panel.
  const sc = new Int8Array(RADIAL);
  for (let k = 0; k < RADIAL; k++) {
    const a = cls[(k - 1 + RADIAL) % RADIAL];
    const b = cls[(k + 1) % RADIAL];
    // Glass and lamps survive the vote on their own: they are small by nature
    // and outvoting them is how a greenhouse turns back into sheet metal.
    sc[k] = (cls[k] === CLS.GLASS || cls[k] === CLS.LAMP
      || cls[k] === a || cls[k] === b) ? cls[k] : (a === b ? a : cls[k]);
  }
  return { z: zc, cy, r: Array.from(sm), cls: Array.from(sc) };
}

const rings = [];
for (let i = 0; i < RINGS; i++) {
  const t = i / (RINGS - 1);
  const zc = bb.z1 - (0.002 + t * 0.996) * L;      // a plane exactly at the nose cuts nothing
  const g = ring(zc);
  if (g) rings.push(g);
}
if (rings.length < 4) throw new Error('too few sections — is the model hollow?');

// The same 1-2-1 along the car. A section is measured independently of its
// neighbours, so a panel gap or a shut line lands in one station and nowhere
// near the next, and the hull ripples along its length instead of across it.
{
  const src = rings.map((g) => g.r.slice());
  const cys = rings.map((g) => g.cy);
  for (let i = 1; i < rings.length - 1; i++) {
    for (let k = 0; k < RADIAL; k++) {
      rings[i].r[k] = (src[i - 1][k] + src[i][k] * 2 + src[i + 1][k]) / 4;
    }
    rings[i].cy = (cys[i - 1] + cys[i] * 2 + cys[i + 1]) / 4;
  }
}

// --- wheels ----------------------------------------------------------------
//
// Measured, never traced. One radius per angle cannot describe an arch that
// curls under itself, so the game rebuilds wheels from these four numbers
// rather than trying to keep the reference's.
let wheel = null;
if (wheels.length) {
  const wb = bounds(wheels);
  const zMid = (bb.z0 + bb.z1) / 2;
  let fS = 0; let fN = 0; let rS = 0; let rN = 0; let maxX = 0; let tx0 = Infinity; let tx1 = -Infinity;
  for (let i = 0; i < wheels.length; i += 3) {
    const z = wheels[i + 2] - zMid;
    if (z >= 0) { fS += z; fN++; } else { rS += z; rN++; }
    maxX = Math.max(maxX, Math.abs(wheels[i]));
    if (wheels[i] > 0) { tx0 = Math.min(tx0, wheels[i]); tx1 = Math.max(tx1, wheels[i]); }
  }
  wheel = {
    radius: +((wb.y1 - wb.y0) / 2).toFixed(3),
    width: +(Number.isFinite(tx0) ? tx1 - tx0 : 0.2).toFixed(3),
    front: +(zMid + (fN ? fS / fN : 0)).toFixed(3),
    rear: +(zMid + (rN ? rS / rN : 0)).toFixed(3),
    track: +(maxX * 2).toFixed(3),
  };
}

// Plenty of references bury the tyre in the bodywork and leave only a rim
// separable, or nothing at all. Rather than let the hull ship a wheel the car
// never had, the four numbers can be given outright — from the tyre code on the
// real car, which is a fact about it in exactly the way the hull is not.
//
//   --wheel=diameter,width,front,rear   (a dash keeps whatever was measured)
const override = (args.find((a) => a.startsWith('--wheel=')) ?? '').slice(8).split(',');
if (override.length > 1) {
  const pick = (i, was) => (override[i] && override[i] !== '-' ? Number(override[i]) : was);
  wheel = {
    radius: +(pick(0, (wheel?.radius ?? 0.3) * 2) / 2).toFixed(3),
    width: +pick(1, wheel?.width ?? 0.2).toFixed(3),
    front: +pick(2, wheel?.front ?? L * 0.3).toFixed(3),
    rear: +pick(3, wheel?.rear ?? -L * 0.3).toFixed(3),
    track: wheel?.track ?? null,
    measured: false,
  };
} else if (wheel) {
  wheel.measured = true;
}

// --- emit ------------------------------------------------------------------

const f3 = (v) => +v.toFixed(3);
const out = {
  name: NAME,
  source: basename(file),
  length: f3(L),
  width: f3(bb.x1 - bb.x0),
  height: f3(bb.y1 - ground),
  ground: f3(ground),
  radial: RADIAL,
  wheel,
  rings: rings.map((g) => [f3(g.z), f3(g.cy), ...g.r.map(f3)]),
  classes: rings.map((g) => g.cls),
};

mkdirSync('src/data/bodies', { recursive: true });
const path = `src/data/bodies/${NAME}.js`;
writeFileSync(path, `// ${NAME} — traced hull from ${basename(file)} by tools/hull.mjs.
//
// ${rings.length} sections of ${RADIAL} radii. Each 'rings' row is [z, cy, r0..r${RADIAL - 1}]: a
// station along the car, the height its outline is centred on, and the distance
// to the surface at each of ${RADIAL} angles around that centre, starting at the right
// flank and turning towards the roof. Metres, nose at +Z, car centred on x = 0.
//
// 'classes' matches it angle for angle and says what the surface is made of,
// read off the material the reference gave that triangle:
// 0 paint, 1 glass, 2 dark trim or rubber, 3 chrome, 4 lamp. The game picks the
// colours; this only says where the windows are.
//
// Derived geometry: the reference's licence applies. See refs/README.txt.
export default ${JSON.stringify(out, null, 2).replace(/\n\s+(-?[\d.]+),/g, ' $1,').replace(/\[\s+/g, '[')};
`);

const tris = (rings.length - 1) * RADIAL * 2 + RADIAL * 2;
console.log(`${basename(file)} -> ${path}`);
console.log(`  ${out.length} x ${out.width} x ${out.height} m`
  + (wheel ? `, wheels r=${wheel.radius} at z=${wheel.front}/${wheel.rear}` : ', no wheels found'));
console.log(`  ${rings.length} sections x ${RADIAL} radii = ${tris} triangles`);
