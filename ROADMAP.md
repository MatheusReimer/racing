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

## Skills: the missing verb, then affinity, then more of them

Scoped, not started. Three pieces in this order, because each one makes the
next worth doing.

### 1. Swapping — done

`Build.removeSkill`, offers that no longer stop at the slot count, and a screen
that asks which skill goes. Taking one with a free slot never asks; levelling
one already carried never asks either. `run-probe` holds all four cases and the
offer behaviour that made them unreachable.

Still open here: the garage cannot drop a skill freely, only the reward screen
can force the question. That is the natural place for "I want this gone" as
opposed to "I want that instead".

### 1b. Skill trees — the mechanism is in, one skill converted

A skill may declare `branches`, each with a rank cap. The garage offers the
branches instead of a level; finding another copy still raises the level. So
finding one again makes it stronger and working on it makes it *specific*,
which are different things and now read as different things.

A skill without branches behaves exactly as before, which is what lets the
other fourteen be converted one at a time instead of in one commit.

Nitro is converted, as the worked example: Surge (more boost, longer), Purge
(clears Frozen and Oiled, then refuses them) and Battering Ram (double, then
triple Impact while boosting). Those last two used to arrive on their own at
levels 3 and 5; they are now given up for each other.

Left to do: the other fourteen. Most already have two or three distinct
qualitative effects buried in `desc(lv)` and `level >= N` checks — 31 of those
checks across the file — so the content largely exists and the work is
restructuring rather than invention. Banana and a couple of others have only
two, and will need a third written.

### 2. Affinity, not fixed pools

A heavy car should reach for blunt things and a precise one for precise things
— and that intent is already in the data, unread. Every car's *starting* skill
already fits its numbers: the Tsurugi is weight +55 and impact +55 and starts
with Shockwave (Area/Impact/Explosive); the Roadster is luck +55 and starts
with Banana (Trap/Control). What is missing is the roll respecting it.

Affinity rather than a closed set of seven per car, and the reason is
arithmetic. There are fifteen skills and six cars. Seven each is forty-two
slots to fill from fifteen things: either the sets overlap almost entirely and
the identity evaporates, or the catalogue has to more than double first. Slay
the Spire's per-character pools work because each is seventy-odd cards deep —
at fifteen, fixing seven at the car-select screen decides half the run before
the first race, which is the opposite of what the genre wants.

So: each vehicle carries tag weights, and `pickSkill` multiplies by them. It is
already `rng.weighted(pool, fn)`, so this is a few lines and a table:

  Tsurugi GT-S   Impact, Explosive, Area, Defense     the brute
  Vantera WRC    Trap, Explosive, Projectile          the fighter
  Hinode Roadster Trap, Control, Defense              the trickster
  Sableline      Electric, Energy, Control            the technician
  Aoi 13B        Speed, Projectile, Fire              fast and fragile
  Kanzen 1.6     Speed, Control, Energy               nimble

Nothing is locked out. A Tsurugi can still find Cryo Burst; it will just see
Shockwave-shaped things more often, and two runs in the same car will still
differ.

One thing to check before trusting the numbers: rarity weight, the Luck stat
and affinity would all multiply into the same roll. Three multiplicative terms
is how a "slight preference" becomes "always the same skill" — worth a probe
that rolls a few thousand offers per car and reports the spread, before the
weights are tuned rather than after.

### 3. More skills, and a rarity curve that is not a cliff

Fifteen, as 7 common / 7 rare / **1 epic**. One epic in the entire game is not
a rarity tier, it is a single card, and the crate-style excitement of finding
something rare has nowhere to land.

The tag vocabulary is just as lopsided: Control appears on 8 of 15 skills,
while Impact, Ice and Fire have exactly one each — so an affinity table that
leans on Impact is leaning on a single skill. Growing to around thirty, with
the thin tags filled out and three or four more epics, is what makes both the
affinity table and a future closed-pool design possible. It is also the point
at which "seven per car" stops being arithmetic nonsense and becomes a real
option to weigh.

---

## One currency, and the surplus that says it needs more sinks

Scrap pays for everything — parts, skills, pits, garage work. The tension is
supposed to be that the same pool serves needs on different clocks: spend it on
a pit now to save this race, or hold it for an upgrade later, and you cannot
hoard because losing the race loses the reward that refills it.

That argument only works if scrap is scarce, and **measured, it was not**.
`tools/economy-probe.mjs` drives a greedy shopper — every node, every shop,
buying everything affordable cheapest-first until it cannot. It spent 447 over
a run and ended holding 1,603: a player buying literally everything on offer
finished with three and a half times what they managed to spend.

So the conclusion ran the other way from the usual one: **the fix is more to
buy, not smaller payouts.** Both missing sinks are now in.

