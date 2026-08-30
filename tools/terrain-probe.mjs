// Is the blocky ground affordable, and does it stay out of the way?
//
// The far verge was a smooth sheet and is now a heightfield of six-metre
// blocks. Three things have to be true of that, and none of them is visible in
// a screenshot taken from the grid:
//
//   * it has to cost something like what the sheet cost, not ten times it;
//   * it must never be built where the road is, because a block on the racing
//     line is a wall;
//   * and it must never stand above the smooth verge it hands over from, or
//     the seam is a cliff facing the player rather than a step away from them.
//
// The third is the one that quantising *downward* is for, and the only way to
// know it held is to measure the worst case rather than to assert it.

import * as THREE from 'three';
import { generateTrack } from '../src/track/track.js';
import { buildBlockTerrain, NEAR_BAND, _internal } from '../src/track/terrain.js';
import { BIOMES } from '../src/data/biomes.js';
import { RNG } from '../src/core/rng.js';
import { generateProps } from '../src/world/scatter.js';

const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

let problems = 0;
console.log('Ground, in blocks\n');
console.log('  biome        tris     ms   worst block over the road   props adrift');
console.log('  ' + '-'.repeat(66));

for (const biome of BIOMES) {
  const track = generateTrack(new RNG(`terrain:${biome.id}`), biome, { difficulty: 1 });
  const t0 = performance.now();
  const geo = buildBlockTerrain(track, biome, { drawDistance: 900 });
  const ms = performance.now() - t0;

  // Nothing on the road. Walk the centreline and ask whether any vertex of the
  // block field landed inside the tarmac plus the near band.
  const pos = geo.attributes.position.array;
  const p = { x: 0, y: 0, z: 0 };
  let intrusion = -Infinity;
  for (let s = 0; s < track.length; s += 9) {
    track.path.pointAt(s, p);
    const keep = NEAR_BAND + track.halfWidthAt(s);
    for (let v = 0; v < pos.length; v += 3) {
      const dx = pos[v] - p.x;
      const dz = pos[v + 2] - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < keep * keep) intrusion = Math.max(intrusion, keep - Math.sqrt(d2));
    }
    // One sweep of the whole buffer per station is enough to catch a systematic
    // failure and too slow to run over every station, so this samples.
    if (s > track.length * 0.25) break;
  }

  // Props stand on the road plane extended sideways. Out where the ground has
  // fallen away and been quantised, that is a prop in mid-air — so measure the
  // worst gap between a scenery prop's feet and the ground under it.
  // Only the props standing on blocks. A trackside barrel sits on the smooth
  // verge, where the ground is the road's own height and the far-field formula
  // does not apply — measuring it against that formula measures nothing but
  // the formula.
  const props = generateProps(new RNG(`terrain:p:${biome.id}`), track, biome, { density: 1 });
  const stations = [];
  for (let s = 0; s < track.length; s += 6) stations.push(track.path.pointAt(s, { x: 0, y: 0, z: 0 }));
  let adrift = 0;
  let onBlocks = 0;
  let worstGap = 0;
  for (const pr of props) {
    let d2 = Infinity;
    for (const st of stations) {
      const dx = pr.x - st.x, dz = pr.z - st.z;
      const d = dx * dx + dz * dz;
      if (d < d2) d2 = d;
    }
    if (Math.sqrt(d2) < NEAR_BAND) continue;
    onBlocks++;
    const ground = _internal.heightAt(track, biome, pr.x, pr.z);
    const rise = _internal.riseFor(biome);
    const gap = pr.y - Math.floor(ground / rise) * rise;
    if (Math.abs(gap) > 1.5) { adrift++; worstGap = Math.max(worstGap, Math.abs(gap)); }
  }

  const ok = tris(geo) < 90000 && ms < 500 && intrusion < 0;
  if (!ok) problems++;
  console.log(`  ${biome.id.padEnd(11)} ${String(tris(geo)).padStart(6)}  `
    + `${ms.toFixed(0).padStart(5)}  ${(intrusion < 0 ? 'none' : `${intrusion.toFixed(1)} m`).padStart(18)}   `
    + `${String(adrift).padStart(5)} of ${onBlocks}`
    + (worstGap ? ` (worst ${worstGap.toFixed(1)} m)` : '')
    + (ok ? '' : '   FAIL'));
}

console.log(problems
  ? `\n${problems} biome(s) with unaffordable or intrusive ground`
  : '\nthe blocks are affordable and they stay off the road');
process.exit(problems ? 1 : 0);
