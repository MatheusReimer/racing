import { clamp, clamp01, lerp, angleDelta } from '../core/math.js';

// Projectiles, traps, blasts and status effects.
//
// Lives in the simulation, not the renderer, for the same reason RaceSim does:
// a skill's damage has to be identical whether a human is watching or the
// balance tool is running it 10,000 times. The visual layer subscribes to
// events and draws; it is never consulted about outcomes.
//
// Everything is pooled. A race can have a few hundred live entities during a
// heavy Bomber run, and allocating those per frame is exactly the kind of
// garbage that turns into a visible hitch mid-corner.

export const STATUS = {
  electrified: {
    id: 'electrified', name: 'Electrified', duration: 3.0,
    // Chains and re-procs read this; the design doc's Electric build is built
    // on top of it.
    onApply: (racer) => {
      // The timer is what restores grip. Setting the penalty without it leaves
      // the car permanently down 30% for the rest of the race.
      racer.body.gripPenalty = Math.min(racer.body.gripPenalty, 0.7);
      racer.body.gripPenaltyTimer = Math.max(racer.body.gripPenaltyTimer, 3.0);
    },
  },
  frozen: {
    id: 'frozen', name: 'Frozen', duration: 2.2,
    onApply: (racer) => { racer.body.gripPenalty = 0.25; racer.body.gripPenaltyTimer = 2.2; },
  },
  burning: { id: 'burning', name: 'Burning', duration: 4.0, dps: 6 },
  emp: {
    id: 'emp', name: 'EMP', duration: 1.6,
    onApply: (racer) => racer.body.stun(1.6),
  },
  oiled: { id: 'oiled', name: 'Oiled', duration: 2.5 },
  punctured: {
    id: 'punctured', name: 'Punctured', duration: 6.0,
    // Not grip. A flat tyre does not make you slide in corners, it makes you
    // slow everywhere, which is a different decision: you keep racing on it
    // and lose ground steadily, or you spend a pit stop on it.
    onApply: (racer, seconds = 6.0) => racer.body.puncture(0.72, seconds),
  },
};

let nextId = 1;

export class CombatSystem {
  constructor(race) {
    this.race = race;
    this.projectiles = [];
    this.traps = [];
    this.pool = [];
    this.time = 0;
  }

  // --- spawning ------------------------------------------------------------

  _alloc() {
    return this.pool.pop() || {};
  }

  _free(obj) {
    obj.dead = true;
    if (this.pool.length < 256) this.pool.push(obj);
  }

  /**
   * @param owner    Racer who fired
   * @param spec     { speed, damage, radius, homing, life, tags, gravity,
   *                   forward, spread, pierce, onHit }
   */
  spawnProjectile(owner, spec) {
    const b = owner.body;
    const phys = owner.build.physics;
    const p = this._alloc();

    // Aim: forward for offensive, backward for defensive drops.
    const dir = spec.forward === false ? -1 : 1;
    const spread = (spec.spread ?? phys.weaponSpread) * (Math.random() - 0.5);
    const yaw = b.yaw + spread + (dir < 0 ? Math.PI : 0);

    const speed = (spec.speed ?? 60) * phys.weaponSpeedScale;

    p.id = nextId++;
    p.kind = 'projectile';
    p.owner = owner;
    p.x = b.x + Math.sin(yaw) * 2.2;
    p.z = b.z + Math.cos(yaw) * 2.2;
    p.y = b.y + 0.7;
    // Inherit the launcher's velocity: a rocket fired at 200 km/h should not
    // be slower than the car that fired it.
    p.vx = Math.sin(yaw) * speed + b.vx * (dir > 0 ? 0.7 : 0.2);
    p.vz = Math.cos(yaw) * speed + b.vz * (dir > 0 ? 0.7 : 0.2);
    p.vy = spec.arc ? spec.arc : 0;
    p.gravity = spec.gravity ?? (spec.arc ? 22 : 0);
    p.damage = (spec.damage ?? 20) * phys.weaponDamageScale;
    p.radius = spec.radius ?? 0;
    p.hitRadius = spec.hitRadius ?? 1.8;
    p.homing = (spec.homing ?? 0) + phys.weaponHoming;
    p.life = spec.life ?? 4;
    p.tags = spec.tags || [];
    p.pierce = spec.pierce ?? 0;
    p.status = spec.status || null;
    p.statusDuration = spec.statusDuration ?? null;
    p.onHit = spec.onHit || null;
    p.target = null;
    p.dead = false;
    p.visual = spec.visual || 'rocket';

    this.projectiles.push(p);
    this.race.events?.emit('fx:projectile', p);
    return p;
  }

