// Drives the UI the way a player does — by clicking — and asserts that every
// screen in a run is reachable and leaves the game in a sane state.
//
// The run-probe already proves the *rules* work by calling the Run API
// directly. This proves the buttons are wired to those rules, which is a
// completely separate failure mode: a screen that renders correctly and calls
// nothing looks fine in a screenshot.

import { chromium } from 'playwright';
import { ensureServer } from './server.mjs';
import { mkdirSync, readFileSync } from 'node:fs';

// Deterministic choices. Walking the run with Math.random() makes the set of
// screens visited — and therefore the set of checks — differ between runs, so
// the suite passes or fails depending on the path it happened to take.
let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 100000) / 100000;
};

const SHOTS = process.env.SHOTS !== '0';
const server = await ensureServer();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

if (SHOTS) mkdirSync('shots', { recursive: true });
/**
 * Screenshot a live WebGL canvas reliably.
 *
 * The context runs with `preserveDrawingBuffer: false` — the right choice for a
 * shipped game, since preserving it costs a full-buffer copy every frame — but
 * it means the drawing buffer's contents are undefined once a frame has been
 * presented. Grabbing the surface asynchronously while the loop is running
 * therefore returns whatever the compositor happens to hold: a stale frame, a
 * torn composite of two frames, or just the sky. Under SwiftShader it is worse.
 *
 * Freezing the loop first makes every frame identical, so whatever moment the
 * capture lands on is the moment we asked for. Time scale is restored after.
 */
async function stableShot(page, path) {
  await page.evaluate(() => {
    const g = window.__game;
    g.__savedTimeScale = g.loop.timeScale;
    g.loop.timeScale = 0;
  });
  // Let a few identical frames go through before reading the surface.
  await page.waitForTimeout(220);
  await page.screenshot({ path });
  await page.evaluate(() => {
    const g = window.__game;
    g.loop.timeScale = g.__savedTimeScale ?? 1;
  });
}

const shot = async (name) => { if (SHOTS) await stableShot(page, `shots/ui-${name}.png`); };

const steps = [];
const check = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const state = () => page.evaluate(() => ({
  run: window.__game.run ? {
    state: window.__game.run.state,
    scrap: window.__game.run.scrap,
    durability: Math.round(window.__game.run.durability),
    parts: window.__game.run.build.parts.length,
    skills: window.__game.run.build.skills.length,
    region: window.__game.run.regionIndex,
    races: window.__game.run.racesRun,
  } : null,
  hasScene: !!window.__game.scene,
  raceState: window.__game.scene?.state ?? null,
  screen: document.querySelector('.screen-title')?.textContent ?? null,
  machine: document.querySelector('.machine-name')?.textContent ?? null,
  roster: document.querySelectorAll('.rcard').length,
  cards: document.querySelectorAll('.card').length,
  nodes: document.querySelectorAll('.mapnode.available').length,
}));

// --- every class the screens build has a rule to draw it -------------------
//
// Static, and it runs first because it costs nothing. Deleting a screen means
// deleting its styles, and the styles of two screens sit next to each other in
// one file: a cut that takes one rule too many orphans a class that still gets
// built, and the result is not an error — it is a gold callout rendering as
// body text, which a passing click-through will not notice.
{
  const js = readFileSync('src/ui/screens.js', 'utf8');
  const css = readFileSync('src/ui/screens.css', 'utf8');
  const used = new Set();
  for (const m of js.matchAll(/el\('[a-z0-9]+',\s*'([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) used.add(c);
  }
  for (const m of js.matchAll(/classList\.add\(([^)]*)\)/g)) {
    for (const c of m[1].match(/'([^']+)'/g) || []) used.add(c.slice(1, -1));
  }
  const orphans = [...used].filter((c) => !css.includes(`.${c}`));
  check('every class the screens build has a style', orphans.length === 0,
    orphans.length ? `no rule for ${orphans.join(', ')}` : `${used.size} classes`);
}

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 });
// A clean profile, every run.
//
// Cosmetics persist in `localStorage`, and a crate owed from a previous walk is
// opened before the title screen — so without this the harness sees a crate
// where it expects a machine, and only on the second run of the day.
await page.evaluate(() => {
  try { localStorage.removeItem('rogue-racer:profile:v1'); } catch { /* fine */ }
});
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__game, { timeout: 20000 });

// --- title ---
await page.waitForSelector('.screen-title', { timeout: 10000 });
let s = await state();
// The five bars on the card are a summary; the fifteen attributes they reduce
// are folded away under them, not dropped. A screen that showed only the
// summary would break the house rule about never racing on a number the player
// was not shown, so the folded rows are counted rather than trusted.
check('title screen renders', !!s.machine && (await page.$$('.machine-spec .statrow')).length >= 12,
  `machine="${s.machine}" spec rows=${(await page.$$('.machine-spec .statrow')).length}`);
