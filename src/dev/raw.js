// Mostrar o modelo como ele veio. Nada mais.
//
// The seven files in refs/ are what came off Sketchfab: the author's own
// triangles, the author's own materials, the author's own textures. Every
// other page in this repository reads one of them and produces something
// else — a decimated hull, a class per face, a paint job, a car that drives.
// This page produces nothing. It loads the .glb, adds it to a scene, and
// lights it well enough to be seen.
//
// Nothing here touches the model: no decimation, no material swap, no
// re-centring, no scaling. The camera moves to the car; the car does not
// move to the camera. The numbers in the corner are counted off the loaded
// file rather than decided by anything in src/.
//
// refs/ is gitignored — these are other people's models, three of them
// NonCommercial — so this is a dev page and never ships. `npm run raw`.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { bake, collapse, facetado, arredondado, voxel } from './styles.js';

/** refs/README.txt, as a list. Author and licence travel with the file. */
const REFS = [
  { id: 'roadster', title: '1989 Mazda MX-5 (NA)', by: 'Res1n', lic: 'CC BY' },
  { id: 'hatch', title: '1997 Peugeot 205 GTI', by: 'Maroi Mister', lic: 'CC BY' },
  { id: 'coupe', title: '1999 Nissan Silvia S15 Spec-S Aero', by: 'Ddiaz Design', lic: 'CC BY-NC-SA' },
  { id: 'rotary', title: '1999 Mazda RX-7 FD', by: 'OUTPISTON', lic: 'CC BY-NC-SA' },
  { id: 'gt', title: '1982 Audi Quattro B2', by: 'OUTPISTON', lic: 'CC BY-NC-SA' },
  { id: 'rally', title: 'Impreza WRX STi Version VI (GC8)', by: 'Mona x Supercars', lic: 'CC BY' },
  { id: 'beetle', title: 'VW Beetle', by: 'Parasar2022', lic: 'CC BY' },
];

const el = (id) => document.getElementById(id);
const say = (text, bad = false) => {
  el('say').textContent = text;
  el('say').classList.toggle('bad', bad);
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
// The file says what colour a surface is. Leave that alone: no tone curve,
// no exposure, only the sRGB transfer the display needs.
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

// A room to reflect. Car paint, chrome and glass are metal and clearcoat, and
// without an environment they are black mirrors of nothing. This is the light
// in the room, not a change to the car.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// The four skins, and what each is allowed to spend. The budgets are the
// interesting part: the hull that failed was fifty thousand triangles trying to
// be a smooth car, and every one of these is an order of magnitude under it
// because none of them is trying to be smooth.
const SKINS = {
  cru: { label: 'cru' },
  facetado: { label: 'facetado', tris: 1400 },
  arredondado: { label: 'arredondado', tris: 5000 },
  voxel: { label: 'voxel' },
};

// How fine the grid is, and where it starts. Cubes go with the square of this,
// so each rung is roughly double the last: 46 is about 4,700 cubes on the MX-5
// and 145 about 47,000.
const GRIDS = [46, 72, 100, 145, 200, 280];
let grid = 3;

const loader = new GLTFLoader();
let shown = null;
/** The loaded reference, and the merged geometry every skin is cut from. */
let source = null;
let skin = 'voxel';

/** Frame whatever was loaded, wherever it happens to sit. */
function look(box) {
  const ball = box.getBoundingSphere(new THREE.Sphere());
  const mid = ball.center;
  const reach = ball.radius || 1;
  // Fit the sphere round the car to the narrower of the two field angles, then
  // come in a little: a car is not a sphere and the fit leaves a wide margin.
  const half = (camera.fov * Math.PI) / 360;
  const across = Math.atan(Math.tan(half) * camera.aspect);
  const back = (reach / Math.sin(Math.min(half, across))) * 0.82;
  camera.position.copy(mid).addScaledVector(new THREE.Vector3(0.9, 0.42, 1.1).normalize(), back);
  camera.near = reach / 100;
  camera.far = reach * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(mid);
  controls.update();
}

/** Count what is on screen, by walking it. */
function count(root) {
  let meshes = 0, tris = 0;
  const mats = new Set(), maps = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += o.isInstancedMesh ? per * o.count : per;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      mats.add(m);
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) maps.add(v);
      }
    }
  });
  return { meshes, tris, mats: mats.size, maps: maps.size };
}

