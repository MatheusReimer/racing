// Say what a part of a car is, by pointing at it.
//
// The classifier reads material names and colours. On a thirty-year-old model
// that gets you `carpaint`, `black`, `chrome` and — for a hundred and sixty
// thousand triangles of the MX-5 — `material`, and no rule can tell which patch
// of `material` is an indicator lens. A person looking at the car can.
//
// So: orbit, click the thing, say what it is. The car rebuilds under the
// cursor, so a mark is right or wrong immediately rather than after a reload.
//
// What gets saved is a sphere in the body's own coordinates. Not a triangle
// index — an index dies the moment anyone re-bakes a hull, and re-baking is a
// live possibility, while a point in space is a statement about the *car*.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadHulls, HULLS, HULL_NAMES } from '../data/bodies/index.js';
import { MARKS, MARK_KINDS, loadMarks } from '../data/bodies/marks.js';
import { VehicleMesh, visualProfile, clearHullCache } from '../vehicle/chassis.js';
import { Build } from '../build/build.js';
import { VEHICLES } from '../data/vehicles.js';

const KIND_COLOUR = {
  paint: 0xd8dde3, glass: 0x2b3a52, dark: 0x2a2f38,
  chrome: 0x9aa3b0, lamp: 0xffe9b8, remove: 0xe2685f,
};
const KINDS = Object.keys(MARK_KINDS);

const say = (text, bad = false) => {
  const el = document.getElementById('say');
  el.textContent = text;
  el.classList.toggle('bad', bad);
};

await loadHulls();
await loadMarks(HULL_NAMES);

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

let body = 'roadster';
let kind = 'dark';
let radius = 0.08;
let mirror = true;
let mesh = null;
const gizmos = new THREE.Group();
scene.add(gizmos);

const marksOf = (name) => (MARKS[name] ??= []);

/**
 * Rebuild the car with the marks as they stand.
 *
 * The cut geometry is cached per hull, so the cache has to go or the change
 * does not show — which is the whole point of doing this in front of the car
 * instead of in a text editor.
 */
function rebuild() {
  if (mesh) { scene.remove(mesh.group); mesh.dispose(); }
  clearHullCache(HULLS[body]);
  const def = BY_BODY[body] ?? VEHICLES[0];
  const build = new Build(def.id);
  mesh = new VehicleMesh(
    visualProfile(build.stats.all(), build.tags, def), { shadows: false });
  mesh.group.rotation.y = 0;
  scene.add(mesh.group);
  drawGizmos();
}

/** The marks themselves, as spheres you can see through. */
function drawGizmos() {
  gizmos.clear();
  const ground = HULLS[body]?.ground ?? 0;
  for (const m of marksOf(body)) {
    const geo = new THREE.SphereGeometry(m.r ?? 0.08, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: KIND_COLOUR[m.is] ?? 0xffffff, transparent: true, opacity: 0.28,
      depthWrite: false,
    });
    const sides = m.mirror === false ? [1] : [1, -1];
    for (const s of sides) {
      const ball = new THREE.Mesh(geo, mat);
      ball.position.set(m.at[0] * s, m.at[1] - ground, m.at[2]);
      gizmos.add(ball);
    }
  }
  document.getElementById('cnt').textContent = String(marksOf(body).length);
}

// --- picking ---------------------------------------------------------------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let dragged = false;

renderer.domElement.addEventListener('pointerdown', () => { dragged = false; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) dragged = true;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  // Orbiting is not clicking. Without this every turn of the car drops a mark.
  if (dragged || !mesh) return;
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(mesh.group, true)
    .find((h) => h.object.isMesh && h.object !== gizmos);
  if (!hit) { say('nada ali', true); return; }

  // Into the body's own coordinates: undo the node's scale, then put back the
  // ground offset the cut took out.
  const local = hit.object.worldToLocal(hit.point.clone());
  const ground = HULLS[body]?.ground ?? 0;
  const at = [local.x, local.y + ground, local.z];

  if (e.shiftKey) {
    // Nearest mark to where you pointed, gone.
    const list = marksOf(body);
    let best = -1;
    let bd = Infinity;
    list.forEach((m, i) => {
      for (const s of m.mirror === false ? [1] : [1, -1]) {
        const d = (m.at[0] * s - at[0]) ** 2 + (m.at[1] - at[1]) ** 2 + (m.at[2] - at[2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    });
    if (best < 0) { say('não há marcas', true); return; }
    list.splice(best, 1);
    say('apagada');
  } else {
    marksOf(body).push({
      at: at.map((v) => Number(v.toFixed(4))),
      r: Number(radius.toFixed(3)),
      is: kind,
      ...(mirror ? {} : { mirror: false }),
    });
    say(`${kind} em ${at.map((v) => v.toFixed(2)).join(', ')}`);
  }
  rebuild();
});

// --- controls --------------------------------------------------------------

const kindsBox = document.getElementById('kinds');
for (const k of KINDS) {
  const b = document.createElement('b');
  b.textContent = k;
  b.style.color = `#${(KIND_COLOUR[k] ?? 0xffffff).toString(16).padStart(6, '0')}`;
  b.onclick = () => setKind(k);
  b.dataset.kind = k;
  kindsBox.appendChild(b);
}
function setKind(k) {
  kind = k;
  for (const b of kindsBox.children) b.classList.toggle('on', b.dataset.kind === k);
}
setKind(kind);

const carBox = document.getElementById('car');
for (const n of HULL_NAMES) {
  const o = document.createElement('option');
  o.value = n;
  o.textContent = BY_BODY[n] ? `${BY_BODY[n].name} (${n})` : n;
  carBox.appendChild(o);
}
carBox.value = body;
carBox.onchange = () => { body = carBox.value; rebuild(); say(''); };

function setRadius(r) {
  radius = Math.max(0.02, Math.min(0.6, r));
  document.getElementById('rad').textContent = String(Math.round(radius * 100));
}
setRadius(radius);

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
  if (i >= 0 && i < KINDS.length) { setKind(KINDS[i]); return; }
  if (e.key === '[') setRadius(radius - 0.01);
  if (e.key === ']') setRadius(radius + 0.01);
  if (e.key.toLowerCase() === 'm') {
    mirror = !mirror;
    document.getElementById('mir').textContent = mirror ? 'sim' : 'não';
  }
  if (e.key.toLowerCase() === 'z') {
    if (marksOf(body).pop()) { rebuild(); say('desfeita'); }
  }
  if (e.key.toLowerCase() === 's') save();
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
