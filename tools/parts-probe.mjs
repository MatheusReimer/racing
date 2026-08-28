// Validates every part, then races each one.
//
// Three separate failure modes, all of which have to be caught mechanically
// because 60 parts is past the point where reading them catches anything:
//
//   1. Schema  — a bad slot, an unknown rarity, a hook name that is never
//                dispatched. A mistyped hook is silent: the part simply never
//                does anything, and no error is ever raised.
//   2. Crashes — a hook that throws is caught and logged by Build, so a broken
//                part degrades into an invisible no-op rather than a failure.
//   3. Inertness — a part that runs without error and still changes nothing.
//
// The third is the one that matters most and is hardest to see by eye.

import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { BIOMES } from '../src/data/biomes.js';
import { PARTS, SLOTS, RARITY } from '../src/data/parts.js';
import { HOOKS } from '../src/build/build.js';
import { instantiateSkill } from '../src/data/skills.js';
import { ATTRIBUTE_IDS } from '../src/stats/attributes.js';
import { MOD_IDS } from '../src/stats/statblock.js';

const HOOK_SET = new Set(HOOKS);
const ATTR_SET = new Set(ATTRIBUTE_IDS);
const MOD_SET = new Set(MOD_IDS);

let schemaErrors = 0;
const ids = new Set();

console.log(`Validating ${PARTS.length} parts...\n`);

for (const p of PARTS) {
  const errs = [];
  if (ids.has(p.id)) errs.push('duplicate id');
  ids.add(p.id);
  if (!SLOTS[p.slot]) errs.push(`unknown slot "${p.slot}"`);
  if (!RARITY[p.rarity]) errs.push(`unknown rarity "${p.rarity}"`);
  if (!p.text) errs.push('no text');
  if (!p.tags || p.tags.length === 0) errs.push('no tags (nothing can synergise with it)');

  for (const k of Object.keys(p.stats || {})) {
    if (!ATTR_SET.has(k)) errs.push(`stats."${k}" is not an attribute`);
  }
  for (const k of Object.keys(p.mods || {})) {
    if (!MOD_SET.has(k)) errs.push(`mods."${k}" is not a mod channel`);
  }
  for (const k of Object.keys(p.hooks || {})) {
    if (!HOOK_SET.has(k)) errs.push(`hooks.${k} is not a dispatched hook`);
  }
  if (!p.stats && !p.mods && !p.hooks) errs.push('does nothing at all');

  // A part above common needs to pose a question. A hook or a mod does that;
  // so does a genuine trade-off, which is why a big downside counts. What is
  // not allowed is a rare that is simply better than a common.
  if (!p.hooks && !p.mods && p.rarity !== 'common' && p.rarity !== 'cursed') {
    const worst = Math.min(0, ...Object.values(p.stats || {})
      .map((v) => (typeof v === 'number' ? v : (v.pct || 0) + (v.flat || 0) / 100)));
    if (worst > -0.15) {
      errs.push(`${p.rarity} with no hook, no mod and no real downside — strictly better than a common`);
    }
  }

  if (errs.length) {
    schemaErrors += errs.length;
    console.log(`SCHEMA ${p.id}: ${errs.join('; ')}`);
  }
}

if (schemaErrors === 0) console.log('schema: all parts valid\n');
else console.log('');

// --- race every part -------------------------------------------------------

const caught = [];
const origError = console.error;
console.error = (...a) => { caught.push(a.join(' ')); };

const RACES = 4;
const rows = [];

