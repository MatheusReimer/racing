// Global race modifiers.
//
// The design brief wants these to multiply variety without needing new maps,
// so each one changes how an existing circuit has to be driven rather than
// what it looks like. `apply` runs once when the race is built; `onTick` runs
// every step for the ones that need continuous pressure.
//
// Modifiers apply to the whole field, never to the player alone. A rule that
// only bound one car would be difficulty, not a modifier.

export const MODIFIERS = [
  {
    id: 'low_gravity', name: 'Low Gravity', icon: '🌙',
    text: 'Cars leave the ground easily and stay there.',
    apply: (sim) => { for (const r of sim.racers) r.body.gravityScale = 0.55; },
  },
  {
    id: 'overheat', name: 'Overheat', icon: '🔥',
    text: 'Everything runs far hotter.',
    apply: (sim) => {
      for (const r of sim.racers) {
        r.build.stats.add('Overheat (race)', null, { heatGen: 9 });
        r.build.recompute();
        r.body.setPhysics(r.build.physics);
      }
    },
  },
  {
    id: 'blood_road', name: 'Blood Road', icon: '🩸',
    text: 'Wrecking a rival repairs you.',
    apply: (sim) => {
      for (const r of sim.racers) {
        r.build.stats.add('Blood Road (race)', null, { repairOnKill: 22 });
        r.build.recompute();
      }
    },
  },
  {
    id: 'double_impact', name: 'Double Impact', icon: '💥',
    text: 'Collisions deal double damage. To everyone.',
    apply: (sim) => {
      for (const r of sim.racers) {
        r.build.stats.add('Double Impact (race)', null, { collisionDamage: 2 });
        r.build.recompute();
        r.body.setPhysics(r.build.physics);
      }
    },
  },
  {
    id: 'chaos', name: 'Chaos', icon: '🌀',
    text: 'Mines appear on the track as the race goes on.',
    onTick: (sim, dt) => {
      sim.chaosTimer = (sim.chaosTimer ?? 3) - dt;
      if (sim.chaosTimer > 0) return;
      sim.chaosTimer = 2.2;
      const s = sim.rng.range(0, sim.track.length);
      const hw = sim.track.halfWidthAt(s);
      const p = sim.track.path.offsetPoint(s, sim.rng.spread(hw * 0.8), { x: 0, y: 0, z: 0 });
      const t = sim.combat.spawnTrap(sim.racers[0], {
        damage: 20, radius: 5, life: 40, tags: ['Trap', 'Explosive'], visual: 'mine',
      });
      // Ownerless: it belongs to the track, so it threatens the whole field
      // including whoever nominally spawned it.
      t.owner = null;
      t.x = p.x; t.z = p.z; t.y = p.y;
    },
  },
  {
    id: 'blackout', name: 'Blackout', icon: '🌑',
    text: 'Visibility is severely reduced.',
    apply: (sim) => { sim.fogBoost = 3.2; },
  },
  {
    id: 'downpour', name: 'Downpour', icon: '🌧️',
    text: 'Every surface offers less grip.',
    apply: (sim) => { for (const r of sim.racers) r.body.gripPenalty = 0.7; },
    onTick: (sim) => {
      // Re-assert every step: landings, blasts and other parts all write to
      // the same field, and a one-shot apply would be undone by the first jump.
      for (const r of sim.racers) {
        if (r.body.gripPenalty > 0.7) r.body.gripPenalty = 0.7;
      }
    },
  },
  {
    id: 'sudden_death', name: 'Sudden Death', icon: '💀',
    text: 'Nothing repairs. Damage is permanent for the whole race.',
    apply: (sim) => { sim.noRepair = true; },
  },
];

export const MODIFIER_BY_ID = Object.fromEntries(MODIFIERS.map((m) => [m.id, m]));

/**
 * Which modifiers a node runs with. Ordinary races usually run clean — a
 * modifier only means something if most races do not have one.
 */
export function rollModifiers(rng, nodeType, regionIndex = 0) {
  const base = { race: 0.18, elite: 0.55, challenge: 0.40, boss: 0.30 }[nodeType] ?? 0;
  if (base === 0) return [];
  const chance = Math.min(0.75, base + regionIndex * 0.08);
  if (rng.next() > chance) return [];
  const count = rng.next() < 0.15 + regionIndex * 0.05 ? 2 : 1;
  return rng.sample(MODIFIERS, count);
}
