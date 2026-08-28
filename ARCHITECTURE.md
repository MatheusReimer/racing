# Architecture

Subsystem contracts, and the reasoning behind the decisions that were not
obvious. Where a choice has a non-obvious cost, that cost is written down.

```
src/
  core/       loop, CPU governor, input, seeded RNG, event bus, math
  stats/      the 15 attributes, and the one place they become physics
  vehicle/    the car: motion model and procedural geometry
  track/      spline, procedural layout, road/verge/barrier meshes
  render/     renderer, HDR target, bloom composite, chase camera
  materials/  procedural noise and textures — no image files exist
  sky/        gradient dome and the lighting rig
  build/      parts, skills, tags, hook dispatch
  combat/     projectiles, traps, blasts, status effects
  ai/         rival drivers
  race/       RaceSim (rules) and Race (presentation)
  run/        node map, run state, reward and shop generation
  fx/         particles and tyre marks
  audio/      Web Audio synthesis
  ui/         HUD and screens
  data/       vehicles, parts, skills, biomes, bosses, events, modifiers
tools/        headless probes and harnesses
```

## The load-bearing split: `RaceSim` vs `Race`

`race/sim.js` contains every rule. `race/race.js` extends it and adds the
scene, meshes, camera and effects, and is forbidden from deciding anything.

This is not tidiness. A roguelike with sixty interacting parts has to answer
statistical questions — *is the Drifter competitive across two hundred seeds* —
and a browser at software-rendered frame rates takes about a minute per race.
`RaceSim` imports no Three.js, so `tools/balance.mjs` runs 180 complete races in
18 seconds in plain Node. The presentation layer subscribes to `onBarrierHit`,
`onCarHit` and `onWreck`; those callbacks are the only channel, and nothing
flows the other way.

The consequence to respect: **a behaviour added to `race.js` exists in the
played game but not in any balance run.** If it changes an outcome, it belongs
in `sim.js`.

## CPU budget

The loop separates three rates that are usually conflated:

| | rate | why |
|---|---|---|
| Simulation | fixed 60 Hz | exponential-decay grip and impulse collisions are unconditionally stable, so 60 Hz is sufficient and handling stops depending on refresh rate |
| Presentation | capped, 60 fps racing / 30 menu / 15 idle | a raw rAF loop runs at panel refresh; on a 144 Hz monitor that is 2.4x the work for frames the simulation cannot distinguish |
| Utilisation | measured, steered to ~85% | `work_ms / frame_interval_ms`, smoothed |

`core/perf.js` is the actuator. It moves a discrete quality tier — render
scale, bloom, shadows, particle budget, draw distance — so that measured
utilisation settles near target. The asymmetry is deliberate: dropping quality
takes 1 s of sustained pressure, raising it takes 4 s of sustained slack, and
either change starts a 1.5 s cooldown during which measurements are discarded.
Without that, the tier hunts across every corner with heavy particle load.

Two details that matter more than they look:

- **Skipped frames must not consume the wall time they spanned.** The pacing
  check returns before any clock bookkeeping, so simulation time is preserved.
- **Utilisation divides by the interval we intend to hold, not the interval
  that happened.** Otherwise a slow frame flatters itself by widening its own
  denominator.

Menus are the largest single saving: a run spends real time on the map and in
shops, and those render at 30 fps for ~4% CPU.

## The vehicle model

`vehicle/physics.js`. Velocity lives in world space. Each step it is decomposed
into components along and across the car's heading; the forward component takes
engine, brake and drag, the lateral component is bled by an exponential grip
term, and steering rotates the *heading*.

**The critical line** is that the velocity is recomposed on the basis it was
decomposed on, *before* the heading advances. Recomposing onto the new heading
welds velocity to the chassis: slip angle becomes zero by construction and
drifting cannot exist. That bug was in the first version and
`tools/physics-probe.mjs` is what caught it.

Cornering has two independent limits, which is how Grip and Turning stay
distinct as the design document requires:

- **Grip** caps the sustainable yaw rate. Holding a corner needs lateral
  acceleration `v·ω`; the tyres supply `corneringAccel`, so `ω ≤ corneringAccel/v`.
  Without this term the heading outruns the tyres at speed and every corner ends
  in a spin.
- **Turning** caps yaw rate at low speed (hairpin tightness) and sets how fast
  the car converges on it (agility).

A yaw *floor* derived from Turning sits under the grip limit, because on ice you
can still point the nose — you simply do not change direction. Without it, low
grip produces helpless understeer instead of a slide. Front-tyre saturation
(`1/(1+(slip/limit)²)`) is what makes a slide settle at an angle rather than
compounding into a spin.

**Drift is control, not negative grip.** The handbrake cuts traction by a fixed
factor. The Drift attribute buys momentum retention through the slide, extra
yaw authority, a wider quality window centred on the angle *that* car holds, and
the Energy payout rate.

`stats/attributes.js` is the only file permitted to convert an attribute into a
physical quantity. Nothing downstream hard-codes a conversion.

## Modifier stacking

`stats/statblock.js` has two channels:

- **`stats`** — the 15 attributes. Flat adds, then the *summed* percentage.
  Percentages sum rather than compound, so three +25% engines are +75%, not
  +95%. Additive stacking keeps a build's ceiling legible.
