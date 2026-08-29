// A car is symmetric, and its classification has to be too.
//
// Cut a car down the middle and the two halves are the same car. So if a face
// on the left is a lamp and the face mirroring it is paint, one of the two is
// wrong — and that is true of every car there has ever been, which makes it
// the one rule strong enough to find noise without knowing what the noise is.
//
// It is also the rule that explains which cars look wrong. Measured before any
// of this was fixed: 0.1% of mirrored faces disagreed on the Quattro and 0.2%
// on the Impreza, the two nobody had ever complained about, against 10% on the
// RX-7 — whose headlight had orange pixels cut through it — and 18% on the
// Beetle. The RX-7's single biggest disagreement was 811 faces of paint facing
// lamp, which *was* the orange in the headlight.

import { readFileSync } from 'node:fs';
import { parseHull, HULL_NAMES } from '../src/data/bodies/index.js';
import { symmetriseClasses } from '../src/vehicle/chassis.js';

// What the game showed before symmetry was enforced, so a regression in the
// hulls themselves is visible as well as a regression in the code.
const WAS = {
  hatch: 3.4, coupe: 3.2, rotary: 10.3, gt: 0.1, roadster: 9.5, rally: 0.2, beetle: 18.5,
};
// What is left afterwards may not get worse than this.
//
// A ratchet at what the fix actually achieves, not a target somebody wished
// for — the same way `economy-probe` holds the surplus. The residue is real:
// the fix pairs faces within 6 cm and this measures within 3, so a face whose
// mirror is 4 cm away gets fixed and still counts here, and one 8 cm away
// counts and never gets fixed. Driving it to zero means a decimator that
// preserves symmetry, which is a different job. This may not get worse.
const CEILING = 3.5;

let problems = 0;
console.log('Both halves of a car agree about what each face is:\n');

for (const name of HULL_NAMES) {
  const buf = readFileSync(`public/bodies/${name}.bin`);
  const hull = parseHull(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { positions, indices } = hull;

  const measure = (classes) => {
    const n = classes.length;
    const cx = new Float32Array(n);
    const cy = new Float32Array(n);
    const cz = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let x = 0; let y = 0; let z = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k] * 3;
        x += positions[v]; y += positions[v + 1]; z += positions[v + 2];
      }
      cx[t] = x / 3; cy[t] = y / 3; cz[t] = z / 3;
    }
    // A tighter cell than the fix uses, on purpose: the test should not be
    // graded by the same tolerance as the thing it is testing.
    const CELL = 0.03;
    const bins = new Map();
    for (let t = 0; t < n; t++) {
      const k = `${Math.round(Math.abs(cx[t]) / CELL)},${Math.round(cy[t] / CELL)},${Math.round(cz[t] / CELL)}`;
      let a = bins.get(k);
      if (!a) { a = []; bins.set(k, a); }
      a.push(t);
    }
    let paired = 0;
    let bad = 0;
    for (const list of bins.values()) {
      for (const t of list) {
        if (cx[t] < 0) continue;
        let best = -1;
        let bd = CELL * CELL;
        for (const u of list) {
          if (cx[u] >= 0) continue;
          const d = (cx[t] + cx[u]) ** 2 + (cy[t] - cy[u]) ** 2 + (cz[t] - cz[u]) ** 2;
          if (d < bd) { bd = d; best = u; }
        }
        if (best < 0) continue;
        paired++;
        if (classes[t] !== classes[best]) bad++;
      }
    }
    return paired ? (bad / paired) * 100 : 0;
  };

  const before = measure(hull.classes);
  const after = measure(symmetriseClasses(hull));
  const ok = after <= CEILING;
  if (!ok) problems++;
  console.log(`  ${name.padEnd(10)} ${before.toFixed(1).padStart(5)}% -> ${after.toFixed(1).padStart(5)}%`
    + `   (was ${(WAS[name] ?? before).toFixed(1)}%)`.padEnd(16)
    + (ok ? 'ok' : `FAIL — over ${CEILING}%`));
}

console.log(problems
  ? `\n${problems} reference(s) still disagree with themselves`
  : '\nevery car is the same car on both sides');
process.exit(problems ? 1 : 0);
