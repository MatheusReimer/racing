import { clamp, clamp01, lerp, angleDelta, wrap } from '../core/math.js';

// Rival AI.
//
// The driver writes into the same `input` struct the player's keyboard writes
// into, and nothing else. No teleporting, no velocity fudging, no rubber-band
// speed multiplier — a rival that is ahead of you got there by driving.
//
// Rubber-banding, where it exists at all, is expressed as *aggression*: a
// trailing rival takes more risk (later braking, tighter lines, more skill
// usage) rather than being handed free speed. That keeps a race close without
// making the player's own speed feel meaningless.
//
// Cornering is anticipatory: the driver samples curvature well ahead of itself
// and computes the speed the corner can actually be taken at from its own
// grip, then brakes to arrive at that speed. A reactive driver that brakes
// when it is already in the corner cannot drive these circuits at all.

export const ARCHETYPES = {
  racer: {
    id: 'racer', name: 'Racer',
    skill: 0.82, aggression: 0.35, cornerConfidence: 0.95,
    lineWander: 0.35, ramChance: 0.15, skillRate: 0.5,
    color: '#d0d5db',
  },
  tank: {
    id: 'tank', name: 'Tank',
    skill: 0.62, aggression: 0.75, cornerConfidence: 0.80,
    lineWander: 0.2, ramChance: 0.85, skillRate: 0.3,
    color: '#6b7d55',
  },
  bomber: {
    id: 'bomber', name: 'Bomber',
    skill: 0.70, aggression: 0.5, cornerConfidence: 0.85,
    lineWander: 0.5, ramChance: 0.3, skillRate: 0.95,
    color: '#c86a2b',
  },
  hunter: {
    id: 'hunter', name: 'Hunter',
    skill: 0.86, aggression: 0.9, cornerConfidence: 0.92,
    lineWander: 0.25, ramChance: 0.95, skillRate: 0.7,
    color: '#a93226',
  },
  disruptor: {
    id: 'disruptor', name: 'Disruptor',
    skill: 0.74, aggression: 0.45, cornerConfidence: 0.88,
    lineWander: 0.6, ramChance: 0.25, skillRate: 1.0,
    color: '#5b8fd0',
  },
  swarm: {
    id: 'swarm', name: 'Swarm',
    skill: 0.55, aggression: 0.6, cornerConfidence: 0.78,
    lineWander: 0.8, ramChance: 0.5, skillRate: 0.4,
    color: '#c9a227',
  },
};

export class Driver {
  constructor(racer, archetype, rng, difficulty = 1) {
    this.racer = racer;
    this.arch = archetype;
    this.rng = rng;
    this.difficulty = difficulty;

    // Personality: a fixed lateral bias so rivals do not all drive the exact
    // same line and stack into a single-file train.
    this.lineBias = rng.spread(0.55) * archetype.lineWander;
    this.reactionLag = lerp(0.16, 0.045, archetype.skill);
    this._steerHold = 0;
    this._holdTimer = 0;
    this._recoverTimer = 0;
    this._skillTimer = rng.range(1, 4);
    this._targetRacer = null;
    this._branchChoice = null;
    this._stuckTimer = 0;
  }

