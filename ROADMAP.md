# Roadmap

Things decided but not built yet. Each entry says what it is, why it is wanted,
and what it will touch, so picking one up does not start from scratch.

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

**`tools/realtime-probe.mjs` still fails at every tier**, though the thing it
was blamed for turned out to be something else: the cars appearing to teleport
was the renderer ignoring the interpolation fraction the loop had been handing
it since the day it was written, and that is fixed. What is left is a real
p99 of four to five seconds against a healthy 3–7 ms p50 — something stalls
hard rather than rendering slowly, and it wants a profile rather than a guess.

One measured contributor: `VehicleMesh` builds the entire generated car, ten
thousand triangles of boxes and lofts, and then throws it away when the body
type has a hull. Ten milliseconds a car, seventy across a grid of seven, spent
on geometry nobody ever sees. That was a deliberate trade when the alternative
was threading a condition through four hundred lines, and it has come due. It
is not the whole story — at three thousand triangles per car and at fifty
thousand the ratio was 0.24x and 0.25x — but it is the part that is certain.

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
