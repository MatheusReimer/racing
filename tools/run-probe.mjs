// Plays complete runs, start to finish, with no browser.
//
// This is the one test that exercises the actual product: three regions of
// node choices, races, rewards, shops, events and bosses, with a car whose
// condition carries across all of it. Everything else validates a component;
// this validates that a run is a thing you can finish.
//
// It also answers the design question the brief cares most about — whether a
// run produces a *build* rather than a pile — by reporting the tag composition
// of the finished machine.
//
//   node tools/run-probe.mjs [runs] [--vehicle=drifter] [--verbose]

import { Run } from '../src/run/run.js';
import { RaceSim } from '../src/race/sim.js';
import { generateMap } from '../src/run/nodemap.js';
import { VEHICLES } from '../src/data/vehicles.js';
import { RNG } from '../src/core/rng.js';

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => /^\d+$/.test(a)) || 12);
const VERBOSE = args.includes('--verbose');
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const ONLY = opt('vehicle', null);

// --- map structure gate ----------------------------------------------------
// Run before anything else: an unreachable node or a mandatory Elite is a
// structural bug that would only show up as a stuck player.
{
  let mapProblems = 0;
  for (let i = 0; i < 200; i++) {
    const map = generateMap(`MAP${i}`, i % 3);

    // Reachability forward from the start.
    const seen = new Set([map.start]);
    const queue = [map.start];
    while (queue.length) {
      const n = queue.pop();
      for (const m of n.next) if (!seen.has(m)) { seen.add(m); queue.push(m); }
    }
    const unreachable = map.nodes.filter((n) => !seen.has(n));
    if (unreachable.length) {
      console.log(`MAP FAIL seed ${i}: ${unreachable.length} unreachable node(s)`);
      mapProblems++;
    }

    // Reachability backward from the boss.
    const back = new Set([map.boss]);
    const q2 = [map.boss];
    while (q2.length) {
      const n = q2.pop();
      for (const m of n.prev) if (!back.has(m)) { back.add(m); q2.push(m); }
    }
    const deadEnds = map.nodes.filter((n) => !back.has(n));
    if (deadEnds.length) {
      console.log(`MAP FAIL seed ${i}: ${deadEnds.length} dead-end node(s)`);
      mapProblems++;
    }

    // No row may force an Elite as the only option.
    for (const row of map.rows) {
      if (row.length === 1 && row[0].type === 'elite') {
        console.log(`MAP FAIL seed ${i}: forced Elite at row ${row[0].row}`);
        mapProblems++;
      }
    }

    // A shop must exist before the boss.
    if (!map.nodes.some((n) => n.type === 'shop')) {
      console.log(`MAP FAIL seed ${i}: no shop anywhere in the region`);
      mapProblems++;
    }
  }
  console.log(mapProblems === 0
    ? '200/200 maps structurally valid\n'
    : `\n${mapProblems} map problem(s)\n`);
}

// --- play runs -------------------------------------------------------------

const vehicles = ONLY ? [ONLY] : VEHICLES.map((v) => v.id);
const results = [];
const errors = [];

const origError = console.error;
console.error = (...a) => errors.push(a.join(' '));

