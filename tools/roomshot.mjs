// Look into a room.
//
// The chase camera sits at bumper height a car's length behind the car, which
// is the worst possible place to judge a room from: it sees floor, a skirting
// board and whichever wall is nearest. This drops the camera into a corner near
// the ceiling and looks across, which is how anybody photographs a room.
//
//   node tools/roomshot.mjs kitchen
//   node tools/roomshot.mjs kitchen,bathroom,bedroom,living
//   ANGLE=200 node tools/roomshot.mjs toyroom

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const NAMES = (process.argv[2] || 'kitchen').split(',');
const OUT = process.argv[3] || `shots/room-${NAMES.join('-')}.png`;
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 800);
const ANGLE = Number(process.env.ANGLE || 35);

const server = await ensureServer();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });

const info = await page.evaluate(async ({ names, angle, w, h }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { buildHouse } = await import('/src/world/rooms.js');
  const { ROOMS, ROOM_W, ROOM_D } = await import('/src/track/house.js');
  const { BIOME_BY_ID } = await import('/src/data/biomes.js');
  const { RNG } = await import('/src/core/rng.js');

  const biome = BIOME_BY_ID.house;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#20242c');

  // Lit like a room with the ceiling light on: broad, from above, warm.
  scene.add(new THREE.HemisphereLight(0xffe9c8, 0x50483c, 2.6));
  const key = new THREE.DirectionalLight(0xfff3dc, 1.5);
  key.position.set(2, 12, 3);
  scene.add(key);

  const group = new THREE.Group();
  const stats = [];
  let z = 0;
  for (const name of names) {
    const theme = ROOMS.find((r) => r.id === name);
    if (!theme) { stats.push({ name, error: 'no such room' }); continue; }
    // A one-room house, so `buildHouse` is exercised exactly as the game does.
    const fake = {
      layout: {
        rows: 1, cols: 1,
        rooms: [{ cell: [0, 0], theme, x: 0, z }],
        doorways: [{ x: ROOM_W / 2, z, nx: 0, nz: 1, a: [0, 0], b: [1, 0] }],
      },
    };
    const built = buildHouse(fake, biome, new RNG(`room:${name}`));
    if (!built) { stats.push({ name, error: 'built nothing' }); continue; }
    group.add(built);
    const geo = built.children[0].geometry;
    stats.push({ name, tris: (geo.index ? geo.index.count : geo.attributes.position.count) / 3 });
    z += ROOM_D + 8;
  }
  scene.add(group);

  const box = new THREE.Box3().setFromObject(group);
  const mid = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const camera = new THREE.PerspectiveCamera(52, w / h, 0.5, 4000);
  // Inside the room, high in a corner, looking down across it.
  //
  // `r` has to be *less* than the room's half-extent or the camera stands in
  // the wall — which is what the first attempt did, and the picture was a flat
  // field of wallpaper with a triangle of daylight in the corner.
  const r = Math.min(size.x, size.z) * 0.34;
  const a = (angle * Math.PI) / 180;
  camera.position.set(mid.x - Math.cos(a) * r, 21, mid.z + Math.sin(a) * r);
  camera.lookAt(mid.x + Math.cos(a) * r, 3, mid.z - Math.sin(a) * r);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  document.body.replaceChildren(renderer.domElement);
  renderer.render(scene, camera);
  return stats;
}, { names: NAMES, angle: ANGLE, w: W, h: H });

mkdirSync('shots', { recursive: true });
writeFileSync(OUT, await page.screenshot());
console.log(`wrote ${OUT}`);
for (const s of info) {
  console.log(s.error ? `  ${s.name}: ${s.error}` : `  ${s.name.padEnd(10)} ${s.tris} tris`);
}
if (errors.length) console.log('\nERRORS:\n' + errors.slice(0, 5).join('\n'));
await browser.close();
await server.close?.();
process.exit(errors.length ? 1 : 0);
