// Boss races.
//
// The brief is explicit that a boss must not be "a car with more HP" — each
// one has to change the rules of the race it appears in. So every boss below
// carries a mechanic expressed through the same modifier, archetype and build
// systems everything else uses, plus a champion: a single rival built well
// past what the field would normally field.
//
// `mirrorsPlayer` is the exception that proves the approach works — The Mirror
// needs no bespoke code at all, because a champion is just a Build and the
// player's Build is already one.

export const BOSSES = [
  {
    id: 'juggernaut',
    name: 'The Juggernaut',
    title: 'Wasteland Champion',
    text: 'A truck the size of a building. It does not race you. It occupies the road.',
    objective: 'Survive it, and finish the race.',
    laps: 3,
    rivals: 4,
    lengthScale: 1.05,
    archetypes: ['tank', 'tank', 'racer', 'bomber'],
    modifiers: ['double_impact'],
    champion: {
      name: 'Juggernaut',
      vehicle: 'gt',
      archetype: 'tank',
      stats: { weight: 1.6, impact: 1.2, armor: 0.9, durability: 1.4, topSpeed: -0.15 },
    },
  },
  {
    id: 'warden',
    name: 'The Warden',
    title: 'Industrial Overseer',
    text: 'It never overtakes. It just makes sure the track is never empty.',
    objective: 'Finish while the circuit fills with ordnance.',
    laps: 3,
    rivals: 4,
    archetypes: ['disruptor', 'disruptor', 'bomber', 'racer'],
    modifiers: ['chaos'],
    champion: {
      name: 'The Warden',
      vehicle: 'rally',
      archetype: 'disruptor',
      stats: { weaponPower: 1.0, energy: 0.8, armor: 0.5, durability: 0.6 },
      skills: ['mine', 'oil_slick', 'emp'],
    },
  },
  {
    id: 'inferno',
    name: 'The Inferno',
    title: 'What Burns Behind You',
    text: 'The road behind it is on fire, and it is not slowing down.',
    objective: 'Never stop moving.',
    laps: 3,
    rivals: 4,
    archetypes: ['hunter', 'racer', 'bomber', 'hunter'],
    modifiers: ['overheat', 'blood_road'],
    champion: {
      name: 'The Inferno',
      vehicle: 'rotary',
      archetype: 'hunter',
      stats: { topSpeed: 0.5, acceleration: 0.4, impact: 0.6, durability: 0.5 },
      skills: ['molotov', 'nitro', 'rocket'],
    },
  },
  {
    id: 'mirror',
    name: 'The Mirror',
    title: 'You, But Wrong',
    text: 'It has your build. It made worse choices with it.',
    objective: 'Beat a distorted copy of your own machine.',
    laps: 3,
    rivals: 4,
    archetypes: ['racer', 'hunter', 'racer', 'tank'],
    modifiers: [],
    mirrorsPlayer: true,
    champion: { name: 'The Mirror', vehicle: null, archetype: 'hunter' },
  },
  {
    id: 'warden_prime',
    name: 'Warden Prime',
    title: 'The Last Gate',
    text: 'Everything the tournament has thrown at you, driving at once.',
    objective: 'Finish first. Nothing else counts.',
    laps: 4,
    rivals: 5,
    archetypes: ['hunter', 'tank', 'bomber', 'disruptor', 'racer'],
    modifiers: ['double_impact', 'chaos'],
    champion: {
      name: 'Warden Prime',
      vehicle: 'rotary',
      archetype: 'hunter',
      stats: { topSpeed: 0.4, armor: 0.8, durability: 0.8, weaponPower: 0.8, impact: 0.5 },
      skills: ['homing_missile', 'shockwave', 'nitro', 'shield'],
    },
  },
];

export const BOSS_BY_ID = Object.fromEntries(BOSSES.map((b) => [b.id, b]));

export function bossForRegion(index) {
  return BOSSES[Math.min(index, BOSSES.length - 1)];
}
