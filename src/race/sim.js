import { generateTrack, BARRIER_OFFSET } from '../track/track.js';
import { Racer } from './racer.js';
import { Driver, ARCHETYPES } from '../ai/driver.js';
import { RNG } from '../core/rng.js';
import { Build } from '../build/build.js';
import { clamp, clamp01, angleDelta, wrapAngle } from '../core/math.js';
import { CombatSystem } from '../combat/combat.js';
import { generateProps, collidableProps } from '../world/scatter.js';
import { generateTraffic, stepTraffic } from './traffic.js';

// The rules of a race, with no rendering in them at all.
//
// Splitting this out from the presentation layer is what lets the balance tool
// run thousands of complete races in plain Node in seconds. Driving the same
// races through a browser at software-rendered frame rates takes about a
// minute each, which is too slow to answer questions like "is the Drift build
// competitive across 200 seeds" — and those are exactly the questions a
// roguelike with 60 interacting parts has to answer repeatedly.
//
// `Race` in race.js extends this and adds the scene, meshes and camera. Both
// run identical simulation code, so a balance result and a played race cannot
// disagree.
//
// Step order is fixed and load-bearing:
//   1. inputs written (player, then rivals)
//   2. motion integrated
//   3. track sampled — resolves surface and on/off-track
//   4. collisions resolved: barriers, then cars
//   5. resources ticked (this is what can kill)
//   6. progress and placings updated
//
// Sampling sits before collisions because the barrier response needs to know
// how far past the edge a car ended up *this* step; resources tick after
// collisions so a fatal impact registers on the frame it happened.

// Barely bounces. An Underground wall is something you scrape down, losing
// speed and time; a bouncy wall throws you back across the road and turns one
// mistake into a second, worse one.
const BARRIER_RESTITUTION = 0.12;
// Per second, not per frame. Scraping a wall should cost roughly half your
// speed over a second of contact — enough to make it the slow line, nowhere
// near enough to pin the car.
const BARRIER_FRICTION = 0.8;
// The rescue watches distance covered per window rather than a best-so-far
// mark: 15 m in 5 s is 3 m/s, well under any car that is actually racing.
const STUCK_WINDOW = 5;
const STUCK_MIN_PROGRESS = 15;
// Long enough that running wide, cutting a verge, or a scrappy recovery are all
// left alone; short enough that nobody spends a third of a lap off the road.
//
// Deliberately not gated on speed. A speed gate looks like the cautious choice
// but it is the hole: a car sliding along the verge fast enough to clear the
// gate never accumulates the timer, and that is precisely the car that never
// gets back on the road. Nine unbroken seconds off the racing surface is not
// ambiguous at any speed.
const OFF_TRACK_RESCUE_TIME = 9;
// Bounce and scrub between two cars. Sheet metal is not springy: most of a
// crash goes into deforming it, which is why 0.28 rather than anything near 1.
const CAR_RESTITUTION = 0.28;
// How much of the speed carried into an obstacle comes back out, as the
// multiplier on the component removed: 1.0 stops the car dead, above 1.0 sends
// it back the way it came.
//
// Speed-dependent, because a car is not a ball. A bumper nudging a barrel at
// walking pace does spring back a little; the same car meeting the same barrel
// at a hundred crumples, and everything that would have been rebound goes into
// the bodywork instead. Flat 1.35 — which is not absorption at all, it is
// reversal with interest — was launching cars backwards out of head-on hits.
const propAbsorb = (closing) => 1 + 0.22 * Math.exp(-closing / 7);
// How much of the normal impulse friction across the contact can spend. This is
// what turns a sideswipe from a clean bounce into two cars dragging along each
// other, and it is where the rotation in a door-to-door fight comes from.
const CAR_FRICTION = 0.5;
const RAM_CONTACT_COOLDOWN = 0.4;
const BARRIER_CONTACT_COOLDOWN = 0.35;

/**
 * A car's resistance to being spun, kg·m², as a rectangular slab.
 *
 * The bodies carry their real dimensions now, so this is the real figure rather
 * than a tuning constant — which matters, because it is the whole reason a long
 * car and a short one of the same weight do not react to the same shunt the
 * same way.
 */
export function yawInertia(racer) {
  const L = racer.halfLength * 2;
  const W = racer.halfWidth * 2;
  return Math.max(1, (racer.body.p.mass * (L * L + W * W)) / 12);
}

/** The corner of a car furthest along `ux, uz`. */
function support(r, ux, uz) {
  const b = r.body;
  const fx = b.forwardX;
  const fz = b.forwardZ;
  const sx = -fz;
  const sz = fx;
  const sf = (fx * ux + fz * uz) >= 0 ? 1 : -1;
  const ss = (sx * ux + sz * uz) >= 0 ? 1 : -1;
  return [
    b.x + fx * r.halfLength * sf + sx * r.halfWidth * ss,
    b.z + fz * r.halfLength * sf + sz * r.halfWidth * ss,
  ];
}

/**
 * Where and how deeply two cars overlap, as rectangles.
 *
 * Separating-axis: two rectangles miss each other if and only if one of their
 * four edge directions separates them, so testing those four both answers
 * whether they touch and, when they do, hands back the shallowest direction —
 * which is the one a real contact would push along.
 *
 * The contact point is the midpoint of the two cars' deepest corners into each
 * other. It is an approximation of a contact patch that is really a short line,
 * but it is on the right side of the car and the right distance off centre,
 * which is all the impulse needs to know to decide how much of the blow becomes
 * spin.
 */
