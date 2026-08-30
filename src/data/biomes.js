// The five regions.
//
// A biome is not a palette swap. Each one changes what the track generator
// produces (`trackChaos` shapes the corners, `trackWidth` the pressure,
// `offTrack` what leaving it costs) and therefore which builds read as strong
// there. Industrial City is where Turning beats Top Speed; the Wasteland is
// wide and forgiving because it is where a run begins.
//
// What a district may *not* do is put grip hazards on the racing line. That
// existed and was removed: the patches were invisible, so losing the car on
// clean asphalt read as the physics glitching rather than as a corner of the
// track you had failed to respect. A district makes itself felt through the
// shape of the road, what is beside it, and what it costs to leave it.
//
// `palette` feeds the procedural materials and sky. Nothing here is loaded
// from disk — the colours are the art.

export const BIOMES = [
  {
    id: 'wasteland',
    name: 'The Wasteland',
    tagline: 'Cracked highway, scrap, and dust that never settles.',
    order: 0,

    // Track character
    traffic: 0.25,
    trackChaos: 0.30,     // moderate harmonic budget: sweeping, readable
    trackWidth: 24,       // wide — this is where a run learns to drive
    elevation: 9,
    offTrack: 'offroad',

    palette: {
      sky: ['#c98d5a', '#e8b878', '#f2d6a8'],
      fog: '#d9a86e',
      fogDensity: 0.0034,
      road: '#3c3936',
      roadLine: '#c8b98f',
      ground: '#9b7a4e',
      groundAlt: '#7d5f3e',
      prop: '#7a5f42',
      accent: '#e07a3f',
      sun: '#ffd9a0',
      sunAngle: 0.46,
      ambient: '#6b5540',
          // Bleached and dusty: the blacks lifted a touch so nothing is truly dark
      // under that haze, and the blue pulled out of the whites.
      grade: { lift: [0.012, 0.008, 0.000], gamma: [1.02, 1.00, 0.98], gain: [1.03, 1.00, 0.95] },
    },

    props: ['wreck', 'barrel', 'sign', 'rock', 'tire_stack'],
    propDensity: 1.0,
    ambientLoop: 'wind',
  },

  {
    id: 'industrial',
    name: 'Industrial City',
    tagline: 'Narrow streets, moving machinery, and no room to be wrong.',
    order: 1,

    traffic: 0.55,
    trackChaos: 0.42,     // busier: more direction changes per lap
    trackWidth: 18,       // tight — Turning and Braking outrank Top Speed
    elevation: 5,
    offTrack: 'gravel',

    palette: {
      sky: ['#2b3138', '#454f5c', '#6a7684'],
      fog: '#4a545f',
      fogDensity: 0.0060,
      road: '#3f4348',
      roadLine: '#d8d2c0',
      ground: '#585d64',
      groundAlt: '#6b717a',
      prop: '#5a6068',
      accent: '#f2c53d',
      sun: '#c9d4e0',
      sunAngle: 0.58,
      ambient: '#3c444e',
          // Cold and sooty. Green held back so the rust does not turn olive.
      grade: { lift: [0.000, 0.004, 0.014], gamma: [0.98, 1.00, 1.03], gain: [0.98, 0.99, 1.05] },
    },

    props: ['container', 'crane', 'barrier', 'pipe', 'sign'],
    propDensity: 1.3,
    ambientLoop: 'machinery',
  },

  {
    id: 'desert',
    name: 'The Long Desert',
    tagline: 'Open dunes, blind canyons, and nothing to hide behind.',
    order: 2,

    traffic: 0.15,
    trackChaos: 0.24,     // long and fast: the Speed build's home
    trackWidth: 26,
    elevation: 16,        // dunes and drops — real air off the crests
    offTrack: 'sand',

    palette: {
      sky: ['#e9b271', '#f5d9a3', '#fdf1d6'],
      fog: '#e8c48d',
      fogDensity: 0.0026,
      road: '#4a443c',
      roadLine: '#e8dcbb',
      ground: '#e0b673',
      groundAlt: '#c2924f',
      prop: '#a8814e',
      accent: '#ff9f43',
      sun: '#fff0c9',
      sunAngle: 0.62,
      ambient: '#a8865c',
          // Hard sun: crushed blacks, warm highlights, no lift at all.
      grade: { lift: [0.000, 0.000, 0.000], gamma: [1.02, 1.00, 0.96], gain: [1.05, 1.01, 0.92] },
    },

    props: ['rock', 'cactus', 'bones', 'sign', 'dune'],
    propDensity: 0.7,
    ambientLoop: 'wind',
  },

  {
    id: 'frozen',
    name: 'Frozen Highway',
    tagline: 'Ice, altitude, and corners that do not care what you intended.',
    order: 3,

    traffic: 0.35,
    trackChaos: 0.38,
    trackWidth: 21,
    elevation: 20,
    offTrack: 'ice',

    palette: {
      sky: ['#5b7a99', '#9fc0d8', '#dfeef7'],
      fog: '#b6d2e4',
      fogDensity: 0.0052,
      road: '#3f454d',
      roadLine: '#eaf4fb',
      ground: '#dbe8f1',
      groundAlt: '#b9cddc',
      prop: '#8ba3b5',
      accent: '#4fd1e0',
      sun: '#eaf6ff',
      sunAngle: 0.40,
      ambient: '#7e97ab',
          // Overcast: flat contrast, blacks lifted into blue, whites held down so
      // the snow does not clip to paper.
      grade: { lift: [0.010, 0.016, 0.028], gamma: [1.05, 1.06, 1.09], gain: [0.98, 0.99, 1.02] },
    },

    props: ['pine', 'rock', 'ice_block', 'sign', 'snow_bank'],
    propDensity: 0.9,
    ambientLoop: 'wind_cold',
  },

  {
    id: 'inferno',
    name: 'Inferno',
    tagline: 'Impossible architecture over a lake of fire.',
    order: 4,

    traffic: 0,
    trackChaos: 0.50,     // the busiest circuits in the game
    trackWidth: 19,
    elevation: 24,
    offTrack: 'lava',     // leaving the road costs Durability, continuously

    palette: {
      sky: ['#2a0a0a', '#7a1c10', '#d1441a'],
      fog: '#6e1c12',
      fogDensity: 0.0075,
      road: '#2b2524',
      roadLine: '#ffb35c',
      ground: '#6a2a22',
      groundAlt: '#8a3520',
      prop: '#40201c',
      accent: '#ff5722',
      sun: '#ff8a4c',
      sunAngle: 0.34,
      ambient: '#5a2018',
          // Firelight. Everything toward the ember, and the shadows kept black —
      // a lift here would turn the smoke grey and kill the contrast the
      // whole district is built on.
      grade: { lift: [0.006, 0.000, 0.000], gamma: [1.04, 1.00, 0.93], gain: [1.06, 0.99, 0.91] },
    },

    props: ['spire', 'brazier', 'bones', 'rock', 'chain'],
    propDensity: 1.1,
    ambientLoop: 'fire',
  },

  {
    id: 'house',
    name: 'The House',

    // Indoors, at ten times life.
    //
    // The car does not shrink. An RC car is about a tenth of a real one, and
    // shrinking the vehicle would invalidate every physics constant, every
    // handling probe and every balance run in the project — so the house is
    // built at 10x instead and the car that has always been 4.06 units long
    // reads as a 1:10 model on a kitchen floor. The speed cap does the same
    // trick: 166 at this scale is 16.6 km/h, which is what an RC car does.
    //
    // Laid out as a ring of rooms with a doorway between each pair. See
    // track/house.js.
    house: true,
    indoor: true,

    tagline: 'Kitchen to bathroom to the TV. The carpet is slower than it looks.',
    order: 5,

    // No civilian traffic indoors. What the road furniture would have been is
    // the furniture.
    traffic: 0,

    // A room is wide and a doorway is one car, so the pressure here is not the
    // width of the track on average — it is the eight places a lap where it
    // stops being wide. `trackWidth` is the room; the pinch comes from
    // `houseWidthAt`.
    // Nine units, and this is the number the whole layout turns on.
    //
    // A house has room-scale corners and there is no way round it: a doorway
    // has to be entered square, a corner of the ring turns ninety degrees, and
    // there is exactly one room between the two doors. Every attempt to open
    // those corners — the swing, the bulge direction, the control spacing, the
    // door straight — moved the minimum radius by less than a metre. It is the
    // shape of a house.
    //
    // So the road gives way instead. A corner has to have more radius than the
    // track has half-width or the inside edge folds through itself, and at
    // radius ~6 that means a half-width under 4.5. Nine units is 90 cm of real
    // floor for a car 18 cm wide — five car widths, which is a racing line
    // through a room rather than a road filling it. Which is also what an RC
    // track in a house actually is: a marked route, with the rest of the floor
    // drivable and slower.
    trackChaos: 0.30,
    trackWidth: 9,
    elevation: 0,
    offTrack: 'gravel',

    // Lit like a room, not like weather. A ceiling light is a broad soft key
    // from almost straight above with very little directionality, which is why
    // the hemisphere carries most of this and the sun almost none: a hard
    // directional light indoors reads as a window, and there is not one.
    palette: {
      sky: ['#2a2622', '#211e1b', '#191715'],
      fog: '#241f1b',
      fogDensity: 0.0042,
      road: '#8a7c68',
      roadLine: '#c9bda6',
      ground: '#6f6353',
      groundAlt: '#5c5245',
      prop: '#9a8f7e',
      accent: '#e0563a',
      sun: '#ffeccd',
      sunAngle: 0.82,
      ambient: '#3a332c',

      sunIntensity: 0.9,
      fillColor: '#ffe9c8',
      fillIntensity: 0.55,
      hemiColor: '#cbbba0',
      hemiIntensity: 3.4,

      // No sky, no moon, no skyline: the dome is a ceiling. What is above the
      // walls is the underside of one, and the gradient runs dark rather than
      // bright because a ceiling is the least lit surface in a lit room.
      grade: { lift: [0.010, 0.008, 0.006], gamma: [1.00, 1.00, 1.00], gain: [1.04, 1.00, 0.96] },
    },

    propDensity: 1.4,
    ambientLoop: 'city',
  },
];

export const BIOME_BY_ID = Object.fromEntries(BIOMES.map((b) => [b.id, b]));

/** Regions in the order a run visits them, when no itinerary was drawn. */
export function biomeForRegion(index) {
  return BIOMES[Math.min(index, BIOMES.length - 1)];
}

/**
 * Draw the districts a run will visit.
 *
 * A run is three regions long and there are six districts, and this used to be
 * `BIOMES[regionIndex]` — so every run went Wasteland, Industrial, Desert, and
 * the last three districts were unreachable in normal play. Three sixths of the
 * world existed only in the probes.
 *
 * The city always opens. It is the district the game is built around, so it is
 * the one every run starts in — not the widest or the most forgiving, which is
 * a real cost: a street circuit is the tightest road in the game and it is now
 * where a player meets the car. The Wasteland used to open for exactly that
 * reason, and it is worth remembering if the opening race starts reading as
 * hostile rather than as an introduction.
 *
 * The rest are drawn without replacement, so a run has a shape you have not
 * memorised.
 */
export function drawItinerary(rng, count) {
  const first = BIOME_BY_ID.house ?? BIOMES[0];
  const rest = BIOMES.filter((b) => b !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest].slice(0, Math.max(1, count));
}
