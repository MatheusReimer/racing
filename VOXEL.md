# Moving the game to voxels

The look is decided: cars, world and effects become voxel. This is the plan for
getting there, written to be picked up on another machine.

Four candidate skins were built on the seven references and looked at side by
side — the raw model, an aggressive faceted collapse, a Taubin-smoothed rounded
version, and a voxel grid. The voxel one was the only one worth keeping. The
other three are still in `src/dev/styles.js`; they cost nothing to leave there
and they are the record of why this decision was made.

## What already works — do not rebuild it

`raw.html` + `src/dev/raw.js` + `src/dev/styles.js`, run with `npm run raw`.

- **`voxel()`** samples the merged reference surface on a barycentric lattice
  fine enough that no cell a triangle crosses is stepped over, averages a colour
  per cell, and emits an `InstancedMesh` of cubes. It reads the *whole* surface
  rather than a decimated one: a collapse is a budget on triangles and this is a
  budget on cells, and putting one in front of the other only means the grid
  samples somebody's approximation instead of the car.
- **`bake()`** is the colour problem, solved. Three sources: the material's base
  colour factor; the base-colour *texture* sampled per vertex at its UV (four of
  the seven keep their paint there — reading only the factor turned the Impreza
  into a white lump); and glass, which is asserted rather than read.
- **Glass** goes through the project's own `tools/lib/classify.mjs`, which
  already knows these files' habits. Six of seven answer by name. The GC8 calls
  all 86 of its materials `Meshpart12Mtl` and names no node, so there is a
  fallback — but a *band*, `0.2 < opacity < 0.8`, never a threshold. That file
  declares 49 materials BLEND including its own bodywork at alpha 0.00, along
  with the hubs, springs and both wishbones. Everything it lies about is fully
  transparent; everything actually glass sits between 0.30 and 0.55. The
  fallback only runs when nothing on the car was *called* a window.
- Grid ladder 46 / 72 / 100 / 145 / 200 / 280, `[` and `]` in the viewer. 145 is
  the default and the one to build against.

## The numbers this rests on

Measured, not estimated. `cells` is occupied cells; `exposed` is faces with no
occupied neighbour — the only ones that can ever be seen.

| body | grid | cells | all faces | exposed | tris culled | tris naive |
| --- | --- | --- | --- | --- | --- | --- |
| roadster | 72 | 13,265 | 79,590 | 20,156 (25%) | 40k | 159k |
| roadster | 100 | 25,418 | 152,508 | 43,226 (28%) | 86k | 305k |
| roadster | 145 | 58,730 | 352,380 | 97,660 (28%) | 195k | 705k |
| rally | 145 | 79,673 | 478,038 | 135,254 (28%) | 271k | 956k |

**Roughly 72% of every voxel body is buried.** Face culling alone is the
difference between unshippable and ordinary, before greedy meshing merges the
coplanar runs — and a car is mostly large flat panels, which is the best case
for greedy meshing.

## Stage 1 — bake bodies offline

New `tools/voxelize.mjs`, beside `decimate.mjs`, reusing `tools/lib/model.mjs`
and `tools/lib/classify.mjs`. Port `bake()` and `voxel()` out of the browser.

Output `public/bodies/<name>.vox`: grid dimensions, cell size in metres, a
palette of the distinct colours, and one palette index per occupied cell in a
run-length or sparse-index form. This replaces `.bin`, and it should be *small* —
58,730 cells against a palette is tens of kilobytes, against a megabyte of
decimated coordinates.

Bake offline rather than at load because the browser path needs the 30–75 MB
reference, which is gitignored and never ships, and takes about 1.5 s a car.

> **Open question.** `bake()` samples textures through a `<canvas>`. Node has no
> canvas. Either decode the glTF's PNG/JPEG images with a dependency, or extract
> the base-colour textures to disk as a bake step. Settle this first — it gates
> the whole stage, and four of the seven cars are white without it.

## Stage 2 — draw them affordably

New `src/vehicle/voxmesh.js`: occupancy grid in, one indexed `BufferGeometry`
out, vertex colours from the palette.