export function obbContact(a, b) {
  const ax = a.body.forwardX;
  const az = a.body.forwardZ;
  const bx = b.body.forwardX;
  const bz = b.body.forwardZ;
  const axes = [[ax, az], [-az, ax], [bx, bz], [-bz, bx]];

  const dx = b.body.x - a.body.x;
  const dz = b.body.z - a.body.z;

  let best = Infinity;
  let nx = 0;
  let nz = 0;
  for (const [ux, uz] of axes) {
    const ra = a.halfLength * Math.abs(ax * ux + az * uz)
      + a.halfWidth * Math.abs(-az * ux + ax * uz);
    const rb = b.halfLength * Math.abs(bx * ux + bz * uz)
      + b.halfWidth * Math.abs(-bz * ux + bx * uz);
    const dist = Math.abs(dx * ux + dz * uz);
    const overlap = ra + rb - dist;
    if (overlap <= 0) return null;          // this axis separates them
    if (overlap < best) {
      best = overlap;
      // Point the normal from a toward b, so the sign of every impulse below
      // follows from the order the pair was taken in.
      const sign = (dx * ux + dz * uz) < 0 ? -1 : 1;
      nx = ux * sign;
      nz = uz * sign;
    }
  }

  // Where along the contact the cars actually meet.
  //
  // Taking a corner of each box and splitting the difference is wrong, and
  // wrong in the way that matters: it puts every contact point half a car-width
  // off the centre line, so a dead-square rear-ending spun the car in front at
  // four radians a second. Two rectangles meeting face to face touch along a
  // segment, and the blow lands in the middle of it. Projecting both boxes onto
  // the contact tangent and taking the middle of the overlap gives that — zero
  // for a square hit, offset for a clipped corner, which is exactly the
  // distinction the impulse is being asked to make.
  const tx = -nz;
  const tz = nx;
  const span = (r) => {
    const fx = r.body.forwardX;
    const fz = r.body.forwardZ;
    const c = r.body.x * tx + r.body.z * tz;
    const e = r.halfLength * Math.abs(fx * tx + fz * tz)
      + r.halfWidth * Math.abs(-fz * tx + fx * tz);
    return [c - e, c + e];
  };
  const [a0, a1] = span(a);
  const [b0, b1] = span(b);
  const tMid = (Math.max(a0, b0) + Math.min(a1, b1)) / 2;

  // And how far along the normal: halfway between the two surfaces in contact.
  const [pax, paz] = support(a, nx, nz);
  const [pbx, pbz] = support(b, -nx, -nz);
  const nMid = ((pax * nx + paz * nz) + (pbx * nx + pbz * nz)) / 2;

  return { nx, nz, depth: best, px: nx * nMid + tx * tMid, pz: nz * nMid + tz * tMid };
}

/**
 * Default rival machine for an archetype: the vehicle whose identity matches
 * how its Driver behaves, plus a flat competence scale from difficulty. Rivals
 * get better by being better cars driven better — never by being exempt from
 * the rules the player plays by.
 */
/** How each vehicle wants to be driven, for autopilot and balance runs. */
export const VEHICLE_DRIVING_STYLE = {
  rotary: 'racer',
  gt: 'tank',
  coupe: 'racer',
  rally: 'bomber',
  roadster: 'racer',
  hatch: 'swarm',
};

const ARCHETYPE_VEHICLE = {
  racer: 'rotary',
  tank: 'gt',
  bomber: 'rally',
  hunter: 'hatch',
  disruptor: 'coupe',
  swarm: 'roadster',
};

export function makeDefaultRivalBuild(arch, difficulty = 1) {
  const build = new Build(ARCHETYPE_VEHICLE[arch.id] || 'rocket');
  const scale = difficulty * 0.06;
  build.stats.add('Field Tuning', {
    topSpeed: scale, acceleration: scale, grip: scale, durability: scale,
  });
  build.recompute();
  return build;
}

// Slipstream geometry.
//
// A wake is a cone behind a car: strongest just off its tail, gone by the time
// you are seven car lengths back or a lane and a half to the side. These are
// the numbers that decide whether following is worth doing, so they are here
// rather than buried in the test below.
const DRAFT_MIN_SPEED = 18;     // m/s; a tow at walking pace is not a thing
const DRAFT_NEAR = 4.0;         // m; closer than this you are about to hit it
const DRAFT_FULL = 13.0;        // m; out to here the wake is at full strength
const DRAFT_FAR = 32.0;         // m; and gone by here
const DRAFT_WIDTH = 1.3;        // m of lateral offset still fully in the wake
const DRAFT_EDGE = 3.2;         // m at which you are in clean air again
const DRAFT_RISE = 3.2;         // how fast the tow builds, per second
const DRAFT_FALL = 2.0;         // and how fast it lets go

/**
 * How much of `other`'s wake `b` is sitting in, 0..1.
 *
 * `other` may be a racer's body or a civilian — a van tows too, and on a public
 * road it is the thing you are most likely to catch. Both carry x, z, yaw and
 * speed, which is all this needs.
 */
function draftBetween(b, other) {
  if ((other.speed ?? 0) < DRAFT_MIN_SPEED * 0.5) return 0;

  const dx = other.x - b.x;
  const dz = other.z - b.z;
  const along = dx * b.forwardX + dz * b.forwardZ;
  if (along < DRAFT_NEAR || along > DRAFT_FAR) return 0;

  const lateral = Math.abs(dx * b.rightX + dz * b.rightZ);
  if (lateral > DRAFT_EDGE) return 0;

  // Pointing the same way. Without this an oncoming car tows you as it passes,
  // which is the opposite of what its wake does.
  const ofx = other.forwardX ?? Math.sin(other.yaw ?? 0);
  const ofz = other.forwardZ ?? Math.cos(other.yaw ?? 0);
  const facing = ofx * b.forwardX + ofz * b.forwardZ;
  if (facing < 0.55) return 0;

  const byDistance = along <= DRAFT_FULL
    ? 1
    : 1 - (along - DRAFT_FULL) / (DRAFT_FAR - DRAFT_FULL);
  const byOffset = lateral <= DRAFT_WIDTH
    ? 1
    : 1 - (lateral - DRAFT_WIDTH) / (DRAFT_EDGE - DRAFT_WIDTH);

  return Math.max(0, byDistance) * Math.max(0, byOffset) * facing;
}

