import { ATTRIBUTE_BY_ID } from './attributes.js';

// The five numbers on the machine screen.
//
// The specification is fifteen attributes and it stays fifteen: nothing here
// replaces it, and the screen still shows every one of them on request. But
// fifteen bars is a spreadsheet, and nobody chooses between six cars by
// reading ninety rows. These five are the shape of a machine at a glance —
// the question the roster is actually asking — and each is a real reduction of
// the attributes underneath it rather than a second set of numbers kept in
// step by hand.
//
// The scale is absolute, not fitted to the roster. 100 on an attribute is an
// average car, so five pips is an average car, and a part found in region two
// can push a bar past anything the showroom will ever display. A scale
// normalised across the six starters would relabel every one of them the
// moment a seventh was added, which makes the bars a description of the list
// instead of a description of the car.

/** Attribute points per pip. 100 sits at 5, so the roster reads 3–8. */
const PER_PIP = 12;
export const PIP_COUNT = 10;

/**
 * `attrs` is averaged, not summed: two attributes at 100 is still an average
 * car, and summing would make every two-attribute row read twice as full as a
 * one-attribute row for no reason the player could see.
 */
export const SUMMARY_STATS = [
  {
    id: 'speed', name: 'Speed', attrs: ['topSpeed'],
    note: 'What it will do down the longest straight on the map.',
  },
  {
    id: 'acceleration', name: 'Acceleration', attrs: ['acceleration'],
    note: 'Off the line, out of a corner, and after every hit.',
  },
  {
    id: 'control', name: 'Control', attrs: ['grip'],
    note: 'How hard it is to unstick. Low is not simply worse — a drift build wants it.',
  },
  {
    id: 'durability', name: 'Durability', attrs: ['durability', 'armor'],
    note: 'How much damage it holds, and how hard it is to damage.',
  },
  {
    id: 'handling', name: 'Handling', attrs: ['turning', 'braking'],
    note: 'How fast it changes its mind, and how late it can leave the brakes.',
  },
];

/** Raw attribute average behind one summary row. */
export function summaryValue(stats, def) {
  let total = 0;
  for (const id of def.attrs) total += stats[id] ?? ATTRIBUTE_BY_ID[id]?.base ?? 100;
  return total / def.attrs.length;
}

export function summaryPips(value) {
  const pips = Math.round(5 + (value - 100) / PER_PIP);
  return Math.max(1, Math.min(PIP_COUNT, pips));
}

/**
 * The five rows for a stat block.
 *
 * @param stats  an attribute map, as `StatBlock.all()` returns it
 * @returns [{ id, name, note, value, pips }]
 */
export function summarise(stats) {
  return SUMMARY_STATS.map((def) => {
    const value = summaryValue(stats, def);
    return { id: def.id, name: def.name, note: def.note, value, pips: summaryPips(value) };
  });
}