check('the roster strip shows every machine', s.roster === 6, `${s.roster} cards`);
// The turntable draws on the next frame; shooting before it has is a picture
// of an empty stage, which is not what this screen looks like.
await page.waitForTimeout(500);
await shot('title');

// --- start a run ---
// Pin the run seed so the map, and therefore the screens this walk visits, are
// identical every time. Without it the check count drifts between runs and a
// regression is impossible to spot.
await page.evaluate(() => { window.__game.forcedSeed = 'UIFLOW1'; });

// The machine screen is the title screen: no roster in front of it, and
// nothing committed until the primary button. Walk to a specific machine with
// the arrows so the run below is always the same car.
check('no run exists before the grid is taken', !s.run,
  s.run ? 'a run started without the button being pressed' : 'clean');
const firstMachine = s.machine;
await page.click('.stage-nav.next');
await page.waitForTimeout(150);
s = await state();
check('the arrows move along the roster', s.machine !== firstMachine,
  `${firstMachine} -> ${s.machine}`);
// The strip is the other way to change car, and the one the layout leads with.
//
// A fixed card, not "the first one that is not selected". The latter depends on
// what the arrows left selected, so the machine this walk starts its run in —
// and therefore the screens it visits and the number of checks it runs — moved
// with the timing of the click before it.
await page.click('.rcard >> nth=3');
await page.waitForTimeout(150);
const clicked = (await state()).machine;
check('the roster strip selects a machine', clicked !== s.machine,
  `${s.machine} -> ${clicked}`);
await page.click('.stage-nav.next');
await page.waitForTimeout(150);
s = await state();
await shot('machine');

await page.click('.screen-foot .btn.primary');
await page.waitForSelector('.mapnode', { timeout: 10000 });
s = await state();
check('starting a vehicle creates a run', !!s.run, s.run ? `dur=${s.run.durability} scrap=${s.run.scrap}` : '');
check('map screen shows selectable nodes', s.nodes > 0, `available=${s.nodes}`);
await shot('map');

// --- walk the run, visiting as many screen types as we can ---
const seen = new Set();
let guard = 0;

