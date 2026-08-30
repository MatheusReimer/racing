# Rogue Racer

An action roguelike racer in the browser. Build a machine over a run of races
and find out how far that particular machine can get.

Everything is voxel. Cars, buildings, scenery and the ground are built as cells
on a grid — nothing is sampled onto one from smooth geometry, because sampling
gives back the shape it was given.

Three.js r180 on WebGL2 is the only runtime dependency. There are no art
assets: every texture, mesh and sound is generated at load or synthesised live.

```
npm install
npm run dev          # http://127.0.0.1:5173
```

## Controls

```
W / S       throttle / brake (S reverses from a stop)
A / D       steer
SHIFT       handbrake — breaks traction on demand
SPACE       nitrous — held, not tapped; refills from drifting and near misses
1 - 4       skills
C           look back
F1          performance overlay (fps, frame time, CPU utilisation, quality tier)
F2          cycle quality tier manually
```

A gamepad works if one is connected: left stick steers, triggers are throttle
and brake, either shoulder button is the handbrake, and X / left bumper is
nitrous.

### When the car stops answering, the game says why

If something is taking control away from you, it is named on screen under the
car rather than left for you to guess at — `WEDGED — hold S to reverse out`,
`NO GRIP`, `SPUN`, `WRONG WAY`, `OFF TRACK`, `AIRBORNE`, `STUNNED`, or
`RUNNING SLOW` when the machine cannot keep up with real time. The states are
ordered, so the most important reason is the one shown.

Two guarantees behind that readout: no loss-of-control episode lasts longer than
you can recover from, and a car that ends up off the road always gets back to
racing — by driving out, or by being put back on the line after nine unbroken
seconds off the surface. `tools/control-probe.mjs` measures both.

## What a run is

Pick one of six vehicles, each of which is a different question rather than a
different set of numbers. Then work through three regions of a node map —
races, elites, shops, events, garages and challenges — collecting parts and
skills, and finish each region's boss.

Your **Durability does not reset between races.** That is the spine of the mode:
every race costs something, and how you spend scrap between them is most of the
decision.

A run is 30–60 minutes and around fourteen races.

## What makes a build

Fifteen attributes, in four groups:

| | |
|---|---|
| **Movement** | Top Speed, Acceleration, Grip, Drift, Turning, Braking |
| **Physical** | Weight, Impact |
| **Survival** | Armor, Durability, Energy, Heat Capacity |
| **Combat** | Weapon Power, Weapon Control, Luck |

Sixty parts and fifteen skills sit on top of them. What makes it a build rather
than a pile is **tags**: parts read the tags of your whole machine, so
`Storm Engine` boosts every Electric source you will ever pick up, including
ones you find later. Rewards are weighted toward tags you already carry, so
committing to a direction produces more of that direction to commit to.

Some examples of the loop closing:

- **Drift → Energy → Skills.** Holding a clean slide pays Energy; `Lightning
  Tires` discharge it into whoever is nearest; `Storm Conductor` turns every 60
  drift-Energy into a lightning strike.
- **Heat as fuel.** `Overheated Engine` raises top speed with Heat.
  `Thermal Tap` converts Heat into Energy. `Meltdown Core` turns hitting
  Critical into a blast instead of damage. The build wants to live at 90%.
- **Low HP as a resource.** `Berserker Bumper` scales Impact with missing
  Durability; `Death's Door` doubles damage below 30%; `Vampiric Plating` heals
  you for ramming, which pulls you back out.

Skill levels change identity, not just numbers. The Electric Grenade gains a
lingering field at 2, electrifies at 3, chains at 4, and at 5 detonates what it
chained to.

## Regions

Each biome changes what the generator produces, not just the palette.

| | |
|---|---|
| **The Wasteland** | Wide and readable. Where a run learns to drive. |
| **Industrial City** | Narrow, busy. Turning and Braking outrank Top Speed. |
| **The Long Desert** | Open, fast, real air off the crests. |
| **Frozen Highway** | Ice on the racing line. Grip stops being reliable and Drift becomes the answer. |
| **Inferno** | Leaving the road costs Durability, continuously. |

## Tools

Everything below runs headless and exits non-zero on failure. Together they are
how the game was built: with sixty interacting parts, reading the content stops
catching mistakes.

```
npm run playtest              # full races in a browser, player on autopilot
npm run balance               # complete races in plain Node — ~10/second
npm run capture shots/x.png   # screenshot, with console errors as a failure

node tools/physics-probe.mjs  # does each attribute produce the handling it promises?
node tools/track-probe.mjs 200 # every circuit closed, drivable, non-crossing?
node tools/combat-probe.mjs   # does every skill land, at level 1 and level 5?
node tools/parts-probe.mjs    # is any part inert, broken, or mistyped?
node tools/run-probe.mjs 12   # can a run be finished, and lost, and does it build?
node tools/uiflow.mjs         # are the buttons wired to the rules?
node tools/progress-probe.mjs # is lap progress monotonic? does the rescue stay out of the way?

npm run drive                 # plays a race with the keyboard, screenshotting each stage
npm run garage                # renders the six vehicles side by side
npm run garage builds         # one chassis pushed to each build archetype
npm run probe                 # the whole suite
```

`run-probe` reports the thing the design is actually aiming at: how many runs
ended up with a machine that has an identity.

```
WIN  RUN1010  The Gambler  regions 3/3  races 14  wins 2  parts 6  skills 4
             theme [Energy x6  Drift x3  Electric x3]
```

## Cars

About 29.7k triangles each — a six-car field is ~178k, which is nothing for
WebGL2. Faceted flat shading throughout, colour in vertex attributes, three draw
calls per car regardless of how much detail is added.

```
node tools/tris.mjs              # triangle budget per car, by part
node tools/garage.mjs            # the six starting vehicles, side by side
node tools/garage.mjs single     # one car, close and near the ground
HIDE_BODY=1 node tools/garage.mjs single   # what sits under the paint
```

`HIDE_BODY` / `HIDE_WHEELS` / `HIDE_GLASS` / `HIDE_TRIM` / `EYE` / `YAW` apply in
`single` mode only; `vehicles` mode has a fixed camera and layout.

## The map

Scenery is placed in bands measured out from the road edge, and built at three
detail levels: full up to 70 m, reduced to 200 m, silhouettes to 480 m. Nothing
is placed on the racing surface.

```
node tools/props-probe.mjs       # per-biome prop counts, LOD split, budgets
```

The probe asserts the racing surface stays clear, that the near band is not
empty, and that the horizon is populated.

## Performance

The game holds a **CPU budget rather than consuming what is available**. Frame
time is measured against the interval it intends to hold, and a governor moves a
quality tier — render scale, bloom, shadows, particle budget, draw distance — to
keep utilisation near 85%. Simulation is fixed at 60 Hz; presentation is capped
at 60 fps racing and 30 in menus, which is most of the saving, since a run
spends real time on the map.

Press **F1** to watch it work.

Quality can be pinned by hand with **F2**, which disables automatic steering.

## Reading the code

`ARCHITECTURE.md` documents the subsystem contracts and, more usefully, the
decisions whose cost is not obvious — why the velocity is recomposed on the old
basis, why cornering has two independent limits, why the composite pass converts
its own colour space, and why smoke may not be additive.

`prompt.md` is the brief this was built from, and the one design question that
was genuinely worth asking before starting.

## Licence

MIT.
