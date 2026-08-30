import * as THREE from 'three';
import { triCount, facetedMaterial } from './shapes.js';
import { RNG } from '../core/rng.js';
import {
  voxFacade, voxMall, voxTownhouse, voxTenement, voxBlock,
  voxFacadeGlow, voxMallGlow, voxTownhouseGlow, voxTenementGlow, FRONTAGE,
  voxWorkshop, voxHospital, voxSpire, voxGrandstand,
  voxWorkshopGlow, voxHospitalGlow, voxRidge,
} from './buildings.js';
import {
  voxStreetlight, voxTrafficLight, voxNeonSign, voxBillboard, voxBusStop,
  voxJerseyBarrier, voxDumpster, voxContainer, voxCrate, voxMarker,
} from './street.js';
import {
  voxRock, voxBoulder, voxPine, voxDeadTree, voxCactus, voxPalm, voxBones,
  voxIceBlock, voxSnowBank,
} from './nature.js';
import {
  voxBarrel, voxTyreStack, voxPole, voxWreck, voxShack, voxBrazier,
  voxGantry, voxCrane, voxPipes,
} from './yard.js';
import { lerp, TAU } from '../core/math.js';

// The things that make a track a place.
//
// Every prop is generated, faceted, and vertex-coloured, so a whole type shares
// one material and draws as a single InstancedMesh however many are scattered.
// Each type declares a few geometry *variants*, because instancing shares
// geometry — variety within a type has to come from having several to choose
// between, plus per-instance scale and rotation.
//
// `radius` is the collision footprint the simulation uses; `toughness` is how
// much Impact is needed to drive through rather than bounce off, which is what
// makes Weight and Impact decide routes as the design brief asks.
// `toughness: null` means indestructible — scenery, not an obstacle.

const TRACKSIDE = 'trackside';  // close to the road, can be hit
const SCENERY = 'scenery';      // background, never collides

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------
//
// Detail is spent where it can be resolved. A barrel two metres from the racing
// line is looked at directly; a tower four hundred metres away is a silhouette
// against fog, and every triangle past the outline of it is wasted.
//
// Two knobs, because they fail differently. `sides` scales segment counts, so a
// far prism is a hexagon rather than an octadecagon — cheap and invisible at
// range. `fine` gates the small applied details (rivets, ribs, slats, spectators)
// entirely: halving the segments of a rivet still leaves a rivet nobody can see,
// so those are dropped rather than shrunk.

export const LODS = [
  // A fourth level, at the kerb.
  //
  // The verge and the near band both used to draw the same "full detail", and
  // full detail was defined by what a prop seventy metres away needs. The
  // things actually worth spending on are the ones you pass within a car's
  // width of at two hundred: the barrels, the shacks, the frontages, the poles.
  // They are also the smallest population — the verge band is metres wide
  // against a field hundreds of metres deep — so raising them is close to free
  // and it is all in the part of the frame anyone is looking at.
  { id: 0, sides: 10.0, fine: true },   // at the kerb, passed within metres
  { id: 1, sides: 1.00, fine: true },   // near the road, looked at
  { id: 2, sides: 0.60, fine: false },  // mid-field, read as shape
  { id: 3, sides: 0.40, fine: false },  // horizon, read as silhouette
];





/**
 * A street frontage: one building in a continuous row.
 *
 * Built to be placed *against* the road rather than scattered near it. Local X
 * is depth into the block and local Z is width along the street, which is the
 * orientation `alignToTrack` produces — so a row of these laid end to end is a
 * wall, and the street becomes a canyon instead of a ribbon in a field.
 *
 * The scatter places them at a fixed setback, so the footprint has to be
 * predictable: depth and width are near-constant and the variety is in height,
 * colour and what is stuck on the front.
 */
