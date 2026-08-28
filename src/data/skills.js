// Active skills.
//
// Two rules shape everything here.
//
// Tags are the interface. A skill declares what it *is* (Electric, Explosive,
// Trap, Projectile, Control...) and parts reach for those tags rather than for
// skill ids. That is what lets "Storm Engine" boost every Electric source a
// build will ever pick up, including ones added later, without either knowing
// about the other.
//
// Levels change identity, not numbers. The design brief is explicit: an
// Electric Grenade at level 5 should not be "the same grenade, +80% damage" —
// it should chain, and then detonate what it chained to. Damage still rises,
// but the reason to level a skill is the new clause.

const L = (n) => n - 1; // levels are 1-based to the player, 0-based in arrays

export const SKILLS = [
  // ---------------------------------------------------------------- speed --
  {
    id: 'nitro',
    name: 'Nitro',
    icon: '🔥',
    tags: ['Speed', 'Energy'],
    rarity: 'common',
    cost: 18,
    cooldown: 6,
    maxLevel: 5,
    desc: (lv) => `Instant boost to ${Math.round((0.35 + lv * 0.05) * 100)}% over top speed for ${(1.6 + lv * 0.25).toFixed(1)}s.`
      + (lv >= 3 ? ' Purges Frozen and Oiled.' : '')
      + (lv >= 5 ? ' Ramming while boosting deals double Impact.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      racer.body.applyBoost(
        (0.35 + level * 0.05) * racer.build.stats.mod('boostPower'),
        1.6 + level * 0.25,
      );
      racer.addHeat(6);
      if (level >= 3 && racer.statuses) {
        racer.statuses = racer.statuses.filter((s) => s.id !== 'frozen' && s.id !== 'oiled');
        racer.body.gripPenalty = 1;
      }
      if (level >= 5) racer._nitroRamUntil = combat.time + 1.6 + level * 0.25;
      racer.build.fire('onBoost', { racer, race: ctx.race, source: 'nitro' });
    },
  },

  // ----------------------------------------------------------- projectiles --
  {
    id: 'rocket',
    name: 'Rocket',
    icon: '🚀',
    tags: ['Projectile', 'Explosive'],
    rarity: 'common',
    cost: 22,
    cooldown: 5,
    maxLevel: 5,
    desc: (lv) => `Fires a rocket. ${Math.round(26 + lv * 8)} damage in a ${(4 + lv * 0.6).toFixed(1)}m blast.`
      + (lv >= 3 ? ' Fires two rockets in a spread.' : '')
      + (lv >= 5 ? ' Wrecks caused by it detonate a second blast.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const shots = level >= 3 ? 2 : 1;
      for (let i = 0; i < shots; i++) {
        combat.spawnProjectile(racer, {
          speed: 78,
          damage: 26 + level * 8,
          radius: 4 + level * 0.6,
          hitRadius: 1.9,
          life: 3.2,
          spread: shots > 1 ? (i === 0 ? -0.09 : 0.09) : undefined,
          tags: ['Projectile', 'Explosive'],
          visual: 'rocket',
          onHit: level >= 5 ? (cs, p, victim) => {
            if (!victim.alive) {
              cs.explode(p.owner, victim.body.x, victim.body.z, 7, 22, ['Explosive']);
            }
          } : null,
        });
      }
      racer.addHeat(5);
    },
  },

  {
    id: 'homing_missile',
    name: 'Homing Missile',
    icon: '🎯',
    tags: ['Projectile', 'Explosive', 'Control'],
    rarity: 'rare',
    cost: 30,
    cooldown: 8,
    maxLevel: 5,
    desc: (lv) => `Seeking missile, ${Math.round(30 + lv * 9)} damage. Tracking scales with Weapon Control.`
      + (lv >= 3 ? ' Re-targets after a kill.' : '')
      + (lv >= 5 ? ' Splits into three on its final second.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      combat.spawnProjectile(racer, {
        speed: 62,
        damage: 30 + level * 9,
        radius: 4.5,
        homing: 0.35 + level * 0.08,
        life: 5,
        tags: ['Projectile', 'Explosive', 'Control'],
        visual: 'missile',
        onHit: level >= 3 ? (cs, p) => { p.target = null; } : null,
      });
      racer.addHeat(7);
    },
  },

  // -------------------------------------------------------------- electric --
  {
    id: 'electric_grenade',
    name: 'Electric Grenade',
    icon: '⚡',
    tags: ['Electric', 'Projectile', 'Area', 'Control'],
    rarity: 'rare',
    cost: 26,
    cooldown: 7,
    maxLevel: 5,
    // The design brief's worked example, implemented as written.
    desc: (lv) => {
      const lines = [`Arcing grenade, ${Math.round(20 + lv * 7)} electric damage.`];
      if (lv >= 2) lines.push('Leaves a charged field.');
      if (lv >= 3) lines.push('Electrifies those it hits.');
      if (lv >= 4) lines.push('Electrification jumps to nearby cars.');
      if (lv >= 5) lines.push('Electrified wrecks explode.');
      return lines.join(' ');
    },
    fire(ctx) {
      const { racer, level, combat } = ctx;
      combat.spawnProjectile(racer, {
        speed: 46,
        arc: 7,
        gravity: 20,
        damage: 20 + level * 7,
        radius: 5.5,
        life: 3,
        tags: ['Electric', 'Projectile', 'Area'],
        status: level >= 3 ? 'electrified' : null,
        visual: 'grenade',
        onHit: (cs, p, victim) => {
          // L2: a lingering field, as a short-lived trap.
          if (level >= 2) {
            cs.spawnTrap(p.owner, {
              behind: false, damage: 8 + level * 2, hitRadius: 5.5, life: 3.5, arm: 0.1,
              tags: ['Electric', 'Area'],
              status: level >= 3 ? 'electrified' : null,
              visual: 'field',
            });
          }
          // L4: the charge jumps outward from whatever it landed on.
          if (level >= 4 && victim) {
            for (const { racer: near } of cs.racersNear(victim.body.x, victim.body.z, 14, victim)) {
              if (near === p.owner) continue;
              cs.applyStatus(near, 'electrified', p.owner);
            }
          }
          // L5: an electrified car that dies takes the neighbourhood with it.
          if (level >= 5 && victim && !victim.alive) {
            cs.explode(p.owner, victim.body.x, victim.body.z, 9, 26, ['Electric']);
          }
        },
      });
      racer.addHeat(4);
    },
  },

  {
    id: 'emp',
    name: 'EMP Pulse',
    icon: '💫',
    tags: ['Electric', 'Area', 'Control'],
    rarity: 'rare',
    cost: 24,
    cooldown: 11,
    maxLevel: 5,
    desc: (lv) => `Stuns every car within ${Math.round(12 + lv * 2)}m.`
      + (lv >= 3 ? ' Also drains 12 Energy from each.' : '')
      + (lv >= 5 ? ' Refunds its own cost per car hit.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const r = 12 + level * 2;
      let hits = 0;
      for (const { racer: victim } of combat.racersNear(racer.body.x, racer.body.z, r, racer)) {
        combat.applyStatus(victim, 'emp', racer);
        if (level >= 3) victim.energy = Math.max(0, victim.energy - 12);
        hits++;
      }
      if (level >= 5) racer.addEnergy(hits * 8);
      combat.race.events?.emit('fx:shockwave', {
        x: racer.body.x, z: racer.body.z, radius: r, color: 0x6fd9ff,
      });
      racer.addHeat(9);
    },
  },

  // ------------------------------------------------------------------ traps --
  {
    id: 'mine',
    name: 'Mine',
    icon: '💣',
    tags: ['Trap', 'Explosive'],
    rarity: 'common',
    cost: 14,
    cooldown: 4,
    maxLevel: 5,
    desc: (lv) => `Drops a mine. ${Math.round(24 + lv * 9)} damage in a ${(4.5 + lv * 0.5).toFixed(1)}m blast.`
      + (lv >= 3 ? ' Drops two.' : '')
      + (lv >= 5 ? ' Mines re-arm once after detonating.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const count = level >= 3 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        combat.spawnTrap(racer, {
          damage: 24 + level * 9,
          radius: 4.5 + level * 0.5,
          life: 30,
          tags: ['Trap', 'Explosive'],
          visual: 'mine',
          onHit: level >= 5 ? (cs, t) => {
            if (t._respawned) return;
            const again = cs.spawnTrap(t.owner, {
              behind: false, damage: t.damage * 0.6, radius: t.radius * 0.8,
              life: 12, tags: t.tags, visual: 'mine',
            });
            again._respawned = true;
            again.x = t.x; again.z = t.z;
          } : null,
        });
      }
      racer.addHeat(3);
    },
  },

  {
    id: 'banana',
    name: 'Banana',
    icon: '🍌',
    tags: ['Trap', 'Control'],
    rarity: 'common',
    cost: 8,
    cooldown: 3,
    maxLevel: 5,
    desc: (lv) => `Drops a slip hazard that spins whoever touches it.`
      + (lv >= 2 ? ` Drops ${Math.min(3, 1 + Math.floor(lv / 2))}.` : '')
      + (lv >= 4 ? ' Victims are also Oiled.' : '')
      + (lv >= 5 ? ' Spun cars take 15 damage.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const count = Math.min(3, 1 + Math.floor(level / 2));
      for (let i = 0; i < count; i++) {
        const t = combat.spawnTrap(racer, {
          damage: level >= 5 ? 15 : 0,
          spin: 2.4 + level * 0.2,
          hitRadius: 2.6,
          life: 40,
          tags: ['Trap', 'Control'],
          status: level >= 4 ? 'oiled' : null,
          visual: 'banana',
        });
        // Fan them across the road so a single line does not dodge all three.
        const spread = (i - (count - 1) / 2) * 3.0;
        t.x += Math.cos(racer.body.yaw) * spread;
        t.z += -Math.sin(racer.body.yaw) * spread;
      }
    },
  },

  {
    id: 'oil_slick',
    name: 'Oil Slick',
    icon: '🛢️',
    tags: ['Trap', 'Control'],
    rarity: 'common',
    cost: 12,
    cooldown: 5,
    maxLevel: 5,
    desc: (lv) => `Lays a slick ${(5 + lv).toFixed(0)}m across. Cars that cross it lose grip.`
      + (lv >= 3 ? ' Lasts twice as long.' : '')
      + (lv >= 5 ? ' Ignites if hit by anything Fire or Explosive.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      combat.spawnTrap(racer, {
        damage: 0,
        hitRadius: 5 + level,
        life: level >= 3 ? 26 : 13,
        tags: ['Trap', 'Control'],
        status: 'oiled',
        visual: 'oil',
        onHit: (cs, t, victim) => {
          victim.body.gripPenalty = 0.18;
          victim.body.gripPenaltyTimer = 2.0;
          if (level >= 5) {
            cs.explode(t.owner, t.x, t.z, 8, 30, ['Explosive', 'Fire']);
          }
        },
      });
    },
  },

  // ------------------------------------------------------------- defensive --
  {
    id: 'shield',
    name: 'Shield',
    icon: '🛡️',
    tags: ['Defense', 'Energy'],
    rarity: 'rare',
    cost: 20,
    cooldown: 12,
    maxLevel: 5,
    desc: (lv) => `Blocks all damage for ${(1.5 + lv * 0.4).toFixed(1)}s.`
      + (lv >= 3 ? ' Reflects contact damage back.' : '')
      + (lv >= 5 ? ' Ends in a shockwave.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      racer.invulnTimer = Math.max(racer.invulnTimer, 1.5 + level * 0.4);
      racer._shieldReflect = level >= 3;
      if (level >= 5) {
        racer._shieldBurst = { at: combat.time + 1.5 + level * 0.4, power: 30 };
      }
      combat.race.events?.emit('fx:shield', { racer, duration: 1.5 + level * 0.4 });
    },
  },

  {
    id: 'repair',
    name: 'Field Repair',
    icon: '🔧',
    tags: ['Defense', 'Energy'],
    rarity: 'rare',
    cost: 32,
    cooldown: 18,
    maxLevel: 5,
    desc: (lv) => `Restores ${Math.round(18 + lv * 7)} Durability.`
      + (lv >= 3 ? ' Also sheds 30 Heat.' : '')
      + (lv >= 5 ? ' Overheals into a temporary shield.' : ''),
    fire(ctx) {
      const { racer, level } = ctx;
      const healed = racer.repair(18 + level * 7);
      if (level >= 3) racer.heat = Math.max(0, racer.heat - 30);
      if (level >= 5 && healed < 18 + level * 7) racer.invulnTimer = Math.max(racer.invulnTimer, 1.2);
      ctx.combat.race.events?.emit('fx:repair', { racer, amount: healed });
    },
  },

  // ---------------------------------------------------------------- exotic --
  {
    id: 'shockwave',
    name: 'Shockwave',
    icon: '💥',
    tags: ['Area', 'Impact', 'Explosive'],
    rarity: 'rare',
    cost: 25,
    cooldown: 9,
    maxLevel: 5,
    desc: (lv) => `Blasts everything within ${Math.round(10 + lv * 2)}m for ${Math.round(18 + lv * 8)} damage and heavy knockback.`
      + (lv >= 3 ? ' Scales with your speed.' : '')
      + (lv >= 5 ? ' Wrecks refund half its cost.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const speedScale = level >= 3
        ? 1 + clampFrac(racer.body.speed / Math.max(1, racer.body.p.maxSpeed)) * 0.8
        : 1;
      const before = combat.race.racers.filter((r) => r.alive).length;
      combat.explode(racer, racer.body.x, racer.body.z, 10 + level * 2,
        (18 + level * 8) * speedScale, ['Area', 'Impact', 'Explosive'], { force: 44 });
      if (level >= 5) {
        const after = combat.race.racers.filter((r) => r.alive).length;
        if (after < before) racer.addEnergy(12);
      }
      racer.addHeat(8);
    },
  },

  {
    id: 'freeze',
    name: 'Cryo Burst',
    icon: '❄️',
    tags: ['Ice', 'Area', 'Control'],
    rarity: 'rare',
    cost: 22,
    cooldown: 10,
    maxLevel: 5,
    desc: (lv) => `Freezes cars within ${Math.round(9 + lv * 2)}m, wrecking their grip.`
      + (lv >= 3 ? ' Also sheds 25 of your Heat.' : '')
      + (lv >= 5 ? ' Frozen cars take +40% damage.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      for (const { racer: v } of combat.racersNear(racer.body.x, racer.body.z, 9 + level * 2, racer)) {
        combat.applyStatus(v, 'frozen', racer);
        if (level >= 5) v._frozenVuln = 1.4;
      }
      if (level >= 3) racer.heat = Math.max(0, racer.heat - 25);
      combat.race.events?.emit('fx:shockwave', {
        x: racer.body.x, z: racer.body.z, radius: 9 + level * 2, color: 0x9fe8ff,
      });
    },
  },

  {
    id: 'molotov',
    name: 'Molotov',
    icon: '🔥',
    tags: ['Fire', 'Projectile', 'Area'],
    rarity: 'common',
    cost: 18,
    cooldown: 6,
    maxLevel: 5,
    desc: (lv) => `Throws a firebomb that sets a ${(5 + lv * 0.8).toFixed(1)}m pool alight.`
      + (lv >= 3 ? ' Burning cars take damage over time.' : '')
      + (lv >= 5 ? ' The pool follows the car that lit it.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      combat.spawnProjectile(racer, {
        speed: 40, arc: 8, gravity: 20,
        damage: 14 + level * 5,
        radius: 5 + level * 0.8,
        life: 3,
        tags: ['Fire', 'Projectile', 'Area'],
        status: level >= 3 ? 'burning' : null,
        visual: 'molotov',
      });
      racer.addHeat(10);
    },
  },

  {
    id: 'decoy',
    name: 'Decoy',
    icon: '👻',
    tags: ['Control', 'Defense'],
    rarity: 'common',
    cost: 15,
    cooldown: 9,
    maxLevel: 5,
    desc: (lv) => `Drops a decoy that pulls homing weapons and Hunter attention for ${(4 + lv).toFixed(0)}s.`
      + (lv >= 3 ? ' Detonates when destroyed.' : '')
      + (lv >= 5 ? ' Drops two.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const n = level >= 5 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        combat.spawnTrap(racer, {
          damage: 0, hitRadius: 2.0, life: 4 + level,
          tags: ['Control', 'Defense'],
          visual: 'decoy',
          onHit: level >= 3 ? (cs, t) => {
            cs.explode(t.owner, t.x, t.z, 6, 20, ['Explosive']);
          } : null,
        });
      }
    },
  },

  {
    id: 'grapple',
    name: 'Grappling Hook',
    icon: '🪝',
    tags: ['Speed', 'Control'],
    rarity: 'epic',
    cost: 20,
    cooldown: 8,
    maxLevel: 5,
    desc: (lv) => `Hooks the car ahead and slingshots you toward it.`
      + (lv >= 3 ? ' Steals 10 of their Energy.' : '')
      + (lv >= 5 ? ' Also drags them backward.' : ''),
    fire(ctx) {
      const { racer, level, combat } = ctx;
      const b = racer.body;
      // Nearest car actually in front, within reach.
      let target = null, bestD = 60;
      for (const { racer: v, d } of combat.racersNear(b.x, b.z, 60, racer)) {
        const dx = v.body.x - b.x, dz = v.body.z - b.z;
        const fwd = (dx * b.forwardX + dz * b.forwardZ) / (d || 1);
        if (fwd < 0.4) continue;
        target = v; bestD = d; break;
      }
      if (!target) return false;   // no target: the skill does not fire or charge

      const dx = target.body.x - b.x, dz = target.body.z - b.z;
      const d = Math.hypot(dx, dz) || 1;
      const pull = 16 + level * 3;
      b.applyImpulse((dx / d) * pull, (dz / d) * pull, true);
      b.applyBoost(0.15 + level * 0.03, 1.2);
      if (level >= 3) {
        const stolen = Math.min(10, target.energy);
        target.energy -= stolen;
        racer.addEnergy(stolen);
      }
      if (level >= 5) target.body.applyImpulse(-(dx / d) * 9, -(dz / d) * 9, true);
      combat.race.events?.emit('fx:grapple', { from: racer, to: target });
      return true;
    },
  },
];

function clampFrac(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export const SKILL_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

/** The five the MVP section of the design brief calls for. */
export const STARTER_SKILL_IDS = ['nitro', 'rocket', 'mine', 'banana', 'electric_grenade'];

export function skillById(id) {
  return SKILL_BY_ID[id];
}

/** A fresh, level-1 instance for putting into a build. */
export function instantiateSkill(id, level = 1) {
  const def = SKILL_BY_ID[id];
  if (!def) throw new Error(`unknown skill: ${id}`);
  return { ...def, level };
}