1. Cull buried faces — 72%, per the table.
2. Greedy-mesh the survivors: merge coplanar same-colour runs into quads.

Budget by role, not globally: the player's car at grid 145, opponents and
traffic at 72. A car at thirty metres does not need 58,000 cells, and
`src/race/trafficmesh.js` already instances traffic.

## Stage 3 — the car in the game

`src/vehicle/chassis.js` is 2,922 lines and the largest single piece of work.

- The hull branch (`HULLS[profile.bodyType]`, around line 1797) becomes the
  voxel branch. The generated/lofted branch beside it stays as the fallback.
- **The bolt-ons are the hidden cost.** Ram bars, wings, armour and every other
  part the build system welds on are generated meshes. A voxel body wearing
  smooth accessories reads as two art styles in one car. They all have to be
  rebuilt on the grid.
- **Damage is the prize.** `DAMAGE_STATES` currently swaps meshes and materials.
  A voxel body can simply *lose cells* — and this is the thing the style is
  actually good at, not a compromise it forces. Budget real time for it; it is
  the strongest gameplay reason to take the look.

> **Open question.** Do wheels stay round? A voxel wheel looks right standing
> still and strange rotating, because the cell grid turns with it. Keeping the
> wheel a generated cylinder is defensible and probably correct.

## Stage 4 — the world

- `src/world/shapes.js` (231 lines) is the primitive library — box, cylinder,
  cone, icosahedron, extrude — deliberately flat-shaded with per-facet colour.
  Rewrite as voxel builders. **This is the leverage point:** `props.js` is 1,962
  lines built almost entirely on top of it, and largely follows for free.
- `src/track/city.js` buildings, `src/world/scatter.js` placement and
  `src/world/propsmesh.js` batching all sit above that and should need less than
  they look like they will.
- **The road stays smooth.** A voxelized driving surface reads as a permanent
  rumble strip and fights the physics, which is a spline. Kerbs, barriers,
  buildings, signage and scenery go to the grid; the ribbon in
  `src/track/mesh.js` does not. Test this early — if a smooth road under voxel
  scenery looks wrong, everything downstream changes.

## Stage 5 — effects

`src/fx/particles.js` is one pooled `Points` cloud with a sprite shader.

- Sparks and debris become instanced cubes that **inherit the colour of the cell
  they came off**. A panel that loses cells sheds those cells. This ties Stage 3
  and Stage 5 together and is most of the payoff.
- Smoke and dust stay sprites. A cube of smoke reads as a solid.

## What this obsoletes — and when

- `paint.html`, `src/dev/paint.js`, `src/data/bodies/marks.js`, `public/marks/`.
  The crate editor exists to guess which triangles of somebody else's mesh are
  glass; a voxel bake decides colour per cell at bake time. `classify.mjs` stays
  — the bake needs it. **Do not delete any of this until the bake is proven on
  all seven cars.** Those marks encode real judgement about these specific cars.
- `tools/decimate.mjs` and `public/bodies/*.bin`, once `.vox` lands.
- `tools/silhouette.mjs` stays. See below.

## The licence has not moved

A voxel bake is still Res1n's surface, quantized. `coupe`, `rotary` and `gt` are
CC BY-NC-SA and still bind the whole game: it cannot be sold and ShareAlike
attaches. Changing the look changed nothing here.

What *has* changed is that the exit is now cheap. At 145 cells a car is a shape
rather than a surface, and `tools/silhouette.mjs` already measures a reference
into about sixty numbers — facts about a car, carrying no licence. A voxel body
generated from measured rings would be licence-free and would look very close to
one baked from a reference, because the grid is throwing away the detail that
distinguishes them anyway. Not this pass. Before anything is sold.

## Picking this up on another machine

- **`refs/` is gitignored and about 200 MB. None of it travels.** Re-download the
  seven models from Sketchfab; the URLs are in `refs/README.txt`, which is now
  tracked even though the rest of the directory is not. Confirm each against the
  triangle counts recorded there.
- `npm i`, then `npm run raw` for the viewer and `npm run dev` for the game.
- `shots/` is gitignored, so the reference screenshots do not travel either.
  Re-shoot them from the viewer.