/**
 * Frontage types all share their width along the street, and only their width.
 *
 * The scatter lays them end to end on a fixed pitch, so one shared width is
 * what makes the wall continuous no matter which types come up next to each
 * other. Depth is free, because they are placed by their *front* face: a deep
 * office and a shallow terrace both meet the pavement on the same line and
 * differ behind it, which is exactly how a real street works.
 *
 * The numbers themselves live in `FRONTAGE`, in `buildings.js`, with the code
 * that builds to them — see the import at the top of this file.
 *
 * `reach` on a frontage is a different thing again: how far the geometry
 * actually extends from its own origin, measured by tools/footprints.mjs and
 * pasted in. Placement used to offset by half the declared *depth*, on the
 * assumption that a frontage grows backwards from its front face. It does not:
 * it is modelled centred, so a townhouse declaring seventeen metres was built
 * thirty-eight across and half of it stood in the street. That was the
 * building in the middle of the road that kept being reported, and the sweep
 * meant to catch it only ever looked into the block, never at the half facing
 * the traffic.
 */


// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every prop type. `build(rng, pal, ctx)` returns one geometry variant.
 *
 * `radius`/`toughness` describe the collision the simulation runs. Toughness is
 * roughly the Impact needed to smash through instead of bouncing off, so a
 * Truck routes through a barrel stack that stops a Rocket — which is how Weight
 * and Impact come to decide navigation, as the design brief asks.
 */