for (let i = 0; i < RUNS; i++) {
  const vehicleId = vehicles[i % vehicles.length];
  const seed = `RUN${1000 + i}`;
  const run = new Run({ seed, vehicleId });
  const rng = new RNG(`${seed}:choices`);

  let guard = 0;
  const log = [];

  while (run.state !== 'dead' && run.state !== 'victory' && guard++ < 200) {
    if (run.state === 'map') {
      const opts = run.availableNodes();
      if (opts.length === 0) { log.push('STUCK: no available nodes'); break; }
      // Choose the way a player might: prefer shops when hurt or rich,
      // otherwise take the interesting node.
      const hurt = run.durabilityFrac < 0.5;
      const pref = hurt ? ['rest', 'shop', 'event', 'race', 'challenge', 'elite']
        : ['elite', 'challenge', 'shop', 'event', 'race', 'rest'];
      const node = opts.slice().sort(
        (a, b) => pref.indexOf(a.type) - pref.indexOf(b.type),
      )[0];
      const cfg = run.choose(node);

      if (run.state === 'race' && cfg) {
        const sim = new RaceSim({
          seed: cfg.seed,
          biome: cfg.biome,
          playerBuild: run.build,
          config: {
            laps: cfg.laps, rivals: cfg.rivals, difficulty: cfg.difficulty,
            rivalArchetypes: cfg.rivalArchetypes, lengthScale: cfg.lengthScale,
          },
        });
        // Carry the car's condition into the race, and back out again.
        sim.player.durability = run.durability;
        sim.player.maxDurability = run.maxDurability;
        sim.setAutopilot(true, cfg.difficulty);
        const res = sim.runToCompletion(1 / 60, 400);
        if (res.outcome === 'timeout') log.push(`TIMEOUT at ${node.type}`);
        run.finishRace(res, sim.player);
        log.push(`${node.type}:P${res.place ?? '-'}`);
      }
    } else if (run.state === 'reward') {
      const offer = run.offer;
      if (offer && offer.length) {
        // Play like a person building something: prefer an offer that shares
        // tags with what is already equipped. Picking uniformly at random
        // measures the floor, not whether the system can produce an identity.
        const scored = offer.map((o) => {
          let score = rng.range(0, 0.8);
          for (const t of o.tags || []) if (run.build.hasTag(t)) score += 1.4;
          if (o.kind === 'skill' && o.upgrade) score += 1.0;
          return { o, score };
        }).sort((a, b) => b.score - a.score);
        const r = run.takeOffer(scored[0].o);
        if (!r.ok) run.skipOffer();
      } else {
        run.skipOffer();
      }
    } else if (run.state === 'shop') {
      let bought = 0;
      for (const item of run.shopStock) {
        if (bought >= 2) break;
        if (item.sold || item.disabled) continue;
        if (run.scrap < item.price) continue;
        if (run.durabilityFrac < 0.6 && item.kind !== 'repair') continue;
        if (run.buy(item).ok) bought++;
      }
      run.leaveShop();
    } else if (run.state === 'event') {
      const ev = run.currentEvent;
      run.resolveEvent(rng.int(0, ev.choices.length - 1));
    } else if (run.state === 'rest') {
      // Both jobs cost scrap and both can refuse — a whole car has nothing to
      // repair, an upgrade may be out of reach — so the walker has to be able
      // to walk away, exactly as the player can.
      let done = false;
      if (run.durabilityFrac < 0.75 || run.build.skills.length === 0) {
        done = run.restRepair().ok;
      } else {
        const up = run.build.skills.find((s) => (s.level ?? 1) < (s.maxLevel ?? 5));
        const branch = up?.branches?.find((b) => (up.picks?.[b.id] ?? 0) < (b.maxRank ?? 3));
        if (up) done = run.restUpgrade(up.id, branch?.id ?? null).ok;
        if (!done) done = run.restRepair().ok;
      }
      if (!done) run.leaveRest();
    } else {
      break;
    }
  }

  const sum = run.summary();
  results.push({ ...sum, guard, log });

  const status = run.state === 'victory' ? 'WIN ' : run.state === 'dead' ? 'DIED' : 'HUNG';
  console.log(
    `${status} ${seed}  ${sum.vehicle.padEnd(12)} ` +
    `regions ${sum.regionsCleared}/3  races ${String(sum.races).padStart(2)}  ` +
    `wins ${sum.wins}  parts ${String(sum.parts.length).padStart(2)}  ` +
    `skills ${sum.skills.length}  scrap ${String(sum.scrap).padStart(4)}  ` +
    `theme [${sum.theme.join(' ')}]`,
  );
  if (VERBOSE) console.log('      ' + log.join(' → '));
}

console.error = origError;

// --- summary ---------------------------------------------------------------

const wins = results.filter((r) => r.outcome === 'victory').length;
const died = results.filter((r) => r.outcome === 'destroyed').length;
const hung = results.filter((r) => r.outcome === 'in progress').length;
const q = (v, f) => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0;
};

console.log(`\n${RUNS} runs: ${wins} completed, ${died} destroyed, ${hung} hung`);
console.log(`  races per run   p50 ${q(results.map((r) => r.races), 0.5)}  max ${q(results.map((r) => r.races), 1)}`);
console.log(`  parts collected p50 ${q(results.map((r) => r.parts.length), 0.5)}  max ${q(results.map((r) => r.parts.length), 1)}`);
console.log(`  regions cleared p50 ${q(results.map((r) => r.regionsCleared), 0.5)}`);

