import { VehicleBody, SURFACES } from '../src/vehicle/physics.js';
import { StatBlock } from '../src/stats/statblock.js';
import { baseStats } from '../src/stats/attributes.js';

const DT = 1 / 60;

function make(overrides = {}) {
  const base = baseStats();
  Object.assign(base, overrides);
  const sb = new StatBlock(base);
  return { body: new VehicleBody(sb.physics()), sb };
}

function sim(body, input, seconds, surface = SURFACES.road) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) body.step(DT, input, surface, 0);
  return body;
}

const FULL = { throttle: 1, brake: 0, steer: 0, drift: false };

console.log('=== 1. terminal speed tracks Top Speed ===');
for (const ts of [60, 100, 160, 240]) {
  const { body, sb } = make({ topSpeed: ts });
  sim(body, FULL, 30);
  const target = sb.physics().maxSpeed;
  console.log(
    `  topSpeed=${String(ts).padStart(3)}  reached ${body.kmh.toFixed(1).padStart(6)} km/h` +
    `  (cap ${(target * 3.6).toFixed(1)} km/h, ${((body.speed / target) * 100).toFixed(1)}%)`
  );
}

console.log('\n=== 2. 0-100 km/h tracks Acceleration ===');
for (const ac of [50, 100, 200]) {
  const { body } = make({ acceleration: ac });
  let t = 0;
  while (body.kmh < 100 && t < 60) { body.step(DT, FULL, SURFACES.road, 0); t += DT; }
  console.log(`  acceleration=${String(ac).padStart(3)}  0-100 in ${t.toFixed(2)}s`);
}

console.log('\n=== 3. braking distance tracks Braking ===');
for (const br of [40, 100, 200]) {
  const { body } = make({ braking: br });
  sim(body, FULL, 20);
  const v0 = body.speed, x0 = body.z;
  let t = 0;
  while (body.forwardSpeed > 1 && t < 30) {
    body.step(DT, { throttle: 0, brake: 1, steer: 0, drift: false }, SURFACES.road, 0);
    t += DT;
  }
  console.log(`  braking=${String(br).padStart(3)}  ${(v0*3.6).toFixed(0)} km/h -> stop in ${Math.abs(body.z-x0).toFixed(1)} m (${t.toFixed(2)}s)`);
}

console.log('\n=== 4. grip: lateral slip under constant steer ===');
for (const g of [40, 100, 200]) {
  const { body } = make({ grip: g });
  sim(body, FULL, 8);
  sim(body, { throttle: 1, brake: 0, steer: 1, drift: false }, 2.5);
  console.log(`  grip=${String(g).padStart(3)}  slip=${(body.slipAngle*57.3).toFixed(1)}deg  drifting=${body.drifting}  speed=${body.kmh.toFixed(0)}km/h`);
}

console.log('\n=== 5. drift stat: speed kept through a held slide ===');
for (const d of [30, 100, 220]) {
  const { body } = make({ drift: d });
  sim(body, FULL, 10);
  const before = body.speed;
  sim(body, { throttle: 1, brake: 0, steer: 1, drift: true }, 2.0);
  console.log(
    `  drift=${String(d).padStart(3)}  ${(before*3.6).toFixed(0)} -> ${body.kmh.toFixed(0)} km/h` +
    `  (kept ${((body.speed/before)*100).toFixed(0)}%)  quality=${body.driftQuality.toFixed(2)}  slip=${(body.slipAngle*57.3).toFixed(0)}deg`
  );
}

console.log('\n=== 6. weight: acceleration and knockback ===');
for (const w of [50, 100, 250]) {
  const { body, sb } = make({ weight: w });
  let t = 0;
  while (body.kmh < 100 && t < 60) { body.step(DT, FULL, SURFACES.road, 0); t += DT; }
  const b2 = make({ weight: w }).body;
  b2.applyBlast(b2.x + 3, b2.z, 40, 12);
  console.log(`  weight=${String(w).padStart(3)}  mass=${sb.physics().mass.toFixed(0)}kg  0-100=${t.toFixed(2)}s  blast knockback=${Math.hypot(b2.vx,b2.vz).toFixed(2)} m/s`);
}

