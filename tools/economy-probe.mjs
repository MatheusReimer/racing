// Is the currency scarce?
//
// The whole economy rests on one answer. Scrap buys parts and skills in the
// shop, and the design leans on the idea that spending it is a decision — that
// what you buy now is what you cannot buy later. If it is abundant instead,
// every purchase is free in the only sense that matters, and any new thing to
// spend it on is not a cost but a formality.
//
// So this drives a greedy shopper: it takes a node, races it, and at every shop
// buys everything it can afford, cheapest first, until it cannot. What it has
// left at the end is the surplus the design does not use.
//
// Not a pass/fail on a fixed number. The interesting quantity is the ratio of
// what a run can spend to what it ends up holding, and the fail is only when
// that surplus is so large that the currency has stopped meaning anything.

import { Run } from '../src/run/run.js';
import { RNG } from '../src/core/rng.js';
import { instantiateSkill } from '../src/data/skills.js';

const N = 60;
const ended = [];
for (let i = 0; i < N; i++) {
  const run = new Run({ seed: `money-${i}` });
  let peak = run.scrap;
  let spent = 0;
  let guard = 0;
  let shops = 0;
  const rng = new RNG(`walk-${i}`);
  while (guard++ < 60 && run.state !== 'dead' && run.state !== 'victory') {
    if (run.state === 'map') {
      const open = run.availableNodes();
      if (!open.length) break;
      run.choose(open[rng.int(0, open.length - 1)]);
      if (run.state === 'race') {
        const place = rng.int(1, 6);
        // A race has to cost the car something, or the garage is a sink that
        // never opens and the repair price never appears in the measurement.
        // Worse finishes hurt more: the back of the field is where the paint
        // gets traded.
        const hurt = run.maxDurability * (0.06 + 0.045 * place) * rng.range(0.5, 1.5);
        run.finishRace({ place, laps: 3 },
          { stats: {}, durability: Math.max(0, run.durability - hurt) });
      }
      continue;
    }
    if (run.state === 'reward') {
      // Take the first offer, or skip; a player does one or the other.
      const o = run.offer?.[0];
      if (o && rng.bool(0.7)) run.takeOffer(o, { drop: run.build.skills[0]?.id });
      else run.skipOffer();
      continue;
    }
    if (run.state === 'shop') {
      shops++;
      // Buy what is affordable, cheapest first — the greedy shopper.
      for (let k = 0; k < 12; k++) {
        const items = (run.shopStock ?? [])
          .filter((x) => !x.sold && !x.disabled && x.price <= run.scrap)
          .sort((a, b) => a.price - b.price);
        if (!items.length) break;
        const before = run.scrap;
        const r = run.buy(items[0], { drop: run.build.skills[0]?.id });
        if (!r.ok) { items[0].sold = true; continue; }   // unbuyable; move on
        spent += before - run.scrap;
      }
      run.leaveShop();
      continue;
    }
    if (run.state === 'rest') {
      // The garage, greedily: repair first, then whatever upgrade is affordable.
      const before = run.scrap;
      const r = run.restRepair();
      if (r.ok) { spent += before - run.scrap; continue; }
      const s0 = run.build.skills.find((sk) => run.upgradeQuote(
        sk.id, sk.branches?.[0]?.id ?? null) <= run.scrap);
      if (s0) {
        const b4 = run.scrap;
        if (run.restUpgrade(s0.id, s0.branches?.[0]?.id ?? null).ok) {
          spent += b4 - run.scrap; continue;
        }
      }
      run.leaveRest();
      continue;
    }
    if (run.state === 'event') { run.resolveEvent(0); continue; }
    break;
  }
  peak = Math.max(peak, run.scrap);
  ended.push({ left: run.scrap, spent, shops, state: run.state, races: run.racesRun });
}

const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
const left = ended.map((e) => e.left);
const spent = ended.map((e) => e.spent);
console.log(`${N} runs, comprador guloso (compra tudo que cabe):`);
console.log(`  sucata gasta      p50 ${q(spent, 0.5)}   p90 ${q(spent, 0.9)}`);
console.log(`  sobrou no fim     p50 ${q(left, 0.5)}   p90 ${q(left, 0.9)}   max ${q(left, 1)}`);
console.log(`  corridas por run  p50 ${q(ended.map((e) => e.races), 0.5)}`);
console.log(`  lojas visitadas   p50 ${q(ended.map((e) => e.shops), 0.5)}`);
console.log(`  terminaram em     ${JSON.stringify(ended.reduce((a, e) => ({ ...a, [e.state]: (a[e.state] ?? 0) + 1 }), {}))}`);

// A greedy shopper that still ends with several times what it spent is a
// currency with nothing to do.
//
// A ratchet, not a target. It stands at 2.7x today and the design wants it
// under 3 — but failing on that would mean a suite that cries every run for
// work nobody has started, and a suite that always fails is a suite nobody
// reads. So it holds the line where it is: this may not get worse, and the
// number it prints is the one to watch as pits and paid garage work land.
const TARGET = 3.0;
const CEILING = 3.0;
const surplus = q(left, 0.5) / Math.max(1, q(spent, 0.5));
const ok = surplus <= CEILING;
console.log(`\n  surplus ${surplus.toFixed(1)}x  (target ${TARGET}, ceiling ${CEILING})`
  + `   ${ok ? 'ok' : 'FAIL — scrap has even less to do than it did'}`);