export class RaceSim {
  constructor({ seed, biome, playerBuild, config = {}, events = null }) {
    this.rng = new RNG(seed);
    this.biome = biome;
    this.events = events;
    this.config = {
      laps: 3,
      rivals: 5,
      difficulty: 1,
      modifiers: [],
      isBoss: false,
      countdown: 3.2,
      ...config,
    };

    this.track = generateTrack(this.rng.fork('track'), biome, {
      difficulty: this.config.difficulty,
      lengthScale: config.lengthScale ?? 1,
    });

    // Scenery is generated here rather than inside `generateTrack` so the
    // simulation owns it: destructible props are gameplay, and the balance runs
    // must smash exactly the same barrels the played game does.
    this.props = generateProps(this.rng.fork('props'), this.track, biome, {
      density: this.config.propDensity ?? 1,
    });
    this.collidable = collidableProps(this.props);

    // Civilian traffic. Denser in the city, and scaled by difficulty so a first
    // race is not a slalom.
    const trafficDensity = (biome.traffic ?? 0)
      * (this.config.trafficDensity ?? 1)
      * (0.7 + 0.3 * (this.config.difficulty ?? 1));
    this.traffic = generateTraffic(this.rng.fork('traffic'), this.track, {
      density: trafficDensity,
    });

    this.racers = [];
    this.drivers = [];
    this.autopilot = null;
    this.combat = new CombatSystem(this);

    this._spawnField(playerBuild);

    this.time = 0;
    this.state = 'countdown';       // countdown | racing | finished
    this.countdown = this.config.countdown;
    this.finishOrder = [];
    this.result = null;
    this._rankScratch = [];
  }

  // --- setup ---------------------------------------------------------------

  _spawnField(playerBuild) {
    const total = 1 + this.config.rivals;

    this.player = new Racer({ build: playerBuild, isPlayer: true, name: 'You' });
    this._addRacer(this.player, 0, total);

    const pool = this.config.rivalArchetypes
      || ['racer', 'racer', 'tank', 'bomber', 'hunter', 'disruptor', 'swarm'];
    for (let i = 0; i < this.config.rivals; i++) {
      const arch = ARCHETYPES[pool[i % pool.length]] || ARCHETYPES.racer;
      // Every racer must own its Build. Sharing one means sharing the stat
      // block, the skill list with its per-race levels, and the hook closures,
      // so one car spending energy would spend it for all of them.
      const build = this.config.makeRivalBuild
        ? this.config.makeRivalBuild(arch, this.rng, i)
        : makeDefaultRivalBuild(arch, this.config.difficulty);
      const r = new Racer({
        build, isPlayer: false, name: arch.name, archetype: arch, colorSeed: i,
      });
      this._addRacer(r, i + 1, total);
      this.drivers.push(new Driver(r, arch, this.rng.fork(`driver${i}`), this.config.difficulty));
    }
  }

  _addRacer(racer, slot, total) {
    racer._trackLength = this.track.length;
    racer.placeAt(this.track.startPose(slot, total));
    this.track.sample(racer.body.x, racer.body.z, racer.sample);
    // Sit the car where the physics is going to hold it, not where the grid
    // maths put it.
    //
    // `startPose` takes its height from the path at the station it lays the
    // slot out on; `sample` takes it from the nearest station to where the car
    // ended up, and on a curve those are not the same station. With elevation
    // under the track the two answers differ by up to a hundred millimetres —
    // always on the inside of the bend, which is why it was the left-hand car
    // on the grid, every time, with its wheels in the tarmac until the lights
    // went out and the first physics step dropped it.
    racer.body.y = racer.sample.groundY;
    racer._lastS = racer.sample.s;
    racer.trackS = racer.sample.s;
    // Fallback footprint; the presentation layer replaces these with the ones
    // its generated mesh actually has. `halfWidth` is the lateral half-extent
    // and is what the barrier must clear, distinct from the round `radius`
    // used for car-to-car contact.
    racer.radius = racer.radius ?? 1.6;
    racer.halfWidth = racer.halfWidth ?? 1.0;
    racer.halfLength = racer.halfLength ?? 2.1;
    this.racers.push(racer);
  }

  /**
   * Hand the player's car to an AI Driver.
   *
   * `archetype` matters: it is how the car is *driven*, not how fast it is.
   * Driving everything as a low-aggression racer measures pace alone, which
   * understates any vehicle whose identity is contact — a Truck driven like a
   * qualifying lap is just a slow Rocket. Callers may name one; otherwise it is
   * inferred from the vehicle.
   */
  setAutopilot(on, difficulty = 1, archetype = null) {
    if (!on) { this.autopilot = null; return; }
    const arch = (typeof archetype === 'string' ? ARCHETYPES[archetype] : archetype)
      || ARCHETYPES[VEHICLE_DRIVING_STYLE[this.player.build.vehicle.id]]
      || ARCHETYPES.racer;
    this.autopilot = new Driver(this.player, arch, this.rng.fork('autopilot'), difficulty);
  }

  // --- simulation ----------------------------------------------------------