  /**
   * @param dt
   * @param track
   * @param racers  everyone in the race, for targeting and avoidance
   * @param leaderProgress  for the aggression band
   */
  update(dt, track, racers, leaderProgress) {
    const r = this.racer;
    const b = r.body;
    const input = r.input;

    if (!r.alive || r.finished) {
      input.throttle = 0; input.brake = 1; input.steer = 0;
      input.drift = false; input.nos = false;
      return;
    }

    const s = r.sample.s ?? 0;
    const speed = b.speed;
    const maxSpeed = b.p.maxSpeed;

    // --- recovery: facing the wrong way, or wedged against a wall ----------
    const trackYaw = track.path.yawAt(s);
    const facingErr = Math.abs(angleDelta(b.yaw, trackYaw));
    if (facingErr > 2.1 && speed < 12) this._recoverTimer = Math.max(this._recoverTimer, 1.4);
    if (speed < 3 && r.sample.onTrack === false) this._stuckTimer += dt;
    else this._stuckTimer = Math.max(0, this._stuckTimer - dt * 2);
    if (this._stuckTimer > 1.6) { this._recoverTimer = 1.2; this._stuckTimer = 0; }

    if (this._recoverTimer > 0) {
      this._recoverTimer -= dt;
      // Reverse and steer back toward the track.
      input.throttle = 0;
      input.brake = 1;
      input.steer = clamp(angleDelta(b.yaw, trackYaw) * 1.5, -1, 1);
      input.drift = false;
      return;
    }

    // --- pick a target point on the racing line ----------------------------
    // Lookahead scales with speed: you steer for where you will be, not where
    // you are. Too short and the car saws at the wheel; too long and it cuts
    // every corner.
    const lookahead = clamp(6 + speed * 0.55, 10, 55);
    const targetS = s + lookahead;

    // Lateral placement: bias plus a pull toward the inside of the coming
    // corner, which is what makes the AI look like it knows the track.
    const curveAhead = track.path.curvatureAt(s + lookahead * 0.6, 14);
    const hw = track.halfWidthAt(targetS);
    let lateral = this.lineBias * hw;
    lateral += clamp(-curveAhead * 380, -1, 1) * hw * 0.55 * this.arch.cornerConfidence;

    lateral += this._avoidance(racers, track, hw);
    lateral = clamp(lateral, -hw * 0.88, hw * 0.88);

    const tp = track.path.offsetPoint(targetS, lateral, { x: 0, y: 0, z: 0 });

    // --- steering ----------------------------------------------------------
    const desiredYaw = Math.atan2(tp.x - b.x, tp.z - b.z);
    let err = angleDelta(b.yaw, desiredYaw);

    // Counter-steer when sliding: aim the *velocity* at the target, not the
    // nose, or the car cannot recover from a slide it started.
    if (b.drifting) {
      const velYaw = Math.atan2(b.vx, b.vz);
      err = angleDelta(b.yaw, desiredYaw) + angleDelta(velYaw, desiredYaw) * 0.8;
    }

    // Reaction lag, so weaker drivers visibly over- and under-correct.
    this._holdTimer -= dt;
    if (this._holdTimer <= 0) {
      this._steerHold = clamp(-err * 3.0, -1, 1);
      this._holdTimer = this.reactionLag;
    }
    input.steer = this._steerHold;

    // --- speed for the corner ahead ----------------------------------------
    // For every point in a forward window, ask two questions:
    //
    //   what speed can that corner be held at?   v_c = sqrt(a_lat * r)
    //   what speed may I be at *now* and still
    //   shed down to v_c across distance d?      v = sqrt(v_c^2 + 2*a_brake*d)
    //
    // and take the minimum. This is the standard braking-point solve, and the
    // distance term is what makes it anticipatory: a hairpin 80 m away raises
    // no alarm at 40 m/s but forbids 60 m/s.
    //
    // Discounting curvature by distance instead — the obvious shortcut — is
    // subtly wrong: scaling `c` down and then inverting it inflates the radius,
    // so far corners look *gentler* rather than merely less urgent, and the car
    // arrives 25% too fast and runs wide every time.
    const confidence = this.arch.cornerConfidence * lerp(0.86, 1.06, this.difficulty / 3);
    const brake = b.p.brakeDecel * 0.8;   // margin: never plan on a perfect stop
    let cornerSpeed = maxSpeed * 1.2;
    const scanEnd = clamp(20 + speed * 2.6, 45, 170);
    for (let d = 6; d < scanEnd; d += 6) {
      const c = Math.abs(track.path.curvatureAt(s + d, 12));
      if (c < 1e-5) continue;
      const vCorner = Math.sqrt(b.p.corneringAccel * (1 / c)) * confidence;
      const vNow = Math.sqrt(vCorner * vCorner + 2 * brake * d);
      if (vNow < cornerSpeed) cornerSpeed = vNow;
    }
    cornerSpeed = clamp(cornerSpeed, maxSpeed * 0.14, maxSpeed * 1.2);

    if (speed > cornerSpeed * 1.06) {
      input.throttle = 0;
      input.brake = clamp01((speed - cornerSpeed) / (maxSpeed * 0.22));
    } else {
      input.brake = 0;
      input.throttle = clamp01((cornerSpeed - speed) / (maxSpeed * 0.1) + 0.35);
    }

    // Off track: lift and steer hard back toward the racing line. The pull has
    // to dominate the normal steering term, or a car that clips a verge on a
    // fast corner just tracks along outside the road for the rest of it.
    if (r.sample.onTrack === false) {
      input.throttle *= 0.5;
      const over = Math.abs(r.sample.side ?? 0) - (r.sample.halfWidth ?? 10);
      const urgency = clamp01(over / 6);
      const back = clamp(Math.sign(r.sample.side ?? 0) * (0.5 + urgency), -1, 1);
      input.steer = clamp(input.steer * 0.3 + back, -1, 1);
      input.drift = false;
    }

    // --- drifting ----------------------------------------------------------
    // Only drivers whose build actually rewards it, and only in corners they
    // are already committed to.
    const wantsDrift = this.racer.build.stats.get('drift') > 130;
    input.drift = wantsDrift && Math.abs(curveAhead) > 0.012 && speed > maxSpeed * 0.5
      && Math.abs(err) > 0.10;

    // --- nitrous -----------------------------------------------------------
    // On the straight, pointed the right way, and not about to need the grip
    // for a corner. Held down until the corner arrives rather than tapped, so
    // rivals show the same rhythm the player is being taught.
    //
    // The reserve threshold matters: a driver that empties the bottle the
    // moment it has any leaves itself nothing for the run to the line, and the
    // field then never contests a finish.
    const straightAhead = Math.abs(curveAhead) < 0.006;
    const reserve = this.racer.raceProgress(track) > track.length * 0.75 ? 0.06 : 0.30;
    input.nos = straightAhead
      && this.racer.nos > reserve
      && speed > maxSpeed * 0.45
      && Math.abs(err) < 0.25
      && !b.drifting;

    // --- aggression --------------------------------------------------------
    this._maybeRam(dt, racers, input, b);
    this._maybeSkill(dt, racers, track);
  }

