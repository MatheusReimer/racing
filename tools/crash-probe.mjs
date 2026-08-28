// Do collisions between cars behave like collisions between cars?
//
// The fault this exists for: impacts did not read as impacts. Two things were
// wrong and both are geometry rather than tuning.
//
// Cars collided as circles. A car is 4.3 m by 1.8 m and its bounding circle has
// a radius of about 1.3, so two running side by side bounced off two thirds of
// a metre of clear air, while one tucked into another's slipstream drove a
// metre into its boot before anything noticed.
//
// And the response was a shove through the centre of mass, so clipping
// somebody's rear quarter and hitting them square in the back were the same
// event. Nothing a collision did could ever rotate a car.
//
// Both are checked here against the two things that have to hold no matter how
// the numbers are tuned: momentum is conserved, and a blow off the centre line
// turns the car it lands on.

import { RaceSim, obbContact, yawInertia } from '../src/race/sim.js';
import { VehicleBody } from '../src/vehicle/physics.js';

const OK = (b) => (b ? 'ok' : 'FAIL');
let problems = 0;
const check = (label, pass, detail) => {
  if (!pass) problems++;
  console.log(`  ${label.padEnd(46)} ${detail.padEnd(30)} ${OK(pass)}`);
};

console.log('Car-on-car contact\n');

// A stand-in for a racer, wrapped around the real `VehicleBody` — the point is
// to test the impulse the game applies, not a copy of it written here.
const car = (x, z, yaw, vx, vz, { mass = 1200, hl = 2.15, hw = 0.9 } = {}) => {
  const body = new VehicleBody({ mass, maxSpeed: 70 });
  body.x = x; body.z = z; body.yaw = yaw; body.vx = vx; body.vz = vz;
  return { alive: true, radius: Math.hypot(hl, hw), halfLength: hl, halfWidth: hw, body };
};

// --- the shape of a car ----------------------------------------------------

{
  // Two cars abreast with a clear half-metre between their flanks. Bounding
  // circles of radius 2.3 overlap heavily here; the cars do not touch at all.
  const a = car(0, 0, 0, 0, 0);
  const b = car(2.3, 0, 0, 0, 0);
  check('abreast, half a metre of air between them', obbContact(a, b) === null,
    `gap ${(2.3 - 1.8).toFixed(2)} m`);
}
{
  // Nose to tail, overlapping by twenty centimetres. Circles would have called
  // this a hit a metre and a half ago; boxes call it now.
  const a = car(0, 0, 0, 0, 0);
  const b = car(0, 4.1, 0, 0, 0);
  const hit = obbContact(a, b);
  check('nose to tail, 20 cm of overlap', hit !== null && Math.abs(hit.depth - 0.2) < 0.02,
    hit ? `depth ${hit.depth.toFixed(3)} m` : 'no contact');
}

// --- what a hit does -------------------------------------------------------

const collide = (a, b) => {
  const sim = Object.create(RaceSim.prototype);
  sim.racers = [a, b];
  sim._applySpeedFloor = () => {};
  sim._applyRamDamage = () => {};
  sim.events = null;
  sim._resolveCars(1 / 60);
};
const momentum = (a, b) => [
  a.body.vx * a.body.p.mass + b.body.vx * b.body.p.mass,
  a.body.vz * a.body.p.mass + b.body.vz * b.body.p.mass,
];

{
  // Square in the back, dead on the centre line. All shove, no spin.
  const a = car(0, 0, 0, 0, 20);
  const b = car(0, 4.0, 0, 0, 0);
  const [px0, pz0] = momentum(a, b);
  collide(a, b);
  const [px1, pz1] = momentum(a, b);
  check('rear-ended square: momentum conserved',
    Math.abs(pz1 - pz0) < 1 && Math.abs(px1 - px0) < 1,
    `dp = ${Math.hypot(px1 - px0, pz1 - pz0).toFixed(2)} kg m/s`);
  check('rear-ended square: nobody spins',
    Math.abs(a.body.impactSpin) < 0.02 && Math.abs(b.body.impactSpin) < 0.02,
    `spin ${b.body.impactSpin.toFixed(3)} rad/s`);
  check('rear-ended square: the one hit is pushed forward',
    b.body.vz > 1, `${b.body.vz.toFixed(1)} m/s`);
}
{
  // Same speed, same closing, but caught on the rear quarter. This has to spin
  // the car it lands on, and that is the whole difference between a nudge and
  // losing it.
  const a = car(1.4, 0, 0, 0, 20);
  const b = car(0, 4.0, 0, 0, 0);
  const [px0, pz0] = momentum(a, b);
  collide(a, b);
  const [px1, pz1] = momentum(a, b);
  check('caught on the rear quarter: momentum conserved',
    Math.hypot(px1 - px0, pz1 - pz0) < 1,
    `dp = ${Math.hypot(px1 - px0, pz1 - pz0).toFixed(2)} kg m/s`);
  check('caught on the rear quarter: it spins the car',
    Math.abs(b.body.impactSpin) > 0.15,
    `spin ${b.body.impactSpin.toFixed(2)} rad/s`);
  check('caught on the rear quarter: the body is thrown',
    Math.abs(b.body.joltPitchVel ?? 0) + Math.abs(b.body.joltRollVel ?? 0) > 0.01,
    `jolt ${((b.body.joltPitchVel ?? 0) ** 2 + (b.body.joltRollVel ?? 0) ** 2) ** 0.5 > 0 ? 'yes' : 'no'}`);
}
{
  // Whatever else happens, two cars must not be left inside each other.
  const a = car(0, 0, 0, 0, 25);
  const b = car(0.6, 3.4, 0.3, 0, 0);
  collide(a, b);
  const after = obbContact(a, b);
  check('after resolving, the cars are not overlapping',
    after === null || after.depth < 0.05,
    after ? `${(after.depth * 1000).toFixed(0)} mm left` : 'clear');
}
{
  // A long car and a short one of the same weight must not answer the same
  // shunt the same way — that is the point of using the real dimensions.
  const long = car(0, 0, 0, 0, 0, { hl: 2.4 });
  const short = car(0, 0, 0, 0, 0, { hl: 1.7 });
  check('a longer car resists being spun more',
    yawInertia(long) > yawInertia(short) * 1.2,
    `${Math.round(yawInertia(long))} vs ${Math.round(yawInertia(short))} kg m2`);
}

console.log('');
if (problems) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('contact happens where the cars are, and lands where it hit');