- **`mods`** — named channels that are not attributes (heat generation, energy
  cost, blast radius). Multiplicative ones compound, because "half cost" twice
  genuinely should be a quarter.

`preview()` returns what the block *would* be with one more source, without
mutating it. That is what lets the reward screen show real deltas rather than a
parallel estimate that can drift out of sync.

## Builds: tags and hooks

`build/build.js`. Depth comes from parts interacting, and two mechanisms carry
it:

- **Tags** are the interface. Parts read the tags of the whole build, counted
  not just present, so an item can scale "per Electric source" and mean it —
  including sources added later that it has never heard of.
- **Hooks** are named moments (`onDrift`, `onImpact`, `onHeatState`,
  `modifyDamageDealt`, …). Hooks are flattened once per build change, because
  dispatch happens thousands of times per race.

Unknown hook names warn loudly at build time. A mistyped hook is otherwise
completely silent — the part simply never does anything.

`modifyDamageDealt` and `modifyDamageTaken` are reducers returning a number;
every other hook mutates a context object.

## Track generation

The centreline is a sum of harmonics on a circle:

```
r(θ) = R · (1 + Σ aₖ·sin(kθ + φₖ))
```

Every term is periodic in θ, so the loop closes exactly — no stitching, no
seam, no validation pass — and bounding `Σ|aₖ|` below 1 keeps it free of
self-intersections without ever testing for them. Each harmonic is a
recognisable feature: k=2 is a long oval, k=3 a trefoil, k=5–7 the sweepers.
Skipping a band outright is what stops every circuit feeling like the same
lumpy ring.

Shortcuts are selected by geometry, not placed at random: every candidate
window is scored by how much distance a chord across it would save, gated on
metres saved rather than ratio. The corners decide where a shortcut can exist.

`Path.project()` answers "what `s` is this position nearest" against a densely
sampled polyline with a uniform bucket grid, because a raw Catmull-Rom
parameter is not distance and is not analytically invertible.

Branch ownership in `Track.sample()` requires the position to be *within the
branch's width*, not merely nearest to it. A branch bulges away from the racing
line, so a car legitimately mid-road is often nearer a branch centreline — and
claiming it there applies the branch's much narrower width and reports a car in
the middle of the road as off-track.

## Meshes

The verge sweeps the path outward rather than displacing a grid. The obvious
implementation projects every vertex onto the path to find its elevation, which
costs ~9000 `Path.project()` calls and blocks the main thread for seconds at
track load. Sweeping gives elevation for free — the ring already knows its `s` —
and the terrain meets the road exactly rather than approximately.

Vertex colours on the ground are **modulation only, never the base colour**. The
texture already carries the colour; applying it twice multiplies two linear
values below 0.3 together and turns the desert black.

Lane markings are baked into vertex colours. The road is sampled 9 vertices
across specifically so there is somewhere to put an edge line and a dashed
centre at no extra cost.

### The car, and where its triangles go

Roughly **29.7k triangles per car**, so a six-car field is ~178k — a number
WebGL2 does not notice, and the whole reason to spend it here rather than pretend
a low-poly look requires a low-poly budget.

The split matters more than the total. It was originally ~3k of tread blocks
against ~1.2k of bodywork, which is exactly backwards: the silhouette is what a
car is recognised by. Now the body loft runs 72 rings of 44 sides, and the rest
goes into things that read at racing distance — suspension inside the arches,
split glazing with frames, a cockpit with a cage and harness, a grille lattice,
gills, louvres, and rims with spokes and lug nuts.

Two rules keep detail from becoming the artifact it was added to remove:

1. **Anything sitting on the car asks the body where it is.** `bodyHalfWidth(fz,
   y)` interpolates the profile and inverts the squircle cross-section. The
   emissive sill strip was previously placed with hand-guessed constants at
   `rideH * 0.52` — below the floor — and `W * 0.5` wide, which is wider than
   the tapered flank. The result was a lit slab hovering in mid air beside the
   car. Constants cannot track a profile that changes; a query can.
2. **Nothing terminates outside the bodywork.** The suspension originally ran to
   `W * 0.5 + 0.06` while the wheels are tucked in at `trackW`, so every arm and
   upright stood proud of the flank as a row of grey blocks. Aero is sized to sit
   under the overhangs, and the roll cage below the roofline.

## Rendering

Custom bloom rather than `EffectComposer`, so it can be switched off entirely by
the governor and so the blur runs at quarter resolution. On tier 0 the scene
renders straight to the canvas with no intermediate target at all.

**The composite pass must convert linear to sRGB itself.** Three applies that
automatically when *its* shaders render to the canvas, by injecting
`<colorspace_fragment>`. A hand-written pass gets no such treatment, and without
the conversion every lit surface reads several stops too dark while unlit
materials look correct — which is a confusing symptom, because half the frame
looks fine.

## Particles

Two clouds, not one: additive for emissive effects (sparks, fire, arcs) and
alpha for particulate ones (smoke, dust, debris). A single draw call cannot mix
blend modes, and additive smoke only ever brightens — it glows white instead of
occluding, and enough of it hides the world completely.

Three terms keep density readable:

- **Near-camera fade.** Effects are emitted at the car, three metres from a
  chase camera. One smoke puff at that range covers the viewport.