  /** Steer away from cars alongside, and toward one we intend to ram. */
  _avoidance(racers, track, hw) {
    const r = this.racer;
    const b = r.body;
    let push = 0;
    for (const other of racers) {
      if (other === r || !other.alive) continue;
      const dx = other.body.x - b.x;
      const dz = other.body.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 400) continue;          // 20 m
      const d = Math.sqrt(d2) || 1;
      // Only care about cars roughly ahead of us.
      const fwd = (dx * b.forwardX + dz * b.forwardZ) / d;
      if (fwd < -0.2) continue;
      const side = (dx * b.rightX + dz * b.rightZ) / d;
      const urgency = (1 - d / 20) * (0.4 + fwd * 0.6);
      // `side` > 0 means the obstacle is to our right; the path's positive
      // lateral offset is to the *left* of travel, so move that way.
      push += Math.sign(side || 1) * urgency * hw * 0.7;
    }
    return push;
  }

  _maybeRam(dt, racers, input, b) {
    if (this.rng.next() > this.arch.ramChance * dt * 2) return;
    let best = null, bestD = 26;
    for (const other of racers) {
      if (other === this.racer || !other.alive) continue;
      // Hunters go for the player specifically; everyone else takes targets
      // of opportunity.
      if (this.arch.id === 'hunter' && !other.isPlayer) continue;
      const dx = other.body.x - b.x, dz = other.body.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      const fwd = (dx * b.forwardX + dz * b.forwardZ) / (d || 1);
      if (fwd < 0.35) continue;
      best = other; bestD = d;
    }
    if (!best) return;
    const dx = best.body.x - b.x, dz = best.body.z - b.z;
    const desired = Math.atan2(dx, dz);
    input.steer = clamp(input.steer - angleDelta(b.yaw, desired) * 1.6, -1, 1);
    input.throttle = 1;
    input.brake = 0;
  }

  _maybeSkill(dt, racers, track) {
    this._skillTimer -= dt * this.arch.skillRate;
    if (this._skillTimer > 0) return;
    this._skillTimer = this.rng.range(2.5, 6.0) / Math.max(0.2, this.difficulty * 0.6);

    const r = this.racer;
    for (let i = 0; i < r.build.skills.length; i++) {
      if (r.cooldowns[i] > 0) continue;
      const sk = r.build.skills[i];
      if (r.energy < (sk.cost ?? 0)) continue;
      r.input.skills[i] = true;
      return;
    }
  }
}
