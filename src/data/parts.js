// Parts.
//
// The design brief is blunt about what makes a part worth existing: "+10%
// Speed" is a bad item, "+15% Speed, and above 80% of top speed your attacks
// deal +30%" is a better one, and the best version also feeds something back
// into the loop. So almost everything here carries a `hooks` clause, and the
// pure stat sticks that remain are deliberately commons — the floor of the
// pool, not the substance of it.
//
// Trade-offs are real. A part that raises one attribute usually lowers
// another, and the strong ones lower something that matters. `cursed` items go
// further: enormous power against a cost severe enough to build a whole run
// around avoiding or embracing.
//
// Authoring notes:
//   stats  numbers are percentages (`topSpeed: 0.25` is +25%); use
//          `{ flat: n }` for an absolute change.
//   mods   are the named channels in statblock.js.
//   hooks  are the events in build.js. `modifyDamage*` are reducers that
//          return a number; everything else mutates the context.
//   tags   are what other parts read. Tag your part honestly — synergies are
//          built entirely on these.

export const SLOTS = {
  engine: { id: 'engine', name: 'Engine', icon: '⚙️' },
  tires: { id: 'tires', name: 'Tires', icon: '🛞' },
  chassis: { id: 'chassis', name: 'Chassis', icon: '🔩' },
  bumper: { id: 'bumper', name: 'Bumper', icon: '🛡️' },
  battery: { id: 'battery', name: 'Battery', icon: '🔋' },
  weapon: { id: 'weapon', name: 'Weapon', icon: '🎯' },
  gadget: { id: 'gadget', name: 'Gadget', icon: '📦' },
  special: { id: 'special', name: 'Special', icon: '✦' },
};

export const RARITY = {
  common: { id: 'common', name: 'Common', weight: 100, color: '#9aa5b1', price: 40 },
  rare: { id: 'rare', name: 'Rare', weight: 46, color: '#4fa3e3', price: 85 },
  epic: { id: 'epic', name: 'Epic', weight: 18, color: '#b06be0', price: 150 },
  legendary: { id: 'legendary', name: 'Legendary', weight: 5, color: '#ffa726', price: 260 },
  cursed: { id: 'cursed', name: 'Cursed', weight: 14, color: '#e5484d', price: 70 },
};

/** Helper: fraction of top speed the car is currently doing. */
const speedFrac = (racer) =>
  Math.min(1, racer.body.speed / Math.max(1, racer.body.p.maxSpeed));

