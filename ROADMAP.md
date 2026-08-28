# Roadmap

Things decided but not built yet. Each entry says what it is, why it is wanted,
and what it will touch, so picking one up does not start from scratch.

---

## Physics: crash impacts

Impacts do not read as impacts — contact behaves like a scripted nudge rather
than like the real thing. This is what is left of a group of three faults
reported from play; the other two are done and are described below, because what
was wrong with them says something about where to look for this one.

**Wheels on the road — fixed.** The car used to hover above the surface or sink
into it in most situations. The physics was innocent: it holds `y` exactly at the
ground. Two pieces of geometry were at fault. Pitch and roll were applied to the
whole car about the group's origin, which sits on the tarmac, so five degrees of
pitch swung the front wheels ten centimetres; the body now turns on a child node
at the axle line and the wheels are not its children, so no attitude can lift
them. And the axle sat at the tyre's nominal radius while the tread blocks stand
proud of it, burying twenty-seven millimetres of every tyre in the road on every
car, permanently; the axle sits at the measured lowest point of the wheel now.

**Squat and dive — fixed.** Accelerating lifted the car. `pitch` summed two
different motions into one angle: lying along the road's slope, which has to turn
the tyres too, and squatting on the springs, which must not. Whichever the
renderer assumed, the other was wrong. They are `terrainPitch` and `bodyPitch`
now and go to different nodes. The travel was also unreal — ±0.12 rad of dive put
the nose of a four-metre car twenty centimetres under the tarmac, and roll of
±0.30 was a boat. Two degrees and three and a half, chosen against the cars: the
bodies carry real ride heights, about a hundred millimetres of sill clearance.

`tools/contact-probe.mjs` measures all of it and runs in `npm run probe`. Both
faults were invisible in a still frame and neither was catchable by any probe
that existed, because all three physics probes ask about forces and none of them
asked where the tyre was.

For crashes, the same suspicion is worth carrying in: the three probes that pass
today do not test what impacts feel like either. `src/vehicle/physics.js` has
`applyImpulse`, which changes velocity and nothing else — no rotation, no
attitude, no energy going anywhere. Whatever is built should come with the probe
that would have caught it.

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