// The design question: does a run produce a build with an identity, or a pile?
const themed = results.filter((r) => {
  const top = r.theme[0];
  if (!top) return false;
  return Number(top.split('x')[1]) >= 3;
}).length;
console.log(`  runs with a dominant theme (3+ shared tags): ${themed}/${RUNS}`);

const problems = [];
if (hung > 0) problems.push(`${hung} run(s) hung — a run must always reach an end state`);
if (wins === 0) problems.push('no run was ever completed — the game may be unwinnable');
if (died === 0 && RUNS >= 8) problems.push('no run was ever lost — there is no pressure');
if (errors.length) problems.push(`${errors.length} hook error(s)`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p);
  for (const e of [...new Set(errors)].slice(0, 6)) console.log('  ! ' + e.slice(0, 180));
  process.exit(1);
}
// --- a full skill loadout is a decision, not a wall -------------------------
//
// There was no `removeSkill` and `pickSkill` filtered the catalogue down to
// skills already held once the slots were full — so from the third pickup on, a
// run was never shown a new skill again. It failed silently: the offers still
// arrived, they were just always the same three skills levelling up, and
// nothing in the game said so.
{
  const { SKILLS, SKILL_BY_ID, instantiateSkill } = await import('../src/data/skills.js');
  const { generateOffer } = await import('../src/run/rewards.js');
  const bad = [];

  const full = () => {
    const run = new Run({ seed: 'swap-probe', vehicleId: 'hatch' });
    const held = SKILLS.filter((s) => !run.build.skills.some((h) => h.id === s.id));
    while (run.build.canAddSkill()) run.build.addSkill(instantiateSkill(held.shift().id, 1));
    return run;
  };

  // With room, taking never asks.
  {
    const run = new Run({ seed: 'swap-probe', vehicleId: 'hatch' });
    const id = SKILLS.find((s) => !run.build.skills.some((h) => h.id === s.id)).id;
    const res = run.takeOffer({ kind: 'skill', id, skill: SKILL_BY_ID[id], name: SKILL_BY_ID[id].name });
    if (!res.ok || res.needsSlot) bad.push('asked for a slot when one was free');
  }

  // Full, and an unheld skill: it asks, and the build is untouched until it is
  // answered — a question that half-applies is worse than a refusal.
  {
    const run = full();
    const before = run.build.skills.map((s) => s.id).join(',');
    const id = SKILLS.find((s) => !run.build.skills.some((h) => h.id === s.id)).id;
    const ask = run.takeOffer({ kind: 'skill', id, skill: SKILL_BY_ID[id], name: SKILL_BY_ID[id].name });
    if (!ask.needsSlot) bad.push('did not ask which skill to drop');
    if (run.build.skills.map((s) => s.id).join(',') !== before) bad.push('changed the build before being answered');

    const drop = run.build.skills[1].id;
    const done = run.takeOffer(
      { kind: 'skill', id, skill: SKILL_BY_ID[id], name: SKILL_BY_ID[id].name }, { drop });
    if (!done.ok) bad.push('the swap itself failed');
    if (run.build.skills.some((s) => s.id === drop)) bad.push('the dropped skill is still fitted');
    if (!run.build.skills.some((s) => s.id === id)) bad.push('the new skill was not fitted');
    if (run.build.skills.length !== run.build.skillSlots) bad.push('slot count changed');
  }

  // Full, but levelling something already held: never asks.
  {
    const run = full();
    const id = run.build.skills[0].id;
    const res = run.takeOffer({ kind: 'skill', id, skill: SKILL_BY_ID[id], name: SKILL_BY_ID[id].name, upgrade: true });
    if (res.needsSlot) bad.push('asked for a slot to level a skill already carried');
  }

  // And the offers keep showing unheld skills when full, which is the bug that
  // made all of the above unreachable.
  {
    const run = full();
    let sawNew = 0;
    for (let i = 0; i < 200; i++) {
      const offer = generateOffer(new RNG(`offer-${i}`), run.build, {});
      for (const o of offer) {
        if (o.kind === 'skill' && !run.build.skills.some((h) => h.id === o.id)) sawNew++;
      }
    }
    if (sawNew === 0) bad.push('a full loadout is never offered a new skill');
  }

  console.log('\nA full skill loadout can still be changed:\n');
  console.log(`  ${bad.length ? 'FAIL ' + bad.join('; ') : 'ok — asks, waits, swaps, and keeps offering'}`);
  if (bad.length) process.exit(1);
}

console.log('\nruns are completable and lossable');
