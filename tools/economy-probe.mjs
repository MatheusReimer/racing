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
process.exit(ok ? 0 : 1);