console.log('\n=== 7. surfaces (full throttle 12s, then hard steer) ===');
for (const s of ['road', 'gravel', 'sand', 'ice']) {
  const { body } = make();
  sim(body, FULL, 12, SURFACES[s]);
  const v = body.kmh;
  sim(body, { throttle: 1, brake: 0, steer: 1, drift: false }, 1.5, SURFACES[s]);
  console.log(`  ${s.padEnd(7)} cruise=${v.toFixed(0).padStart(3)}km/h  slip after steer=${(body.slipAngle*57.3).toFixed(1)}deg`);
}

console.log('\n=== 8. determinism + stability ===');
const a = make().body, b = make().body;
const inputs = [];
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < 3000; i++) {
  inputs.push({ throttle: rnd() > 0.2 ? 1 : 0, brake: rnd() > 0.9 ? 1 : 0, steer: rnd() * 2 - 1, drift: rnd() > 0.8 });
}
for (const inp of inputs) a.step(DT, inp, SURFACES.road, 0);
for (const inp of inputs) b.step(DT, inp, SURFACES.road, 0);
const identical = a.x === b.x && a.z === b.z && a.yaw === b.yaw;
const finite = Number.isFinite(a.x) && Number.isFinite(a.z) && Number.isFinite(a.yaw) && Number.isFinite(a.speed);
console.log(`  deterministic: ${identical}   finite after 3000 chaotic steps: ${finite}`);
console.log(`  final: pos=(${a.x.toFixed(1)}, ${a.z.toFixed(1)}) speed=${a.kmh.toFixed(1)}km/h yaw=${(a.yaw*57.3).toFixed(0)}deg`);

console.log('\n=== 9. reverse ===');
{
  const { body } = make();
  sim(body, { throttle: 0, brake: 1, steer: 0, drift: false }, 5);
  console.log(`  after 5s of brake from rest: ${body.forwardSpeed.toFixed(2)} m/s (should be negative, bounded)`);
}

console.log('');
console.log('=== 10. steering direction (regression guard) ===');
// A mirrored steering convention is self-consistent: slip sign, body lean and
// the AI's avoidance all invert together, so everything looks fine while the
// car turns the wrong way. This pins the actual world-space direction.
//
// Three.js is right-handed with Y up, so a car facing +Z has its right at -X.
{
  let bad = 0;
  // Measured over a short burst, before the car can complete a half turn.
  //
  // This used to hold the wheel for four seconds and read the final X. That is
  // only a direction test while the car turns less than half a circle: when the
  // arcade handling pass raised `steerRate`, the same correct steering carried
  // the car past 180 degrees, the yaw wrapped from -170 to +120, X came out on
  // the other side, and the guard reported INVERTED for a car turning exactly
  // the way it should. A guard that fails when the car gets *better* teaches
  // you to ignore it.
  for (const [key, steer, wantLabel] of [['D (right)', 1, '-X'], ['A (left)', -1, '+X']]) {
    const { body } = make();
    body.place(0, 0, 0);                       // facing +Z
    sim(body, { throttle: 1, brake: 0, steer, drift: false }, 0.8);
    const turned = body.yaw * 57.3;
    const wentTo = body.x < 0 ? '-X' : '+X';
    const ok = wentTo === wantLabel && Math.abs(turned) < 175;
    if (!ok) bad++;
    console.log(`  ${key.padEnd(10)} -> x=${body.x.toFixed(1).padStart(7)} (${wentTo}), `
      + `yaw=${turned.toFixed(0).padStart(5)}deg  ${ok ? 'ok' : 'INVERTED'}`);
  }

  // The right vector must be the actual right: cross(forward, up).
  const { body } = make();
  body.place(0, 0, 0);
  const trueRightX = body.forwardZ * 1 * -1;   // cross((0,0,1),(0,1,0)).x = -1
  const ok = Math.sign(body.rightX) === Math.sign(trueRightX);
  console.log(`  right vector at yaw 0 = (${body.rightX.toFixed(2)}, ${body.rightZ.toFixed(2)})  ${ok ? 'ok' : 'POINTS LEFT'}`);
  if (!ok) bad++;

  if (bad) {
    console.log(`  ${bad} steering-direction failure(s)`);
    process.exitCode = 1;
  }
}
