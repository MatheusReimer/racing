# Roadmap

Things decided but not built yet. Each entry says what it is, why it is wanted,
and what it will touch, so picking one up does not start from scratch.

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
