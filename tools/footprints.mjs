// Measure how much room each prop actually takes, and print the table.
//
//   node tools/footprints.mjs
//
// `radius` on a prop is what a car collides against, and it is deliberately
// tight: a barrel you clip should let you through. How much room the thing
// needs so that it is not standing in the road is a different number and a much
// larger one — a ridge collides at 25 m and is drawn ninety-four across.
// Declaring both by hand is how the second one came to be a guess that was out
// by a factor of four, which put ridges through the track on every folded
// corner. So it is measured off the geometry that actually gets built, and
// pasted into `PROP_TYPES` the way tools/silhouette.mjs numbers are.
//
// Scatter cannot do this at run time: `RaceSim` holds no Three.js, by design,
// and it is the simulation that places props.

import { PROP_TYPES, buildPropLibrary, disposePropLibrary } from '../src/world/props.js';
import { BIOMES } from '../src/data/biomes.js';

// An entry is `{ levels: [variant-geometries per LOD], variants: [...] }`, so
// every level of every variant is measured: a coarse LOD is a different shape
// and it is the one you see at the distance a horizon prop lives at.
// Only what is in the way.
//
// The widest part of a street lamp is its boom, eight metres up and reaching
// over the road on purpose; the widest part of a billboard is a hoarding on
// stilts. Holding those out by their full width strips the street of the things
// that make it a street. What has to clear the road is whatever a car could
// meet, so the measurement stops at roof height and a lamp is measured as the
// post it is at ground level.
const CAR_HEIGHT = 2.5;
const take = (g, acc) => {
  const pos = g?.attributes?.position;
  if (!pos) return acc;
  let w = acc;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > CAR_HEIGHT) continue;
    w = Math.max(w, Math.abs(pos.getX(i)), Math.abs(pos.getZ(i)));
  }
  return w;
};
const reach = (entry) => {
  let w = 0;
  for (const group of [entry.variants, ...(entry.levels ?? [])]) {
    for (const g of group ?? []) w = take(g, w);
  }
  return w;
};

// Every biome, because a type's palette and its random draw differ between
// them and the widest one is the one that has to fit.
const widest = new Map();
for (const biome of BIOMES) {
  const lib = buildPropLibrary(biome, 1);
  for (const [type, entry] of Object.entries(lib)) {
    const w = reach(entry);
    if (w > (widest.get(type) ?? 0)) widest.set(type, w);
  }
  disposePropLibrary(lib);
}

// The scatter also scales each instance, up to +22% for loose props and +35%
// for horizon pieces, so the number that has to be cleared is the largest one
// that will ever be built.
const SCALE_HEADROOM = 1.35;

console.log('// Measured with tools/footprints.mjs. Half-extent in metres of the');
console.log('// widest instance any biome builds, scale headroom included.');
const rows = [...widest].sort((a, b) => b[1] - a[1]);
for (const [type, w] of rows) {
  const def = PROP_TYPES[type];
  if (!def || def.spanning || def.frontage) continue;
  const need = +(w * SCALE_HEADROOM).toFixed(1);
  const have = def.footprint ?? def.radius ?? 0;
  const flag = need > have + 0.25 ? `   // was ${have}` : '';
  console.log(`  ${(type + ':').padEnd(16)} ${String(need).padStart(6)},${flag}`);
}