export const PROP_TYPES = {
  tyre_stack: { build: voxTyreStack, place: TRACKSIDE, radius: 0.75, footprint: 0.9, toughness: 60, height: 1.4 },
  barrel: { build: voxBarrel, place: TRACKSIDE, radius: 0.5, footprint: 1.0, toughness: 40, height: 1.2 },
  crate: { build: voxCrate, place: TRACKSIDE, radius: 0.6, footprint: 1.3, toughness: 55, height: 1.1 },
  marker: { build: voxMarker, place: TRACKSIDE, radius: 0.35, footprint: 0.7, toughness: 25, height: 2.2 },

  gantry: { build: voxGantry, place: SCENERY, radius: 0, toughness: null, height: 6.5, spanning: true },
  // `footprint` is how much room a prop needs, which is not `radius`.
  //
  // `radius` is what a car collides against, and scenery has none — a building
  // is not something you hit, it is something that is there. Placement was
  // reading it anyway and so treated a twenty-five-metre building as a point
  // with two metres of margin. On a circuit that folds back on itself, a
  // building put sixty metres off one straight lands on another part of the
  // lap, and thirteen metres of it ends up in the road. These are half-extents
  // at the largest each generator builds.
  grandstand: { build: voxGrandstand, place: SCENERY, radius: 0, footprint: 18.0, toughness: null, height: 8 },

  wreck: { build: voxWreck, place: TRACKSIDE, radius: 1.6, footprint: 3.5, toughness: 190, height: 1.2 },
  shack: { build: voxShack, place: SCENERY, radius: 2.4, footprint: 3.5, toughness: null, height: 3 },
  pole: {
    build: voxPole,
    place: SCENERY, radius: 0.3, footprint: 0.2, toughness: null, height: 8,
  },
  dead_tree: { build: voxDeadTree, place: SCENERY, radius: 0.4, footprint: 0.7, toughness: 140, height: 5 },
  rock: {
    build: voxRock,
    place: TRACKSIDE, radius: 1.3, footprint: 4.4, toughness: null, height: 1.6,
  },
  boulder: {
    build: voxBoulder,
    place: SCENERY, radius: 3.0, footprint: 8.1, toughness: null, height: 3.4,
  },

  pine: { build: voxPine, place: SCENERY, radius: 0.6, footprint: 3.7, toughness: 150, height: 9 },
  ice_block: { build: voxIceBlock, place: TRACKSIDE, radius: 1.2, footprint: 5.0, toughness: 80, height: 1.8 },
  snow_bank: { build: voxSnowBank, place: SCENERY, radius: 2.2, footprint: 6.8, toughness: null, height: 1.2 },

  cactus: { build: voxCactus, place: TRACKSIDE, radius: 0.45, footprint: 2.0, toughness: 35, height: 5 },
  bones: { build: voxBones, place: SCENERY, radius: 1.8, footprint: 5.7, toughness: null, height: 1.4 },

  container: { build: voxContainer, place: TRACKSIDE, radius: 3.1, footprint: 4.3, toughness: 320, height: 2.6 },
  crane: { build: voxCrane, place: SCENERY, radius: 1.6, footprint: 2.0, toughness: null, height: 26 },
  pipes: { build: voxPipes, place: SCENERY, radius: 1.0, footprint: 22.0, toughness: null, height: 2.5 },

  spire: { build: voxSpire, place: SCENERY, radius: 1.6, footprint: 4.0, toughness: null, height: 19 },
  streetlight: {
    build: voxStreetlight, glow: voxStreetlight.glow,
    place: TRACKSIDE, radius: 0.3, footprint: 0.4, toughness: null, height: 9,
    // The boom reaches out along local +X; it belongs over the road.
    faceRoad: 1,
  },
  traffic_light: {
    build: voxTrafficLight, glow: voxTrafficLight.glow,
    place: TRACKSIDE, radius: 0.25, footprint: 0.9, toughness: null, height: 5.6,
    faceRoad: 1,
  },
  neon_sign: {
    build: voxNeonSign, glow: voxNeonSign.glow,
    place: TRACKSIDE, radius: 0.3, footprint: 1.6, toughness: null, height: 5,
  },
  jersey_barrier: {
    build: voxJerseyBarrier, place: TRACKSIDE, radius: 1.6, footprint: 2.0, toughness: 260, height: 1,
  },
  dumpster: { build: voxDumpster, place: TRACKSIDE, radius: 1.2, footprint: 2.2, toughness: 90, height: 1.6 },
  palm: { build: voxPalm, place: SCENERY, radius: 0.4, footprint: 0.6, toughness: 120, height: 9 },

  // --- frontages ---
  //
  // Everything that makes one of these a front — glazing, canopy, sign, door,
  // lit windows — is on the -X face, which is the one that has to see the
  // street. They share `frontage.width` so a row of mixed types still tiles
  // into a continuous wall; `depth` is per type and only decides how far back
  // the building goes, because the scatter places them by their front face.
  facade: {
    build: voxFacade, glow: voxFacadeGlow,
    place: SCENERY, radius: 0, toughness: null, height: 42,
    frontage: { reach: 18.2, width: FRONTAGE.facade.w, depth: FRONTAGE.facade.d },
    faceRoad: -1,
  },
  mall: {
    build: voxMall, glow: voxMallGlow,
    place: SCENERY, radius: 0, toughness: null, height: 14,
    frontage: { reach: 20.4, width: FRONTAGE.mall.w, depth: FRONTAGE.mall.d },
    faceRoad: -1,
  },
  townhouse: {
    build: voxTownhouse, glow: voxTownhouseGlow,
    place: SCENERY, radius: 0, toughness: null, height: 11,
    frontage: { reach: 18.9, width: FRONTAGE.townhouse.w, depth: FRONTAGE.townhouse.d },
    faceRoad: -1,
  },
  tenement: {
    build: voxTenement, glow: voxTenementGlow,
    place: SCENERY, radius: 0, toughness: null, height: 19,
    frontage: { reach: 14.4, width: FRONTAGE.tenement.w, depth: FRONTAGE.tenement.d },
    faceRoad: -1,
  },

  billboard: {
    build: voxBillboard, glow: voxBillboard.glow,
    place: SCENERY, radius: 0.5, footprint: 5.6, toughness: null, height: 12, faceRoad: -1,
  },
  bus_stop: {
    build: voxBusStop, glow: voxBusStop.glow,
    place: TRACKSIDE, radius: 1.4, footprint: 3.5, toughness: null, height: 2.7, faceRoad: -1,
  },

  workshop: {
    build: voxWorkshop, glow: voxWorkshopGlow,
    place: SCENERY, radius: 0, footprint: 17.5, toughness: null, height: 7.5,
    faceRoad: -1,
  },
  hospital: {
    build: voxHospital, glow: voxHospitalGlow,
    place: SCENERY, radius: 0, footprint: 25.4, toughness: null, height: 36,
    faceRoad: -1,
  },

  // 17.0, not the 15.4 tools/footprints.mjs measures. Every mass is centred,
  // so the half-extent is w/2 and w tops out at 25 — 12.5 m, and 16.9 with the
  // probe's scale headroom. The tool samples one seed; this is the bound.
  building: { build: voxBlock, place: SCENERY, radius: 0, footprint: 19.6, toughness: null, height: 40, horizon: true },
  ridge: { build: voxRidge, place: SCENERY, radius: 0, footprint: 32.0, toughness: null, height: 26, horizon: true },

  brazier: { build: voxBrazier, glow: voxBrazier.glow, place: TRACKSIDE, radius: 0.9, footprint: 1.3, toughness: 90, height: 2.2, emissive: 0xff5a1e },
};