- **Distance fade.** The particle shader cannot use Three's fog chunk, so it
  carries its own, matched to the biome's fog density.
- **Bounded growth.** Unbounded, a 1.9 s smoke particle reaches ~8 m across.

Continuous emitters are rate-limited per *second*. A per-frame probability
emits twice as much at 120 fps as at 60.

## Audio

All synthesised; no files. The engine is a small additive stack (fundamental,
two harmonics, filtered noise) whose pitch tracks the same `forwardSpeed` the
physics uses, with a synthetic gearbox layered on so acceleration has shape
instead of one long glide. Everything routes through a compressor, because an
explosion during a heavy drift would otherwise clip.

## Run structure

`run/run.js` owns the build, the money, the map and — critically — the car's
condition. **Durability does not reset between races.** That single decision is
what makes a sequence of races a run: a scrappy win costs something, and a
Garage becomes a real choice against a Shop.

It also has to be tuned against the damage a race actually inflicts. The first
version killed 11 of 12 runs at a median of 2 races; `maxDurability` and a 25%
between-race service brought that to 7 wins in 12 at a median of 14 races.

Reward relevance is weighted toward tags the build already carries. A uniform
roll across sixty parts almost never continues a theme, so a build never
coheres. With weighting, 9 of 12 probe runs develop a dominant theme.

## The world, and why it is faceted

The map was empty, and the fix was a scatter system rather than more terrain
detail. `world/scatter.js` places ~280 props per circuit in four bands, and the
band a prop lands in is a design decision, not a distance:

- **road** — light, smashable clusters *on* the racing line, always hugging one
  side so the far half stays clear. This is the band that turns Weight and
  Impact into navigation stats: the same barrel stack is a route for a Truck
  (8 damage across a race) and a hazard for a Rocket (71).
- **verge** — punishes cutting a corner without walling it off.
- **outer / far** — scenery. Grandstands, cranes, spires: the things that make a
  circuit somewhere rather than a ribbon in a void.

Props are data (`generateProps` returns plain objects) so the simulation owns
destruction and the balance runs smash exactly the barrels the played game does.
Rendering is one `InstancedMesh` per (type, variant): ~280 props cost about
fifteen draw calls, and a destroyed one is hidden by zeroing its instance matrix
rather than by rebuilding the buffer.

**Faceted, not smooth.** `world/shapes.js` emits *non-indexed* geometry
throughout, because `computeVertexNormals()` averages the normals of every face
sharing a vertex — correct for a curved surface, and exactly wrong for this
look, since it turns a deliberate facet into a soft blur. Non-indexed costs
about 3x the vertices; that is the price of the style and at these counts it is
nowhere near mattering.

Vehicle bodies use polygonal cross-sections (a sampled squircle) rather than
rectangles, so the loft produces chamfered shoulders and a real silhouette while
every face stays flat. Cars went from 640 to ~6,500 triangles: sixteen rings of
sixteen sides, a visible interior behind the glass, and wheels with staggered
tread, paired spokes, a brake disc and a caliper.

## Track edges

Three separate faults all felt like "the invisible walls are glitching", and
`barrier-probe.mjs` was written to tell them apart:

1. The collision boundary sat at `halfWidth + 0.35` and the drawn barrier at
   `halfWidth + 1.1`. You bounced off something 0.75 m inside the thing you
   could see. Both now read `BARRIER_OFFSET` from `track.js`, so they cannot
   drift apart again.
2. Branches had collision walls and **no barrier mesh at all** — a shortcut was
   lined with genuinely invisible walls. Branches are now unwalled: a shortcut
   is a route, not a corridor, and leaving one puts you on the biome's rough,
   which already costs you.
3. Branch ownership flapped frame-to-frame near a junction, so the half-width
   jumped between the branch's 5 m and the main line's 11 m and the correction
   threw the car up to **13 m sideways**. Ownership is now sticky (1.45x harder
   to leave than to enter) and the correction is clamped.

The probe also has to separate the no-progress rescue's deliberate teleport from
a barrier fault, or the rescue's 12 m reposition masks everything else.

### The rail is drawn where the collision line is not

A fourth fault looked like the same thing but is not: the guard rail passed
straight through the middle of the car.

Collision constrains a **single point** — the car's centre. Drawing the rail on
that same line therefore guarantees that a car resting on its limit has half its
bodywork through the fence. So `BARRIER_OFFSET` (where the centre stops) and
`BARRIER_RAIL_OFFSET` (where the rail is drawn) are now deliberately different,
separated by `BARRIER_CAR_CLEARANCE` — one half-width of the *widest* car in the
roster, not the average, because under-sizing it puts that one car back inside
the rail.

Fixing this by moving the *collision* line inward instead was tried and measured,
and it is worse in a way worth recording:

| inset | worst recovery from pinned | never recovered |
|-------|---------------------------|-----------------|
| 0.0 m | 10.0 s                    | 0               |
| 0.3 m | 11.2 s                    | 0               |
| 0.6 m | 11.8 s                    | 0               |
| 1.0 m | 15.0 s                    | 1               |

Making the inset depend on the car's heading — the geometrically correct answer,
a box support function so an angled car's corner is stopped too — is worse still
(2 failures), and not because of the margin it costs. A heading-dependent
boundary **moves as the car rotates**, so turning away from the wall to escape
shoves the car back into it mid-manoeuvre.

