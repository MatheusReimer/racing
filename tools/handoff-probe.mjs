// Does a race that ends hand control back?
//
// When a race finishes, `RaceSim.update` returns early and `Input.enabled` is
// set false — the car freezes completely and deliberately. Control is only
// returned when the reward screen appears, which happens inside a `setTimeout`
// in a handler dispatched through the EventBus.
//
// The EventBus catches and logs handler exceptions rather than letting them
// propagate, so anything that throws on the way to that screen leaves the
// player looking at a frozen car with no UI and no error — indistinguishable
// from "I lost control of the car".
//
// This drives real races to their real end, in real time, and asserts that a
// screen appears and input comes back.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';

const RACES = Number(process.argv[2] || 3);
const server = await ensureServer();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(`[console] ${t}`);
  // The EventBus logs swallowed handler failures through console.error.
  if (t.includes('[events] handler')) errors.push(`[swallowed] ${t}`);
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game, { timeout: 20000 });

const check = (ok, name, detail = '') =>
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);

let failures = 0;

for (let i = 0; i < RACES; i++) {
  // Start a real run and take the first node, so the whole run pipeline is in
  // play — not a sandbox race that skips it.
  await page.evaluate(() => {
    const g = window.__game;
    g.showTitle();
  });
  // The title screen is the machine screen itself — one car at a time, walked
  // with the arrows. It used to be a roster of cards and this waited for one;
  // the cards went and this probe sat here for ten seconds and threw.
  await page.waitForSelector('.stage-nav.next', { timeout: 10000 });
  await page.click('.stage-nav.next');
  await page.waitForTimeout(150);
  await page.click('.stage-nav.next');
  await page.waitForTimeout(150);
  await page.click('.screen-foot .btn.primary');
  await page.waitForSelector('.mapnode.available', { timeout: 10000 });
  await page.click('.mapnode.available');
  await page.waitForSelector('.screen-foot .btn.primary', { timeout: 10000 });
  await page.click('.screen-foot .btn.primary');
  await page.waitForFunction(() => window.__game.scene?.state === 'racing', { timeout: 20000 });

  // Autopilot so the race actually completes, then fast-forward the simulation
  // *through the real update path* rather than skipping to the end state.
  await page.evaluate(() => window.__game.scene.setAutopilot(true, 1));

  const laps = await page.evaluate(() => window.__game.scene.config.laps);

  const outcome = await page.evaluate(() => new Promise((resolve) => {
    const g = window.__game;
    let guard = 0;
    const tick = () => {
      const sc = g.scene;
      if (!sc) return resolve({ ok: true, note: 'scene torn down' });
      // Advance in real-ish chunks so timers and handlers run normally.
      for (let i = 0; i < 40 && sc.state !== 'finished'; i++) sc.update(1 / 60, null);
      if (sc.state === 'finished') return resolve({ ok: true, finished: true });
      if (guard++ > 900) return resolve({ ok: false, note: 'race never finished' });
      requestAnimationFrame(tick);
    };
    tick();
  }));

  if (!outcome.ok) { failures++; check(false, `race ${i + 1} completes`, outcome.note); continue; }

  // The frozen window: state is 'finished', input is off, and the reward screen
  // is on a 1.4 s timer. Sample through it.
  const frozen = await page.evaluate(() => ({
    raceState: window.__game.scene?.state ?? null,
    inputEnabled: window.__game.input.enabled,
    hasScreen: !!document.querySelector('.screen'),
  }));
  check(frozen.raceState === 'finished' && !frozen.inputEnabled,
    `race ${i + 1} freezes on finish (expected)`,
    `state=${frozen.raceState} input=${frozen.inputEnabled}`);

  // Wait past the deliberate delay, then control must be back in the player's
  // hands one way or another: a screen to click, or a live car.
  await page.waitForTimeout(2600);
  const after = await page.evaluate(() => {
    const g = window.__game;
    return {
      runState: g.run?.state ?? null,
      hasScreen: !!document.querySelector('.screen'),
      screenTitle: document.querySelector('.screen-title')?.textContent
        ?? document.querySelector('.result-hero .big')?.textContent ?? null,
      cards: document.querySelectorAll('.card').length,
      inputEnabled: g.input.enabled,
      hasScene: !!g.scene,
      loopRunning: g.loop.running,
    };
  });

  const handedBack = after.hasScreen || after.inputEnabled;
  if (!handedBack) failures++;
  check(handedBack, `race ${i + 1} hands control back`,
    `run=${after.runState} screen="${after.screenTitle}" cards=${after.cards} `
    + `input=${after.inputEnabled} loop=${after.loopRunning}`);

  // And the screen must be an actionable one, not an empty frame.
  if (after.hasScreen) {
    const actionable = await page.evaluate(() =>
      document.querySelectorAll('.card, .choice, .btn, .mapnode.available').length);
    if (actionable === 0) failures++;
    check(actionable > 0, `race ${i + 1} screen is actionable`, `${actionable} controls`);
  }
}

await browser.close();
server.stop();

if (errors.length) {
  console.log(`\n${errors.length} error(s) — including anything the EventBus swallowed:`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e.slice(0, 260));
  failures += errors.length;
}

console.log('');
if (failures) {
  console.log(`${failures} failure(s): a finished race can leave the player frozen.`);
  process.exit(1);
}
console.log('every finished race hands control back');
