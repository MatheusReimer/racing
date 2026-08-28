// The 15 attributes, and the single place where an attribute becomes physics.
//
// Every attribute is expressed on a scale where 100 is "an average car". That
// choice matters: it makes the percentage modifiers the design doc is written
// in ("+25% Top Speed") mean the same thing everywhere, and it lets a part
// author reason about magnitude without knowing the physics constants below.
//
// Nothing outside this file should hard-code a conversion from an attribute to
// a physical quantity. If braking needs retuning, it is retuned here once.

export const GROUPS = {
  movement: { id: 'movement', name: 'Movement', accent: '#4fc3f7' },
  physical: { id: 'physical', name: 'Physical', accent: '#ffb74d' },
  survival: { id: 'survival', name: 'Survival', accent: '#81c784' },
  combat: { id: 'combat', name: 'Combat', accent: '#e57373' },
};

/**
 * `higherIsBetter` is not universally true — Weight genuinely cuts both ways,
 * and the UI must not paint a heavy chassis red just because the number rose.
 */
export const ATTRIBUTES = [
  // --- Movement ---
  {
    id: 'topSpeed', name: 'Top Speed', group: 'movement', base: 100,
    desc: 'How fast the car can ultimately go. Feeds boost ceilings and every effect that scales with velocity.',
    higherIsBetter: true,
  },
  {
    id: 'acceleration', name: 'Acceleration', group: 'movement', base: 100,
    desc: 'How quickly you reach top speed. Governs launches, corner exits, and recovery after a hit.',
    higherIsBetter: true,
  },
  {
    id: 'grip', name: 'Grip', group: 'movement', base: 100,
    desc: 'Tyre adhesion. High grip corners cleanly; low grip slides — which a drift build wants.',
    higherIsBetter: true,
  },
  {
    id: 'drift', name: 'Drift', group: 'movement', base: 100,
    desc: 'Control while sliding. Not negative grip: it is how much speed and steering you keep mid-slide, and how much Energy the slide pays out.',
    higherIsBetter: true,
  },
  {
    id: 'turning', name: 'Turning', group: 'movement', base: 100,
    desc: 'How fast the car changes heading. Independent of Grip — you can turn quickly and still slide.',
    higherIsBetter: true,
  },
  {
    id: 'braking', name: 'Braking', group: 'movement', base: 100,
    desc: 'Deceleration. Sacrificing it is a real cost: you must begin braking much earlier.',
    higherIsBetter: true,
  },

  // --- Physical ---
  {
    id: 'weight', name: 'Weight', group: 'physical', base: 100,
    desc: 'Mass. Heavier means more Impact and less knockback taken, but slower acceleration and lazier direction changes.',
    higherIsBetter: null, // genuinely bidirectional
  },
  {
    id: 'impact', name: 'Impact', group: 'physical', base: 100,
    desc: 'Collision force. Turns ramming into a legitimate weapon, and decides what obstacles you can drive through.',
    higherIsBetter: true,
  },

  // --- Survival ---
  {
    id: 'armor', name: 'Armor', group: 'survival', base: 100,
    desc: 'Damage reduction. Distinct from Durability: armour is how hard you are to hurt, not how much hurt you hold.',
    higherIsBetter: true,
  },
  {
    id: 'durability', name: 'Durability', group: 'survival', base: 100,
    desc: 'Structural health. At zero the car is destroyed and the run ends.',
    higherIsBetter: true,
  },
  {
    id: 'energy', name: 'Energy', group: 'survival', base: 100,
    desc: 'The resource skills spend. Capacity and regeneration both scale from it.',
    higherIsBetter: true,
  },
  {
    id: 'heat', name: 'Heat Capacity', group: 'survival', base: 100,
    desc: 'Thermal headroom before meltdown. Some of the strongest parts deliberately run you hot.',
    higherIsBetter: true,
  },

  // --- Combat ---
  {
    id: 'weaponPower', name: 'Weapon Power', group: 'combat', base: 100,
    desc: 'Offensive magnitude: damage, blast radius, elemental strength.',
    higherIsBetter: true,
  },
  {
    id: 'weaponControl', name: 'Weapon Control', group: 'combat', base: 100,
    desc: 'Accuracy, range, projectile speed and homing. A weapon can hit very hard and still be hard to land.',
    higherIsBetter: true,
  },
  {
    id: 'luck', name: 'Luck', group: 'combat', base: 100,
    desc: 'Reward quality, rare offers, event outcomes. A bet on the future rather than power now.',
    higherIsBetter: true,
  },
];