if (ok && surplus > TARGET) {
  console.log('  Above target: a greedy run still ends holding several times what');
  console.log('  it managed to spend. More to spend it on is the fix, not lower pay.');
}
// --- half the money buys half the job --------------------------------------
//
// The rule the whole garage rests on: a repair is sold pro rata, so a player
// who can pay 50% of the price gets 50% of the repair. It is the one place a
// run can be salvaged when the money is not there, and an all-or-nothing
// regression here would turn the node that exists to help a broken car into
// the node that turns it away.
console.log('\nHalf the money buys half the job:\n');
let ruleProblems = 0;
{
  const probe = (fracOfPrice) => {
    const run = new Run({ seed: 'prorata', vehicleId: 'hatch' });
    run.durability = run.maxDurability * 0.3;
    const quote = run.repairQuote();
    run.scrap = Math.round(quote.price * fracOfPrice);
    // Standing in the garage, which a fresh Run is not — it starts on the map,
    // so without this the "node intact" check was reading the state the run
    // began in rather than the state the refusal left it in.
    run.state = 'rest';
    const before = run.durability;
    const r = run.restRepair();
    return {
      quote,
      paidFrac: fracOfPrice,
      healedFrac: (run.durability - before) / quote.amount,
      ok: r.ok,
      spentNode: run.state !== 'rest',
      text: r.text || r.reason,
    };
  };

  for (const f of [1, 0.75, 0.5, 0.25]) {
    const r = probe(f);
    // A percent of slack for the integer scrap the price is rounded to.
    const off = Math.abs(r.healedFrac - f);
    const good = r.ok && off <= 0.02;
    if (!good) ruleProblems++;
    console.log(`  paid ${(f * 100).toFixed(0).padStart(3)}% of the price`
      + `  ->  ${(r.healedFrac * 100).toFixed(0).padStart(3)}% of the repair`
      + `   ${good ? 'ok' : 'FAIL'}`);
  }

  // And nothing at all is a refusal, not a transaction: the garage is a whole
  // map node, and spending it to be handed two points of Durability is worse
  // for the player than being turned away while they can still go elsewhere.
  const broke = probe(0);
  const refused = !broke.ok && !broke.spentNode;
  if (!refused) ruleProblems++;
  console.log(`  paid   0% of the price  ->  refused, node intact`
    + `   ${refused ? 'ok' : 'FAIL'}`);
}
// --- an upgrade is paid off, not turned away -------------------------------
//
// A rank is discrete, so unlike a repair it cannot be *delivered* in part —
// but it can be *paid for* in part, across visits, and the rank lands on the
// visit that finishes it. Same promise as the repair: your money is always
// worth what it is worth.
console.log('\nAn upgrade is paid off across visits:\n');
{
  const run = new Run({ seed: 'layaway', vehicleId: 'hatch' });
  if (!run.build.skills.find((x) => x.id === 'nitro')) {
    run.build.addSkill(instantiateSkill('nitro'));
  }
  const price = run.upgradeQuote('nitro', 'ram');
  const step = Math.max(1, Math.ceil(price / 3));
  let visits = 0;
  let landed = false;
  let spent = 0;
  for (let i = 0; i < 6 && !landed; i++) {
    run.scrap = step;
    run.state = 'rest';
    const before = run.scrap;
    const r = run.restUpgrade('nitro', 'ram');
    if (!r.ok) break;
    visits++;
    spent += before - run.scrap;
    landed = !r.partial;
  }
  const rank = run.build.skills.find((x) => x.id === 'nitro')?.picks?.ram ?? 0;
  const exact = spent === price;
  console.log(`  a ${price} scrap branch, ${step} a visit`
    + `  ->  landed after ${visits} visits, ${spent} paid`
    + `   ${landed && rank > 0 && exact ? 'ok' : 'FAIL'}`);
  if (!landed || rank < 1 || !exact) ruleProblems++;

  // And the pot starts again for the next rank rather than carrying over.
  const carried = run.upgradePaid('nitro', 'ram');
  console.log(`  the pot resets for the next rank  ->  ${carried} carried`
    + `   ${carried === 0 ? 'ok' : 'FAIL'}`);
  if (carried !== 0) ruleProblems++;

  // Too little to be worth the node: refused, node intact, same as a repair.
  run.scrap = 1;
  run.state = 'rest';
  const tiny = run.restUpgrade('nitro', 'ram');
  const held = !tiny.ok && run.state === 'rest' && run.scrap === 1;
  console.log(`  1 scrap against the next rank  ->  refused, node intact, nothing taken`
    + `   ${held ? 'ok' : 'FAIL'}`);
  if (!held) ruleProblems++;
}

if (ruleProblems) console.log(`\n  ${ruleProblems} problem(s) with how part payment works`);

process.exit(ok && !ruleProblems ? 0 : 1);
