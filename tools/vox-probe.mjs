// Is a voxel body affordable to draw?
//
// The move to voxels rests on two numbers from VOXEL.md, and neither was ever
// checked against a mesh — they were counted off the grid. This builds the
// mesh and measures what actually comes out.
//
//   * about 72% of cell faces are buried and can never be seen;
//   * what is left is large flat panels, which is the best case for greedy
//     meshing.
//
// A car body the game already ships is 32k to 50k triangles. That is the bar:
// a voxel body that lands near it is a swap, and one that lands at ten times it
// is a rewrite of the renderer.

import { readFileSync, existsSync } from 'node:fs';
import { parseVox, voxGeometry, coarsen } from '../src/vehicle/voxmesh.js';

const NAMES = ['hatch', 'coupe', 'rotary', 'gt', 'roadster', 'rally', 'beetle'];
// What the decimated bodies cost, so the comparison is against the thing this
// replaces rather than against a number somebody liked.
const BIN_TRIS = { hatch: 47923, coupe: 45814, rotary: 32366, gt: 42031, roadster: 44536, rally: 49353, beetle: 49970 };
// A body that lands under this is a swap. Twice the mesh it replaces is still
// ordinary; ten times is not.
const CEILING = 2.0;

let problems = 0;
console.log('A voxel body, meshed:\n');
console.log('  body        cells    naive    culled+merged   vs .bin   coarse');
console.log('  ' + '-'.repeat(62));

for (const name of NAMES) {
  const path = `public/bodies/${name}.vox`;
  if (!existsSync(path)) {
    problems++;
    console.log(`  ${name.padEnd(10)} FAIL — no ${path}`);
    continue;
  }
  const buf = readFileSync(path);
  const vox = parseVox(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const geo = voxGeometry(vox);
  const tris = geo.index.count / 3;
  const naive = vox.count * 12;

  const half = voxGeometry(coarsen(vox));
  const halfTris = half.index.count / 3;

  const ratio = tris / BIN_TRIS[name];
  const ok = ratio <= CEILING;
  if (!ok) problems++;
  console.log(`  ${name.padEnd(10)} ${String(vox.count).padStart(6)}  `
    + `${String(naive).padStart(7)}  ${String(tris).padStart(9)}  `
    + `${(naive / tris).toFixed(1)}x menos  `
    + `${ratio.toFixed(2)}x  ${ok ? '  ' : 'FAIL'}  ${String(halfTris).padStart(6)}`);
}

console.log(problems
  ? `\n${problems} body/bodies too expensive to draw`
  : '\ngreedy meshing puts a voxel body inside the budget the old one had');
process.exit(problems ? 1 : 0);