- **The garage was free.** Repair and a skill upgrade both cost nothing, which
  made the one node that exists purely to spend money the one node that did not
  take any. Repair is now 1.4 scrap a point and is sold **pro rata**: the share
  of the price you can pay is the share of the repair you get, so 50 scrap
  against a 100 scrap job mends half the damage. That is the rule for every
  repair in the game, in the garage and in the pits, and it exists because the
  player who most needs the garage is exactly the one who cannot pay in full —
  an all-or-nothing repair would turn the node that salvages a bad run into the
  node that turns it away.

  Below 5% of the price it refuses instead, and the node is not consumed: a
  garage is a whole map node, and spending it to be handed two points of
  Durability is worse than being turned away while you can still go elsewhere.
  `tools/economy-probe.mjs` holds the rule at 100/75/50/25% and the refusal.

  A skill upgrade is the exception and stays all-or-nothing — priced from the
  skill's rarity, rising with each rank down a branch. A rank is discrete and
  there is no half of one to sell. It refuses for free, which is why the garage
  needed an exit that costs nothing.
- **Pits** are in; see below.

Greedy-shopper surplus: **3.6x → 2.7x**, under the target of 3. The probe holds
a ratchet, now at 3.0, rather than failing at a target it has met — a suite that
always fails is a suite nobody reads. The number to watch is the one it prints.

Two things the measurement itself turned up, both worth remembering:

- `finishRace` did `Math.max(0, racer.durability)`, which is NaN for a racer
  that reports none. It sat quietly inside the car for as long as nothing
  priced against durability, and the moment the garage did, it ate the wallet.
- the probe's walker never damaged its car, so the repair sink it was measuring
  could not open. **A probe that does not exercise the thing it measures
  reports whatever it likes.**

## Pits: pay time and money, mid-race — built

A garage, a fuel stop, an armourer — sitting on the circuit rather than between
races, taking scrap in exchange for putting the car back together.

**Built.** `src/race/pits.js`, `tools/pit-probe.mjs`, and a dedicated pit lane
in `generateTrack`. What follows is the reasoning, and then what was actually
decided where it differs.

**Not a pause and not a menu.** A race that stops so you can shop is a race
that stops: you spend, you resume in the same position, and it cost nothing. A
pit works in racing games because it costs *time*, and the interesting question
is whether the seconds are worth it.

**The branches looked like the right shape, and were not.** A shortcut leaves
the racing line and rejoins it, has geometry, painted chevrons and warning
arrows. But putting pits on whichever branches came out *longer* than the line
they left covered only **44% of circuits**, and a service the player cannot
count on is one they never plan a run around.

So the pit lane is generated deliberately, like a real circuit's: the
straightest 190 m stretch that is clear of the other branches and of the grid,
offset to the outside of whatever bend remains, tapered in and out around a
parallel middle. Every circuit has exactly one. Three numbers came out of
measuring rather than choosing:

- the **outside** of the bend, because the offset is measured along the road's
  normal but the clearance that matters is the perpendicular distance back — on
  the inside of a bend those differ, and offsetting inward ate the margin and
  put two lanes in sixty on the racing line;
- **190 m** rather than 150, because at 150 every lane's entry pinched to a
  40-50 m radius, which no car holds at the limiter's speed: the corner
  governed the lane and the limiter was decoration;
- **19 m/s** (68 km/h) for the limiter, because the tightest taper any
  generated lane has will hold about 76.

The limiter itself is `body.speedCap`, which caps `maxSpeedNow()` *and* brakes
a car that is over it at 14 m/s² — capping the top speed alone only stops the
car pulling harder, and drag here is deliberately small, so a car arriving at
220 would have coasted most of the lane.

Measured cost of a stop: **5.1 s** against staying on the line, and that is a
floor — both cars in the comparison start at the limiter's speed.

Steering into one is the consent. You cannot end up in a pit lane by accident
the way you can drive over a pickup; you have to aim for it, which is what lets
it take money without ever asking a question at 180 km/h. If the scrap is not
there, it does what it can afford rather than refusing — a wasted detour is a
harsh enough punishment for not checking.

The three the game already has the machinery for:

  Fuel      refills Energy, which is what skills spend
  Garage    repairs Durability, which today only recovers between races
  Armourer  clears cooldowns, or refunds skill uses

The middle one fixes something real: durability is only recoverable in the
garage node, so a race that starts badly cannot be salvaged from inside it.

**What is beside the lane.** A workshop and its dressing — tyres at a mechanic,
drums at a fuel stop, crates at an armoury — placed outboard, clear of the rail
as well as the tarmac. Without it the lane was somewhere the money went with
nothing there to have taken it.

### The structural problem, and what was chosen

**The race does not know the run.** `Race` is constructed with `playerBuild`,
not with `Run`, and `scrap` lives on `Run` alone. That separation is deliberate
and it is what makes `tools/balance.mjs` trustworthy: it drives `RaceSim` with
no renderer, no effects and no run wrapped around it, and it is therefore
honest about what the game does.

So a pit that charges scrap needs a channel that does not break that. The
options, and the trade in each:

- **An optional wallet handed to `Race`** (`{ balance, spend }`). Small, and
  `RaceSim` stays ignorant. But a balance run with no wallet has pits that
  behave differently from the played game, and the runs stop measuring it.
- **Scrap modelled inside `RaceSim`**, seeded from the run and read back after.
  Keeps the balance runs honest, at the cost of putting an economy into the
  layer that has carefully avoided having one.
