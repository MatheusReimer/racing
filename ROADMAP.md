# Roadmap

Things decided but not built yet. Each entry says what it is, why it is wanted,
and what it will touch, so picking one up does not start from scratch.

---

## Make the street a street — lane markings done

The road paints its own markings in its fragment shader: a double yellow centre
line, broken lane divides at every 3.6 m out from it, solid edge lines, chevron
hatching along a branch's shoulders, and warning chevrons for the last forty
metres before a split. All of it from `aLane` — where a vertex is across the
road and how far along — so it follows the curvature for free, stays 140 mm
wide at any distance, and costs no geometry and no draw call.

What is left, and why it was not done here:

- **Crossings and stop lines** at the city's junctions. `city.js` lays the
  centreline out on a block grid and so knows where they are, but that
  information does not survive into the track the renderer is given. Getting
  it there is the work, not the painting.
- **Arrows and words** — turn arrows in a lane, BUS, SLOW. These want a glyph,
  which means either a texture (the first texture in the project's road path)
  or signed-distance shapes written out by hand.
- **Signs that mean something.** `traffic_light`, `streetlight` and `neon_sign`
  already place and glow — seventeen traffic lights on a two-kilometre city
  lap — but there is no direction signage at a branch and no warning plate
  before the corners `tools/track-probe.mjs` already identifies as sharp.
- **Lights that change.** Still the open question from before: a light that is
  always green is set dressing, and one that changes is a rule the traffic
  simulation would have to respect or the whole thing reads as broken.

---

## Damage you can see — done

Four states — untouched, hit at three quarters, in trouble at a half, wrecked
— shown as scuffed paint, dimmed and then dead headlights, a bumper hanging
off the nose, a lifted bonnet, and smoke out of the engine bay. `DAMAGE_STATES`
in `src/vehicle/chassis.js` is the one table all of it reads, so the mesh and
the effects layer cannot drift apart on where a threshold is.

`tools/damage-probe.mjs` holds ten things about it, and `node tools/garage.mjs
damage` renders the four side by side, which is how the numbers were set.

Two things left where this touched:

- **Civilian cars show nothing.** They are one instanced draw per body type
  with a per-instance colour, so damage there means a second geometry or a mask
  attribute like the paint one — see `src/race/trafficmesh.js`. Rivals do show
  it; they are `Racer`s with meshes.
- **The wrecked state never smokes in a race.** Durability hitting zero clears
  `alive`, and the effects loop skips a car that is not alive. The rate in the
  table is what a wreck should look like if one is ever left on the road, and
  it is what the garage renders.

---

## The road's height, on the worst one per cent of it

`sample()` reports the ground under a car as the path's height at the nearest
station to it. The road mesh draws each ring flat across its width at that
ring's own centreline height. On a curve those are different stations, so the
two disagree — by 0.1 mm at the median and 2–13 mm at p95, which is nothing, and
by up to 270 mm in the worst one per cent, which is a car sunk to its sills on
a tight bend.

The start grid was one of those spots, at 112 mm, and that one is fixed: cars
are seated on the sampled ground rather than on the grid's own arithmetic, and
`tools/contact-probe.mjs` holds it at zero. The general case is not fixed. The
honest repair is for the two to ask the same question — either the mesh takes
each vertex's height from `sample()`, which costs a projection per vertex once
at generation, or `sample()` learns to answer for a point rather than for a
station. Worth doing before anything else is tuned against ride height, and not
worth doing blind: the sweep that produced those numbers is four lines and
should be a probe.

---

## A car that wins 85% of the time, and a five-second frame

**`tools/balance.mjs` reports the Kanzen 1.6 winning around 85% of races.**
Checked against the commits before the bodies, the scale change and the
collision rewrite — it predates all of them. Worth a look before the roster is
tuned around anything else.

**`tools/realtime-probe.mjs` still fails at every tier, and the number is not
what it looks like.** Its p99 is `workMs`, the loop's own timer, which starts at
the frame's rAF timestamp — so on a GPU-bound machine it counts the wait for the
*previous* frame's rasterisation as this frame's CPU work. Profiling the frames
directly says our code costs 1–7 ms in the frames the probe calls two seconds
long, and that during racing the worst whole frame is 253 ms with a 117 ms
median. It is software rasterisation of 1280x720, which is what the probe's own
note warns about, and it will not be improved by making the game do less.

What that probe would need to be useful is a signal that separates CPU work from
present-wait — the loop already tracks `pacing` for exactly that and the verdict
does not use it. Worth doing before anyone chases this number again: three
separate sessions have now blamed real bugs on it and found something else.

---

## Body kits, vinyls and underglow

The roster is now six distinct tuner silhouettes, but a car still does not
*visibly* change as it is built. Underground's identity is that the car you
finish a run with does not look like the one you started in.

The machinery is already there: the chassis generator reshapes from stats (Top
Speed adds a wing, Armour adds plating), `VehicleMesh` has an underglow plane
sitting at ~1% opacity, and paint is vertex colour on the body loft — so kits,
neon and two-tone vinyls need no textures and no new systems, only a vocabulary.
In a night district the underglow in particular should be the signature it is in
Underground rather than the invisible thing it is now.

---

## Streaming: free the world behind the car

**The Crash Bandicoot technique.** As the car moves forward, geometry that has
passed behind it is unloaded rather than kept resident — it cannot be seen
again on this lap, so there is no reason for it to occupy memory or to be
walked every frame. Detail ahead is paged in as it approaches.

Why it is worth doing here: the map's budget is currently bounded by what can
be held *all at once*, which is what forces the detail-versus-distance
trade-off in the first place. Streaming turns that into a budget for what is
*in front of you*, which is the only part anyone looks at. It is the same
argument as the distance LODs, taken to its conclusion.

What it touches:

- `src/world/propsmesh.js` — instance buffers would become windowed rather
  than whole-track. An `InstancedMesh` can already hide an instance by zeroing
  its matrix (that is how destroyed props work); this needs the stronger
  version, where instances outside the window are not uploaded at all.
- `src/world/scatter.js` — props are already generated with an `s` (distance
  along the track), so they are sortable into a ring buffer keyed by track
  position without any new data.
- `src/track/mesh.js` — the road, verge and barrier are single meshes for the
  whole lap. Streaming them means splitting into segments, which is a larger
  change than the props and should come second.

Two things to be careful about, both of which the current design would hide:

1. **A lap is a loop.** What is "behind" you on lap 1 is ahead of you again in
   ninety seconds. The window has to be keyed on track position modulo lap
   length, not on absolute progress, or the second lap runs through an empty
   world.
2. **Rivals are elsewhere on the circuit.** The player is not the only car;
   anything unloaded still has to exist for the simulation, which is already
   true — `RaceSim` holds no Three.js — but the *destruction* bookkeeping in
   `PropsMesh` assumes every prop has a live instance slot. A rival smashing a
   prop outside the player's window must still be smashed when it comes back
   into view.

Worth measuring before building: `tools/realtime-probe.mjs` already reports
real-time ratio per quality tier, so the gain can be stated as a number rather
than assumed.
