// Say what a part of a car is, by drawing a crate round it.
//
// The classifier reads material names and colours. On a thirty-year-old model
// that gets you `carpaint`, `black`, `chrome` and — for a hundred and sixty
// thousand triangles of the MX-5 — `material`, and no rule can tell which patch
// of `material` is an indicator lens. A person looking at the car can.
//
// What that person is fixing is almost never a solid patch. Measured over the
// seven references: 58% of the 205 comes out `dark`, 24% of the MX-5 comes out
// `chrome`, 26% of the RX-7 comes out `lamp` — and it is scattered *through*
// panels that are otherwise right, in slivers a few centimetres across. There
// are thousands of them. Clicking each one was the first version of this tool
// and it is hopeless: an eight-centimetre ball moves three to thirty faces of
// fifty thousand, which is invisible, and a ball big enough to cover a wing
// reaches through the car and takes the interior and the far side with it.
//
// So a mark here is a crate and a rule — "the chrome in this crate is paint".
// Draw it coarsely, round the whole wing; the `from` filter is what keeps it
// off the faces that were already right. The car rebuilds under the cursor, so
// a crate is right or wrong immediately rather than after a reload.
//
// What gets saved is that crate, in the body's own coordinates. Not a triangle
// index — an index dies the moment anyone re-bakes a hull, and re-baking is a
// live possibility, while a box in space is a statement about the *car*.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadHulls, HULLS, HULL_NAMES } from '../data/bodies/index.js';
import { MARKS, MARK_KINDS, countMark, boxOf } from '../data/bodies/marks.js';
import {
  VehicleMesh, visualProfile, clearHullCache, hullClasses, faceCentres,
} from '../vehicle/chassis.js';
import { Build } from '../build/build.js';
import { VEHICLES } from '../data/vehicles.js';

const KIND_COLOUR = {
  paint: 0xd8dde3, glass: 0x2b3a52, dark: 0x2a2f38,
  chrome: 0x9aa3b0, lamp: 0xffe9b8, remove: 0xe2685f,
};
const KINDS = Object.keys(MARK_KINDS);
/** Class id back to name, for the readout under the cursor. */
const KIND_OF = [];
for (const [k, v] of Object.entries(MARK_KINDS)) KIND_OF[v] = k;
/** What `from` says when it says nothing. Written to a mark as no `from` at all. */
const ANY = 'tudo';

const el = (id) => document.getElementById(id);
const say = (text, bad = false) => {
  el('say').textContent = text;
  el('say').classList.toggle('bad', bad);
};

await loadHulls();

// Which body belongs to which car, so the picker reads like the game.
const BY_BODY = {};
for (const v of VEHICLES) BY_BODY[v.bodyType] = v;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.add(new THREE.HemisphereLight(0xa8c4ff, 0x14181f, 1.5));
const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
key.position.set(3, 6, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xbcd2ff, 0.8);
fill.position.set(-4, 2, -3);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 60);
camera.position.set(3.2, 1.6, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.6, 0);
controls.enableDamping = true;

// --- state -----------------------------------------------------------------

const wanted = new URLSearchParams(location.search).get('car');
let body = HULL_NAMES.includes(wanted) ? wanted : 'roadster';
let from = ANY;
let to = 'paint';
let pad = 0.02;
let mirror = true;
let mesh = null;
/** First corner of the crate being drawn, in body coordinates, or null. */
let corner = null;
/** What each face of this hull currently is, and where each face is. */
let classes = null;
let centres = null;

const gizmos = new THREE.Group();
const marksOf = (name) => (MARKS[name] ??= []);

/**
 * Rebuild the car with the marks as they stand.
 *
 * The cut geometry is cached per hull, so the cache has to go or the change
 * does not show — which is the whole point of doing this in front of the car
 * instead of in a text editor.
 */
function rebuild() {
  gizmos.removeFromParent();
  if (mesh) { scene.remove(mesh.group); mesh.dispose(); }
  const hull = HULLS[body];
  clearHullCache(hull);
  const def = BY_BODY[body] ?? VEHICLES[0];
  const build = new Build(def.id);
  mesh = new VehicleMesh(
    visualProfile(build.stats.all(), build.tags, def), { shadows: false });
  mesh.group.rotation.y = 0;
  scene.add(mesh.group);
  // The gizmos hang off the hull's own node, so a crate drawn in body
  // coordinates lands exactly where the faces it selects are — the node
  // carries the car's size, and a gizmo in scene space would drift from the
  // car by however much the build stretched it.
  (mesh.hullRoot ?? mesh.group).add(gizmos);
  classes = hullClasses(hull);
  centres ??= faceCentres(hull);
  drawGizmos();
  showHist();
}

