// What a crate can contain.
//
// Cosmetics only, and that is the whole point of them. Parts and skills are the
// *run's* economy — found, fitted, and gone when the run ends — and anything
// that survives a run and affects how a car drives turns a roguelike into a
// grind: the twentieth run starts stronger than the first, and the first stops
// being a fair fight. These change nothing but what the car looks like, so a
// player who has opened fifty crates and one who has opened none arrive at the
// grid with the same machine.
//
// Which also means they can be handed out freely. There is no balance to
// protect, so the only question a crate has to answer is whether the thing
// inside is worth looking at.

/** Rarity, and how often a crate rolls it. Weights, not percentages. */
export const CRATE_RARITY = {
  common: { id: 'common', name: 'Common', weight: 100, color: '#9aa5b1' },
  rare: { id: 'rare', name: 'Rare', weight: 42, color: '#4fa3e3' },
  epic: { id: 'epic', name: 'Epic', weight: 15, color: '#b06be0' },
  legendary: { id: 'legendary', name: 'Legendary', weight: 4, color: '#ffa726' },
};

/**
 * Paint.
 *
 * A base and an accent, because the cars already carry both — the accent drives
 * the emissive trim, so a paint that changes only the body leaves the car's
 * glow the colour of the vehicle it started as.
 */
export const PAINTS = [
  { id: 'factory', name: 'Factory', rarity: 'common', base: null, accent: null,
    note: 'However the car left the showroom.' },

  { id: 'primer', name: 'Primer Grey', rarity: 'common', base: '#6f6a63', accent: '#c9c3b6' },
  { id: 'oxide', name: 'Red Oxide', rarity: 'common', base: '#8a4232', accent: '#e0b48a' },
  { id: 'works', name: 'Works White', rarity: 'common', base: '#dfe3e6', accent: '#2f3a48' },
  { id: 'slate', name: 'Slate', rarity: 'common', base: '#3c4652', accent: '#8fa2b8' },

  { id: 'midnight', name: 'Midnight', rarity: 'rare', base: '#141c33', accent: '#4f7fd0' },
  { id: 'sulphur', name: 'Sulphur', rarity: 'rare', base: '#d8c22a', accent: '#3a3320' },
  { id: 'seafoam', name: 'Seafoam', rarity: 'rare', base: '#4fbfa0', accent: '#0f3d34' },
  { id: 'rosso', name: 'Rosso', rarity: 'rare', base: '#c8201c', accent: '#ffd9a0' },

  { id: 'oilslick', name: 'Oil Slick', rarity: 'epic', base: '#2a1f3a', accent: '#9dff5c' },
  { id: 'ember', name: 'Ember', rarity: 'epic', base: '#5a1408', accent: '#ff6a2b' },
  { id: 'arctic', name: 'Arctic', rarity: 'epic', base: '#cfe6f2', accent: '#4fd1ff' },

  { id: 'chrome', name: 'Chrome', rarity: 'legendary', base: '#c6ccd4', accent: '#ffffff' },
  { id: 'voidblack', name: 'Void', rarity: 'legendary', base: '#0b0d12', accent: '#b06be0' },
];

/**
 * Wheels.
 *
 * A tint on the rim rather than new geometry. The hub's colours live in the
 * mesh's vertex colours and its material multiplies them, so a whole finish is
 * one colour — and a wheel is small on screen, where a change of metal reads
 * and a change of spoke count does not.
 */
export const RIMS = [
  { id: 'stock', name: 'Stock', rarity: 'common', tint: null,
    note: 'Whatever came on the car.' },

  { id: 'graphite', name: 'Graphite', rarity: 'common', tint: '#6a6f76' },
  { id: 'bronze', name: 'Bronze', rarity: 'common', tint: '#b98a4a' },
  { id: 'white', name: 'Rally White', rarity: 'rare', tint: '#e6e8ea' },
  { id: 'gold', name: 'Gold', rarity: 'rare', tint: '#e8c14a' },
  { id: 'gunmetal', name: 'Gunmetal', rarity: 'rare', tint: '#3f4650' },
  { id: 'copper', name: 'Copper', rarity: 'epic', tint: '#d97a45' },
  { id: 'polished', name: 'Polished', rarity: 'epic', tint: '#f2f5f8' },
  { id: 'magnesium', name: 'Magnesium', rarity: 'legendary', tint: '#d8e0c8' },
];

/** Everything a crate draws from, as one list, so rolling is one function. */
export const COSMETICS = [
  ...PAINTS.map((p) => ({ ...p, slot: 'paint' })),
  ...RIMS.map((r) => ({ ...r, slot: 'rim' })),
];

export const COSMETIC_BY_ID = Object.fromEntries(
  COSMETICS.map((c) => [`${c.slot}:${c.id}`, c]),
);

/** What every profile starts with, so a car is never unpaintable. */
export const DEFAULT_OWNED = ['paint:factory', 'rim:stock'];

/**
 * Roll a crate.
 *
 * Weighted by rarity, and never a duplicate while anything is left unowned —
 * a crate that hands back something already owned is a crate that did nothing,
 * and there is no economy here for a duplicate to feed.
 *
 * @param rng    a seeded RNG, so a run's reward is part of that run's seed
 * @param owned  ids the player already has
 */
export function rollCrate(rng, owned = []) {
  const has = new Set(owned);
  const left = COSMETICS.filter((c) => !has.has(`${c.slot}:${c.id}`));
  if (!left.length) return null;

  let total = 0;
  for (const c of left) total += CRATE_RARITY[c.rarity]?.weight ?? 1;
  let roll = rng.next() * total;
  for (const c of left) {
    roll -= CRATE_RARITY[c.rarity]?.weight ?? 1;
    if (roll <= 0) return { ...c, key: `${c.slot}:${c.id}` };
  }
  const last = left[left.length - 1];
  return { ...last, key: `${last.slot}:${last.id}` };
}