  /**
   * A dropped hazard. Traps arm after a short delay so you cannot detonate one
   * on yourself the instant you place it.
   */
  spawnTrap(owner, spec) {
    const b = owner.body;
    const phys = owner.build.physics;
    const t = this._alloc();

    const back = spec.behind === false ? 1 : -1;
    t.id = nextId++;
    t.kind = 'trap';
    t.owner = owner;
    t.x = b.x + Math.sin(b.yaw) * 3.4 * back;
    t.z = b.z + Math.cos(b.yaw) * 3.4 * back;
    t.y = b.y;
    t.damage = (spec.damage ?? 18) * phys.weaponDamageScale;
    t.radius = spec.radius ?? 0;
    t.hitRadius = spec.hitRadius ?? 2.4;
    t.life = spec.life ?? 25;
    t.arm = spec.arm ?? 0.6;
    t.tags = spec.tags || [];
    t.status = spec.status || null;
    t.statusDuration = spec.statusDuration ?? null;
    t.spin = spec.spin ?? 0;         // takes the line away instead of damaging
    t.surface = spec.surface || null; // oil slick
    t.onHit = spec.onHit || null;
    t.dead = false;
    t.visual = spec.visual || 'mine';

    this.traps.push(t);
    this.race.events?.emit('fx:trap', t);
    return t;
  }

  /**
   * Area damage and knockback. Damage falls off with distance; knockback is
   * handled by the body so mass decides who gets launched.
   */
  explode(owner, x, z, radius, damage, tags = [], opts = {}) {
    const r = radius * (owner ? owner.build.stats.mod('blastRadius') : 1);
    const dmgMult = this._tagMultiplier(owner, tags);

    for (const racer of this.race.racers) {
      if (!racer.alive) continue;
      if (racer === owner && !opts.selfDamage) continue;
      const dx = racer.body.x - x;
      const dz = racer.body.z - z;
      const d = Math.hypot(dx, dz);
      if (d > r) continue;

      const falloff = 1 - d / r;
      const dmg = damage * dmgMult * (0.35 + falloff * 0.65);
      this._dealDamage(owner, racer, dmg, tags, opts.status, false, opts.statusSeconds);
      racer.body.applyBlast(x, z, (opts.force ?? 26) * falloff, r);
    }

    this.race.events?.emit('fx:explosion', { x, y: 0.8, z, radius: r, power: damage / 30, tags });
  }

  // --- stepping ------------------------------------------------------------

  update(dt) {
    this.time += dt;
    this._stepProjectiles(dt);
    this._stepTraps(dt);
    this._stepStatuses(dt);
  }

  _stepProjectiles(dt) {
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) {
        if (p.radius > 0) this.explode(p.owner, p.x, p.z, p.radius, p.damage, p.tags);
        this._retire(list, i, p);
        continue;
      }

      // Homing: steer the velocity toward the nearest valid target ahead.
      if (p.homing > 0) {
        if (!p.target || !p.target.alive) p.target = this._nearestTarget(p);
        if (p.target) {
          const speed = Math.hypot(p.vx, p.vz);
          const want = Math.atan2(p.target.body.x - p.x, p.target.body.z - p.z);
          const cur = Math.atan2(p.vx, p.vz);
          // Turn rate is capped: full homing would make Weapon Control
          // pointless and every shot unavoidable.
          const turn = clamp(angleDelta(cur, want), -1, 1) * Math.min(p.homing, 0.9) * 6 * dt;
          const na = cur + turn;
          p.vx = Math.sin(na) * speed;
          p.vz = Math.cos(na) * speed;
        }
      }