/**
 * What a city street is made of, and how long it stays made of it.
 *
 * `weight` is how often a type comes up; `run` is how many frontages in a row
 * it keeps producing once it does. The run is the part that matters. Drawing a
 * type per slot gives an office, a terrace, a mall, a tenement, an office — a
 * street nobody built, where every hundred metres looks like every other. Real
 * blocks come in stretches, so the district you are driving through changes as
 * you go round the lap, and coming back to a stretch you recognise is what
 * turns a circuit into a place.
 */
// ===========================================================================
// THE CITY IS STRIPPED
//
// Everything downtown places is commented out below, deliberately, so the city
// can be rebuilt from an empty street rather than adjusted on top of what was
// there. Uncommenting the two blocks marked STRIPPED restores it exactly.
//
// What was wrong with it, so the rebuild does not repeat it: the frontages were
// never the problem. Measured on one lap of downtown, the street had 63
// facades, 62 townhouses, 41 tenements and 6 malls standing on it, every one at
// detail level 0 — windows cut, clutter bolted on, shopfronts glazed. What
// buried them was `building`: 216 of them, 87 close enough to read, and
// `voxBlock` is deliberately a plain slab with no windows at any level because
// it was written for the horizon. It was weighted 3 in the scenery table, the
// highest of anything there, which put the least detailed object in the game
// between the player and the most detailed ones.
// ===========================================================================

/** STRIPPED — the city's frontage mix. */
export const CITY_FRONTAGES = {
  // facade: { weight: 3.0, run: [2, 4] },      // commercial: the default street
  // tenement: { weight: 2.2, run: [2, 5] },    // the cheap end of it
  // townhouse: { weight: 2.0, run: [3, 6] },   // residential, and the longest runs
  // mall: { weight: 0.9, run: [1, 2] },        // rare, and it interrupts
};

/** Which types each biome uses, and how heavily. */
export const BIOME_PROPS = {
  wasteland: {
    trackside: { barrel: 3, tyre_stack: 3, crate: 2, wreck: 2, marker: 3, rock: 2 },
    scenery: { pole: 3, dead_tree: 2, shack: 2, workshop: 2, boulder: 1, grandstand: 0.5 },
    horizon: { building: 2, ridge: 2, crane: 1, hospital: 0.6 },
  },
  industrial: {
    trackside: { container: 3, barrel: 3, crate: 3, tyre_stack: 2, marker: 3 },
    scenery: { crane: 2, pipes: 3, pole: 3, shack: 1, workshop: 2.5, grandstand: 0.8 },
    horizon: { building: 4, crane: 2, ridge: 1 },
  },
  desert: {
    trackside: { rock: 3, cactus: 3, barrel: 1, marker: 3 },
    scenery: { boulder: 3, bones: 2, dead_tree: 1, pole: 1 },
    horizon: { ridge: 4, building: 1 },
  },
  frozen: {
    trackside: { ice_block: 3, tyre_stack: 2, marker: 3, barrel: 1 },
    scenery: { pine: 4, snow_bank: 3, pole: 2, shack: 1 },
    horizon: { ridge: 3, building: 1 },
  },
  // STRIPPED — see the note above `CITY_FRONTAGES`.
  downtown: {
    stripped: true,
    trackside: {
      // streetlight: 4, neon_sign: 3, traffic_light: 3,
      // jersey_barrier: 3, dumpster: 2, bus_stop: 2, marker: 1,
    },
    scenery: {
      // building: 3, billboard: 2.5, palm: 2, pole: 1, shack: 1,
      // workshop: 1.2, hospital: 0.8,
    },
    horizon: {
      // building: 5, crane: 1, hospital: 0.5,
    },
  },

  inferno: {
    trackside: { brazier: 3, rock: 2, barrel: 2, marker: 2 },
    scenery: { spire: 3, bones: 2, boulder: 2 },
    horizon: { ridge: 3, spire: 2 },
  },
};