- **Settle after the race.** Simplest, and the decision loses its bite: you
  cannot overspend if the bill arrives later.

**The second was chosen.** `RaceSim` holds `scrap`, seeded from
`config.scrap` and read back through `Run.spendInRace` in `_onRaceOver`. A
balance run seeds nothing and therefore has a pit nobody can afford, which is a
true statement about a car with no money rather than a different set of rules.

### What is left

- **The AI never pits.** `Driver` follows the racing line and has no notion of
  branches at all, so the lane is a player-only decision and the field never
  gives up five seconds for a repair. Fine for now; it means a stop always
  costs places, which is the honest reading, but a rival that pits when it is
  wrecked would make the field read as racing rather than as pace-setting.
- **The armoury is only worth taking with a skill on a long cooldown**, which
  is correct but narrow. It is already excluded from circuits where the build
  carries no skills at all.
- **Nothing accounts for pit spending in `tools/economy-probe.mjs`**, which
  does not race. The surplus figure therefore still ignores the newest sink.

---

## The effects are placeholders and read like it

Everything that happens to a car looks like the same thing happening: a burst
of particles at a point. There are seven presets in the whole game — spark,
fire, electric, boost, smoke, tireSmoke, debris — and every event picks one and
throws a handful of them.

What a hit currently is, in full: four to twenty-eight sparks, forty per cent
as much debris, and five puffs of smoke if it was hard. That is the same recipe
whether the car clipped a barrier at 40 km/h or was rammed at 200, whether it
was hit from behind or T-boned, and whether it hit a wall, a barrel or another
car. Strength scales the *count*, and nothing else.

The ones worth doing, roughly in order of how much each is missing:

- **Impact.** Should differ by what was hit and from where. A wall wants a
  scrape — sparks dragged along the direction of travel, not a spherical burst
  — and metal on metal wants a flash the barrier does not get. The direction of
  the blow is already computed for the physics and thrown away by the effect.
- **Damage.** The car now has visible states and torn panels, and the moment it
  crosses one is unmarked. Panels leaving, glass going, a puff from the bay as
  the threshold is crossed — the state machine already fires at exactly the
  right instant.
- **Nitro.** One additive plume at the back at a fixed rate. It should build,
  it should shake the frame, and it should end — the speed blur and the chroma
  in the composite already exist and are driven by speed alone; the boost is
  the one moment worth pushing them past what speed asks for.
- **Wheels.** Tyre smoke exists and is decent, but nothing throws dirt when a
  car drops a wheel off the tarmac, and the surfaces already say what they are
  (`gravel`, `sand`, `ice`).
- **Skills.** Fifteen of them share three presets between them. An EMP and a
  Cryo Burst look the same but blue.

Two things worth deciding before building rather than after. The particle
budget is a quality tier and already tight — 260 on Low — so richer effects
mean fewer of them rather than more, and the split between the additive and
alpha clouds is already 70/30. And a lot of what is missing is not particles at
all: a scrape wants a decal, a boost wants the camera, and an impact wants a
frame of screen shake, which is the cheapest of the three and the one this
project has none of.

---

## Crates: what is in them next

The first slice is in — cosmetics that persist, a crate for finishing a
tournament, and a locker to wear them from. What it does not have yet, in the
order it was asked for:

- **Wheels and rims as shapes**, not only as a tint. The hub is generated
  geometry, so a different spoke count is a different builder rather than a
  different colour — real work, and the most visible of what is left.
- **Spoilers and wings.** The chassis already reshapes from stats (Top Speed
  adds a wing), so the vocabulary exists; a cosmetic wing means separating that
  from the stat that currently drives it.
- **Glass tints.** `hullGlassMat` is one unlit near-black material per car, so
  this one is nearly free — the reason it is not done is that a tint bright
  enough to see fights the "windows must be black" the roster was just fixed to.
- **Whole cars.** `STARTER_VEHICLE_IDS` has sat in `vehicles.js` since the
  roster was written and nothing gates on it. Turning it on means *removing*
  access to three cars the player has today, so it wants deciding rather than
  doing.
- **Multiplayer**, which is what the crates were asked for in service of, and
  which nothing here has been built against.

One thing to hold on to: crates pay only for finishing a tournament, and only
cosmetics. Both halves matter. Paying for a loss makes it an attendance prize,
and anything in a crate that changes how a car drives makes run twenty start
stronger than run one — which is the thing a roguelike cannot survive.

---

## The frame timer measures the wrong thing

**The 85% Kanzen is gone, and it was not this that fixed it.** The entry that
used to be here said `tools/balance.mjs` reported the Kanzen 1.6 winning around
85% of races. It now wins 4%, and the spread across the roster is 4–25%.
Measured deliberately with the slipstream disabled, so this is not the tow
flattening it — something between then and now already had. The tow does help:
with it the spread closes to 4–17%, because a car that runs away can now be
reeled back in. Nothing here needs doing; the number is recorded so the next
person does not go hunting a problem that has been solved.

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
