# The prompt

> quero que voce faça um clone disso Death Roads: Tournament. Seguindo as guias
> dadas aqui https://github.com/mshumer/Claude-of-Duty com esse pitch
> Rogue Racer — Game Design Proposal
> [...50 sections of design document...]

Followed by the same technical bar the referenced repository sets: Three.js
r180 on WebGL2 as the only runtime dependency, everything an engine would
normally hand you written by hand on top of the renderer, zero art assets, all
audio synthesised live with the Web Audio API, and a Playwright harness for
headless capture.

## The one question worth asking

The brief contained a genuine fork rather than an ambiguity of wording.

*Death Roads: Tournament* is a **deckbuilder**: you play cards to change lane,
brake, and ram. The Rogue Racer pitch describes **real-time physics** — grip,
drift, braking distance, mass, collisions at 100 km/h — and section 3.3
explicitly rejects a "drive → stop → fight → drive" loop. Sections 10 through
24 define fifteen attributes that only mean anything if a car is being
simulated continuously.

Those are two different games, so it was put to the user directly rather than
guessed at. The answer was real-time driving, at full vertical-slice scope.
Death Roads therefore informs the *genre* — a roguelike where the race is the
combat, with a node map, rival archetypes and bosses — and the pitch defines
the mechanics.

A second question covered scope: MVP (section 47) versus vertical slice versus
the full section 48 vision. The answer was the vertical slice, so all fifteen
attributes are in, not the five the MVP calls for.

## Everything else is inference

The design document is unusually specific about intent, and where it states a
principle this repository tries to obey it literally rather than
approximately:

- **"Trade-offs reais"** (§3.2) — the `Overclocked Engine` in `data/parts.js`
  carries the exact numbers the document gives as its example.
- **"Itens não devem ser apenas stat sticks"** (§30) — `tools/parts-probe.mjs`
  fails the build if a part above Common has no hook, no mod channel, and no
  real downside.
- **"Drift não deve ser simplesmente Grip negativo"** (§13) — Drift buys slide
  control, momentum retention and Energy payout; breaking traction is a fixed
  mechanical effect of the handbrake. The distinction is enforced in
  `stats/attributes.js` and measured by `tools/physics-probe.mjs`.
- **The Electric Grenade's five levels** (§31) are implemented clause for
  clause, including level 5 detonating what level 4 chained to.
- **"Every run should create a machine with a story"** (§50) — the end-of-run
  screen describes what the car became, and `tools/run-probe.mjs` reports how
  many runs actually developed a dominant theme, because a north star that is
  not measured is decoration.

## What the tools are for

The design brief asks for sixty-plus parts that interact. That is well past the
point where reading the content catches mistakes, so most of the engineering
effort here went into being able to *ask the game questions*:

- `physics-probe` — does an attribute produce the handling it promises?
- `track-probe` — is every generated circuit closed, drivable and non-crossing?
- `combat-probe` — does every skill actually land, at every level?
- `parts-probe` — is any part inert, broken, or silently mistyped?
- `balance` — across hundreds of races, is any vehicle unplayable?
- `run-probe` — can a run be finished, can it be lost, and does it produce a build?
- `uiflow` — are the buttons wired to the rules?

Splitting `RaceSim` from `Race` exists to serve those: the simulation carries no
rendering, so a few hundred complete races run in plain Node in seconds instead
of a minute each through a browser.

## What the user asked for mid-build

> alguma chance de nao usarmos 100% da cpu toda hora? podemos manter uns 80-90

This arrived while `core/loop.js` was being written and shaped it. The result is
a measured CPU budget rather than a hopeful one: see the *CPU budget* section of
`ARCHITECTURE.md`.