Widening the drawn corridor costs nothing, because the boundary a player feels
has not moved at all. What remains is that a spun car's nose can overhang the
rail by up to ~1.5 m; the probe measures that and holds it bounded rather than
asserting it away.

### Off the road is not the same as making no progress

The no-progress rescue cannot see a car scraping along the verge: it is covering
plenty of ground, so it never looks stuck — while being off the road, on gravel,
at half speed, and not racing. Cars used to escape this by bouncing off scenery,
which only worked because the scenery was being placed *inside* the barrier line.
Moving the props out to where they belong removed that accidental crutch, and
`_checkStuck` gained a second trigger: nine unbroken seconds off the racing
surface, on the main line.

Deliberately **not** gated on speed. A speed gate looks like the cautious choice
and is in fact the hole — a car sliding along the verge fast enough to clear the
gate never accumulates the timer, and that is exactly the car that never gets
back on the road.

## The CPU budget has two signals, not one

The original governor watched only `utilisation`: how much of each frame
interval was spent inside our own code. That is blind to more than half the
cost. GL commands are *submitted* during the frame and then rasterised and
presented after `render()` returns, so a GPU-bound machine reports a
comfortable 45% while frames actually arrive 110 ms apart.

Measured under load, the consequence was severe: the governor sat at Ultra
reporting 48% CPU while the game ran at 9 fps and **0.59x real time**.

Running slower than the wall clock is the worst failure mode a driving game
has. Every control still works, at a fraction of the rate, and it is
indistinguishable from the car having stopped responding — which is exactly how
it was reported. There is no error, no stutter, nothing to point at.

So the loop now measures three things and the governor reads all of them:

| signal | what it sees | fails when |
|---|---|---|
| `utilisation` | our own code, against the intended interval | CPU-bound |
| `pacing` | real gap between presented frames, against that interval | GPU- or compositor-bound |
| `realtimeRatio` | simulated seconds per real second | the loop is losing time |

`realtimeRatio` below 0.85 drops a tier **immediately**, bypassing the usual
one-second hysteresis. Separately, sustained bad pacing halves the presentation
cap (60 → 30 fps): a wider frame budget lets the same catch-up ceiling cover far
more simulated time, so 8 steps span 133 ms against a 33 ms target instead of a
16 ms one. Choppier, but in real time and controllable.

All three are on the F1 overlay. A silent slow-motion state is what made this
impossible to diagnose from the outside.

`realtime-probe.mjs` measures the ratio per quality tier and fails if even the
lowest tier cannot hold real time.

## Two conventions that silently mirrored the game

Both of these were reported by a player, not caught by a probe, and both are now
guarded.

**Steering direction.** Three.js is right-handed with Y up, so a car whose
forward is +Z has its right-hand side at **-X** — `cross(forward, up)`. The
vehicle's `right` getter returned +X, and `forward = (sin yaw, cos yaw)` means
*increasing* yaw swings the nose toward +X, so a positive steer input turned
left. The two errors were consistent with each other: slip sign, body lean,
wheel angle and the AI's avoidance all inverted together, so the car handled
correctly while going the wrong way. `physics-probe.mjs` test 10 now pins the
world-space direction of each key.

**Race progress.** `raceProgress` was `lap * length + trackS`. The lap counter
increments at the start line; `trackS` wraps at the spline's **seam**. Those are
the same place only when `startS` is 0 — and the generator puts the start line
on the straightest part of the circuit, a median 352 m away from the seam. So
mid-lap, every car's progress fell by a full lap length (measured: 2245 m).

That scrambled the standings, but far worse: progress is also the trigger for
the no-progress rescue, which slams a car to 12 m/s. A player driving normally
was being dropped from 150 km/h to 43 km/h every five seconds for most of every
lap, with no visible cause. Progress is now measured from the start line, and
the rescue additionally refuses to fire on any car that is moving above 8 m/s on
track — it is a last resort for a wedged car, and must never be able to reach
into the physics of a car that is simply driving.

`progress-probe.mjs` asserts monotonicity and counts rescues across seeds.

## Smaller traps, all now guarded

**The brake is reverse when stationary.** That is deliberate — it is what the S
key does from a standstill. But the countdown held the whole field on
`brake: 1`, so every car drove backwards off the grid before the lights went
out. The grid is now pinned outright during the countdown rather than held on
the brake.

**Loft end caps were wound inward.** `cross(f2-f0, f1-f0)` pointed at -Z on the
front cap, so back-face culling threw the nose and tail away and you could see
into the car's interior. Winding is now checked mechanically:
`mesh-probe.mjs` walks every generated mesh as a directed-edge graph and
asserts each edge is shared by exactly two triangles traversing it in opposite
directions. Comparing normals against a centroid does *not* work here — on a
merged mesh built from many boxes, a quarter of all faces legitimately point
inward, so that test reports 25% failure on perfect geometry.

**Autopilot archetype is part of the measurement.** The balance tool drove every
vehicle with the low-aggression `racer` brain, which measures pace and nothing
else and understates any vehicle whose identity is contact. A Truck driven like
a qualifying lap is just a slow Rocket. Each vehicle now names its own driving
style.