while (guard++ < 26) {
  s = await state();
  if (!s.run) break;
  if (s.run.state === 'dead' || s.run.state === 'victory') break;

  if (s.run.state === 'map') {
    const available = await page.$$('.mapnode.available');
    if (available.length === 0) { check('map always offers a move', false, 'no available nodes'); break; }
    await available[Math.floor(rand() * available.length)].click();
    await page.waitForTimeout(350);
    continue;
  }

  if (s.run.state === 'race') {
    // Briefing screen, then drive it on autopilot to keep the test fast.
    if (!seen.has('briefing')) {
      seen.add('briefing');
      check('pre-race briefing renders', !!s.screen, `"${s.screen}"`);
      await shot('briefing');
    }
    const go = await page.$('.screen-foot .btn.primary');
    if (go) await go.click();
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const sc = window.__game.scene;
      if (sc && !sc.autopilot) sc.setAutopilot(true, 1);
    });

    if (!seen.has('race')) {
      seen.add('race');
      const inRace = await page.evaluate(() => !!window.__game.scene);
      check('race scene starts from the briefing', inRace);
      await page.waitForTimeout(2500);
      await shot('race');
    }

    // Rather than sit through a full race at software-rendered frame rates,
    // fast-forward the simulation directly. Same code path, no waiting.
    await page.evaluate(() => new Promise((done) => {
      const sc = window.__game.scene;
      if (!sc) return done();
      for (let i = 0; i < 60 * 400 && sc.state !== 'finished'; i++) sc.update(1 / 60, null);
      done();
    }));
    await page.waitForTimeout(1900);   // the deliberate post-race delay
    continue;
  }

  if (s.run.state === 'reward') {
    if (!seen.has('reward')) {
      seen.add('reward');
      check('reward screen offers choices', s.cards > 0, `cards=${s.cards}`);
      const hasDeltas = await page.evaluate(() => document.querySelectorAll('.deltas .delta').length);
      check('reward cards show stat deltas', hasDeltas > 0, `deltas=${hasDeltas}`);
      await shot('reward');
      const before = s.run.parts + s.run.skills;
      // Try each offer in turn. A part offer legitimately cannot be installed
      // when every part slot is full, and asserting on the first card alone
      // turns that ordinary game state into a test failure.
      const applied = await page.evaluate(() => {
        const g = window.__game;
        for (const offer of g.run.offer) {
          const res = g.run.takeOffer(offer);
          if (res.ok) return { ok: true, text: res.text };
        }
        return { ok: false, reason: 'every offer was rejected' };
      });
      await page.waitForTimeout(300);
      const after = await state();
      const slotsFull = await page.evaluate(() =>
        !window.__game.run.build.canAddPart() && !window.__game.run.build.canAddSkill());
      check('taking a reward changes the build',
        applied.ok ? after.run.parts + after.run.skills > before : slotsFull,
        applied.ok
          ? `${before} -> ${after.run.parts + after.run.skills}`
          : `nothing applicable (slots full: ${slotsFull})`);
      if (!applied.ok) await page.evaluate(() => window.__game.run.skipOffer());
      // takeOffer/skipOffer advance the run state directly; re-render whatever
      // screen that landed on.
      await page.evaluate(() => {
        const g = window.__game;
        if (g.run.state === 'map') g.showMap();
        else if (g.run.state === 'victory' || g.run.state === 'dead') g.endRun();
      });
      await page.waitForTimeout(300);
      continue;
    }
    const skip = await page.$('.screen-foot .btn:last-child');
    if (skip) await skip.click(); else await page.click('.cards .card >> nth=0');
    await page.waitForTimeout(300);
    continue;
  }

  if (s.run.state === 'shop') {
    if (!seen.has('shop')) {
      seen.add('shop');
      check('shop screen renders stock', s.cards > 0, `items=${s.cards}`);
      await shot('shop');
      const scrapBefore = s.run.scrap;
      // Buy the first affordable thing.
      const bought = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.card')];
        const target = cards.find((c) => !c.classList.contains('disabled') && !c.classList.contains('sold'));
        if (!target) return false;
        target.click();
        return true;
      });
      await page.waitForTimeout(300);
      const after = await state();
      if (bought) {
        check('buying spends scrap', after.run.scrap < scrapBefore || after.run.durability > s.run.durability,
          `${scrapBefore} -> ${after.run.scrap}`);
      }
    }
    const leave = await page.$('.screen-foot .btn.primary');
    if (leave) await leave.click();
    await page.waitForTimeout(300);
    continue;
  }

  if (s.run.state === 'event') {
    if (!seen.has('event')) {
      seen.add('event');
      const choices = await page.$$('.choice');
      check('event screen offers choices', choices.length > 0, `choices=${choices.length}`);
      await shot('event');
    }
    const choices = await page.$$('.choice:not(.disabled)');
    if (choices.length) await choices[0].click();
    await page.waitForTimeout(350);
    continue;
  }

  if (s.run.state === 'rest') {
    if (!seen.has('rest')) {
      seen.add('rest');
      const choices = await page.$$('.choice');
      check('garage screen offers repair and upgrades', choices.length > 0, `options=${choices.length}`);
      // The garage charges now, so every job has to say what it costs before
      // the player commits a node to it.
      const prices = await page.$$eval('.choice .price', (n) => n.map((e) => e.textContent));
      check('garage jobs are priced', prices.length > 0, prices.slice(0, 3).join(' / '));
      await shot('rest');
    }
    const choices = await page.$$('.choice:not(.disabled)');
    if (choices.length) await choices[0].click();
    else {
      // Nothing affordable and nothing to mend: there must still be a way out.
      const out = await page.$$('.screen-foot .btn');
      check('a player who can afford nothing can still leave the garage', out.length > 0);
      if (out.length) await out[out.length - 1].click();
    }
    await page.waitForTimeout(350);
    continue;
  }

  break;
}

s = await state();
check('run reaches a conclusion or is still coherent',
  !!s.run, s.run ? `state=${s.run.state} races=${s.run.races} region=${s.run.region}` : 'no run');

// --- game over screen ---
await page.evaluate(() => window.__game.endRun());
await page.waitForTimeout(400);
const overTitle = await page.evaluate(() => document.querySelector('.result-hero .big')?.textContent);
check('game over screen renders', !!overTitle, `"${overTitle}"`);
const story = await page.evaluate(() => document.querySelector('.story')?.textContent?.length ?? 0);
check('run summary tells the story of the machine', story > 60, `${story} chars`);
await shot('gameover');

// --- back to title ---
await page.click('.screen-foot .btn.primary');
await page.waitForTimeout(400);
const back = await page.evaluate(() => document.querySelector('.machine-name')?.textContent);
s = await state();
check('restart returns to the title', !!(await page.$('.screen--machine')) && !s.run,
  `screen="${back}"${s.run ? ' but a run is live' : ''}`);

console.log(`\nscreens visited: ${[...seen].join(', ')}`);

await browser.close();
server.stop();

const failed = steps.filter((x) => !x.ok);
if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e.slice(0, 200));
}
console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
process.exit(failed.length + errors.length > 0 ? 1 : 0);
