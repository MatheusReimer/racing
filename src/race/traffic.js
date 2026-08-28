import { wrap, clamp, clamp01, TAU } from '../core/math.js';
import { ROAD_LIFT } from '../track/track.js';

// Civilian traffic.
//
// Pure data and rules — no Three.js — for the same reason `RaceSim` is: the
// balance harness runs hundreds of races a second in plain Node, and traffic
// changes how races are won, so it has to exist there too.
//
// Traffic is the one thing allowed on the racing surface. That is not a
// contradiction of clearing the static obstacles: a parked barrel on the
// racing line is a toll, paid identically every lap by everyone, and it made
// Weight decide routes. Traffic is *read*, not memorised — it moves, it is
// somewhere different on lap two, and threading it is a skill that pays
// nitrous. One is a tax, the other is the game.
//
// Cars run in lanes either side of the centreline. Same-direction traffic sits
// on the right, oncoming on the left, so the fast line down the left of a
// straight is exactly where the head-on risk lives.

/** Metres per second for ordinary civilian traffic. */
const SPEED_MIN = 11;   // ~40 km/h
const SPEED_MAX = 17;   // ~61 km/h

/** How close counts as threading it rather than hitting it. */
const NEAR_MISS_RADIUS = 3.4;
const NEAR_MISS_MIN_SPEED = 22;

/** Contact. Traffic is heavy and slow: hitting it hurts. */
const HIT_RADIUS = 2.6;
const HIT_COOLDOWN = 0.8;
// How long a knocked civilian stays a loose body, and how quickly it bleeds off
// what it was given. Long enough that you see where it went and it is still
// there when you look in the mirror; short enough that the road clears.
const DAZED_TIME = 2.6;
const DAZED_DRAG = 0.9;
const DAZED_SPIN_DECAY = 1.4;
// Sheet metal, not rubber. Same figure the racers use on each other.
const TRAFFIC_RESTITUTION = 0.28;

export class TrafficCar {
  constructor(opts) {
    this.s = opts.s;
    this.lane = opts.lane;           // signed lateral offset, fraction of half-width
    this.dir = opts.dir;             // +1 with the race, -1 oncoming
    this.speed = opts.speed;
    this.kind = opts.kind ?? 0;      // which body the renderer should use
    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0;
    this.radius = 1.9;
    this.mass = 1500;
    this.alive = true;
    // Nudged sideways by a hit, then eased back to its lane.
    this.lateralPush = 0;

    // What a hit turns it into.
    //
    // A civilian car is on rails: its position is recomputed every step from
    // its distance along the road and its lane, which is cheap and keeps a
    // hundred of them flowing. It also means nothing can ever happen to one.
    // Hitting it could only nudge a lateral offset that sprang back and scale a
    // number, so the car you just drove into carried on down its lane while
    // your own car shook — which is the whole of why the contact read as
    // strange rather than as a crash.
    //
    // So a hit takes it off the rails. `dazed` counts down while it is a loose
    // body with a velocity and a spin, going wherever it was sent, and when it
    // runs out the car works out where it ended up and rejoins the road from
    // there. Rails until something happens, physics while it does, which is how
    // traffic behaves in the games this one is measured against.
    this.vx = 0;
    this.vz = 0;
    this.yawRate = 0;
    this.dazed = 0;
  }
}

/**
 * Lay out traffic around a circuit.
 *
 * Spacing is randomised rather than regular: evenly spaced traffic is a
 * metronome you learn once, and the whole point is that it has to be read.
 */
export function generateTraffic(rng, track, opts = {}) {
  const density = opts.density ?? 1;
  if (density <= 0) return [];

  const L = track.length;
  // One car per ~110 m of circuit at density 1, both directions together.
  const count = Math.max(0, Math.round((L / 110) * density));
  const cars = [];

  for (let i = 0; i < count; i++) {
    const s = rng.range(0, L);
    // Keep the grid and the run to the first corner clear: a car parked in
    // front of the grid is not a hazard to read, it is a coin flip at lights
    // out.
    if (Math.abs(track.path.deltaAlong(track.startS, s)) < 90) continue;

    const oncoming = rng.bool(0.38);
    const dir = oncoming ? -1 : 1;
    // Right-hand traffic: with the race on the right, against it on the left.
    const laneSide = oncoming ? -1 : 1;
    const lane = laneSide * rng.range(0.28, 0.66);

    cars.push(new TrafficCar({
      s,
      lane,
      dir,
      speed: rng.range(SPEED_MIN, SPEED_MAX),
      kind: rng.int(0, 3),
    }));
  }
  return cars;
}

/**
 * Advance traffic and resolve it against the racers.
 *
 * `onHit` and `onNearMiss` are how the presentation layer hears about it; the
 * rules do not know what a sound or a spark is.
 */