**Two probes were flaky and are not any more.** `uiflow` walked the run with
`Math.random()` and an unseeded map, so which screens it visited — and which
checks ran — differed per run; it now pins both. `balance` flagged "never wins"
at n=30, which for a true 3% win rate fails at random about 40% of the time;
that check now requires n ≥ 50 and reports a note below it. A probe that fails
at random is worse than no probe, because it teaches you to ignore the output.

## Capturing frames

`preserveDrawingBuffer` is false, which is correct for a shipped game — keeping
it costs a full-buffer copy every frame. The consequence is that the drawing
buffer's contents are **undefined once a frame has been presented**, so reading
the canvas asynchronously while the loop runs returns whatever the compositor
happens to hold: a stale frame, a torn composite of two frames, or just the sky
dome. Under SwiftShader in headless Chromium it is close to guaranteed.

Every capture in `tools/` therefore goes through `stableShot()`, which sets
`loop.timeScale = 0`, waits for a few identical frames, screenshots, and
restores it. Without that the screenshots are not evidence — several hours were
spent debugging a renderer that was working, because the captures said it was
not.

## The grid: six cars, six shapes

`bodyType` picks the silhouette; stats then push that shape around rather than
defining it. Before, stats were the *only* thing shaping the mesh, so every
vehicle was one silhouette stretched — a heavy car was a long version of a light
one. On a street circuit the roster has to be readable at thirty metres.

| car | body | length | what reads |
|-----|------|--------|------------|
| Kanzen 1.6 | hatch | 3.96 m | tall glass, cut-off tail |
| Sableline S-Type | coupe | 4.81 m | long bonnet, fastback |
| Aoi 13B | rotary | 4.56 m | lowest and widest, no overhang |
| Tsurugi GT-S | gt | 5.52 m | long, square shoulders, flat tail |
| Hinode Roadster | roadster | 3.65 m | open — windscreen frame and roll hoop |
| Vantera WRC | rally | 4.87 m | three-box saloon with a boot deck |

The roadster has no roof at all: `cabin.roof: false` swaps the greenhouse loft
for a screen frame, a hoop and a closed rear deck, so it is not a hollow shell.

### Grip is a baseline, not a differentiator

Raising cornering to arcade levels made the Grip stat far too powerful. At
0.21 m/s² per point a high-grip car cornered **35% harder** than a low one, and
on a circuit that is mostly corners that is not a trade-off, it is a winner: the
Roadster took 80% of races. Flattened to 0.12 with a raised base, so the
baseline is unchanged at grip 100 and the *spread* narrowed. Win rates went from
5–80% to 10–40% across the six.

## Handling, measured rather than felt

"It feels bad" is not actionable, so `handling-probe.mjs` turns the feel into
four numbers: the tightest arc the car will hold at speed, the fastest entry to
a 26 m city corner that still makes it, slip angle under ordinary cornering, and
turn-in time.

That immediately located the problem. Turn-in was 0.07 s, slip 3°, the handbrake
worked — all fine. But the **tightest arc the car would hold was 56 m at any
speed**, and the city is built from 26 m fillets: a 26 m corner at 100 km/h needs
30 m/s², and the car had 20. Every junction had to be braked to 90 km/h, which
turns a district into a series of pauses.

Grip was the lever, not steering rate — the wheel was already fast enough. At
34 m/s² (~3.5g) the minimum arc is 28 m and a city corner goes at 110 km/h.

The drift terms had to be rescaled *again* for the same reason as last time:
`driftGripScrub` and the yaw `overshoot` are both multipliers on grip, so raising
grip without lowering them deletes the handbrake slide. Matched to the previous
products; speed kept through a drift is unchanged at 72%.

## A city is a grid, not a shape

The first attempt at a city district was a palette swap and street furniture on
the existing generator, and it did not read as a city at all — correctly
criticised as "muito simplória". The reason is structural: every other district
is **harmonics on a circle**, which produces a closed loop of sweeping curves in
open country. No amount of lamp posts makes that a city, because a city is not a
shape. It is a grid: streets meeting at right angles, blocks between them, and
the road as a canyon with walls.

`track/city.js` lays one out the way a city is laid out:

1. take a grid of blocks
2. grow a connected region of them
3. **the circuit is the boundary of that region**

The boundary of a simply-connected polyomino is guaranteed to be a single closed
loop that never crosses itself — the property the harmonic generator has to test
for and hope about. Right-angle corners come out for free and are then filleted
to ~26 m, which the arcade grip takes at about 80 km/h. Result: 76–81% of a lap
is straight, against a sweeping ring where almost none of it is.

Three failure modes had to be closed, and each is a way the boundary stops being
a loop:

- **Holes.** An enclosed hole makes the boundary two loops, and the circuit
  silently becomes whichever the tracer found first. Flood-filled from outside.
- **Diagonal pinches.** Two blocks touching only at a corner give that grid
  vertex four boundary edges, so the boundary is a figure-of-eight — two streets
  crossing at a point with no junction. Filling one diagonal makes it a corner.
- **Anything else.** The tracer returns null rather than guessing, and the
  generator draws again. Twenty-four attempts, then it gives up honestly.

### Offsetting sideways assumes open country

Buildings appeared in the middle of the road, and the cause was more general than
the city. `offsetPoint(s, lateral)` places things by pushing sideways from the
centreline, which assumes there is open country either side. That fails twice:

- On **any** circuit, an inward offset larger than the local radius of curvature
  folds through the centre of the corner and comes out the far side. A 26 m city
  fillet does that to anything placed past 26 m in.
- In a **city**, 200 m sideways is three blocks over — on another street. The
  mid and far scenery bands were written for open country where that space is
  empty.

Rather than guard each cause, `place()` now asks the track where the thing
actually landed and rejects it if that is a road. One sample per prop at
generation time, and it closes both plus whichever third case nobody has found.

The probe missed this because it checked the lateral offset a prop was placed
*with* rather than where it ended up — so it reported a clean road while eight
buildings stood in one. It samples the world position now.

### Buildings have to be a wall, not scenery

Every other district scatters props at random distances, which gives buildings
*near* a road. A street needs a continuous frontage: `facade` is built with its
depth along local X and its width along local Z — the orientation `alignToTrack`
produces — and laid end to end down both sides at a 2.4 m setback. A generous
setback leaves open ground between the barrier and the buildings, and open ground
beside a city street reads as a field with offices behind it.

Street lighting is on a **regular** 34 m pitch, alternating sides. Regular is the
point: the rhythm of light pools going past is most of what reads as speed at
night, and scattering them destroys it.

### Two things the city broke that the country never did

- **Shortcuts came out 77 m longer than the main line.** The branch builder
  offsets the racing line to the inside of a bend, which shortens a sweeping
  curve. A city corner is a short arc between two long straights, so offsetting
  across that span leaves the straights exactly as long and adds the lateral
  excursion on top. City shortcuts are now diagonal alleys cutting the corner —
  120 m round two sides of a right angle against an 85 m hypotenuse — and save
  17–34 m. Frontages are skipped where an alley runs, because a shortcut with a
  building in it is worse than no shortcut: it is a route the map offers and the
  world refuses.
- **A 6.4 m curvature spike on a circuit whose tightest real corner is 26 m.**
  Straights and fillets were sampled at different spacings, and a Catmull-Rom
  through unevenly spaced points overshoots at the joins. The spike existed in
  the spline and not in the road. Fixed by resampling to a uniform arc-length
  step.

The width profile is also inverted for cities: pinching the road where curvature
is high is right for a country circuit and exactly backwards at a junction,
which is the widest part of a street.

### Lighting a canyon

Two passes were needed, and the second only because the first worked. Once
frontages walled both sides they occluded most of the hemisphere, so the rig that
lit an open street left a canyon black. Weighted heavily toward hemispherical
light: a strong directional fill grazing the ground's normal map speckles it with
specular glitter, and a warm one turns the pavement brown, which beside a city
street reads as a dirt field. City verge also loses its terrain relief and its
brightness variation — beside a street the correct reading is pavement: uniform,
dark, and not competing with the road.

Every run now opens in the city. That is a real cost worth remembering: a street
circuit is the tightest road in the game, and the Wasteland used to open
precisely because it is the widest and most forgiving place to meet the car.

## Underground: what the pivot actually changed

The reference for map, cars and driving is *NFS: Underground*. The roguelike
layer — builds, tags, skills, the Energy economy — is untouched.

### Handling

Arcade, and the numbers say so: cornering grip went from ~1.3g to ~2.0g and
braking from 11.5 to 15.5 m/s². A city 90 is now entered late and hard rather
than braked to a crawl for.

Two knock-on effects had to be paid for explicitly, and both were invisible
until measured:

- **The drift economy nearly died.** `driftGripScrub` is a *multiplier* on grip,
  so raising grip by half and leaving it alone deleted the handbrake slide —
  speed kept through a drift fell from 72% to 41%, quality from 1.00 to 0.41.
  That starves every Drift-tagged skill and the Energy behind them.
- **The drift *geometry* went with it.** The commanded yaw rate is
  `latAccelCap * overshoot`; raising the first and not lowering the second let a
  slide reach 57°. Both are now matched to their previous products, so what
  changed is the grip under the car and not the shape of a drift.

Balance improved rather than degraded: the win-rate spread across six vehicles
went from 2–38% to 5–35%.

Walls scrape. Restitution dropped to 0.12 and contact damps the yaw rate and
eases the heading parallel to the barrier — a wall is a cost in time, not a spin.

### Nitrous is not Energy

Energy is the *skill* economy: spent on deck buttons, earned by playing the
build. Nitrous is the *driving* economy: earned by holding a slide and by
threading traffic, spent on the straight after. Folding them together would make
every squeeze of the bottle a skill you did not cast — the wrong decision to put
in front of the player twenty times a lap. Held on Space, drift moved to Shift
alone.

### Traffic, and why it is not the obstacles we just removed

Static obstacles on the racing line are a toll: paid identically every lap by
everyone, memorised once. Traffic is *read* — it moves, it is somewhere else on
lap two, and threading it pays nitrous. `traffic-probe.mjs` tests exactly that
distinction: a driver that reads the road takes 24 contacts across eight
circuits where one driving the centreline blind takes 41.

Damage is deliberately small (`2 + closing * 0.26`); the cost that matters is
the speed scrubbed off. At the first attempt (`4 + closing * 0.55`) traffic took
an attentive driver's whole car in five contacts, which is a durability tax on
entering the district rather than a hazard.

