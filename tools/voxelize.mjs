// Bake every body to a voxel grid.
//
//   node tools/voxelize.mjs            # all seven, grid 145
//   node tools/voxelize.mjs rotary     # one
//   node tools/voxelize.mjs --cells=72 # a coarser grid
//
// The bake itself runs in the browser — see src/dev/bake.js for why — and this
// is the thing that opens it once per car and waits.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';

const args = process.argv.slice(2);
const cells = Number(args.find((a) => a.startsWith('--cells='))?.slice(8) ?? 145);
const only = args.filter((a) => !a.startsWith('--'));
const CARS = only.length
  ? only : ['hatch', 'coupe', 'rotary', 'gt', 'roadster', 'rally', 'beetle'];

const server = await ensureServer();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log(`Baking ${CARS.length} bodies at grid ${cells}\n`);
let problems = 0;
for (const car of CARS) {
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:5173/bake.html?car=${car}&cells=${cells}`,
    { waitUntil: 'load', timeout: 60000 });
  const report = await page.waitForFunction(() => window.__bake, { timeout: 300000 })
    .then((h) => h.jsonValue())
    .catch(() => null);
  const ms = Date.now() - t0;
  if (!report?.ok) {
    problems++;
    console.log(`  ${car.padEnd(10)} FAIL  ${(await page.textContent('#say')) || 'sem resposta'}`);
    continue;
  }
  console.log(`  ${car.padEnd(10)} ${String(report.cells).padStart(7)} cells  `
    + `${String(report.palette).padStart(4)} colours  `
    + `${report.dims.join('x').padEnd(14)} `
    + `${(report.bytes / 1024).toFixed(0).padStart(5)} KB  `
    + `${report.flipped ? 'FLIP' : '    '} ${String(report.by).padEnd(5)} cabin ${String(report.cabinMargin).padEnd(5)} shape ${String(report.shapeMargin).padEnd(5)} vidro ${String(report.glassVerts).padEnd(7)} ${report.agree ? '' : 'DISCORDAM'}  `
    + `${(ms / 1000).toFixed(1)}s`);
}

if (errors.length) for (const e of [...new Set(errors)].slice(0, 5)) console.log('  ! ' + e.slice(0, 160));
console.log(problems ? `\n${problems} body/bodies failed` : '\nevery body baked');
await browser.close();
server.stop?.();
process.exit(problems ? 1 : 0);
