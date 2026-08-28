import { wrap, clamp01, TAU } from '../core/math.js';
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

  for (const car of cars) {
    if (!car.alive) continue;

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
        if ((r._trafficCd ?? 0) > 0) continue;
        r._trafficCd = HIT_COOLDOWN;

        // Closing speed along the line between them is what hurts. A car
        // drifting into traffic at the same speed should barely register;
        // meeting an oncoming car at 200 should not be survivable cheaply.
        const d = Math.max(0.001, Math.sqrt(d2));
        const nx = dx / d, nz = dz / d;
        const rel = (b.vx - car.dir * Math.sin(car.yaw) * car.speed) * -nx
          + (b.vz - car.dir * Math.cos(car.yaw) * car.speed) * -nz;
        const closing = Math.max(0, rel);

        // Push the racer out and scrub speed hard. Traffic is not a wall to
        // lean on: the whole reason it is tense is that touching it costs the
        // corner and often the place.
        b.x += nx * (hitR - d);
        b.z += nz * (hitR - d);
        const keep = clamp01(1 - closing / 55) * 0.55 + 0.20;
        b.vx *= keep;
        b.vz *= keep;
        b.yawRate *= 0.35;
        b.gripPenalty = Math.min(b.gripPenalty, 0.55);
        b.gripPenaltyTimer = Math.max(b.gripPenaltyTimer, 0.5);

        car.lateralPush += -nx * 0 + Math.sign(-(car.lane)) * 0.6;
        car.speed *= 0.6;

        hooks.onHit?.(r, car, closing);
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