### The city

`downtown` is a sixth district rather than a replacement — the other five stay.
Night, wet, neon, and the tightest road in the game at 17 m.

Two rendering points carried the whole look:

- **The light rig comes from the palette now.** Intensities used to be constants
  multiplying palette colours, which works while the palette is bright and
  collapses when it is not: a night sky of `#0d1424` driving a hemisphere light
  at 1.45 contributes nothing, and the city rendered as a black screen with neon
  in it. A night district needs a rig that does not follow its own sky colour,
  because the street is lit by lamps that are not in the model — `fill` stands
  in for their spill.
- **Wet asphalt is why Underground looks like Underground**: the road is the
  brightest surface in frame because it is a mirror, not because it is lit. It
  has to be *smooth* though — dropping roughness to 0.16 while leaving the
  normal map at full strength put a specular highlight on every bump in the
  texture, which at a grazing angle reads as a field of orange glitter rather
  than as tarmac.

Lit props get a second, unlit pass (`def.glow`), for the same reason the braziers
do: a lamp head that responds to scene lighting is not a lamp, it is pale paint.

### Half the world was unreachable

A run is three regions and `biomeForRegion` returned `BIOMES[regionIndex]`, so
every run went Wasteland, Industrial, Desert and the last three districts existed
only in the probes. This predates the city — Frozen and Inferno were already
unreachable. Runs now draw an itinerary from the seed: the Wasteland always
opens, because it is the widest circuit and the design leans on that to teach
the car, and the rest are drawn without replacement.

## The world, at three distances

Props are built at three detail levels and placed into bands measured **outward
from the road edge**, not from the centreline — so a wide corner and a narrow
straight get scenery in the same place relative to the tarmac.

| band | distance off the road | level | what it is |
|------|----------------------|-------|------------|
| verge | 1.5–16 m | 0 | trackside furniture, destructible |
| near | 16–70 m | 0 | scenery you look at |
| mid | 70–200 m | 1 | read as shape |
| far | 200–480 m | 2 | silhouettes against fog |

Two knobs per level, because detail fails in two different ways. `sides` scales
segment counts, so a distant prism is a hexagon rather than an octadecagon.
`fine` gates the applied details — rivets, ribs, slats, spectators, window bands
— **entirely**, because halving the segment count of a rivet still leaves a
rivet nobody can see. Typical falloff: a grandstand is 1052 → 132 → 116
triangles, a container 788 → 12, a barrel 572 → 176 → 112.

Instancing shares one geometry per draw, so the detail level is part of the
bucket key alongside type and variant. That is the price of LOD here, and it is
why the far levels carry fewer variants: at four hundred metres the difference
between three silhouettes and one is not visible, and three buckets is three
draw calls.

Before this, every prop sat within **35 m** of the road — there was no "far" to
place anything in, which is most of why the horizon read as empty. `building`
and `ridge` exist only for that band.

### Nothing on the racing surface

Road obstacles are gone by choice. They were the design's way of making Weight
and Impact decide routes — a Truck driving through a barrel stack that stops a
Rocket — and that lever is now gone with them. Destructible props remain on the
verge, so smashing things is the price of running wide rather than a toll on the
racing line. `props-probe.mjs` asserts the surface stays clear, excluding
gantries, which span the road from above on purpose.

## Ground contact, and a tolerance that was not one

The vertical test was `if (this.y > groundY + 0.001)`. One millimetre is not a
tolerance on rolling terrain: at 40 m/s a 2% downgrade drops the surface 13 mm
in a single step. Measured on ordinary laps, the car was flagged **airborne 12-13%
of the time driving in a straight line**, with a worst gap of 54 mm.

That is not a cosmetic bug, because airborne means `gripRate *= 0.05` and
`yawCap *= 0.18`. Every crest and dip quietly took the car's grip and steering
away and put `AIRBORNE` on the HUD while all four wheels were on the road — the
"car stops answering for no reason" report, arriving through a third distinct
mechanism after the barrier friction and the verge rescue.

The tolerance is now `CONTACT_TOLERANCE + groundDrop * 2`, so it scales with how
fast the surface is falling away: following the terrain is contact, and a real
`launch()` still separates (0.65 s of flight and 1.3 m of height for `launch(9)`).
`control-probe.mjs` asserts the figure stays under 1%. Nothing calls `launch()`
yet, so today the correct answer is zero; when ramps arrive that check becomes
the guarantee that they are the only thing lifting the car.

`body.airTime` was added alongside it so the HUD only names sustained flight — a
state that flickers on every rise is noise, not information.

## Elevation you can see

The circuit's elevation was four harmonics at k = 1, 2, 3 and 5 — wavelengths
from 400 m to a full lap. At racing speed that is a change of horizon, not a
hill: you cross a 2 km harmonic in fifty seconds and never feel it. A rolling
set at k = 8, 13 and 21 was added, which is what you actually drive over, and
the control-point count went from 96 to 288 because a k=21 term sampled 96 times
around the loop is 4.5 samples per cycle and aliases into a different, lumpier
shape than the one asked for.