/** The marks themselves, as crates you can see through. */
function drawGizmos() {
  // Rebuilt on every pointer move while a crate is being drawn, so what it
  // made last time has to go back — a leak here is a leak per mouse move.
  gizmos.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  gizmos.clear();
  const ground = HULLS[body]?.ground ?? 0;
  for (const m of marksOf(body)) {
    const b = boxOf(m);
    if (!b) continue;
    const colour = KIND_COLOUR[m.is] ?? 0xffffff;
    for (const s of m.mirror === false ? [1] : [1, -1]) {
      const min = new THREE.Vector3(Math.min(b[0] * s, b[3] * s), b[1] - ground, b[2]);
      const max = new THREE.Vector3(Math.max(b[0] * s, b[3] * s), b[4] - ground, b[5]);
      gizmos.add(crate(new THREE.Box3(min, max), colour, 0.10));
    }
  }
  if (corner) gizmos.add(pendingCrate());
  el('cnt').textContent = String(marksOf(body).length);
}

/** One crate: a wire box, so you can see the car through it, with a faint fill. */
function crate(box3, colour, fill = 0.10) {
  const size = box3.getSize(new THREE.Vector3());
  const at = box3.getCenter(new THREE.Vector3());
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(
    Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4));
  const lines = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: colour }));
  const solid = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity: fill, depthWrite: false,
  }));
  g.add(lines, solid);
  g.position.copy(at);
  return g;
}

/** The crate being drawn, from the first corner to wherever the cursor is. */
function pendingCrate() {
  const b = boxOf({ box: pendingBox() });
  const ground = HULLS[body]?.ground ?? 0;
  return crate(
    new THREE.Box3(
      new THREE.Vector3(b[0], b[1] - ground, b[2]),
      new THREE.Vector3(b[3], b[4] - ground, b[5])),
    0x4fa3e3, 0.06);
}

/**
 * Corner to corner, plus the slack, in body coordinates.
 *
 * The end defaults to the cursor, which is what the preview follows, but a
 * click passes its own point: a touch device never hovers, and on a mouse the
 * pointer can leave the car between the move and the release.
 */
function pendingBox(end = hover ?? corner) {
  return [
    Math.min(corner[0], end[0]) - pad, Math.min(corner[1], end[1]) - pad,
    Math.min(corner[2], end[2]) - pad,
    Math.max(corner[0], end[0]) + pad, Math.max(corner[1], end[1]) + pad,
    Math.max(corner[2], end[2]) + pad,
  ];
}

/** The mark the pending crate would write. */
const pendingMark = (end) => ({
  box: pendingBox(end).map((v) => Number(v.toFixed(4))),
  is: to,
  ...(from === ANY ? {} : { from }),
  ...(mirror ? {} : { mirror: false }),
});

/** What this car is made of now, so you know what you are fighting. */
function showHist() {
  const tally = new Array(6).fill(0);
  for (const c of classes) tally[c]++;
  el('hist').textContent = KINDS
    .map((k, i) => (tally[i] ? `${k} ${Math.round((tally[i] / classes.length) * 100)}%` : ''))
    .filter(Boolean).join(' · ');
}

// --- picking ---------------------------------------------------------------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let dragged = false;
/** Where the cursor is on the car, in body coordinates, or null. */
let hover = null;

/** Only the hull's own meshes. A hit on a wheel is not a statement about a hull. */
const targets = () => [...(mesh?.bodyParts ?? []), mesh?.hullGlass,
  mesh?.lampFront, mesh?.lampRear].filter(Boolean);

/**
 * Where on the car the pointer is, in the body's own coordinates.
 *
 * Through the hull's node rather than the mesh that was hit: the node carries
 * the car's size, and every hull mesh hangs off it untransformed, so one
 * inverse serves the body, the glass and both lamps. Then the ground offset the
 * cut took out goes back on.
 */
function pointAt(e) {
  if (!mesh) return null;
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(targets(), false)[0];
  if (!hit) return null;
  const p = (mesh.hullRoot ?? mesh.group).worldToLocal(hit.point.clone());
  return [p.x, p.y + (HULLS[body]?.ground ?? 0), p.z];
}

/** What the face nearest a point is. Nothing, if the nearest one is far away. */
function classAt(at, reach = 0.12) {
  if (!centres || !classes) return -1;
  const { cx, cy, cz } = centres;
  let best = -1;
  let bd = reach * reach;
  for (let t = 0; t < classes.length; t++) {
    const d = (cx[t] - at[0]) ** 2 + (cy[t] - at[1]) ** 2 + (cz[t] - at[2]) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best < 0 ? -1 : classes[best];
}

renderer.domElement.addEventListener('pointerdown', () => { dragged = false; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) { dragged = true; return; }
  hover = pointAt(e);
  const c = hover ? classAt(hover) : -1;
  el('here').textContent = c < 0 ? '—' : KIND_OF[c];
  el('here').style.color = c < 0 ? '#8894a8'
    : `#${(KIND_COLOUR[KIND_OF[c]] ?? 0xffffff).toString(16).padStart(6, '0')}`;
  if (corner && hover) {
    // The crate as it stands, and what it would do — before you commit to it.
    drawGizmos();
    const n = countMark(classes, centres, pendingMark());
    const b = pendingBox();
    const cm = (i) => Math.round((b[i + 3] - b[i]) * 100);
    say(`${cm(0)}×${cm(1)}×${cm(2)} cm — ${n} faces`);
  }
});

