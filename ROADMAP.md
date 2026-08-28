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

## A five-second frame, and a car that wins 87% of the time

Two faults found by probes while working on something else, neither caused by
it, both left alone rather than fixed badly in passing.

**`tools/realtime-probe.mjs` fails at every tier.** p50 frame time is a healthy
3–7 ms, but p99 is four to five *seconds*: something stalls hard rather than
rendering slowly. The shape points at mesh construction when cars spawn, and
`VehicleMesh` is a candidate by construction — for a body with a hull it builds
the whole generated car, ten thousand triangles of boxes and lofts, and then
throws it away and uses the hull instead. That was a deliberate trade when the
alternative was threading a condition through four hundred lines; if this is the
stall, the trade has come due. Measured at three thousand triangles per car and
at fifty thousand: 0.24x and 0.25x real time. So it is not the body budget, and
it predates all of that work.

**`tools/balance.mjs` reports the Kanzen 1.6 winning 87% of races.** Also
predates the bodies, the scale change and the collision rewrite — checked
against each. Worth a look before the roster is tuned around anything else.

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
