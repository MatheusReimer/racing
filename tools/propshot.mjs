// Look at one prop, close up, in daylight.
//
// Every judgement about the world's look was being made from a screenshot of a
// night street taken two hundred metres from the nearest building, which is the
// one view in which a wall and a wall with windows in it are the same picture.
// This renders a single generator's output against a neutral ground with a sun
// on it, at whatever angle and distance are asked for, so "does this read as
// voxel" is a question that can actually be looked at.
//
//   node tools/propshot.mjs facade                 one prop, three-quarter view
//   node tools/propshot.mjs facade,mall,tenement   a row of them, side by side
//   ANGLE=180 DIST=1.4 node tools/propshot.mjs mall
//
// Writes shots/prop-<name>.png and prints the triangle count, which is the
// other half of the judgement.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const NAMES = (process.argv[2] || 'facade').split(',');
const OUT = process.argv[3] || `shots/prop-${NAMES.join('-')}.png`;
const W = Number(process.env.W || 1400);
const H = Number(process.env.H || 800);
const ANGLE = Number(process.env.ANGLE || 38);
const DIST = Number(process.env.DIST || 1.0);
const LOD = Number(process.env.LOD || 0);
const BIOME = process.env.BIOME || 'industrial';

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

const info = await page.evaluate(async ({ names, angle, dist, lod, biomeId, w, h }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { PROP_TYPES } = await import('/src/world/props.js');
  const { facetedMaterial } = await import('/src/world/shapes.js');
  const { BIOME_BY_ID, BIOMES } = await import('/src/data/biomes.js');
  const { RNG } = await import('/src/core/rng.js');

  const biome = BIOME_BY_ID[biomeId] ?? BIOMES[0];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fa6bd);

  // Daylight, and deliberately hard. Soft light hides relief, and relief is
  // the entire question being asked here.
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
  sun.position.set(-6, 9, 5);
  scene.add(sun, new THREE.HemisphereLight(0xbcd4ee, 0x53504a, 0.85));

  const group = new THREE.Group();
  const stats = [];
  // Laid out along z, which is the street direction: every frontage in this
  // game faces -x, so a row placed any other way shows its side to the camera
  // and the windows are the half you cannot see.
  let z = 0;
  for (const name of names) {
    const def = PROP_TYPES[name];
    if (!def) { stats.push({ name, error: 'no such prop' }); continue; }
    const ctx = { biome, sides: 10, fine: true, lod };
    const geo = def.build(new RNG(`shot:${name}`), biome.palette, ctx);
    if (!geo) { stats.push({ name, error: 'built nothing' }); continue; }
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    const mesh = new THREE.Mesh(geo, facetedMaterial());
    mesh.position.z = z - b.min.z;
    group.add(mesh);
    if (def.glow) {
      const g = def.glow.fromLayout
        ? def.glow(new RNG(`shotglow:${name}`), ctx.layout)
        : def.glow(new RNG(`shotglow:${name}`), biome.palette, ctx);
      if (g) {
        const lit = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          vertexColors: true, toneMapped: false,
        }));
        lit.position.copy(mesh.position);
        group.add(lit);
      }
    }
    stats.push({
      name,
      tris: (geo.index ? geo.index.count : geo.attributes.position.count) / 3,
      size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(1)),
    });
    z += (b.max.z - b.min.z) + 6;
  }
  scene.add(group);

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4a4a46, roughness: 1 }),
  );
  ground.position.set(mid.x, 0, mid.z);
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(38, w / h, 0.5, 4000);
  const r = Math.max(size.x, size.y, size.z) * 1.35 * dist;
  const a = (angle * Math.PI) / 180;
  camera.position.set(mid.x - Math.cos(a) * r, mid.y + size.y * 0.35, mid.z + Math.sin(a) * r);
  camera.lookAt(mid.x, mid.y * 0.85, mid.z);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setClearColor(0x8fa6bd);
  document.body.replaceChildren(renderer.domElement);
  renderer.render(scene, camera);
  return stats;
}, { names: NAMES, angle: ANGLE, dist: DIST, lod: LOD, biomeId: BIOME, w: W, h: H });

mkdirSync('shots', { recursive: true });
writeFileSync(OUT, await page.screenshot());
console.log(`wrote ${OUT}`);
for (const s of info) {
  console.log(s.error
    ? `  ${s.name}: ${s.error}`
    : `  ${s.name.padEnd(12)} ${String(s.tris).padStart(6)} tris   ${s.size.join(' x ')} m`);
}
if (errors.length) console.log('\nERRORS:\n' + errors.slice(0, 5).join('\n'));
await browser.close();
await server.close?.();
process.exit(errors.length ? 1 : 0);
