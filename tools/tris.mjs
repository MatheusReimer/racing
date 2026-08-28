// Triangle budget per car, by part.
//
// Note the constructor takes a *visualProfile*, not a Build: passing a Build
// makes `stats.weight` undefined, every derived dimension NaN, and the whole
// mesh degenerate — while still reporting plausible triangle counts, because
// counts do not depend on the vertex values.
//
//   node tools/tris.mjs

import { VehicleMesh, visualProfile } from '../src/vehicle/chassis.js';
import { Build } from '../src/build/build.js';
import { VEHICLES } from '../src/data/vehicles.js';

const tri = (g) => (g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0);
let worst = 0;

for (const v of VEHICLES) {
  const b = new Build(v.id);
  const m = new VehicleMesh(visualProfile(b.stats.all(), b.tags, v), { shadows: false });
  if (!Number.isFinite(m.length)) throw new Error(`${v.name}: degenerate mesh`);
  const per = {
    body: tri(m.bodyGeo), glass: tri(m.glassGeo), trim: tri(m.trimGeo),
    tyre: tri(m.wheelGeo), tread: tri(m.treadGeo), hub: tri(m.hubGeo),
  };
  const wheel = per.tyre + per.tread + per.hub;
  const total = per.body + per.glass + per.trim + wheel * 4;
  worst = Math.max(worst, total);
  console.log(`${v.name.padEnd(12)} ${String(Math.round(total)).padStart(6)} tris  |  `
    + `body ${per.body}  glass ${per.glass}  trim ${per.trim}  per-wheel ${wheel} (x4)  `
    + `| ${m.length.toFixed(2)}m x ${m.width.toFixed(2)}m`);
}
console.log(`\nheaviest car: ${worst} tris; a six-car field is ${(worst * 6 / 1000).toFixed(0)}k`);