for (const part of PARTS) {
  let crashed = 0;
  const before = caught.length;
  let statDelta = 0;
  let dealt = 0, taken = 0, kills = 0, wins = 0, deaths = 0;

  for (let i = 0; i < RACES; i++) {
    const build = new Build(part.slot === 'chassis' ? 'gt' : 'coupe');
    // Give it skills so weapon/energy parts have something to act on.
    build.addSkill(instantiateSkill('rocket', 3));
    build.addSkill(instantiateSkill('nitro', 3));
    build.addSkill(instantiateSkill('mine', 3));

    const baseline = { ...build.stats.all() };
    build.addPart(part);
    const after = build.stats.all();
    for (const id of ATTRIBUTE_IDS) statDelta += Math.abs(after[id] - baseline[id]);

    const sim = new RaceSim({
      seed: `PART-${part.id}-${i}`,
      biome: BIOMES[i % BIOMES.length],
      playerBuild: build,
      config: { laps: 2, rivals: 5, difficulty: 1 },
    });
    sim.setAutopilot(true, 1);
    const res = sim.runToCompletion(1 / 60, 300);

    const p = sim.player;
    dealt += p.stats.damageDealt;
    taken += p.stats.damageTaken;
    kills += p.stats.kills;
    if (res.outcome === 'finished' && res.place === 1) wins++;
    if (res.outcome === 'destroyed') deaths++;
    if (res.outcome === 'timeout') crashed++;

    if (!Number.isFinite(p.body.x) || !Number.isFinite(p.body.speed)) {
      caught.push(`${part.id}: produced non-finite physics`);
    }
  }

  const hookErrors = caught.length - before;
  rows.push({
    part, statDelta: statDelta / RACES, dealt: dealt / RACES, taken: taken / RACES,
    kills: kills / RACES, wins, deaths, hookErrors, crashed,
  });
}

console.error = origError;

// --- report ---------------------------------------------------------------

const problems = [];
for (const r of rows) {
  if (r.hookErrors > 0) problems.push(`${r.part.id}: hook threw ${r.hookErrors}x`);
  if (r.crashed > 0) problems.push(`${r.part.id}: ${r.crashed} race(s) never finished`);
  // Inert check: no stat movement, no mods, and no hook is suspicious.
  const hasMods = r.part.mods && Object.keys(r.part.mods).length > 0;
  const hasHooks = r.part.hooks && Object.keys(r.part.hooks).length > 0;
  if (r.statDelta < 0.01 && !hasMods && !hasHooks) {
    problems.push(`${r.part.id}: inert (no stats, no mods, no hooks)`);
  }
  // A hook that exists but is empty is worse than none — it reads as content.
  if (hasHooks) {
    for (const [name, fn] of Object.entries(r.part.hooks)) {
      const src = fn.toString().replace(/\s/g, '');
      if (/^\(?\w*\)?=>\{\}$/.test(src) || /function\w*\(\)\{\}/.test(src)) {
        problems.push(`${r.part.id}: hook ${name} is an empty stub`);
      }
    }
  }
}

const bySlot = {};
for (const r of rows) (bySlot[r.part.slot] ||= []).push(r);

for (const [slot, list] of Object.entries(bySlot)) {
  console.log(`\n${SLOTS[slot].name.toUpperCase()}`);
  for (const r of list.sort((a, b) => b.wins - a.wins)) {
    console.log(
      `  ${r.part.id.padEnd(22)} ${r.part.rarity.padEnd(10)} ` +
      `Δstat ${r.statDelta.toFixed(0).padStart(4)}  ` +
      `dealt ${r.dealt.toFixed(0).padStart(4)}  taken ${r.taken.toFixed(0).padStart(4)}  ` +
      `kills ${r.kills.toFixed(1)}  ${r.wins}/${RACES}W ${r.deaths}D` +
      (r.hookErrors ? `  ERRORS:${r.hookErrors}` : ''),
    );
  }
}

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p);
}
if (caught.length) {
  console.log(`\nfirst hook errors:`);
  for (const c of [...new Set(caught)].slice(0, 8)) console.log('  ' + c.slice(0, 160));
}
if (!problems.length && !caught.length && !schemaErrors) console.log('all parts valid and active');

process.exit(problems.length + caught.length + schemaErrors > 0 ? 1 : 0);
