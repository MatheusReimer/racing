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
    id: 'downtown',
    name: 'Olympic City',
    // Laid out from a block grid rather than harmonics — see track/city.js.
    city: true,

    // Stripped to bare road while the city is rebuilt.
    //
    // One flag, read in three places, rather than three commented-out call
    // sites: the props tables place nothing (`props.js`), the ground surfaces
    // are not built (`track/mesh.js`), and the sky draws no skyline
    // (`sky/sky.js`). Deleting this line brings all of it back at once, which
    // is the property that matters — a strip you cannot undo in one edit is a
    // deletion wearing a different name.
    stripped: true,
    tagline: 'Wet asphalt, neon, and traffic that does not know there is a race on.',
    order: 5,

    traffic: 1.0,

    // A street circuit: busy, narrow, and lit. Chaos is high because city
    // blocks turn rather than sweep, and the width is the tightest in the game
    // — the pressure here comes from what is *on* the road, not from the road.
    trackChaos: 0.50,
    trackWidth: 17,
    elevation: 6,
    offTrack: 'gravel',

    // Night. Everything below is chosen so the road is the brightest thing in
    // frame and the neon is the only saturated colour in it.
    palette: {
      sky: ['#080b16', '#0d1424', '#131d33'],
      fog: '#0b1120',
      fogDensity: 0.0068,
      road: '#2c323c',
      roadLine: '#d8dde6',
      ground: '#1d2128',
      groundAlt: '#171a20',
      prop: '#414a57',
      accent: '#ff2e88',
      sun: '#8fa8d8',
      sunAngle: 0.20,
      ambient: '#1b2436',

      // Lit by street lamps that are not in the light model, so `fill` stands
      // in for their spill: warm, from low down, and strong enough that the
      // road reads. The moon is the key and mostly makes the wet asphalt shine.
      // Weighted toward the hemisphere rather than the directional fill. A
      // strong directional light grazing the ground's normal map speckles it
      // with specular glitter — at night that reads as static, not as tarmac.
      // Hemispherical light is diffuse only, so it lifts the scene without
      // catching every bump.
      // Raised again once the frontages went in: buildings walling both sides
      // occlude most of the hemisphere, so the same rig that lit an open street
      // leaves a canyon black.
      // Cool and mostly hemispherical. A warm directional fill this strong
      // turned the ground brown, which beside a city street reads as a dirt
      // field rather than as asphalt in shadow.
      // No warm directional fill at all. At a grazing angle it lit the pavement
      // gold and did nothing the hemisphere was not already doing better; the
      // lamps that justify a warm tint are emissive geometry, not this light.
      sunIntensity: 1.9,
      fillColor: '#9fb6d8',
      fillIntensity: 0.10,
      hemiColor: '#44608f',
      hemiIntensity: 5.2,

      night: true,
      wet: true,

      // The moon sits where the key light comes from, so the shadows on the
      // street point away from the thing casting them. Bigger than the real
      // one — half a degree is a speck, and the point of it is to be seen.
      // Kept lower than a real moon would be at this hour: a city street is a
      // canyon, and the band of sky a driver can actually see is a few degrees
      // wide above the rooflines. Higher and it is a moon nobody sees.
      moon: { size: 0.038, elevation: 0.36, color: '#e9eefc' },
      // The matte beyond the fog: a silhouette a shade above the fog colour,
      // so the towers separate from it without becoming a wall of cut-outs.
      skylineColor: '#1b2740',
      skylineWindow: '#ffd39a',
          // Sodium and neon on wet asphalt: blacks lifted into blue so the night
      // has depth rather than holes, midtones pulled down, and just enough
      // magenta in the whites to read as a city rather than as moonlight.
      grade: { lift: [0.008, 0.010, 0.026], gamma: [1.00, 1.00, 1.05], gain: [1.02, 0.98, 1.05] },
    },

    propDensity: 1.25,
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
  const first = BIOME_BY_ID.downtown ?? BIOMES[0];
  const rest = BIOMES.filter((b) => b !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest].slice(0, Math.max(1, count));
}
