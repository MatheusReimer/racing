// Starting vehicles.
//
// The roster is the Underground grid: six street tuners, each a recognisable
// shape before you read a single number. `bodyType` picks the silhouette the
// chassis generator builds — a hatch is not a coupe with different stats, it is
// a different car from thirty metres away, which is the whole point of having a
// grid rather than six repaints.
//
// Each one is still a different *question*, not a different set of numbers: the
// design brief asks for mechanical identity, so every vehicle carries a rule
// that changes how a run plays and stat offsets committed hard enough to matter
// on the first race.
//
// `stats` are deltas from the 100 baseline, applied flat. A vehicle is allowed
// to be genuinely bad at something — that is what makes the parts you find
// afterwards a decision rather than an upgrade.

export const VEHICLES = [
  {
    id: 'hatch',
    bodyType: 'hatch',
    startingSkill: 'nitro',
    name: 'Kanzen 1.6',
    tagline: 'Front-drive, high-revving, borrowed.',
    color: '#d8dde3',
    accent: '#e8402f',
    stats: {
      acceleration: 28, turning: 30, braking: 15,
      topSpeed: -22, weight: -25, armor: -18, durability: -10,
    },
    skillSlots: 3,
    partSlots: 6,
    identity: 'Changes direction like nothing else on the grid. Runs out of road at the top end.',
    rule: {
      id: 'hatch_light',
      text: 'Nitrous lasts 35% longer.',
      mods: { nosDuration: 1.35 },
    },
  },

  {
    id: 'coupe',
    bodyType: 'coupe',
    startingSkill: 'electric_grenade',
    name: 'Sableline S-Type',
    tagline: 'Rear-drive. Sideways is the fast way.',
    color: '#2f7fd0',
    accent: '#7ef0ff',
    stats: {
      drift: 62, turning: 22, grip: -10, energy: 25,
      acceleration: 12, durability: -6,
    },
    skillSlots: 4,
    partSlots: 5,
    identity: 'Low grip is not a flaw here — it is the engine that powers your skills.',
    rule: {
      id: 'coupe_charge',
      text: 'Drifting generates 60% more Energy.',
      mods: { driftEnergy: 1.6 },
    },
  },

  {
    id: 'rotary',
    bodyType: 'rotary',
    startingSkill: 'rocket',
    name: 'Aoi 13B',
    tagline: 'Screams to nine thousand. Then screams at you.',
    color: '#e0473a',
    accent: '#ffd23f',
    stats: {
      topSpeed: 40, acceleration: 22, braking: 8, grip: 8,
      armor: -20, durability: -12, weight: -16, heat: 30,
    },
    skillSlots: 3,
    partSlots: 6,
    identity: 'Nothing out-drags it down a straight. Nothing runs hotter, either.',
    rule: {
      id: 'rotary_redline',
      text: 'Above 80% of top speed you gain Energy continuously, but run 25% hotter.',
      mods: { heatGen: 6, redlineEnergy: 1 },
    },
  },

  {
    id: 'gt',
    bodyType: 'gt',
    startingSkill: 'shockwave',
    name: 'Tsurugi GT-S',
    tagline: 'All four wheels, all the time.',
    color: '#20304a',
    accent: '#c0c8d4',
    stats: {
      weight: 55, impact: 55, armor: 35, durability: 40, grip: 22,
      acceleration: -12, turning: -12,
    },
    skillSlots: 3,
    partSlots: 6,
    identity: 'Heavy, planted, and immovable in traffic. Slow to change its mind.',
    rule: {
      id: 'gt_momentum',
      text: 'Collisions never reduce your speed by more than 25%.',
      mods: { collisionSpeedFloor: 0.75 },
    },
  },

  {
    id: 'roadster',
    bodyType: 'roadster',
    startingSkill: 'banana',
    name: 'Hinode Roadster',
    tagline: 'No roof, no weight, no mercy.',
    color: '#f0c419',
    accent: '#8e44ad',
    stats: {
      turning: 22, grip: 6, luck: 55, braking: 8,
      weight: -35, armor: -30, durability: -24, topSpeed: -16,
    },
    skillSlots: 3,
    partSlots: 6,
    identity: 'The most agile thing here, and the least willing to be touched.',
    rule: {
      id: 'roadster_odds',
      text: 'Rewards offer one extra choice, but shops cost 20% more.',
      mods: { rewardChoices: 1, shopPrices: 1.2 },
    },
  },

  {
    id: 'rally',
    bodyType: 'rally',
    startingSkill: 'mine',
    name: 'Vantera WRC',
    tagline: 'Built for roads that are not there.',
    color: '#1e5fa8',
    accent: '#e8b923',
    stats: {
      grip: 35, durability: 20, weaponPower: 25,
      topSpeed: -12, heat: -20,
    },
    skillSlots: 3,
    partSlots: 9,
    identity: 'Three extra part slots and grip everywhere. Never the fastest in a straight line.',
    rule: {
      id: 'rally_frame',
      text: 'Three extra part slots, and off-track surfaces cost you 40% less grip.',
      mods: { offTrackGrip: 1.4 },
    },
  },
];

export const VEHICLE_BY_ID = Object.fromEntries(VEHICLES.map((v) => [v.id, v]));

/** Vehicles available from the start; the rest unlock through meta progression. */
export const STARTER_VEHICLE_IDS = ['hatch', 'coupe', 'gt'];
