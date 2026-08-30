// The whole pipeline, end to end: the file the bake wrote, parsed, meshed, and
// drawn. A triangle count says a mesh is affordable; it does not say the
// winding is right or that the car is where it claims to be.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseVox, voxGeometry, coarsen } from '../vehicle/voxmesh.js';

const params = new URLSearchParams(location.search);
const CAR = params.get('car') ?? 'roadster';
const LOD = params.get('lod') === '1';

const res = await fetch(`/bodies/${CAR}.vox`);
if (!res.ok) throw new Error(`sem /bodies/${CAR}.vox`);
let vox = parseVox(await res.arrayBuffer());
if (LOD) vox = coarsen(vox);
const geo = voxGeometry(vox);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11141a);
scene.add(new THREE.HemisphereLight(0xa8c4ff, 0x14181f, 1.5));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.1);
sun.position.set(4, 6, 3);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xbcd2ff, 0.7);
fill.position.set(-4, 2, -5);
scene.add(fill);

const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.62, metalness: 0.04, flatShading: true,
}));
scene.add(mesh);

// The ground the car is meant to be standing on. If a body is baked wrong it
// floats or sinks, and nothing in a triangle count would say so.
const grid = new THREE.GridHelper(12, 24, 0x2b3442, 0x1b2129);
scene.add(grid);

const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.05, 60);
camera.position.set(4.6, 2.1, 5.2);
const controls = new OrbitControls(camera, document.body);
controls.target.set(0, 0.6, 0);
controls.enableDamping = true;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
controls.domElement = renderer.domElement;

geo.computeBoundingBox();
const b = geo.boundingBox;
document.getElementById('say').textContent =
  `${CAR}${LOD ? ' (grosso)' : ''}: ${geo.index.count / 3} triângulos · `
  + `${vox.count} células · ${b.max.z - b.min.z >= 0 ? '' : ''}`
  + `${(b.max.x - b.min.x).toFixed(2)} x ${(b.max.y - b.min.y).toFixed(2)} x ${(b.max.z - b.min.z).toFixed(2)} m · `
  + `chão em y=${b.min.y.toFixed(3)}`;

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
window.__vox = { tris: geo.index.count / 3, cells: vox.count, minY: b.min.y };