Amplitude stays proportional to 1/k so every harmonic contributes the same
maximum gradient, but harmonics *sum*, and a seed that lines several up produces
a slope no per-harmonic tuning prevents — inferno reached 33%, a one-in-three
ramp. The assembled control points are measured once and scaled to a 12% cap.
Result: 9–17 crests per lap in every biome, none steeper than 12.1%.

None of which is visible if the car does not lean into it. `body.pitch` was
driven purely by acceleration, so the car stayed level while the road tilted
underneath it. It now carries a terrain term measured from the rise over the
distance actually covered each step — no extra sampling, and it holds below a
couple of centimetres of travel where the quotient is noise.

The terrain mesh had the matching problem: nine lateral columns ending at 260 m,
so a single 65 m quad spanned the middle distance and the ground relief existed
in the maths and not in the mesh. It now runs 21 columns to 560 m, dense near
the road and thinning outward, tessellation scaled per quality tier — going
denser than that all the way out cost roughly a quarter of the low tier's
real-time headroom for detail sitting behind fog. Vertex count, not extent, is
what the ground charges for.

## Rubber is light removed, not colour added

The tyre marks wrote an absolute grey, `vec4(0.04, 0.04, 0.05, vAlpha * 0.55)`,
blended over whatever was underneath. On any surface *darker* than that grey —
which is most of the track once it is in shadow — an absolute value paints
**lighter** than the tarmac. The marks then read as a pale smear trailing the
rear wheels, which looks like a shadow stuck under the car rather than a skid.

They now multiply (`blendSrc: ZeroFactor, blendDst: SrcColorFactor`, stated
explicitly because `THREE.MultiplyBlending` in r180 demands `premultipliedAlpha`
and warns every frame otherwise), so a mark can only ever darken what is under
it.

Worth generalising: any decal that composites toward a fixed colour will invert
somewhere on a track that spans this much brightness.

## Arguments in the wrong slot, twice

`boxOf` applies its offset *before* returning, so rotating the result swings it
about the world origin rather than about itself. The gantry truss and a pole
brace both did this and flew off the map; the crane's bracing had the same bug
plus a compensating `translate(0, y - (y - 0), 0)` — which is `y`, written so it
looks like a correction. Build at the origin, rotate, then place.

Worse, because it was silent: `barrel(rng, pal, color, ctx)` was called as
`build(rng, pal, ctx)`, so the **colour parameter received the context object**,
and `new THREE.Color({...})` returns white without complaining. Every barrel on
every track had been rendering white instead of red or green. Nothing ever
passed a colour, so the parameter is gone rather than reordered. The `gantry`
builder already carried a comment about this exact hazard — the same mistake was
sitting three functions away, undetected, because its failure mode was a
plausible colour rather than NaN geometry.

## Three guards that failed for the wrong reason

All three passed for years and then failed when the game got *better*, which is
the worst kind of guard: it teaches you to ignore the output.

- **Steering direction** held the wheel for four seconds and read the final X.
  That is a direction test only while the car turns less than half a circle.
  When `steerRate` went up, correct steering carried the car past 180°, the yaw
  wrapped from −170 to +120, and the guard reported INVERTED for a car turning
  exactly as it should. Now measured over 0.8 s.
- **Corner radius** failed below a hardcoded 12 m while the *drivable* radius was
  computed twenty lines above and used only for display. Higher grip made tight
  corners easier and the constant started failing tracks the car had just got
  better at. The real limit is geometric: a corner tighter than the road is wide
  folds its inside edge through itself.
- **Traffic avoidance** compared one hit against one hit on a single circuit,
  which distinguishes nothing — the verdict flipped when unrelated scenery
  changed the driven line. Averaged over eight circuits it is 41 against 24.

A fourth was simply mis-attributed: the "destroyed by traffic alone" check tested
`!alive`, which also counts a car that smashed its way through the scenery. It
now sums damage tagged as traffic.

## Two harnesses that reported confidently and were wrong

Both of these produced plausible output while measuring nothing, which is worse
than failing:

- A throwaway triangle counter passed a `Build` to `VehicleMesh`, which takes a
  **`visualProfile`**. `stats.weight` was `undefined`, every derived dimension
  became `NaN`, and the whole mesh was degenerate — yet it still reported
  sensible-looking triangle counts, because counts do not depend on vertex
  values. `tools/tris.mjs` now asserts `Number.isFinite(mesh.length)` before
  reporting anything.
- The garage capture screenshots the page while the garage has stopped the game
  loop, so it depends on the compositor still holding the last frame. It now
  reads the canvas inside the frame that drew it (`__garage.grab()`), which
  removes the race. Worth knowing when reading its output: `HIDE_*`, `EYE` and
  `YAW` only apply in `single` mode — in `vehicles` mode the camera and layout
  are fixed, so passing them there correctly changes nothing.

## Known limits

- Bosses field a champion build but do not yet have bespoke arena mechanics
  beyond modifiers; The Mirror does not yet clone the player's build.
- Destructible props and world obstacles (§8) are not implemented — barriers
  and surface hazards carry that role.
- Meta progression between runs (§37) is not implemented; all six vehicles are
  defined but `STARTER_VEHICLE_IDS` gates only three by intent, and nothing
  unlocks the rest yet.
- The `Gambler` measures poorly in `balance.mjs` by construction: its identity
  is reward quality across a run, and the tool measures single races.
- No shadow cascades; one 90 m shadow frustum follows the camera.