export function stepTraffic(cars, track, racers, dt, hooks = {}) {
  const L = track.length;

  const scratch = {};
  for (const car of cars) {
    if (!car.alive) continue;

    if (car.dazed > 0) {
      // Loose. Where it goes is where it was sent.
      car.dazed -= dt;
      car.x += car.vx * dt;
      car.z += car.vz * dt;
      car.yaw += car.yawRate * dt;
      const drag = Math.exp(-DAZED_DRAG * dt);
      car.vx *= drag;
      car.vz *= drag;
      car.yawRate *= Math.exp(-DAZED_SPIN_DECAY * dt);
      // Follow the ground rather than hanging at the height it was hit at.
      track.sample(car.x, car.z, scratch);
      car.y = (scratch.groundY ?? 0);
      car.speed = Math.hypot(car.vx, car.vz);
      if (car.dazed <= 0) {
        // Rejoin the road from wherever it ended up, rather than snapping back
        // to the lane it left — a car that teleports home is worse than one
        // sitting across the carriageway.
        car.s = scratch.s ?? car.s;
        const hw0 = track.halfWidthAt(car.s) || 1;
        car.lane = clamp((scratch.side ?? 0) / hw0, -0.92, 0.92);
        car.lateralPush = 0;
        car.speed = Math.max(car.speed, 6);
      }
      continue;
    }

    car.s = wrap(car.s + car.dir * car.speed * dt, L);
    car.lateralPush *= Math.exp(-2.2 * dt);

    const hw = track.halfWidthAt(car.s);
    const lateral = car.lane * hw + car.lateralPush;
    const p = track.path.offsetPoint(car.s, lateral, { x: 0, y: 0, z: 0 });
    // On the tarmac, not in it. The road is drawn `ROAD_LIFT` above the path it
    // follows, and civilian cars were reading the path.
    car.x = p.x; car.y = p.y + ROAD_LIFT; car.z = p.z;
    // Oncoming cars face back down the road.
    car.yaw = track.path.yawAt(car.s) + (car.dir < 0 ? Math.PI : 0);
    car.vx = Math.sin(car.yaw) * car.speed * car.dir;
    car.vz = Math.cos(car.yaw) * car.speed * car.dir;
    car.yawRate = 0;
  }

  for (const r of racers) {
    if (!r.alive || r.finished) continue;
    const b = r.body;
    if (r._trafficCd > 0) r._trafficCd -= dt;

    for (const car of cars) {
      if (!car.alive) continue;
      const dx = b.x - car.x;
      const dz = b.z - car.z;
      const d2 = dx * dx + dz * dz;

      const hitR = HIT_RADIUS + (r.halfWidth ?? 1.0);
      if (d2 < hitR * hitR) {
        // The cooldown limits what a hit *costs*, never whether it happens.
        //
        // It used to skip the whole contact, which meant that for eight tenths
        // of a second after touching one car you passed clean through the next
        // — and traffic comes in groups, so this was most of the time you spent
        // in it. Two solid objects have to stop being in the same place whatever
        // the damage bookkeeping thinks, so the push-out and the speed the
        // contact scrubs happen every step of every contact; only the damage,
        // the grip penalty and the noise are rate-limited.
        const billable = (r._trafficCd ?? 0) <= 0;

        const d = Math.max(0.001, Math.sqrt(d2));
        const nx = dx / d;
        const nz = dz / d;   // points from the civilian toward the racer

        // Both cars, with their own masses, rather than one scripted response.
        //
        // The racer used to be pushed out and have its speed multiplied by a
        // number while the civilian kept driving; nothing about that is a
        // collision. An impulse divided by the two masses is, and it is the
        // same arithmetic the racers already use on each other — which is the
        // contact that plays well.
        const mr = r.body.p.mass;
        const mc = car.mass;
        const rel = (r.body.vx - car.vx) * nx + (r.body.vz - car.vz) * nz;
        const closing = Math.max(0, -rel);
        const jn = ((1 + TRAFFIC_RESTITUTION) * closing) / (1 / mr + 1 / mc);

        // Out of each other first, in proportion to mass: the heavy one wins.
        const over = hitR - d;
        r.body.x += nx * over * (mc / (mr + mc));
        r.body.z += nz * over * (mc / (mr + mc));
        car.x -= nx * over * (mr / (mr + mc));
        car.z -= nz * over * (mr / (mr + mc));

        // The racer takes it at the point of contact, so a clip on the corner
        // turns the car and a square hit does not — the tyres decide, the same
        // way they do against another racer.
        const lever = r.radius ?? 1.6;
        const inertia = Math.max(1, (mr * ((lever * 2) ** 2 + (lever * 1.2) ** 2)) / 12);
        r.body.applyContactImpulse(nx * jn, nz * jn, -nx * lever, -nz * lever, inertia);

        // And the civilian comes off its rails. Where it goes from here is
        // wherever this sends it.
        car.vx -= (nx * jn) / mc;
        car.vz -= (nz * jn) / mc;
        // Struck off centre, so it spins. The sign follows which side of the
        // civilian's nose the racer hit.
        const fx = Math.sin(car.yaw);
        const fz = Math.cos(car.yaw);
        const side = nx * -fz + nz * fx;
        car.yawRate += clamp((-side * jn) / (mc * 2.4), -3.2, 3.2);
        car.dazed = Math.max(car.dazed, DAZED_TIME);
        car.speed = Math.hypot(car.vx, car.vz);

        if (billable) {
          r._trafficCd = HIT_COOLDOWN;
          r.body.gripPenalty = Math.min(r.body.gripPenalty, 0.55);
          r.body.gripPenaltyTimer = Math.max(r.body.gripPenaltyTimer, 0.5);
          hooks.onHit?.(r, car, closing);
        }
        continue;
      }

      // Near miss: threading a gap at speed refills nitrous. This is the loop
      // that makes traffic worth having rather than merely survivable.
      const missR = NEAR_MISS_RADIUS + (r.halfWidth ?? 1.0);
      if (d2 < missR * missR && b.speed > NEAR_MISS_MIN_SPEED) {
        if (car._missedBy === r && (car._missCd ?? 0) > 0) continue;
        car._missedBy = r;
        car._missCd = 1.2;
        const strength = clamp01(b.speed / 55) * (car.dir < 0 ? 1.0 : 0.65);
        r.awardNearMiss?.(strength);
        hooks.onNearMiss?.(r, car, strength);
      }
    }
  }

  for (const car of cars) {
    if (car._missCd > 0) car._missCd -= dt;
  }
}