export const PARTS = [
  // ======================================================= ENGINE ==========
  {
    id: 'turbocharger', name: 'Turbocharger', slot: 'engine', rarity: 'common',
    tags: ['Speed'],
    stats: { topSpeed: 0.16, acceleration: 0.10, braking: -0.08 },
    mods: { heatGen: 3 },
    text: 'The straightforward trade: go faster, stop worse, run hotter.',
  },
  {
    id: 'velocity_core', name: 'Velocity Core', slot: 'engine', rarity: 'rare',
    tags: ['Speed'],
    stats: { topSpeed: 0.25, braking: -0.10 },
    text: 'Above 80% of top speed, everything you do hits 30% harder.',
    hooks: {
      modifyDamageDealt: (amount, ctx) =>
        speedFrac(ctx.racer) > 0.8 ? amount * 1.3 : amount,
    },
  },
  {
    id: 'storm_engine', name: 'Storm Engine', slot: 'engine', rarity: 'epic',
    tags: ['Speed', 'Electric'],
    stats: { topSpeed: 0.18, energy: 0.15 },
    text: 'Electric damage scales with your speed — up to +80% flat out.',
    hooks: {
      modifyDamageDealt: (amount, ctx) => {
        if (!ctx.tags?.includes('Electric')) return amount;
        return amount * (1 + speedFrac(ctx.racer) * 0.8);
      },
    },
  },
  {
    id: 'overclocked_engine', name: 'Overclocked Engine', slot: 'engine', rarity: 'rare',
    tags: ['Speed', 'Heat'],
    stats: { topSpeed: 0.25, acceleration: 0.15, braking: -0.10 },
    mods: { heatGen: 9 },
    text: 'The design brief\'s example, verbatim. Fast, hot, hard to slow down.',
  },
  {
    id: 'overheated_engine', name: 'Overheated Engine', slot: 'engine', rarity: 'epic',
    tags: ['Heat', 'Speed'],
    stats: { acceleration: 0.10 },
    mods: { heatGen: 7 },
    text: 'Top speed rises with Heat: up to +45% at the edge of meltdown.',
    hooks: {
      // Heat as a resource you *spend upward*: the whole Heat archetype exists
      // because of parts like this one.
      onTick: (ctx) => {
        const boost = (ctx.racer.heat / 100) * 0.45;
        ctx.racer.body.boostPower = Math.max(ctx.racer.body.boostPower, boost);
        ctx.racer.body.boostTimer = Math.max(ctx.racer.body.boostTimer, 0.2);
      },
    },
  },
  {
    id: 'flywheel', name: 'Momentum Flywheel', slot: 'engine', rarity: 'rare',
    tags: ['Speed', 'Impact'],
    stats: { topSpeed: 0.10, weight: { flat: 30 }, acceleration: -0.12 },
    mods: { collisionSpeedFloor: 0.6 },
    text: 'Heavy, slow to spin up, and very hard to stop once it is going.',
  },
  {
    id: 'cold_start', name: 'Cold Start Manifold', slot: 'engine', rarity: 'common',
    tags: ['Speed'],
    stats: { acceleration: 0.28, topSpeed: -0.06 },
    text: 'Leaps off the line. Runs out of legs.',
  },
  {
    id: 'afterburner', name: 'Afterburner', slot: 'engine', rarity: 'rare',
    tags: ['Speed', 'Fire'],
    stats: { topSpeed: 0.12 },
    mods: { boostPower: 1.4, heatGen: 4 },
    text: 'Every boost is 40% stronger.',
    hooks: {
      onBoost: (ctx) => { ctx.racer.addHeat(8); },
    },
  },
  {
    id: 'hell_engine', name: 'Hell Engine', slot: 'engine', rarity: 'cursed',
    tags: ['Speed', 'Heat', 'Fire'],
    stats: { topSpeed: 0.70 },
    mods: { heatGen: 26 },
    text: 'CURSED — enormous speed, and it never stops generating heat.',
  },

  // ======================================================== TIRES ==========
  {
    id: 'street_slicks', name: 'Street Slicks', slot: 'tires', rarity: 'common',
    tags: ['Grip'],
    stats: { grip: 0.18, drift: -0.10 },
    text: 'Sticky, predictable, dull. Nothing wrong with that.',
  },
  {
    id: 'lightning_tires', name: 'Lightning Tires', slot: 'tires', rarity: 'rare',
    tags: ['Drift', 'Electric'],
    stats: { drift: 0.25, grip: -0.10 },
    text: 'A good drift builds a charge. Release it into whoever is nearest.',
    hooks: {
      onDrift: (ctx) => {
        const r = ctx.racer;
        r._arc = (r._arc || 0) + ctx.quality * ctx.dt;
        if (r._arc < 1.4) return;
        r._arc = 0;
        const near = ctx.race.combat.racersNear(r.body.x, r.body.z, 22, r);
        if (near.length === 0) return;
        ctx.race.combat._dealDamage(r, near[0].racer, 14, ['Electric'], 'electrified');
      },
    },
  },
  {
    id: 'overclocked_tires', name: 'Overclocked Tires', slot: 'tires', rarity: 'rare',
    tags: ['Drift'],
    stats: { drift: 0.35, turning: 0.20, grip: -0.28 },
    text: 'Turns beautifully. Holds nothing. Bring a plan.',
  },
  {
    id: 'studded_tires', name: 'Studded Tires', slot: 'tires', rarity: 'common',
    tags: ['Grip'],
    stats: { grip: 0.30, topSpeed: -0.08 },
    text: 'Grip on anything, at a cost in speed everywhere.',
  },
  {
    id: 'drift_compound', name: 'Drift Compound', slot: 'tires', rarity: 'rare',
    tags: ['Drift', 'Energy'],
    stats: { drift: 0.30 },
    mods: { driftEnergy: 1.45 },
    text: 'Drifting pays 45% more Energy.',
  },
  {
    id: 'gyro_hubs', name: 'Gyroscopic Hubs', slot: 'tires', rarity: 'epic',
    tags: ['Grip', 'Drift'],
    stats: { turning: 0.28, grip: 0.12 },
    text: 'Landing from a jump instantly restores full grip and refunds Energy.',
    hooks: {
      onLanded: (ctx) => {
        ctx.racer.body.gripPenalty = 1;
        ctx.racer.body.gripPenaltyTimer = 0;
        ctx.racer.addEnergy(6);
      },
    },
  },
  {
    id: 'magnetic_treads', name: 'Magnetic Treads', slot: 'tires', rarity: 'epic',
    tags: ['Grip'],
    stats: { grip: 0.25, weight: { flat: 20 } },
    text: 'Ice and oil no longer reduce your grip.',
    hooks: {
      onTick: (ctx) => {
        const body = ctx.racer.body;
        const s = body.surface;
        const slick = s && (s.id === 'ice' || s.id === 'oil');
        // Exactly cancel the surface's grip term while on it, and hand the
        // penalty back the moment we leave — holding a 5x multiplier after
        // driving off the ice would be a far bigger buff than the part says.
        if (slick) {
          body.gripPenalty = 1 / Math.max(0.12, s.grip);
          body.gripPenaltyTimer = 0.1;
        } else if (body.gripPenalty > 1) {
          body.gripPenalty = 1;
        }
      },
    },
  },
  {
    id: 'bald_tires', name: 'Bald Tires', slot: 'tires', rarity: 'cursed',
    tags: ['Drift'],
    stats: { grip: -0.45, drift: 0.55, topSpeed: 0.15 },
    text: 'CURSED — almost no grip at all. Drift builds only.',
  },

  // ====================================================== CHASSIS ==========
  {
    id: 'reinforced_frame', name: 'Reinforced Frame', slot: 'chassis', rarity: 'common',
    tags: ['Tank'],
    stats: { durability: 0.22, weight: { flat: 22 }, acceleration: -0.08 },
    text: 'More car between you and the problem.',
  },
  {
    id: 'heavy_armor', name: 'Heavy Armor', slot: 'chassis', rarity: 'common',
    tags: ['Tank'],
    stats: { armor: 0.35, weight: { flat: 34 }, topSpeed: -0.10 },
    text: 'The decision the design brief describes: take it, and you are not fast any more.',
  },
  {
    id: 'featherframe', name: 'Featherframe', slot: 'chassis', rarity: 'rare',
    tags: ['Speed'],
    stats: { weight: { flat: -34 }, acceleration: 0.20, turning: 0.14, armor: -0.20 },
    text: 'Almost nothing to it. Explosions will throw you across the track.',
  },
  {
    id: 'ablative_plating', name: 'Ablative Plating', slot: 'chassis', rarity: 'rare',
    tags: ['Tank'],
    stats: { armor: 0.25, durability: 0.12 },
    text: 'The first hit of each race is free.',
    hooks: {
      onRaceStart: (ctx) => { ctx.racer._ablative = true; },
      modifyDamageTaken: (amount, ctx) => {
        if (!ctx.racer._ablative) return amount;
        ctx.racer._ablative = false;
        return 0;
      },
    },
  },
  {
    id: 'crumple_zones', name: 'Crumple Zones', slot: 'chassis', rarity: 'rare',
    tags: ['Tank', 'Energy'],
    stats: { durability: 0.18, weight: { flat: 14 } },
    text: 'Damage you take is partly converted into Energy.',
    hooks: {
      onDamageTaken: (ctx) => { ctx.racer.addEnergy(ctx.amount * 0.55); },
    },
  },
  {
    id: 'absolute_unit', name: 'Absolute Unit', slot: 'chassis', rarity: 'epic',
    tags: ['Tank', 'Impact'],
    stats: { weight: { flat: 90 }, armor: 0.30, durability: 0.30, impact: 0.35, acceleration: -0.25 },
    text: 'Knockback does not apply to you. Obstacles are not obstacles.',
    hooks: {
      // Clear the penalty *and* its timer. Clearing only the timer stops the
      // restore branch in physics.step from ever running, which latches the
      // current penalty forever and leaves the car unable to corner at all.
      onTick: (ctx) => {
        ctx.racer.body.gripPenalty = 1;
        ctx.racer.body.gripPenaltyTimer = 0;
      },
    },
  },
  {
    id: 'glass_chassis', name: 'Glass Chassis', slot: 'chassis', rarity: 'cursed',
    tags: ['Glass'],
    stats: { weaponPower: 1.00, durability: -0.70, weight: { flat: -20 } },
    text: 'CURSED — double weapon power, and a car you can lose to one mistake.',
  },
  {
    id: 'scavenger_shell', name: 'Scavenger Shell', slot: 'chassis', rarity: 'epic',
    tags: ['Tank'],
    stats: { armor: 0.15, durability: 0.15 },
    text: 'Every wreck you cause repairs 12 Durability.',
    mods: { repairOnKill: 12 },
  },

  // ======================================================= BUMPER ==========
  {
    id: 'reinforced_bumper', name: 'Reinforced Bumper', slot: 'bumper', rarity: 'common',
    tags: ['Impact'],
    stats: { impact: 0.40, weight: { flat: 16 } },
    text: 'Collisions above 100 km/h set off a small explosion.',
    hooks: {
      onImpact: (ctx) => {
        if (ctx.kind === 'barrier' || ctx.speed < 8) return;
        const b = ctx.racer.body;
        if (b.speed * 3.6 < 100) return;
        ctx.race.combat.explode(ctx.racer, b.x, b.z, 6, 14, ['Explosive', 'Impact']);
      },
    },
  },
  {
    id: 'ram_prow', name: 'Ram Prow', slot: 'bumper', rarity: 'common',
    tags: ['Impact'],
    stats: { impact: 0.55, weight: { flat: 24 }, turning: -0.10 },
    text: 'A wedge welded to the front. Aim it at people.',
  },
  {
    id: 'berserker_bumper', name: 'Berserker Bumper', slot: 'bumper', rarity: 'epic',
    tags: ['Impact', 'Berserk'],
    stats: { impact: 0.20 },
    text: 'Impact rises as your Durability falls — up to +120% at death\'s door.',
    hooks: {
      modifyDamageDealt: (amount, ctx) => {
        if (ctx.kind !== 'ram') return amount;
        const missing = 1 - ctx.racer.durabilityFrac;
        return amount * (1 + missing * 1.2);
      },
    },
  },
  {
    id: 'shock_bumper', name: 'Shock Bumper', slot: 'bumper', rarity: 'rare',
    tags: ['Impact', 'Electric'],
    stats: { impact: 0.25 },
    text: 'Ramming electrifies what you hit.',
    hooks: {
      onImpact: (ctx) => {
        if (ctx.target) ctx.race.combat.applyStatus(ctx.target, 'electrified', ctx.racer);
      },
    },
  },
  {
    id: 'kinetic_converter', name: 'Kinetic Converter', slot: 'bumper', rarity: 'epic',
    tags: ['Impact', 'Energy'],
    stats: { impact: 0.30 },
    text: 'Ramming converts the hit into Energy and a short boost.',
    hooks: {
      onImpact: (ctx) => {
        if (ctx.kind === 'barrier') return;
        ctx.racer.addEnergy(ctx.speed * 1.3);
        ctx.racer.body.applyBoost(0.16, 1.1);
      },
    },
  },
  {
    id: 'spring_loaded', name: 'Spring-Loaded Ram', slot: 'bumper', rarity: 'rare',
    tags: ['Impact', 'Speed'],
    stats: { impact: 0.20, weight: { flat: -10 } },
    text: 'Hitting a barrier launches you forward instead of stopping you.',
    hooks: {
      onImpact: (ctx) => {
        if (ctx.kind !== 'barrier') return;
        ctx.racer.body.applyBoost(0.30, 1.4);
      },
    },
  },

  // ====================================================== BATTERY ==========
  {
    id: 'spare_cells', name: 'Spare Cells', slot: 'battery', rarity: 'common',
    tags: ['Energy'],
    stats: { energy: 0.25 },
    text: 'More Energy. That is all it does, and sometimes that is enough.',
  },
  {
    id: 'overcharged_battery', name: 'Overcharged Battery', slot: 'battery', rarity: 'rare',
    tags: ['Energy'],
    stats: { energy: 0.20 },
    mods: { energyCost: 0.72, heatGen: 3 },
    text: 'Skills cost 28% less Energy.',
  },
  {
    id: 'capacitor_bank', name: 'Capacitor Bank', slot: 'battery', rarity: 'rare',
    tags: ['Energy', 'Electric'],
    stats: { energy: 0.35 },
    text: 'At full Energy, your next skill costs nothing.',
    hooks: {
      onSkillUse: (ctx) => {
        // Refund if we were topped out when it fired.
        if (ctx.racer._wasFull) ctx.racer.addEnergy((ctx.skill.cost ?? 0));
      },
      onTick: (ctx) => { ctx.racer._wasFull = ctx.racer.energyFrac > 0.985; },
    },
  },
  {
    id: 'coolant_loop', name: 'Coolant Loop', slot: 'battery', rarity: 'common',
    tags: ['Heat'],
    stats: { heat: 0.35 },
    text: 'Runs cool. Boring, and often exactly what a build needs.',
  },
  {
    id: 'thermal_tap', name: 'Thermal Tap', slot: 'battery', rarity: 'epic',
    tags: ['Heat', 'Energy'],
    stats: { energy: 0.15, heat: -0.15 },
    text: 'Converts Heat into Energy continuously.',
    hooks: {
      onTick: (ctx) => {
        const r = ctx.racer;
        if (r.heat < 25) return;
        const converted = Math.min(r.heat, 14 * ctx.dt);
        r.heat -= converted;
        r.addEnergy(converted * 1.5);
      },
    },
  },
  {
    id: 'unstable_battery', name: 'Unstable Battery', slot: 'battery', rarity: 'cursed',
    tags: ['Energy'],
    stats: { energy: 0.30 },
    mods: { energyCost: 0.18 },
    text: 'CURSED — skills cost almost nothing, but each one damages you.',
    hooks: {
      onSkillUse: (ctx) => { ctx.racer.damage(9, { type: 'unstable' }, ctx.race); },
    },
  },
  {
    id: 'flux_regulator', name: 'Flux Regulator', slot: 'battery', rarity: 'rare',
    tags: ['Energy'],
    stats: { energy: 0.12 },
    mods: { energyRegenFlat: 3.2, skillCooldown: 0.82 },
    text: 'Faster regeneration, shorter cooldowns.',
  },
  {
    // The only source of `skillCharges`, and the only part that answers the
    // question charges create: not "how often can I use this" but "how many
    // times have I got left". Epic, because one more use of every skill in a
    // race is worth more than any single cooldown or cost reduction.
    id: 'deep_magazine', name: 'Deep Magazine', slot: 'battery', rarity: 'epic',
    tags: ['Energy', 'Weapon'],
    stats: { energy: 0.10 },
    mods: { skillCharges: 1, skillCooldown: 1.12 },
    text: 'One more use of every skill each race. Slower between them.',
  },

  // ======================================================= WEAPON ==========
  {
    id: 'targeting_computer', name: 'Targeting Computer', slot: 'weapon', rarity: 'common',
    tags: ['Weapon'],
    stats: { weaponControl: 0.35 },
    text: 'Tighter spread, faster projectiles, real homing.',
  },
  {
    id: 'heavy_ordnance', name: 'Heavy Ordnance', slot: 'weapon', rarity: 'common',
    tags: ['Weapon', 'Explosive'],
    stats: { weaponPower: 0.30, weaponControl: -0.18 },
    mods: { blastRadius: 1.2 },
    text: 'Hits far harder. Good luck aiming it.',
  },
  {
    id: 'chain_lightning', name: 'Chain Lightning Rig', slot: 'weapon', rarity: 'epic',
    tags: ['Weapon', 'Electric'],
    stats: { weaponPower: 0.20 },
    mods: { electricDamage: 1.3 },
    text: 'Electric hits jump to a second target for half damage.',
    hooks: {
      modifyDamageDealt: (amount, ctx) => {
        if (!ctx.tags?.includes('Electric') || !ctx.target) return amount;
        const r = ctx.racer;
        // The arc must not arc: without the guard the jump deals Electric
        // damage, which re-enters this hook, and the chain never terminates.
        if (r._chaining) return amount;
        r._chaining = true;
        try {
          const near = ctx.race.combat.racersNear(
            ctx.target.body.x, ctx.target.body.z, 18, ctx.target,
          );
          const second = near.find((n) => n.racer !== r);
          if (second) {
            ctx.race.combat._dealDamage(r, second.racer, amount * 0.5, ['Electric'], 'electrified');
          }
        } finally {
          r._chaining = false;
        }
        return amount;
      },
    },
  },
  {
    id: 'shrapnel_loader', name: 'Shrapnel Loader', slot: 'weapon', rarity: 'rare',
    tags: ['Weapon', 'Explosive'],
    stats: { weaponPower: 0.18 },
    mods: { explosiveDamage: 1.28, blastRadius: 1.15 },
    text: 'Everything explosive gets bigger and meaner.',
  },
  {
    id: 'trap_layer', name: 'Automated Trap Layer', slot: 'weapon', rarity: 'rare',
    tags: ['Weapon', 'Trap'],
    stats: { weaponPower: 0.12 },
    mods: { trapDamage: 1.35 },
    text: 'Drops a mine automatically every time you complete a lap.',
    hooks: {
      onLap: (ctx) => {
        ctx.race.combat.spawnTrap(ctx.racer, {
          damage: 24, radius: 5, life: 60, tags: ['Trap', 'Explosive'], visual: 'mine',
        });
      },
    },
  },
  {
    id: 'glass_cannon_array', name: 'Glass Cannon Array', slot: 'weapon', rarity: 'epic',
    tags: ['Weapon', 'Glass'],
    stats: { weaponPower: 0.55, weaponControl: 0.25, armor: -0.35 },
    text: 'Kill it before it reaches you, because it only has to reach you once.',
  },

  // ======================================================= GADGET ==========
  {
    id: 'nitro_injector', name: 'Nitro Injector', slot: 'gadget', rarity: 'common',
    tags: ['Speed'],
    stats: { acceleration: 0.12 },
    mods: { boostOnKill: 1.6 },
    text: 'Every wreck you cause hands you a boost.',
  },
  {
    id: 'scavenger_drone', name: 'Scavenger Drone', slot: 'gadget', rarity: 'rare',
    tags: ['Energy'],
    mods: { energyOnKill: 22, pickupRadius: 8 },
    stats: { luck: 0.15 },
    text: 'Wrecks feed you Energy.',
  },
  {
    id: 'blood_road', name: 'Blood Road Kit', slot: 'gadget', rarity: 'epic',
    tags: ['Berserk'],
    stats: { impact: 0.15 },
    mods: { repairOnKill: 20, boostOnKill: 1.2 },
    text: 'Destroying a rival repairs you and boosts you. Keep moving.',
  },
  {
    id: 'lucky_dice', name: 'Lucky Dice', slot: 'gadget', rarity: 'common',
    tags: ['Luck'],
    stats: { luck: 0.45 },
    mods: { rewardChoices: 1 },
    text: 'One more choice after every race.',
  },
  {
    id: 'reroll_module', name: 'Reroll Module', slot: 'gadget', rarity: 'rare',
    tags: ['Luck'],
    stats: { luck: 0.20 },
    mods: { rerolls: 2, shopPrices: 0.9 },
    text: 'Two extra rerolls, and cheaper shops.',
  },
  {
    id: 'expansion_rack', name: 'Expansion Rack', slot: 'gadget', rarity: 'epic',
    tags: ['Utility'],
    stats: { weight: { flat: 18 }, acceleration: -0.08 },
    mods: { partSlots: 2 },
    text: 'Two more part slots. Everything you bolt on makes you heavier.',
  },
  {
    id: 'skill_harness', name: 'Skill Harness', slot: 'gadget', rarity: 'epic',
    tags: ['Utility', 'Energy'],
    stats: { energy: 0.10 },
    mods: { skillSlots: 1 },
    text: 'One more skill slot.',
  },

  // ====================================================== SPECIAL ==========
  // These are the ones that change what a run *is*.
  {
    id: 'storm_conductor', name: 'Storm Conductor', slot: 'special', rarity: 'legendary',
    tags: ['Electric', 'Energy'],
    stats: { energy: 0.20, drift: 0.15 },
    text: 'Every 60 Energy you earn from drifting fires a lightning strike at the nearest car.',
    hooks: {
      onDrift: (ctx) => {
        const r = ctx.racer;
        r._storm = (r._storm || 0) + ctx.gained;
        if (r._storm < 60) return;
        r._storm -= 60;
        const near = ctx.race.combat.racersNear(r.body.x, r.body.z, 45, r);
        if (!near.length) return;
        const t = near[0].racer;
        ctx.race.combat.explode(r, t.body.x, t.body.z, 8, 34, ['Electric'], { force: 20 });
        ctx.race.combat.applyStatus(t, 'electrified', r);
      },
    },
  },
  {
    id: 'perpetual_motion', name: 'Perpetual Motion', slot: 'special', rarity: 'legendary',
    tags: ['Speed', 'Impact'],
    stats: { topSpeed: 0.15 },
    text: 'Speed feeds impact, impact feeds speed: every wreck raises your top speed for the rest of the race.',
    hooks: {
      onRaceStart: (ctx) => { ctx.racer._pm = 0; },
      onKill: (ctx) => {
        const r = ctx.racer;
        r._pm = (r._pm || 0) + 1;
        r.build.stats.removeByLabel('Perpetual Motion (stacks)');
        r.build.stats.add('Perpetual Motion (stacks)', { topSpeed: 0.08 * r._pm });
        r.build.recompute();
        r.body.setPhysics(r.build.physics);
      },
    },
  },
  {
    id: 'meltdown_core', name: 'Meltdown Core', slot: 'special', rarity: 'legendary',
    tags: ['Heat', 'Explosive'],
    stats: { heat: 0.25 },
    mods: { heatGen: 10 },
    text: 'Reaching Critical heat detonates a blast around you instead of hurting you.',
    hooks: {
      onHeatState: (ctx) => {
        if (ctx.state !== 'critical' && ctx.state !== 'meltdown') return;
        const b = ctx.racer.body;
        ctx.race.combat.explode(ctx.racer, b.x, b.z, 16, 55, ['Explosive', 'Fire'], { force: 50 });
        ctx.racer.heat = 45;
        ctx.racer.meltdownTimer = 0;
      },
    },
  },
  {
    id: 'last_stand', name: 'Last Stand Protocol', slot: 'special', rarity: 'legendary',
    tags: ['Berserk', 'Tank'],
    stats: { armor: 0.15 },
    text: 'Once per race, a fatal hit leaves you on 1 Durability and clears your cooldowns.',
    hooks: {
      onRaceStart: (ctx) => { ctx.racer._lastStand = true; },
      modifyDamageTaken: (amount, ctx) => {
        const r = ctx.racer;
        if (!r._lastStand || amount < r.durability) return amount;
        r._lastStand = false;
        r.cooldowns.fill(0);
        r.energy = r.maxEnergy;
        return Math.max(0, r.durability - 1);
      },
    },
  },
  {
    id: 'momentum_engine', name: 'Momentum Engine', slot: 'special', rarity: 'epic',
    tags: ['Speed', 'Drift'],
    stats: { drift: 0.20 },
    text: 'Holding a clean drift builds a boost that releases when you straighten out.',
    hooks: {
      onDrift: (ctx) => {
        ctx.racer._charge = Math.min(1, (ctx.racer._charge || 0) + ctx.quality * ctx.dt * 0.5);
      },
      onTick: (ctx) => {
        const r = ctx.racer;
        if (r.body.drifting || !r._charge) return;
        if (r._charge > 0.25) r.body.applyBoost(0.20 * r._charge, 1.2);
        r._charge = 0;
      },
    },
  },
  {
    id: 'vampiric_plating', name: 'Vampiric Plating', slot: 'special', rarity: 'epic',
    tags: ['Berserk', 'Tank'],
    stats: { armor: 0.10, durability: -0.10 },
    text: 'You heal for 25% of all damage you deal.',
    hooks: {
      onImpact: (ctx) => { if (ctx.damage) ctx.racer.repair(ctx.damage * 0.25); },
    },
  },
  {
    id: 'hybrid_matrix', name: 'Hybrid Matrix', slot: 'special', rarity: 'epic',
    tags: ['Utility'],
    stats: { luck: 0.10 },
    text: 'Gain +4% to all attributes for every distinct tag your build carries.',
    hooks: {
      // The payoff for refusing to specialise — the design brief wants a
      // generalist route to exist, and this is it.
      onRaceStart: (ctx, build) => {
        const variety = build.tagVariety;
        build.stats.removeByLabel('Hybrid Matrix (variety)');
        const bonus = variety * 0.04;
        build.stats.add('Hybrid Matrix (variety)', {
          topSpeed: bonus, acceleration: bonus, grip: bonus, drift: bonus,
          turning: bonus, braking: bonus, armor: bonus, durability: bonus,
          energy: bonus, weaponPower: bonus,
        });
        build.recompute();
        ctx.racer.body.setPhysics(build.physics);
      },
    },
  },
  {
    id: 'deaths_door', name: "Death's Door", slot: 'special', rarity: 'cursed',
    tags: ['Berserk', 'Glass'],
    stats: { durability: -0.55 },
    text: 'CURSED — below 30% Durability you deal double damage and gain 30% speed.',
    hooks: {
      onTick: (ctx) => {
        const r = ctx.racer;
        if (r.durabilityFrac >= 0.3) return;
        r.body.boostPower = Math.max(r.body.boostPower, 0.30);
        r.body.boostTimer = Math.max(r.body.boostTimer, 0.2);
      },
      modifyDamageDealt: (amount, ctx) =>
        ctx.racer.durabilityFrac < 0.3 ? amount * 2 : amount,
    },
  },
  {
    id: 'gamblers_engine', name: "Gambler's Engine", slot: 'special', rarity: 'cursed',
    tags: ['Luck'],
    stats: { luck: 0.80 },
    mods: { rewardChoices: 2 },
    text: 'CURSED — far better rewards, but each race starts you at 60% Durability.',
    hooks: {
      onRaceStart: (ctx) => {
        ctx.racer.durability = Math.min(ctx.racer.durability, ctx.racer.maxDurability * 0.6);
      },
    },
  },
];

export const PART_BY_ID = Object.fromEntries(PARTS.map((p) => [p.id, p]));

/** Parts of a rarity, optionally filtered to a slot. */
export function partsOf(rarity, slot = null) {
  return PARTS.filter((p) => p.rarity === rarity && (!slot || p.slot === slot));
}

/**
 * Roll a part. Luck shifts the rarity distribution upward rather than adding a
 * flat bonus, so investing in Luck changes *what you see*, which is the point.
 */
export function rollPart(rng, { luck = 1, exclude = new Set(), allowCursed = true } = {}) {
  const pool = PARTS.filter((p) => !exclude.has(p.id) && (allowCursed || p.rarity !== 'cursed'));
  if (pool.length === 0) return null;
  return rng.weighted(pool, (p) => {
    const r = RARITY[p.rarity];
    if (!r) return 0;
    // Luck lifts the rare end of the curve and flattens commons.
    const lift = p.rarity === 'common' ? 1 / luck : Math.pow(luck, 1.35);
    return r.weight * lift;
  });
}