renderer.domElement.addEventListener('pointerup', (e) => {
  // Orbiting is not clicking. Without this every turn of the car drops a mark.
  if (dragged || !mesh) return;
  const at = pointAt(e);
  if (!at) { say('nada ali', true); return; }

  // Alt: the eyedropper. What you point at is what the crate will look for,
  // which beats guessing at a class name for a grey sliver.
  if (e.altKey) {
    const c = classAt(at);
    if (c < 0) { say('nada ali', true); return; }
    setFrom(KIND_OF[c]);
    say(`de: ${KIND_OF[c]}`);
    return;
  }

  if (e.shiftKey) {
    // The crate you pointed into, gone. The smallest one, so a correction laid
    // over a big crate comes off before the crate under it.
    const list = marksOf(body);
    let best = -1;
    let bv = Infinity;
    list.forEach((m, i) => {
      const b = boxOf(m);
      if (!b) return;
      for (const s of m.mirror === false ? [1] : [1, -1]) {
        const x = at[0] * s;
        if (x < b[0] || x > b[3] || at[1] < b[1] || at[1] > b[4]
          || at[2] < b[2] || at[2] > b[5]) continue;
        const v = (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
        if (v < bv) { bv = v; best = i; }
      }
    });
    if (best < 0) { say('nenhuma caixa aqui', true); return; }
    list.splice(best, 1);
    rebuild();
    say('apagada');
    return;
  }

  if (!corner) {
    corner = at;
    hover = at;
    drawGizmos();
    say('canto A — clique o canto oposto (Esc cancela)');
    return;
  }

  const mark = pendingMark(at);
  const n = countMark(classes, centres, mark);
  corner = null;
  if (!n) {
    drawGizmos();
    say(`nenhuma face ${from === ANY ? '' : `${from} `}nessa caixa`, true);
    return;
  }
  marksOf(body).push(mark);
  rebuild();
  say(`${from === ANY ? 'tudo' : from} → ${to}: ${n} faces`);
});

// --- controls --------------------------------------------------------------

/** One row of buttons: what a crate looks for, or what it makes. */
function row(id, names, pick) {
  const boxEl = el(id);
  for (const k of names) {
    const b = document.createElement('b');
    b.textContent = k;
    b.style.color = `#${(KIND_COLOUR[k] ?? 0x8894a8).toString(16).padStart(6, '0')}`;
    b.dataset.kind = k;
    b.onclick = () => pick(k);
    boxEl.appendChild(b);
  }
  return (on) => {
    for (const b of boxEl.children) b.classList.toggle('on', b.dataset.kind === on);
  };
}

const showFrom = row('from', [ANY, ...KINDS], (k) => setFrom(k));
const showTo = row('to', KINDS, (k) => setTo(k));
function setFrom(k) { from = k; showFrom(k); }
function setTo(k) { to = k; showTo(k); }
setFrom(from);
setTo(to);

const carBox = el('car');
for (const n of HULL_NAMES) {
  const o = document.createElement('option');
  o.value = n;
  o.textContent = BY_BODY[n] ? `${BY_BODY[n].name} (${n})` : n;
  carBox.appendChild(o);
}
carBox.value = body;
carBox.onchange = () => {
  body = carBox.value;
  corner = null;
  centres = null;
  // So a reload comes back to the car you were working on.
  history.replaceState(null, '', `?car=${body}`);
  rebuild();
  say('');
};

function setPad(p) {
  pad = Math.max(0, Math.min(0.30, p));
  el('pad').textContent = String(Math.round(pad * 100));
  if (corner) drawGizmos();
}
setPad(pad);

async function save() {
  const marks = marksOf(body);
  const res = await fetch('/__marks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: body, marks }),
  });
  const out = await res.json().catch(() => ({ ok: false, error: 'resposta ilegível' }));
  if (out.ok) say(`salvo: ${out.wrote} marcas em public/marks/${body}.json`);
  else say(`não salvou: ${out.error}`, true);
}

addEventListener('keydown', (e) => {
  const i = Number(e.key) - 1;
  if (i >= 0 && i < KINDS.length) { setTo(KINDS[i]); return; }
  if (e.key === '[') setPad(pad - 0.01);
  if (e.key === ']') setPad(pad + 0.01);
  if (e.key === 'Escape' && corner) {
    corner = null;
    drawGizmos();
    say('cancelada');
  }
  const k = e.key.toLowerCase();
  if (k === 'd') {
    // Round the sources, including "tudo" — the eyedropper is the fast way in,
    // this is the way back out.
    const all = [ANY, ...KINDS];
    setFrom(all[(all.indexOf(from) + 1) % all.length]);
  }
  if (k === 'm') {
    mirror = !mirror;
    el('mir').textContent = mirror ? 'sim' : 'não';
    if (corner) drawGizmos();
  }
  if (k === 'z') {
    if (marksOf(body).pop()) { rebuild(); say('desfeita'); }
  }
  if (k === 's') save();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

rebuild();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