  update(dt, playerInput) {
    if (this.state === 'finished') return;

    // Where everything was, before this step moves it.
    //
    // The renderer draws between two simulated instants rather than at the
    // last one, which is what stops a car covering ninety centimetres between
    // one frame and the next at speed. Taken here, at the top, so the pair
    // spans the whole step including whatever the collisions do to it.
    for (const r of this.racers) r.body.savePose();
    for (const c of this.traffic ?? []) {
      c.px = c.x; c.py = c.y; c.pz = c.z; c.pyaw = c.yaw;
    }

    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.events?.emit('race:start', this);
        for (const r of this.racers) r.build.fire('onRaceStart', { racer: r, race: this });
      }
    }

    const racing = this.state === 'racing';
    if (racing) this.time += dt;

    // 1. inputs
    if (racing) {
      if (this.autopilot) {
        this.autopilot.update(dt, this.track, this.racers, this._leaderProgress());
      } else if (playerInput) {
        Object.assign(this.player.input, playerInput);
      }
      for (const d of this.drivers) {
        d.update(dt, this.track, this.racers, this._leaderProgress());
      }
    } else {
      // Held on the grid. Note `brake: 0`, not 1: in this model the brake
      // becomes reverse once the car is stationary — which is what the S key is
      // for — so holding it through the countdown drove the entire field
      // backwards off the grid.
      for (const r of this.racers) {
        r.input.throttle = 0; r.input.brake = 0; r.input.steer = 0;
        r.input.drift = false; r.input.nos = false;
      }
    }

    if (racing) this._updateDraft(dt);

    // 2-3. motion, then sample
    for (const r of this.racers) {
      if (!r.alive) continue;
      if (racing) {
        r.body.step(dt, r.input, r.sample.surface || undefined, r.sample.groundY ?? 0);
      } else {
        // Engines running, wheels stopped. Integrating at all before the lights
        // go out lets the grid drift, so the field is pinned instead.
        r.body.vx = 0;
        r.body.vz = 0;
        r.body.vy = 0;
        r.body.yawRate = 0;
        r.body.speed = 0;
        r.body.forwardSpeed = 0;
        r.body.lateralSpeed = 0;
        r.body.slipAngle = 0;
        r.body.drifting = false;
      }
      this.track.sample(r.body.x, r.body.z, r.sample);
    }

    // 4. skills, then collisions. Skills resolve first so a shockwave fired
    //    this step is already pushing cars apart when contacts are evaluated.
    if (racing) this._resolveSkills(dt);
    this.combat.update(dt);

    this._resolveBarriers(dt);
    this._resolveProps(dt);
    if (this.traffic.length && racing) {
      stepTraffic(this.traffic, this.track, this.racers, dt, {
        onHit: (racer, car, closing) => {
          // Traffic ruins your race, it does not end your run. The cost that
          // matters is the speed scrubbed off in `stepTraffic` — losing the
          // corner and the place. Damage at `4 + closing * 0.55` was killing an
          // attentive driver in five contacts, which turns a hazard to read
          // into a durability tax on entering the district at all.
          racer.damage(2 + closing * 0.26, { type: 'traffic' }, this);
          this.events?.emit('audio:impact', { strength: closing, isPlayer: racer.isPlayer });
          this.onTrafficHit?.(racer, car, closing);
        },
        onNearMiss: (racer, car, strength) => {
          this.events?.emit('race:nearmiss', { racer, car, strength });
        },
      });
    }
    this._resolveCars(dt);

    // 5. resources
    for (const r of this.racers) {
      if (!r.alive) continue;
      if (r._ramCd > 0) r._ramCd -= dt;
      if (r._barrierCd > 0) r._barrierCd -= dt;
      r.stepResources(dt, this);
    }

    // 6. progress
    if (racing) {
      for (const r of this.racers) {
        if (!r.alive || r.finished) continue;
        r.updateProgress(this.track);
        this._checkStuck(r, dt);
        if (r.lap >= this.config.laps) {
          r.finished = true;
          r.finishTime = this.time;
          this.finishOrder.push(r);
          this.events?.emit('race:finish', { racer: r, place: this.finishOrder.length });
        }
      }
      this._updatePlacings();
      this._checkEnd();
    }

    // Reset one-shot skill presses so a held key does not re-fire.
    for (const r of this.racers) r.input.skills.fill(false);
  }

  /**
   * Turn skill button presses into effects.
   *
   * Cost and cooldown are charged only when the skill reports that it actually
   * did something: a grappling hook with nothing to grab must not eat 20
   * Energy and go on cooldown. A skill returning `false` is a no-op.
   */
  _resolveSkills(dt) {
    for (const racer of this.racers) {
      if (!racer.alive || racer.finished) continue;
      const skills = racer.build.skills;
      for (let i = 0; i < skills.length && i < racer.input.skills.length; i++) {
        if (!racer.input.skills[i]) continue;
        this.useSkill(racer, i);
      }
    }
  }

  useSkill(racer, index) {
    const skill = racer.build.skills[index];
    if (!skill || !skill.fire) return false;
    if ((racer.cooldowns[index] ?? 0) > 0) return false;

    const cost = (skill.cost ?? 0) * racer.build.stats.mod('energyCost');
    if (racer.energy < cost) return false;

    const ctx = {
      racer,
      race: this,
      combat: this.combat,
      level: skill.level ?? 1,
      skill,
    };
    const fired = skill.fire(ctx);
    if (fired === false) return false;   // skill declined; charge nothing

    racer.energy -= cost;
    racer.cooldowns[index] = (skill.cooldown ?? 1) * racer.build.stats.mod('skillCooldown');
    racer.stats.skillsUsed++;
    racer.build.fire('onSkillUse', { racer, race: this, skill, level: ctx.level });
    this.events?.emit('race:skill', { racer, skill, index });
    return true;
  }

  /** Run to completion with no rendering. Returns the result. */
  runToCompletion(dt = 1 / 60, maxSeconds = 400) {
    const maxSteps = Math.ceil((maxSeconds + this.config.countdown) / dt);
    for (let i = 0; i < maxSteps && this.state !== 'finished'; i++) {
      this.update(dt, null);
    }
    if (this.state !== 'finished') {
      this.result = { outcome: 'timeout', place: this.player.position };
      this.state = 'finished';
    }
    return this.result;
  }

  /**
   * Rescue a car that has stopped making progress.
   *
   * Every racing game needs this and it is not a workaround for a bug: a heavy
   * car can wedge itself between a barrier and another car in a geometry no
   * amount of steering escapes, and a human is just as capable of ending up
   * there as the AI. Without it a run can simply stop.
   *
   * The rescue is deliberately not free — it costs the time already lost, puts
   * the car back at walking pace, and takes a small bite of Durability — so it
   * is never a better option than driving.
   */
  _checkStuck(racer, dt) {
    // A car that is driving is not stuck, whatever the progress metric says.
    // This guard is deliberately independent of `raceProgress`: the rescue is a
    // last resort for a wedged car, and must never reach out and slow down
    // someone going fast in a direction the metric mismeasured.
    //
    // "Driving" has to include *which way*. Speed and being on track are not
    // enough: a car left facing backwards after a hard barrier hit satisfies
    // both while driving the wrong way down the circuit, and the guard kept
    // resetting the timer so the rescue never came. It could stay like that
    // indefinitely, which from the seat is a car that has stopped responding.
    const trackYaw = this.track.path.yawAt(racer.trackS);
    const withTrack = Math.cos(angleDelta(racer.body.yaw, trackYaw));

    // Second trigger: time spent off the racing surface, not ground covered.
    //
    // The progress rule cannot see this case. A car scraping along the verge is
    // covering plenty of ground, so it never looks stuck — but it is off the
    // road, on gravel, at half speed, and it is not racing. Cars used to escape
    // this by bouncing off scenery, which only worked because the scenery was
    // being placed inside the barrier line; with the props moved out to where
    // they belong, that accidental crutch is gone and the honest rule has to
    // replace it. Speed-limited so a fast car running wide is left alone, and
    // branch-exempt so taking a shortcut is not treated as leaving the road.
    if (racer.sample.onTrack === false && !racer.sample.branch) {
      racer._offTrackTime = (racer._offTrackTime ?? 0) + dt;
    } else {
      racer._offTrackTime = 0;
    }
    if (racer._offTrackTime > OFF_TRACK_RESCUE_TIME) {
      this._rescue(racer);
      return;
    }

    if (racer.body.speed > 8 && racer.sample.onTrack !== false && withTrack > 0.2) {
      racer._stuckWindow = 0;
      racer._windowStart = racer.raceProgress(this.track);
      return;
    }

    // Rate, not absolute gain. Comparing against a best-so-far mark meant a car
    // creeping along a barrier at 2 km/h still gained the 1.5 m threshold every
    // couple of seconds and reset the timer — forever. Measuring distance
    // covered per window catches the crawl that the threshold missed.
    const progress = racer.raceProgress(this.track);
    racer._stuckWindow = (racer._stuckWindow ?? 0) + dt;
    if (racer._windowStart == null) racer._windowStart = progress;
    if (racer._stuckWindow < STUCK_WINDOW) return;

    const gained = progress - racer._windowStart;
    racer._stuckWindow = 0;
    racer._windowStart = progress;
    if (gained > STUCK_MIN_PROGRESS) return;
    this._rescue(racer);
  }

  /** Put a car back on the racing line, moving, at the cost of a little health. */
  _rescue(racer) {
    const pose = {
      ...this.track.path.pointAt(racer.trackS, { x: 0, y: 0, z: 0 }),
      yaw: this.track.path.yawAt(racer.trackS),
    };
    racer.body.place(pose.x, pose.z, pose.yaw);
    racer.body.y = pose.y;
    // Rejoin moving, not from a standstill, so the rescue does not itself
    // strand a heavy car that cannot accelerate out of the way.
    racer.body.vx = Math.sin(pose.yaw) * 12;
    racer.body.vz = Math.cos(pose.yaw) * 12;
    racer.damage(4, { type: 'rescue' }, this);
    racer._stuckWindow = 0;
    racer._offTrackTime = 0;
    racer._windowStart = racer.raceProgress(this.track);
    racer.rescuedAt = this.time;
    this.events?.emit('race:rescue', { racer });
  }

  /**
   * Who is in whose wake.
   *
   * Runs before the step, so a car is towed by where the field was rather than
   * by where it is about to be — which is what keeps this the same for every
   * car and independent of the order they are integrated in.
   *
   * The field tows and so does the traffic: tucking in behind a van is a real
   * thing to do on a public road, and the civilians are the only cars on the
   * circuit slow enough to be caught easily.
   */
  _updateDraft(dt) {
    for (const r of this.racers) {
      if (!r.alive) { r.body.draft = 0; continue; }
      const b = r.body;
      if (b.speed < DRAFT_MIN_SPEED) { b.draft = 0; b.draftFrom = null; continue; }

      let best = 0;
      let from = null;
      for (const other of this.racers) {
        if (other === r || !other.alive) continue;
        const d = draftBetween(b, other.body);
        if (d > best) { best = d; from = other; }
      }
      for (const car of this.traffic ?? []) {
        if (!car.alive) continue;
        const d = draftBetween(b, car);
        if (d > best) { best = d; from = car; }
      }

      // Eased rather than snapped. A wake is not a switch, and without this a
      // car weaving behind another flickers between towed and not, which the
      // engine falloff turns into audible surging.
      const rate = best > b.draft ? DRAFT_RISE : DRAFT_FALL;
      b.draft += (best - b.draft) * Math.min(1, rate * dt);
      if (b.draft < 0.002) b.draft = 0;
      b.draftFrom = b.draft > 0.05 ? from : null;
    }
  }

  _leaderProgress() {
    let best = -Infinity;
    for (const r of this.racers) {
      const p = r.raceProgress(this.track);
      if (p > best) best = p;
    }
    return best;
  }

  _updatePlacings() {
    const arr = this._rankScratch;
    arr.length = 0;
    for (const r of this.racers) arr.push(r);
    arr.sort((a, b) => {
      // Finished cars rank by finish time, ahead of everyone still running.
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.raceProgress(this.track) - a.raceProgress(this.track);
    });
    for (let i = 0; i < arr.length; i++) arr[i].position = i + 1;
  }

  _checkEnd() {
    if (!this.player.alive) {
      this.state = 'finished';
      this.result = { outcome: 'destroyed', place: this.racers.length, time: this.time };
      this.events?.emit('race:over', this.result);
      return;
    }
    if (this.player.finished) {
      this.state = 'finished';
      this.result = {
        outcome: 'finished',
        place: this.finishOrder.indexOf(this.player) + 1,
        time: this.player.finishTime,
        field: this.racers.length,
      };
      this.events?.emit('race:over', this.result);
    }
  }

  // --- collisions ----------------------------------------------------------

  /**
   * Cars against destructible scenery.
   *
   * Whether you go through a barrel stack or bounce off it is decided by
   * momentum and Impact, which is what the design brief means by obstacles
   * being a route rather than a wall: the same cluster is a shortcut for a
   * Truck and a hazard for a Rocket.
   */
  _resolveProps(dt) {
    const props = this.collidable;
    if (props.length === 0) return;

    for (const r of this.racers) {
      if (!r.alive) continue;
      const b = r.body;
      const phys = r.build.physics;
      // Momentum times Impact. Mass is normalised on the baseline 1200 kg so a
      // heavy car genuinely carries more through an obstacle.
      const smash = b.speed * (phys.mass / 1200) * phys.impactForce * 1.5;

      for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        if (!prop.alive) continue;

        const dx = prop.x - b.x;
        const dz = prop.z - b.z;
        const rsum = prop.radius + r.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 > rsum * rsum) continue;

        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d, nz = dz / d;
        // Only a contact we are driving *into* counts.
        const closing = b.vx * nx + b.vz * nz;
        if (closing <= 0) continue;

        if (smash >= prop.toughness) {
          prop.alive = false;
          // Going through costs a little speed and a little paint, scaled by
          // how close the call was.
          const ratio = clamp01(prop.toughness / Math.max(smash, 1));
          b.vx -= nx * closing * 0.22 * ratio;
          b.vz -= nz * closing * 0.22 * ratio;
          // Going through still shakes the car — less than bouncing off it.
          b.jolt(-nx * closing * 0.35 * ratio, -nz * closing * 0.35 * ratio);
          r.damage(prop.toughness * 0.020, { type: 'prop', prop: prop.type }, this);
          this.events?.emit('race:propSmashed', { prop, racer: r });
          this.onPropSmashed?.(prop, r, closing);
          r.build.fire('onImpact', {
            racer: r, race: this, target: null, kind: 'prop',
            speed: closing, damage: prop.toughness * 0.045,
          });
        } else {
          // Bounce. Push out of penetration, take the speed, and pay for it.
          //
          // This removed 1.35 times the closing component, which does not
          // absorb a collision — it reverses it. Nose-first into a barrier at
          // sixty and you left at twenty going backwards, which is what "I
          // touch a structure and the car goes into reverse" was. A car meeting
          // something solid crumples and stops; it does not rebound off it. So
          // a tenth comes back and the rest is gone, and what is left of your
          // speed along the obstacle is scrubbed rather than carried, because
          // sliding past something you just hit head-on is its own kind of
          // wrong.
          const over = rsum - d;
          b.x -= nx * over;
          b.z -= nz * over;
          const absorb = propAbsorb(closing);
          b.vx -= nx * closing * absorb;
          b.vz -= nz * closing * absorb;
          const ptx = -nz;
          const ptz = nx;
          const pvt = b.vx * ptx + b.vz * ptz;
          b.vx -= ptx * pvt * 0.30;
          b.vz -= ptz * pvt * 0.30;
          b.gripPenalty = Math.min(b.gripPenalty, 0.6);
          b.gripPenaltyTimer = Math.max(b.gripPenaltyTimer, 0.35);
          b.jolt(-nx * closing, -nz * closing);
          // Nudge the car sideways off the obstacle so repeatedly driving into
          // something unsmashable does not become a permanent stop. Which way
          // comes from the prop rather than from `Math.random`: a race has to
          // replay identically from its seed, and the playtest and balance
          // tools depend on it.
          const away = (prop.x + prop.z) % 2 < 1 ? 1 : -1;
          b.x += -nz * 0.12 * away;
          b.z += nx * 0.12 * away;
          const applied = r.damage(closing * 0.30, { type: 'prop', prop: prop.type }, this);
          this.onPropHit?.(prop, r, closing);
          this.events?.emit('audio:impact', { strength: closing, isPlayer: r.isPlayer });
          r.build.fire('onImpact', {
            racer: r, race: this, target: null, kind: 'prop',
            speed: closing, damage: applied,
          });
        }
      }
    }
  }

  /**
   * Push cars back inside the track edge. Modelled as a wall: the velocity
   * component into the barrier is reflected and damped, the tangential
   * component is scrubbed, and damage scales with approach speed rather than
   * absolute speed — brushing a wall while quick is not the same mistake as
   * driving into one.
   */
  _resolveBarriers(dt) {
    for (const r of this.racers) {
      if (!r.alive) continue;
      const b = r.body;
      const s = r.sample;

      // Only the main line is walled. A shortcut is a route, not a corridor:
      // it has no barrier mesh, so giving it collision walls means bouncing off
      // something that was never drawn. Leaving a branch simply puts you on the
      // biome's rough, which already costs you.
      if (s.branch) continue;

      const path = s.path || this.track.path;
      const localS = s.branch ? this.track._branchLocalS(s.branch, s.s) : s.s;
      const t = path.tangentAt(localS);
      const sideSign = Math.sign(s.side) || 1;
      // Wall normal points back toward the centreline.
      const nx = -sideSign * t.z;
      const nz = sideSign * t.x;

      // How far the bodywork reaches toward the wall.
      //
      // This used to test the car's centre point against the boundary, which
      // meant the centre came to rest exactly on the rail with half the car
      // through it. Reserving a fixed half-width is not enough either: a car
      // at an angle to the barrier reaches much further sideways than its
      // flank does, so a nose-in car buried its front corner in the fence and
      // sat there. This is the support function of the car's box along the
      // wall normal — exact for a rectangle at any heading, and it costs two
      // dot products.
      // This limit constrains the car's *centre*, which is why the rail is
      // drawn a car half-width further out (BARRIER_RAIL_OFFSET). That is what
      // fixes the rail passing through the car: a car alongside the wall now
      // meets it with its flank instead of resting its centre on it.
      //
      // Making this limit depend on the car's heading — so an angled car's
      // corner is stopped too — was tried and is worse, and not because of the
      // margin it costs. A heading-dependent boundary *moves as the car
      // rotates*, so turning away from the wall to escape shoves the car back
      // into it mid-manoeuvre. Pinned cars that recovered in 10 s stopped
      // recovering at all, and tightening the cap made it worse rather than
      // better. A spun car's nose can overhang the rail; that is the cheaper
      // artifact by a long way.
      const limit = s.halfWidth + BARRIER_OFFSET;
      const over = Math.abs(s.side) - limit;
      if (over <= 0) continue;

      // Clamp the correction. The boundary is curved and this push is linear,
      // so a stale sample on a tight corner can compute an enormous overlap;
      // teleporting the car is never the right answer to that.
      const push = Math.min(over, 2.5);
      b.x += nx * push;
      b.z += nz * push;

      const vn = b.vx * nx + b.vz * nz;
      if (vn >= 0) continue;

      const approach = -vn;
      const speedBefore = Math.hypot(b.vx, b.vz);

      // Reflect the component going into the wall.
      b.vx -= nx * vn * (1 + BARRIER_RESTITUTION);
      b.vz -= nz * vn * (1 + BARRIER_RESTITUTION);

      // Friction along the wall.
      //
      // This was `v *= 0.94` applied to the whole velocity every frame it was
      // in contact — 6% per frame, which is 0.94^60 = 2% of your speed left
      // after one second, and it is worse the faster the game runs. A car held
      // against a barrier was scrubbed to a standstill and then pinned there:
      // throttle fighting a 6%-per-frame drain, brake with nothing to slow, and
      // steering authority that scales with a speed now near zero. It read
      // exactly as the controls having died.
      //
      // Now it is time-based, and applied only to the component running *along*
      // the wall, which is the only part friction acts on.
      const tx = -nz, tz = nx;
      const vt = b.vx * tx + b.vz * tz;
      const kept = vt * Math.exp(-BARRIER_FRICTION * dt);
      b.vx += tx * (kept - vt);
      b.vz += tz * (kept - vt);

      // Slide along the wall rather than spinning off it — but only while you
      // are actually sliding along it.
      //
      // Damping the yaw and pulling the heading parallel is what makes a
      // glancing scrape a cost in time instead of a spin, and that is worth
      // keeping. Applied at any speed it does something else entirely: a car
      // nose-first into a barrier at walking pace had its heading taken away
      // and turned to face down the wall, every frame, whatever the driver did.
      // Between that and steering authority vanishing with speed, being stuck
      // was a state you waited out rather than drove out of.
      //
      // So it fades out below a scraping speed. Rubbing along a wall at pace is
      // still smoothed; sitting against one is left entirely to the driver.
      const SCRAPE = 9;
      const along = Math.min(1, Math.abs(vt) / SCRAPE);
      // And keep straightening it for a moment after the rail is behind it: the
      // spin a wall produces arrives after the contact, not during it.
      b.wallSteady = Math.max(b.wallSteady ?? 0, 0.55 * along);
      if (along > 0.01) {
        const wallYaw = Math.atan2(tx * Math.sign(vt || 1), tz * Math.sign(vt || 1));
        b.yawRate *= Math.exp(-6 * along * dt);
        b.yaw = wrapAngle(b.yaw + angleDelta(wallYaw, b.yaw) * (1 - Math.exp(-4 * along * dt)));
        b.wallYaw = wallYaw;
      }

      this._applySpeedFloor(r, speedBefore);

      // Only a real hit hurts, and only once per contact window. Without the
      // cooldown a car scraping a wall is billed on all 60 steps it spends
      // there, which deletes a car for a mistake that only looked like a graze.
      if (approach > 6 && (r._barrierCd ?? 0) <= 0) {
        r._barrierCd = BARRIER_CONTACT_COOLDOWN;
        // The wall is what threw the car, so the jolt comes from the wall.
        b.jolt(nx * approach, nz * approach);
        const applied = r.damage((approach - 6) * 1.2, { type: 'barrier' }, this);
        b.gripPenalty = Math.min(b.gripPenalty, 0.6);
        b.gripPenaltyTimer = Math.max(b.gripPenaltyTimer, 0.3);
        this.onBarrierHit?.(r, -nx, -nz, approach);
        this.events?.emit('audio:impact', { strength: approach, isPlayer: r.isPlayer });
        r.build.fire('onImpact', {
          racer: r, race: this, target: null, kind: 'barrier',
          speed: approach, damage: applied,
        });
      }
    }
  }

  /**
   * Car on car, as two rectangles rather than two circles.
   *
   * Circles were wrong in both directions at once. A car is 4.3 m by 1.8 m and
   * its bounding circle has a radius of about 1.3, so two cars running side by
   * side bounced off each other with two thirds of a metre of clear air
   * between them, while one tucked into another's slipstream drove a metre into
   * its boot before anything noticed. Neither reads as contact, because neither
   * happens where the contact is.
   *
   * With boxes the collision has a *place*, and that is what the response has
   * been missing. An impulse through the centre of mass can only ever shove;
   * clipping somebody's rear quarter and hitting them square in the back were
   * the same event. Applied at the point it actually landed, the same blow
   * splits into shove and spin according to how far off centre it was, which is
   * the difference between a nudge and losing the car.
   */
  _resolveCars(dt) {
    const n = this.racers.length;
    for (let i = 0; i < n; i++) {
      const a = this.racers[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.racers[j];
        if (!b.alive) continue;

        // Cheap circle test first: most pairs on the grid are nowhere near each
        // other, and SAT on every pair every step is not worth paying for.
        const dxc = b.body.x - a.body.x;
        const dzc = b.body.z - a.body.z;
        const reach = a.radius + b.radius;
        if (dxc * dxc + dzc * dzc > reach * reach) continue;

        const hit = obbContact(a, b);
        if (!hit) continue;
        const { nx, nz, depth, px, pz } = hit;

        const ab = a.body;
        const bb = b.body;
        const ma = ab.p.mass;
        const mb = bb.p.mass;
        const total = ma + mb;

        // Separate in proportion to mass: the lighter car gives way.
        //
        // Clamped, for the same reason the barrier push is. When the frame rate
        // drops the loop takes several sim steps between drawn frames, and at
        // fifty metres a second a car covers most of its own length inside one
        // of them — so two of them can arrive already deeply inside each other
        // rather than just touching. Undoing that in one go teleports both,
        // which reads far worse than the overlap it fixes. Half a metre a step
        // has them apart within a few steps and never jumps.
        const sep = Math.min(depth, 0.5);
        ab.x -= nx * sep * (mb / total);
        ab.z -= nz * sep * (mb / total);
        bb.x += nx * sep * (ma / total);
        bb.z += nz * sep * (ma / total);

        // Lever arms from each centre of mass to where the cars are touching.
        const rax = px - ab.x;
        const raz = pz - ab.z;
        const rbx = px - bb.x;
        const rbz = pz - bb.z;

        const Ia = yawInertia(a);
        const Ib = yawInertia(b);
        const wa = ab.yawRate + ab.impactSpin;
        const wb = bb.yawRate + bb.impactSpin;

        // Velocity of the two cars *at the point they meet*, which is not their
        // velocity: a rotating car's flank is moving even when its centre is not.
        const vax = ab.vx - wa * raz;
        const vaz = ab.vz + wa * rax;
        const vbx = bb.vx - wb * rbz;
        const vbz = bb.vz + wb * rbx;
        const rvx = vbx - vax;
        const rvz = vbz - vaz;

        const closing = rvx * nx + rvz * nz;
        if (closing > 0) continue;   // already separating

        const aSpeedBefore = Math.hypot(ab.vx, ab.vz);
        const bSpeedBefore = Math.hypot(bb.vx, bb.vz);

        // Rotation enters the denominator: a blow near the centre is resisted by
        // the car's mass, one out at a corner also by its resistance to spin.
        const ran = rax * nz - raz * nx;
        const rbn = rbx * nz - rbz * nx;
        const invMass = 1 / ma + 1 / mb + (ran * ran) / Ia + (rbn * rbn) / Ib;
        const jn = (-(1 + CAR_RESTITUTION) * closing) / invMass;

        ab.applyContactImpulse(-jn * nx, -jn * nz, rax, raz, Ia);
        bb.applyContactImpulse(jn * nx, jn * nz, rbx, rbz, Ib);

        // Friction across the contact. Without it a sideswipe is a clean bounce;
        // with it the two cars drag along each other, which is what a sideswipe
        // is and where the rotation in a door-to-door fight comes from.
        const tx = -nz;
        const tz = nx;
        const vt = rvx * tx + rvz * tz;
        const rat = rax * tz - raz * tx;
        const rbt = rbx * tz - rbz * tx;
        const invT = 1 / ma + 1 / mb + (rat * rat) / Ia + (rbt * rbt) / Ib;
        const jt = clamp(-vt / invT, -jn * CAR_FRICTION, jn * CAR_FRICTION);
        ab.applyContactImpulse(-jt * tx, -jt * tz, rax, raz, Ia);
        bb.applyContactImpulse(jt * tx, jt * tz, rbx, rbz, Ib);

        this._applySpeedFloor(a, aSpeedBefore);
        this._applySpeedFloor(b, bSpeedBefore);

        const approach = -closing;

        // Every contact unsettles both cars, whether or not it hurts them.
        //
        // Two cars running abreast at the same speed that touch lose almost no
        // speed, and that is not a bug — there is no sliding between them, so
        // there is nothing for friction to take. But it left a side-swipe
        // costing literally nothing: the pair sprang apart, both still at a
        // hundred and eight, with no sound, no shudder and no consequence, and
        // that is what "the cars go sideways but it does not feel like a
        // collision" was. Real sheet metal at that speed puts a car off its
        // line. So the tyres are upset in proportion to how hard the contact
        // was, which costs grip and steering for a moment rather than speed
        // outright — and it is the impulse that decides, not the closing speed,
        // because a heavy car leaning on a light one is a big impulse at
        // walking pace.
        const bite = clamp01(Math.abs(jn) / 9000);
        for (const [x, other] of [[a, b], [b, a]]) {
          const upset = 1 - 0.45 * bite * (other.body.p.mass / 1200);
          x.body.gripPenalty = Math.min(x.body.gripPenalty, clamp(upset, 0.45, 1));
          x.body.gripPenaltyTimer = Math.max(x.body.gripPenaltyTimer, 0.25 + bite * 0.5);
        }

        // And it is heard and felt from the first touch, not from the third.
        // The old floor of three metres a second silenced exactly the contact
        // that happens most: two cars fighting for the same line.
        if (approach > 0.6 || bite > 0.08) {
          this.onCarHit?.(a, b, nx, nz, approach);
          this.events?.emit('audio:impact', {
            strength: Math.max(approach, bite * 12), isPlayer: a.isPlayer || b.isPlayer,
          });
        }

        // Damage still needs a real hit behind it.
        if (approach < 3) continue;
        this._applyRamDamage(a, b, nx, nz, approach);
        this._applyRamDamage(b, a, -nx, -nz, approach);
      }
    }
  }

  /**
   * Momentum retention. Some machines are defined by the fact that hitting
   * things does not stop them; this is where that promise is kept. Applied
   * after every impulse that a collision produced.
   */
  _applySpeedFloor(racer, speedBefore) {
    const floor = racer.build.stats.mod('collisionSpeedFloor');
    if (floor <= 0 || speedBefore <= 0.01) return;
    const b = racer.body;
    const now = Math.hypot(b.vx, b.vz);
    const min = speedBefore * floor;
    if (now >= min || now < 1e-4) return;
    const k = min / now;
    b.vx *= k;
    b.vz *= k;
  }

  _applyRamDamage(attacker, victim, nx, nz, approach) {
    // One contact, one hit. Two cars in sustained contact overlap for several
    // steps; billing each of those as a separate collision turns a nudge into
    // a kill.
    if ((victim._ramCd ?? 0) > 0) return;

    const ab = attacker.body;
    // Facing bonus: hitting with the nose is worth far more than being shunted.
    const facing = clamp01(ab.forwardX * nx + ab.forwardZ * nz);
    const impact = attacker.build.physics.impactForce;
    let dmg = (approach - 3) * 1.3 * impact * (0.4 + facing * 0.9);

    const ctx = {
      racer: attacker, race: this, target: victim, kind: 'ram',
      speed: approach, facing, amount: dmg,
    };
    dmg = attacker.build.reduce('modifyDamageDealt', dmg, ctx);
    if (dmg <= 0) return;

    const applied = victim.damage(dmg, { type: 'ram', from: attacker }, this);
    victim._ramCd = RAM_CONTACT_COOLDOWN;
    attacker.stats.damageDealt += applied;
    attacker.build.fire('onImpact', { ...ctx, damage: applied });

    if (!victim.alive) {
      attacker.stats.kills++;
      this._onKill(attacker, victim);
    }
  }

  _onKill(killer, victim) {
    const mods = killer.build.stats;
    killer.addEnergy(mods.mod('energyOnKill'));
    killer.repair(mods.mod('repairOnKill'));
    const boost = mods.mod('boostOnKill');
    if (boost > 0) killer.body.applyBoost(0.25, boost);
    killer.build.fire('onKill', { racer: killer, race: this, target: victim });
    this.events?.emit('race:wreck', { killer, victim });
    this.onWreck?.(killer, victim);
  }
}