const VARIANTS = 3;

/**
 * Build the geometry variants and shared material for every type a biome uses.
 * Called once per race.
 */
export function buildPropLibrary(biome, seed = 1) {
  const pal = biome.palette;
  const spec = BIOME_PROPS[biome.id] || BIOME_PROPS.wasteland;
  const used = new Set([
    ...Object.keys(spec.trackside), ...Object.keys(spec.scenery),
    ...Object.keys(spec.horizon ?? {}),
    'gantry',
  ]);
  // Frontages are placed by a dedicated pass rather than drawn from a weighted
  // table, so they have to be asked for explicitly.
  if (biome.city) for (const name of Object.keys(CITY_FRONTAGES)) used.add(name);

  const library = {};
  let totalTris = 0;

  for (const name of used) {
    const def = PROP_TYPES[name];
    if (!def) continue;
    // One set of variants per detail level. Variety is worth paying for close
    // up and worth nothing at the horizon, so the far levels get a single
    // variant: at that range the difference between three silhouettes and one
    // is not visible, and three buckets is three draw calls.
    // Body and glow are built together, variant by variant, so they can share
    // one `ctx`.
    //
    // They used to be two independent passes over two independent RNG streams,
    // and a frontage's lit windows were therefore computed from a different
    // height, a different floor count and a different column count than the
    // wall they were meant to be in. Every city block in the game has been
    // lighting windows that are not there. The streams themselves are
    // untouched — each still sees the same calls in the same order — so
    // nothing but the pairing changes.
    const levels = [];
    const glowLevels = def.glow ? [] : null;
    for (const lod of LODS) {
      const rng = new RNG(`${seed}:prop:${name}`);
      const glowRng = new RNG(`${seed}:glow:${name}`);
      const count = def.spanning ? 1 : (lod.id === 0 ? VARIANTS : lod.id === 1 ? 2 : 1);
      const glowCount = def.glow
        ? (lod.id === 0 ? VARIANTS : lod.id === 1 ? 2 : 1) : 0;
      const variants = [];
      const glows = [];
      for (let v = 0; v < Math.max(count, glowCount); v++) {
        const ctx = { biome, sides: lod.sides, fine: lod.fine, lod: lod.id };
        if (v < count) {
          const geo = def.build(rng, pal, ctx);
          if (geo) {
            variants.push(geo);
            totalTris += triCount(geo);
          }
        }
        // `ctx.layout` is whatever the body left behind. A generator that
        // leaves nothing gets the glow it always got.
        if (v < glowCount) {
          // A native voxel glow is drawn on the body's own grid and wants
          // the layout; a faceted one builds its own boxes and wants the
          // palette. Flagged rather than sniffed: both take two arguments.
          const g = def.glow.fromLayout
            ? def.glow(glowRng, ctx.layout)
            : def.glow(glowRng, pal, ctx);
          if (g) glows.push(g);
        }
      }
      levels.push(variants);
      glowLevels?.push(glows);
    }
    if (levels[0].length === 0) continue;

    library[name] = {
      def,
      levels,
      glowLevels,
      variants: levels[0],
      material: facetedMaterial({
        roughness: name === 'ice_block' ? 0.25 : 0.86,
        metalness: name === 'container' || name === 'crane' ? 0.25 : 0.04,
      }),
    };
  }

  library.__stats = { types: Object.keys(library).length, tris: totalTris };
  return library;
}

export function disposePropLibrary(library) {
  for (const [name, entry] of Object.entries(library)) {
    if (name.startsWith('__')) continue;
    if (entry.levels) {
      for (const level of entry.levels) for (const g of level) g.dispose();
      if (entry.glowLevels) for (const level of entry.glowLevels) for (const g of level) g.dispose();
      entry.material?.dispose();
      continue;
    }
    for (const g of entry.variants) g.dispose();
    entry.material.dispose();
  }
}