export const ATTRIBUTE_IDS = ATTRIBUTES.map((a) => a.id);
export const ATTRIBUTE_BY_ID = Object.fromEntries(ATTRIBUTES.map((a) => [a.id, a]));

/** Attributes may be driven low by cursed parts but never to zero or below. */
export const ATTR_MIN = 5;
export const ATTR_MAX = 600;

export function baseStats() {
  const out = {};
  for (const a of ATTRIBUTES) out[a.id] = a.base;
  return out;
}

// ---------------------------------------------------------------------------
// Attribute -> physics. All tuning constants live here.
// ---------------------------------------------------------------------------

/**
 * Speeds are metres per second internally; the HUD converts to km/h. At the
 * baseline 100 this is 46 m/s (166 km/h), which reads as fast at our camera
 * height and track scale without making corners unreadable.
 */
export const derive = {
  maxSpeed: (s) => 20 + s.topSpeed * 0.26,

  /**
   * Engine acceleration in m/s^2, before the top-speed falloff curve.
   * Weight divides it — a heavy car with the same engine is slower off the
   * line, which is the trade the design doc asks Weight to make.
   */
  engineAccel: (s) => (4 + s.acceleration * 0.10) * (100 / (60 + s.weight * 0.4)),

  /**
   * Lateral friction as an exponential decay rate (per second). Higher sheds
   * sideways velocity faster, which reads as adhesion. This form is
   * unconditionally stable, which is why 60 Hz simulation is enough.
   */
  gripRate: (s) => 2.8 + s.grip * 0.068,

  /**
   * Drift is control, not "negative grip". Breaking traction is a fixed cut
   * applied by the handbrake; these three are what the Drift attribute buys.
   *
   * `driftSpeedKeep` — fraction of forward speed a slide preserves. At 100 a
   * drift costs almost nothing; at 30 every slide is a mistake you pay for.
   */
  driftSpeedKeep: (s) => 0.62 + Math.min(0.36, s.drift * 0.0036),

  /** Extra yaw authority while sliding — the ability to steer *with* the slide. */
  driftSteerBonus: (s) => 0.25 + s.drift * 0.006,

  /**
   * How much the slide scrubs sideways momentum. This is the main thing the
   * Drift attribute buys: a poor drifter sheds enormous energy through the
   * tyres every time the tail steps out, a great one carries it through.
   *
   * Scaled down when the base `gripRate` went up for the arcade handling pass.
   * The scrub is a multiplier on grip, so raising grip by half and leaving this
   * alone silently deleted the handbrake slide — speed kept through a drift
   * fell from 72% to 41% and drift quality from 1.00 to 0.41, which starves
   * every Drift-tagged skill and the Energy economy behind them.
   */
  driftGripScrub: (s) => 1.05 - Math.min(0.76, s.drift * 0.0038),

  /**
   * The slide angle this car is built to hold, and how forgiving the window
   * around it is. Both widen with Drift, so a drift build is not punished for
   * running the bigger angle it is capable of — the payout rate below is what
   * separates the builds, not the geometry.
   */
  driftIdealSlip: (s) => 0.40 + s.drift * 0.0022,
  driftBandWidth: (s) => 0.30 + s.drift * 0.0016,

  /** Energy paid out per second of well-held slide, scaled by slide quality. */
  driftEnergyRate: (s) => s.drift * 0.085,

  /**
   * Lateral acceleration the tyres can hold, m/s^2. This is what actually
   * limits cornering: the sustainable yaw rate is `corneringAccel / speed`, so
   * grip decides how fast you can take a given radius.
   *
   * Baseline is 34 (~3.5g), which is not a road car and is not meant to be.
   * The reference is Underground: you point the car at a corner at speed and it
   * goes, and the drama comes from traffic, walls and nitrous rather than from
   * the tyres letting go.
   *
   * The number is set by the corner the city is built from. A 26 m fillet taken
   * at 100 km/h needs v^2/r = 30 m/s^2; at 2.0g the car could hold no tighter
   * than a 56 m arc at any speed, so every junction had to be braked to 90 and
   * the district read as a series of pauses. Grip is the lever for that, not
   * steering rate — the wheel was already fast enough.
   *
   * The *slope* is deliberately shallow. A steeper one (0.21/point) put the
   * same baseline in place but let a high-grip car corner 35% harder than a low
   * one, and on a circuit that is mostly corners that is not a trade-off, it is
   * a winner: the Roadster took 80% of races. Cornering is now something every
   * car on the grid has, and the Grip stat trims it.
   */
  corneringAccel: (s) => 22 + s.grip * 0.12,

  /**
   * Turning is agility, kept distinct from Grip. It sets the *ceiling* on yaw
   * rate at low speed (hairpin tightness)...
   */
  steerRate: (s) => (1.45 + s.turning * 0.012) * (100 / (70 + s.weight * 0.3)),

  /**
   * ...and how quickly the car converges on that rate — how fast it changes
   * direction, which is what the design doc actually asks Turning to mean.
   * Mass makes the nose lazy.
   */
  yawResponse: (s) => (7 + s.turning * 0.075) * (110 / (80 + s.weight * 0.3)),

  /**
   * Braking deceleration, m/s^2. Baseline lands around 15.5, which stops from
   * 100 km/h in roughly 25 m. Arcade-strong on purpose: an Underground corner
   * is entered late and hard, and a long brake zone turns a street circuit into
   * a series of pauses. Trading Braking away for Top Speed is still felt.
   */
  brakeDecel: (s) => 6 + s.braking * 0.095,

  /** Kilograms. Used for collision impulse exchange. */
  mass: (s) => 300 + s.weight * 9,

  /**
   * Collision damage multiplier. Impact and mass both matter, but sub-linearly
   * in mass so a heavy tank does not trivially one-shot everything.
   */
  impactForce: (s) => (s.impact / 100) * Math.pow(derive.mass(s) / 1200, 0.6),

  /**
   * Fraction of incoming damage removed. Diminishing returns keep stacked
   * armour from reaching immunity: 100 -> 33%, 300 -> 60%, 600 -> 75%.
   */
  damageReduction: (s) => s.armor / (s.armor + 200),

  /**
   * Structural HP. Sized against the damage a full race actually inflicts
   * (~50-60 at baseline) so that a run is a sequence of races rather than a
   * best-of-two: with the between-race servicing in Run, this supports roughly
   * eight races of attrition before the repair economy has to be engaged.
   */
  maxDurability: (s) => 60 + s.durability * 0.9,

  maxEnergy: (s) => 20 + s.energy * 0.4,

  /** Passive energy regeneration per second. */
  energyRegen: (s) => 1.5 + s.energy * 0.022,

  /**
   * Heat is a 0..100 percentage at runtime. A higher Heat Capacity attribute
   * makes each unit of generated heat count for less and cools faster.
   */
  heatGainScale: (s) => 100 / Math.max(20, s.heat),
  heatCoolRate: (s) => 3.0 + s.heat * 0.035,

  weaponDamageScale: (s) => s.weaponPower / 100,
  weaponSpeedScale: (s) => 0.7 + s.weaponControl * 0.003,
  weaponHoming: (s) => Math.min(0.9, Math.max(0, (s.weaponControl - 100) * 0.0035)),
  weaponSpread: (s) => Math.max(0.01, 0.20 - s.weaponControl * 0.0014),

  luckScale: (s) => s.luck / 100,
};

/** Heat states from the design doc, in ascending severity. */
export const HEAT_STATES = [
  { id: 'normal', name: 'Normal', min: 0, max: 50, color: '#7ec8e3' },
  { id: 'hot', name: 'Hot', min: 50, max: 75, color: '#ffd166' },
  { id: 'overdrive', name: 'Overdrive', min: 75, max: 90, color: '#ff9f45' },
  { id: 'critical', name: 'Critical', min: 90, max: 100, color: '#ff5c5c' },
  { id: 'meltdown', name: 'MELTDOWN', min: 100, max: Infinity, color: '#ff2d2d' },
];

export function heatState(heatPct) {
  for (let i = HEAT_STATES.length - 1; i >= 0; i--) {
    if (heatPct >= HEAT_STATES[i].min) return HEAT_STATES[i];
  }
  return HEAT_STATES[0];
}