/** Take whatever is on screen off it, and give its memory back. */
function clear() {
  if (!shown) return;
  scene.remove(shown);
  shown.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry !== source?.merged) o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
  });
  shown = null;
}

/** Cut the loaded reference into one of the four skins and show that. */
async function wear(name) {
  skin = name;
  for (const b of document.querySelectorAll('#skins b')) b.classList.toggle('on', b.dataset.k === name);
  if (!source) return;

  if (name === 'cru') {
    clear();
    shown = source.gltf;
    scene.add(shown);
    tally(source.raw, 'como veio do Sketchfab.');
    return;
  }

  say(`a cortar ${name}…`);
  // A frame to let that paint, because everything below blocks the thread.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  // The grid reads the whole surface; the other two read a collapse of it.
  let built;
  if (name === 'voxel') {
    built = voxel(source.merged, { cells: GRIDS[grid] });
  } else {
    const budget = SKINS[name].tris;
    let cut = source.cuts.get(budget);
    if (!cut) { cut = await collapse(source.merged, budget); source.cuts.set(budget, cut); }
    built = name === 'facetado' ? facetado(cut) : arredondado(cut);
  }

  clear();
  shown = built;
  scene.add(shown);
  tally(count(built), name === 'voxel'
    ? `${built.count.toLocaleString('pt-PT')} cubos · grelha ${GRIDS[grid]} · [ ] muda`
    : 'gerado a partir da referência, não copiado dela.');
}

/** The line of numbers under the picker. */
function tally(n, note) {
  el('nums').innerHTML =
    `<b>${n.tris >= 10000 ? `${(n.tris / 1000).toFixed(1)}k` : n.tris}</b> triângulos · ` +
    `<b>${n.meshes}</b> ${n.meshes === 1 ? 'malha' : 'malhas'}<br>` +
    `<b>${n.mats}</b> ${n.mats === 1 ? 'material' : 'materiais'} · <b>${n.maps}</b> texturas<br>` +
    `${source.size.x.toFixed(2)} × ${source.size.y.toFixed(2)} × ${source.size.z.toFixed(2)} (unidades do ficheiro)`;
  say(note);
}

async function show(id) {
  const ref = REFS.find((r) => r.id === id);
  el('what').innerHTML = `${ref.title}<br>${ref.by} · ${ref.lic}`;
  el('nums').textContent = '—';
  say('a carregar…');

  let gltf;
  try {
    gltf = await loader.loadAsync(`/refs/${id}.glb`, (e) => {
      if (e.total) say(`a carregar… ${Math.round((e.loaded / e.total) * 100)}%`);
      else say(`a carregar… ${(e.loaded / 1e6).toFixed(1)} MB`);
    });
  } catch (err) {
    say(`não abriu /refs/${id}.glb — ${err.message ?? err}`, true);
    return;
  }

  clear();
  if (source) {
    source.merged.dispose();
    for (const c of source.cuts.values()) c.dispose();
  }

  const box = new THREE.Box3().setFromObject(gltf.scene);
  source = {
    gltf: gltf.scene,
    raw: count(gltf.scene),
    size: box.getSize(new THREE.Vector3()),
    merged: bake(gltf.scene),
    // One collapse per budget, kept: switching skins should be instant after
    // the first look, and the collapse is the slow half.
    cuts: new Map(),
  };
  look(box);
  await wear(skin);
}

const picker = el('car');
for (const r of REFS) {
  const o = document.createElement('option');
  o.value = r.id;
  o.textContent = `${r.id} — ${r.title}`;
  picker.appendChild(o);
}
picker.onchange = () => show(picker.value);

const skins = el('skins');
for (const [k, v] of Object.entries(SKINS)) {
  const b = document.createElement('b');
  b.dataset.k = k;
  b.textContent = v.label;
  b.onclick = () => wear(k);
  skins.appendChild(b);
}
addEventListener('keydown', (e) => {
  const k = Object.keys(SKINS)[Number(e.key) - 1];
  if (k) { wear(k); return; }
  if (e.key !== '[' && e.key !== ']') return;
  const next = grid + (e.key === ']' ? 1 : -1);
  if (next < 0 || next >= GRIDS.length) return;
  grid = next;
  wear('voxel');
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

show(REFS[0].id);