      if (p.gravity) {
        p.vy -= p.gravity * dt;
        p.y += p.vy * dt;
      }
      p.x += p.vx * dt;
      p.z += p.vz * dt;

      // Ground contact for arcing projectiles.
      const groundY = 0;
      if (p.gravity && p.y <= groundY) {
        if (p.radius > 0) this.explode(p.owner, p.x, p.z, p.radius, p.damage, p.tags);
        this._retire(list, i, p);
        continue;
      }

      // Hit test against racers.
      let consumed = false;
      for (const racer of this.race.racers) {
        if (!racer.alive || racer === p.owner) continue;
        const dx = racer.body.x - p.x;
        const dz = racer.body.z - p.z;
        if (dx * dx + dz * dz > (p.hitRadius + racer.radius) ** 2) continue;

        if (p.radius > 0) {
          // With its status. `explode` has always taken one and nothing has
          // ever handed it one, so every *area* projectile dropped it on the
          // floor: a Molotov never set anyone Burning and an Electric Grenade
          // never Electrified anything, at any level, ever. Both read as
          // working, because both still did their damage and their blast.
          this.explode(p.owner, p.x, p.z, p.radius, p.damage, p.tags,
            { status: p.status, statusSeconds: p.statusDuration });
        } else {
          this._dealDamage(p.owner, racer, p.damage * this._tagMultiplier(p.owner, p.tags),
            p.tags, p.status);
        }
        if (p.onHit) p.onHit(this, p, racer);

        if (p.pierce > 0) { p.pierce--; consumed = false; }
        else consumed = true;
        break;
      }
      if (consumed) this._retire(list, i, p);
    }
  }

  _stepTraps(dt) {
    const list = this.traps;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      t.life -= dt;
      if (t.arm > 0) t.arm -= dt;
      if (t.life <= 0) { this._retire(list, i, t); continue; }
      if (t.arm > 0) continue;

      for (const racer of this.race.racers) {
        if (!racer.alive) continue;
        // Your own traps stay harmless: a mine you dropped is a weapon, not a
        // mistake waiting for you on the next lap.
        if (racer === t.owner) continue;
        const dx = racer.body.x - t.x;
        const dz = racer.body.z - t.z;
        if (dx * dx + dz * dz > (t.hitRadius + racer.radius) ** 2) continue;

        if (t.radius > 0) {
          this.explode(t.owner, t.x, t.z, t.radius, t.damage, t.tags,
            { status: t.status, statusSeconds: t.statusDuration });
        } else if (t.damage > 0) {
          // `statusSeconds` last, past `silent`: a trap that both hurts and
          // applies a status used to lose its duration here, so a Spike Strip
          // at level 5 — the only level where it also does damage — punctured
          // for six seconds instead of the nine its card promised.
          this._dealDamage(t.owner, racer, t.damage * this._tagMultiplier(t.owner, t.tags),
            t.tags, t.status, false, t.statusDuration);
        } else if (t.status) {
          // A trap whose whole point is the status and not the damage.
          //
          // The status used to ride along inside `_dealDamage`, so a
          // zero-damage trap applied nothing at all — which meant the Banana's
          // "victims are also Oiled" at level 4 never once happened, because
          // its damage only starts at level 5. Nothing failed loudly; the
          // effect simply was not there.
          this.applyStatus(racer, t.status, t.owner, t.statusDuration);
        }
        if (t.spin > 0) {
          // Taking the line away, at whatever strength the trap asked for.
          //
          // The grip loss used to be a flat 0.2 for 1.1s whatever the spin —
          // fine for a hazard built to spin you out, wrong for one that only
          // means to twitch the wheel, which got the full spin-out anyway.
          const bite = Math.min(1, t.spin / 2.4);
          racer.body.yawRate += (Math.random() > 0.5 ? 1 : -1) * t.spin;
          racer.body.gripPenalty = Math.min(racer.body.gripPenalty, 1 - 0.8 * bite);
          racer.body.gripPenaltyTimer = Math.max(racer.body.gripPenaltyTimer, 1.1 * bite);
        }
        if (t.onHit) t.onHit(this, t, racer);
        this.race.events?.emit('fx:trapHit', { trap: t, racer });
        this._retire(list, i, t);
        break;
      }
    }
  }

  _stepStatuses(dt) {
    for (const racer of this.race.racers) {
      if (!racer.statuses) continue;
      for (let i = racer.statuses.length - 1; i >= 0; i--) {
        const st = racer.statuses[i];
        st.t -= dt;
        const def = STATUS[st.id];
        if (def?.dps) {
          this._dealDamage(st.source, racer, def.dps * dt, [def.id === 'burning' ? 'Fire' : ''], null, true);
        }
        if (st.t <= 0) racer.statuses.splice(i, 1);
      }
    }
  }

  _retire(list, i, obj) {
    list.splice(i, 1);
    this.race.events?.emit('fx:despawn', obj);
    this._free(obj);
  }

  // --- helpers -------------------------------------------------------------

  _nearestTarget(p) {
    let best = null;
    let bestD = 90;
    for (const racer of this.race.racers) {
      if (!racer.alive || racer === p.owner) continue;
      const dx = racer.body.x - p.x;
      const dz = racer.body.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      // Only chase things roughly in front, or homing looks like a boomerang.
      const speed = Math.hypot(p.vx, p.vz) || 1;
      const fwd = (dx * p.vx + dz * p.vz) / (d * speed);
      if (fwd < 0.2) continue;
      best = racer; bestD = d;
    }
    return best;
  }

  /** Elemental damage multipliers from the owner's build. */
  _tagMultiplier(owner, tags) {
    if (!owner || !tags || tags.length === 0) return 1;
    const m = owner.build.stats;
    let mult = 1;
    if (tags.includes('Electric')) mult *= m.mod('electricDamage');
    if (tags.includes('Explosive')) mult *= m.mod('explosiveDamage');
    if (tags.includes('Trap')) mult *= m.mod('trapDamage');
    if (tags.includes('Projectile')) mult *= m.mod('projectileDamage');
    return mult;
  }

  _dealDamage(owner, victim, amount, tags, status, silent = false, statusSeconds = null) {
    if (amount <= 0 || !victim.alive) return 0;

    let dmg = amount;
    if (owner) {
      const ctx = { racer: owner, race: this.race, target: victim, kind: 'skill', tags, amount: dmg };
      dmg = owner.build.reduce('modifyDamageDealt', dmg, ctx);
    }

    const applied = victim.damage(dmg, { type: 'skill', from: owner, tags }, this.race);
    if (owner) owner.stats.damageDealt += applied;

    if (status) this.applyStatus(victim, status, owner, statusSeconds);
    if (!silent) {
      this.race.events?.emit('fx:hit', { racer: victim, amount: applied, tags });
    }

    if (!victim.alive && owner) {
      owner.stats.kills++;
      this.race._onKill(owner, victim);
    }
    return applied;
  }

  /**
   * @param seconds  override the status's own duration — a skill that scales
   *                 how long it lasts needs to say so, and the description on
   *                 the card is a promise the code has to keep
   */
  applyStatus(racer, id, source = null, seconds = null) {
    const def = STATUS[id];
    if (!def) return;
    const t = seconds ?? def.duration;
    if (!racer.statuses) racer.statuses = [];
    const existing = racer.statuses.find((s) => s.id === id);
    if (existing) {
      existing.t = Math.max(existing.t, t);
      // Re-applied, so whatever the status does to the car is re-applied too:
      // a second hit that only pushed the timer out would leave a longer but
      // weaker effect than the first one.
      def.onApply?.(racer, t);
    } else {
      racer.statuses.push({ id, t, source });
      def.onApply?.(racer, t);
    }
    this.race.events?.emit('fx:status', { racer, id });
  }

  hasStatus(racer, id) {
    return !!racer.statuses?.some((s) => s.id === id);
  }

  /** Everything alive within `r` metres of a point, nearest first. */
  racersNear(x, z, r, exclude = null) {
    const out = [];
    for (const racer of this.race.racers) {
      if (!racer.alive || racer === exclude) continue;
      const d = Math.hypot(racer.body.x - x, racer.body.z - z);
      if (d <= r) out.push({ racer, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  clear() {
    this.projectiles.length = 0;
    this.traps.length = 0;
  }
}
