import { ATTRIBUTES, ATTRIBUTE_BY_ID, GROUPS } from '../stats/attributes.js';
import { NODE_TYPES } from '../run/nodemap.js';
import { RARITY, SLOTS } from '../data/parts.js';
import { VEHICLES, VEHICLE_BY_ID } from '../data/vehicles.js';
import { SKILL_BY_ID } from '../data/skills.js';
import { Build } from '../build/build.js';
import { clamp01 } from '../core/math.js';

// Every screen that is not the in-race HUD.
//
// These are built as DOM on demand and torn down on exit, which is the right
// trade here: they are shown between races, not during, so construction cost
// is invisible and the alternative (keeping seven screens live and hidden)
// leaks state between visits.
//
// One rule runs through all of them: never show a number without showing what
// it does to the build. A reward card that says "+25% Top Speed" is data; one
// that also shows the resulting stat bars moving, and highlights the tags you
// already carry, is a decision.

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Tag chips, highlighting the ones the build already runs. */
function tagRow(tags, build) {
  const row = el('div', 'tags');
  for (const t of tags || []) {
    const owned = build?.hasTag(t);
    row.appendChild(el('span', `tag${owned ? ' owned' : ''}`, esc(t)));
  }
  return row;
}

/**
 * Stat deltas a reward would cause. Computed by previewing the StatBlock, so
 * the numbers shown are exactly the numbers that will apply — not an estimate
 * maintained in parallel.
 */
function deltaRow(offer, build) {
  if (offer.kind !== 'part') return null;
  const preview = build.stats.preview(offer.part.name, offer.part.stats, offer.part.mods);
  const diff = preview.diffFrom(build.stats);
  const keys = Object.keys(diff);
  if (keys.length === 0) return null;

  const row = el('div', 'deltas');
  for (const id of keys.slice(0, 6)) {
    const d = diff[id];
    const attr = ATTRIBUTE_BY_ID[id];
    // Weight is genuinely bidirectional; never paint it as a loss.
    const cls = attr.higherIsBetter === null ? 'neutral' : (d > 0) === attr.higherIsBetter ? 'up' : 'down';
    row.appendChild(el('span', `delta ${cls}`,
      `${attr.name.split(' ')[0]} ${d > 0 ? '+' : ''}${Math.round(d)}`));
  }
  return row;
}

function offerCard(offer, build, onPick) {
  const card = el('button', `card r-${offer.rarity || 'common'}`);
  const head = el('div', 'card-head');
  head.appendChild(el('span', 'card-name', esc(offer.name)));
  const slotLabel = offer.kind === 'part' ? SLOTS[offer.slot]?.name
    : offer.kind === 'skill' ? 'Skill' : '';
  head.appendChild(el('span', 'card-slot', esc(slotLabel)));
  card.appendChild(head);
  card.appendChild(el('div', 'card-text', esc(offer.text)));
  if (offer.tags) card.appendChild(tagRow(offer.tags, build));
  const d = deltaRow(offer, build);
  if (d) card.appendChild(d);
  // The same affordance the roster cards carry: a card is a button, and
  // nothing on it said so but the cursor.
  const foot = el('div', 'card-foot');
  foot.appendChild(el('span', 'card-price',
    offer.price != null ? `${offer.price} scrap` : ''));
  foot.appendChild(el('span', 'card-go', offer.price != null ? 'Buy' : 'Take'));
  card.appendChild(foot);
  if (offer.disabled) card.classList.add('disabled');
  if (offer.sold) card.classList.add('sold');
  card.onclick = () => { if (!offer.disabled && !offer.sold) onPick(offer); };
  return card;
}

/** The persistent build readout shown alongside the map. */
function buildPanel(run) {
  const p = el('div', 'build-panel');
  const stats = run.build.stats.all();

  p.appendChild(el('h3', null, `${esc(run.build.vehicle.name)}`));

  for (const group of Object.values(GROUPS)) {
    const attrs = ATTRIBUTES.filter((a) => a.group === group.id);
    p.appendChild(el('h3', null, esc(group.name)));
    for (const a of attrs) {
      const row = el('div', 'statrow');
      row.appendChild(el('span', 'nm', esc(a.name)));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      // 250 is the visual ceiling: past that the bar saturates rather than
      // rescaling everything else into invisibility.
      fill.style.width = `${clamp01(stats[a.id] / 250) * 100}%`;
      fill.style.background = group.accent;
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'vl', String(Math.round(stats[a.id]))));
      p.appendChild(row);
    }
  }

  p.appendChild(el('h3', null, `Parts (${run.build.parts.length}/${run.build.partSlots})`));
  if (run.build.parts.length === 0) p.appendChild(el('div', 'itemline', '<span class="empty">Nothing installed</span>'));
  for (const part of run.build.parts) {
    const line = el('div', 'itemline');
    line.appendChild(el('span', 'nm', esc(part.name)));
    const rr = el('span', 'rr', esc(RARITY[part.rarity].name));
    rr.style.color = RARITY[part.rarity].color;
    line.appendChild(rr);
    p.appendChild(line);
  }

  p.appendChild(el('h3', null, `Skills (${run.build.skills.length}/${run.build.skillSlots})`));
  if (run.build.skills.length === 0) p.appendChild(el('div', 'itemline', '<span class="empty">No skills equipped</span>'));
  for (const s of run.build.skills) {
    const line = el('div', 'itemline');
    line.appendChild(el('span', 'nm', `${s.icon || ''} ${esc(s.name)}`));
    line.appendChild(el('span', 'rr', `Lv${s.level ?? 1}`));
    p.appendChild(line);
  }

  const themes = [...run.build.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (themes.length) {
    p.appendChild(el('h3', null, 'Identity'));
    const row = el('div', 'tags');
    for (const [t, n] of themes) {
      row.appendChild(el('span', `tag${n >= 2 ? ' owned' : ''}`, `${esc(t)} ×${n}`));
    }
    p.appendChild(row);
  }

  return p;
}

function runBar(run) {
  const bar = el('div', 'runbar');
  const dur = Math.round(run.durability);
  const max = Math.round(run.maxDurability);
  // Labelled, and the seed pushed to the far end. It read as four unlabelled
  // pairs separated by hairlines, which is a legend you have to learn; the
  // seed in particular is the one thing here nobody needs mid-run and it sat
  // second from the middle.
  bar.innerHTML =
    `<span><span class="k">Durability</span><b>${dur}/${max}</b></span>` +
    `<span><span class="k">Scrap</span><b>${run.scrap}</b></span>` +
    `<span><span class="k">Region</span><b>${run.regionIndex + 1}/${run.regionCount}</b></span>` +
    `<span class="seed"><span class="k">Seed</span><b>${esc(run.seed)}</b></span>`;
  return bar;
}

/**
 * The chrome every screen shares: a status strip, a heading, a scrolling body,
 * a footer with a hint on the left and actions on the right, and optionally the
 * build panel down the side.
 *
 * The panel is a grid column. It used to be an absolutely positioned box with
 * `paddingRight` written by hand onto the header, the body and the footer —
 * the same layout stated three times, in inline styles, in the wrong language.
 * Anything that changed its width had to change four places, the footer's rule
 * ran under it, and on a narrow window it claimed a third of the screen.
 *
 * `foot.actions` is where buttons go; appending straight to `foot` still works
 * and lands them on the right, which is where they were.
 */
function frame(title, sub, run, { withPanel = false, centred = false } = {}) {
  const s = el('div', 'screen');
  if (withPanel && run) s.classList.add('has-panel');
  if (centred) s.classList.add('screen--centred');

  if (run) s.appendChild(runBar(run));

  const head = el('div', 'screen-head');
  if (title) head.appendChild(el('div', 'screen-title', esc(title)));
  if (sub) head.appendChild(el('div', 'screen-sub', esc(sub)));
  // A heading with nothing in it is 60px of padding above the content. The
  // end-of-run screen says DESTROYED in ninety-point type; it does not also
  // need "Run Over" in the corner saying the same thing smaller.
  if (head.childNodes.length) s.appendChild(head);

  const body = el('div', 'screen-body');
  s.appendChild(body);

  const foot = el('div', 'screen-foot');
  const hint = el('div', 'foot-hint');
  const actions = el('div', 'foot-actions');
  foot.appendChild(hint);
  foot.appendChild(actions);
  s.appendChild(foot);

  if (withPanel && run) s.appendChild(buildPanel(run));

  return { root: s, body, foot: actions, head, hint };
}

// ---------------------------------------------------------------------------

export class Screens {
  constructor(root) {
    this.root = root;
    this.el = null;
  }

  clear() {
    if (this.el) this.el.remove();
    this.el = null;
    // The showroom asks for this every frame to know where to draw; a stale one
    // would keep reporting the rectangle of a screen that is gone.
    this.showroomStage = null;
  }

  /**
   * Where the showroom should draw, in CSS pixels, or null if no screen is
   * offering it a stage. Measured live so a resize needs no bookkeeping.
   */
  showroomRect() {
    if (!this.showroomStage) return null;
    const b = this.showroomStage.getBoundingClientRect();
    return b.width > 8 && b.height > 8 ? b : null;
  }

  _show(node) {
    // A footer with nothing in it is a rule across the bottom of the screen and
    // nothing else. The event screen has no actions in its footer — its choices
    // are the actions — so it drew a stray line under an empty band.
    const foot = node.querySelector('.screen-foot');
    if (foot && !foot.querySelector('.btn')
      && !foot.querySelector('.foot-hint')?.textContent.trim()) {
      foot.remove();
    }
    this.clear();
    this.el = node;
    this.root.appendChild(node);
    return node;
  }

  toast(text) {
    const t = el('div', 'toast', esc(text));
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // --- title / vehicle select ----------------------------------------------

  title({ vehicleId, onStart, onSwitch, lastSummary }) {
    return this.machine(vehicleId, { onStart, onSwitch, lastSummary });
  }

  // --- one machine, in detail ----------------------------------------------

  /**
   * The screen between picking a machine off the roster and committing to it.
   *
   * A roster card that starts a run the moment it is clicked asks for the
   * decision before showing you what you are deciding: six cars at thumbnail
   * size, a paragraph each. This is the car at the size it deserves with its
   * whole specification beside it, and the run does not begin until you say
   * so. The arrows either side of it move along the roster, so comparing two
   * machines does not mean going back and forth through a menu.
   */
  machine(vehicleId, { onStart, onSwitch, lastSummary }) {
    const v = VEHICLE_BY_ID[vehicleId];
    const { root, body, foot, hint } = frame(v.name, v.tagline, null);
    root.classList.add('screen--machine');
    // The game's name, once, above the machine's. There is no longer a roster
    // screen in front of this one to carry it.
    root.querySelector('.screen-head')
      .prepend(el('div', 'screen-overline', 'Rogue Racer'));
    root.style.setProperty('--machine', v.accent || v.color);
    root.style.setProperty('--machine-body', v.color);

    const wrap = el('div', 'machine');
    const stage = el('div', 'machine-stage');

    // Along the roster without leaving the screen.
    const at = VEHICLES.findIndex((x) => x.id === v.id);
    for (const [dir, cls] of [[-1, 'prev'], [1, 'next']]) {
      const other = VEHICLES[(at + dir + VEHICLES.length) % VEHICLES.length];
      const b = el('button', `stage-nav ${cls}`, dir < 0 ? '‹' : '›');
      b.title = other.name;
      b.onclick = () => onSwitch(other.id);
      stage.appendChild(b);
    }
    wrap.appendChild(stage);

    const info = el('div', 'machine-info');
    info.appendChild(el('div', 'section-label', 'What it is'));
    info.appendChild(el('div', 'machine-identity', esc(v.identity)));
    if (v.rule) info.appendChild(el('div', 'rule', esc(v.rule.text)));

    // The whole specification, in absolutes, computed by the same StatBlock
    // the race will run on — not the deltas the card shows, which only say
    // what is unusual about this machine rather than what it actually is.
    const build = new Build(v.id);
    const stats = build.stats.all();
    info.appendChild(el('div', 'section-label', 'Specification'));
    for (const group of Object.values(GROUPS)) {
      const attrs = ATTRIBUTES.filter((a) => a.group === group.id);
      if (!attrs.length) continue;
      info.appendChild(el('h4', 'machine-group', esc(group.name)));
      for (const a of attrs) {
        const row = el('div', 'statrow');
        row.appendChild(el('span', 'nm', esc(a.name)));
        const bar = el('div', 'bar');
        const fill = el('div', 'fill');
        fill.style.width = `${clamp01(stats[a.id] / 250) * 100}%`;
        fill.style.background = group.accent;
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('span', 'vl', String(Math.round(stats[a.id]))));
        info.appendChild(row);
      }
    }

    info.appendChild(el('div', 'section-label', 'Loadout'));
    const slots = el('div', 'tally tally--tight');
    slots.innerHTML =
      `<div class="item"><div class="v">${build.partSlots}</div><div class="k">Part slots</div></div>`
      + `<div class="item"><div class="v">${build.skillSlots}</div><div class="k">Skill slots</div></div>`;
    info.appendChild(slots);

    const skill = SKILL_BY_ID[v.startingSkill];
    if (skill) {
      const line = el('div', 'machine-skill');
      line.appendChild(el('div', 'lbl', `${skill.icon || ''} ${esc(skill.name)}`));
      line.appendChild(el('div', 'det',
        esc(typeof skill.desc === 'function' ? skill.desc(1) : skill.desc || '')));
      info.appendChild(line);
    }

    wrap.appendChild(info);
    body.appendChild(wrap);

    hint.textContent = lastSummary
      ? `Last run: ${lastSummary.vehicle} — ${lastSummary.outcome === 'victory'
        ? 'completed the tournament' : `destroyed after ${lastSummary.races} races`}`
      : 'Nothing is committed until you take the grid';
    const go = el('button', 'btn primary', `Start a run in the ${v.name}`);
    go.onclick = () => onStart(v.id);
    foot.appendChild(go);

    const node = this._show(root);
    this.showroomStage = stage;
    return node;
  }

  // --- node map ------------------------------------------------------------

  map(run, { onChoose }) {
    const biome = run.biome;
    const { root, body } = frame(
      biome.name,
      `${biome.tagline}  ·  Region ${run.regionIndex + 1} of ${run.regionCount}`,
      run, { withPanel: true },
    );

    const wrap = el('div', 'map-wrap');
    const grid = el('div', 'map-grid');
    const available = new Set(run.availableNodes());
    const nodeEls = new Map();

    for (const row of run.map.rows) {
      const r = el('div', 'map-row');
      for (const node of row) {
        const def = NODE_TYPES[node.type];
        const btn = el('button', 'mapnode');
        if (node.type === 'boss') btn.classList.add('boss');
        if (node.visited) btn.classList.add('visited');
        if (node === run.map.current) btn.classList.add('current');
        if (available.has(node)) btn.classList.add('available');
        else if (!node.visited) btn.classList.add('locked');

        btn.appendChild(el('span', null, def.icon));
        btn.appendChild(el('span', 'lbl', esc(def.name.split(' ')[0])));
        btn.title = `${def.name} — ${def.desc}`;
        if (available.has(node)) btn.onclick = () => onChoose(node);
        r.appendChild(btn);
        nodeEls.set(node, btn);
      }
      grid.appendChild(r);
    }

    // Edges. Without them the map is a grid of icons, not a route: which node
    // leads where is the entire decision the screen exists to present.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'map-edges');
    grid.appendChild(svg);

    wrap.appendChild(grid);
    body.appendChild(wrap);
    const node = this._show(root);

    // Measure after layout, then draw.
    requestAnimationFrame(() => {
      const box = grid.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      svg.setAttribute('width', box.width);
      svg.setAttribute('height', box.height);

      const centre = (n) => {
        const b = nodeEls.get(n).getBoundingClientRect();
        return { x: b.left - box.left + b.width / 2, y: b.top - box.top + b.height / 2 };
      };

      for (const from of run.map.nodes) {
        for (const to of from.next) {
          const a = centre(from);
          const b2 = centre(to);
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
          line.setAttribute('x2', b2.x); line.setAttribute('y2', b2.y);
          // A path you can actually take right now is drawn brightly; the rest
          // are structure.
          const live = from === run.map.current && available.has(to);
          line.setAttribute('stroke', live ? '#4fc3f7' : 'rgba(255,255,255,0.13)');
          line.setAttribute('stroke-width', live ? 2 : 1);
          if (!from.visited && !live) line.setAttribute('stroke-dasharray', '3 5');
          svg.appendChild(line);
        }
      }

      // Scroll to what the player can actually do. The map is taller than the
      // viewport and is laid out boss-at-top, so the default scroll position
      // shows the end of the region rather than the choice in front of them.
      const focus = run.map.current ? nodeEls.get(run.map.current) : nodeEls.get(run.map.start);
      if (focus) {
        const fb = focus.getBoundingClientRect();
        const bb = body.getBoundingClientRect();
        body.scrollTop += (fb.top - bb.top) - bb.height * 0.62;
      }
    });

    return node;
  }

  // --- post-race reward ----------------------------------------------------

  reward(run, result, { onTake, onSkip, onReroll }) {
    const placeText = result.place === 1 ? 'Won the race'
      : result.place ? `Finished ${result.place}${['', 'st', 'nd', 'rd'][result.place] || 'th'}`
      : 'Race over';
    const { root, body, foot, hint } = frame(
      placeText,
      result.challengeMet ? 'Challenge met — bonus reward' : `+${result.scrap} scrap`,
      run, { withPanel: true },
    );
    hint.textContent = 'Tags you already run are highlighted';

    body.appendChild(el('div', 'section-label', 'Take one'));
    const cards = el('div', 'cards');
    for (const offer of run.offer) {
      cards.appendChild(offerCard(offer, run.build, onTake));
    }
    body.appendChild(cards);

    const reroll = el('button', 'btn', `Reroll (${run.rerollsLeft})`);
    reroll.disabled = run.rerollsLeft <= 0;
    reroll.onclick = onReroll;
    foot.appendChild(reroll);
    const skip = el('button', 'btn', 'Take nothing (+45 scrap)');
    skip.onclick = onSkip;
    foot.appendChild(skip);

    return this._show(root);
  }

  // --- shop ----------------------------------------------------------------

  shop(run, { onBuy, onLeave }) {
    const { root, body, foot, hint } = frame('Shop', 'Spend it or carry it to the boss',
      run, { withPanel: true });
    hint.textContent = `${run.scrap} scrap to spend`;

    body.appendChild(el('div', 'section-label', 'Stock'));
    const cards = el('div', 'cards');
    for (const item of run.shopStock) {
      const affordable = run.scrap >= item.price;
      const card = offerCard({ ...item, disabled: item.disabled || !affordable }, run.build, onBuy);
      if (!affordable && !item.sold) card.classList.add('disabled');
      cards.appendChild(card);
    }
    body.appendChild(cards);

    const leave = el('button', 'btn primary', 'Back to the road');
    leave.onclick = onLeave;
    foot.appendChild(leave);
    return this._show(root);
  }

  // --- event ---------------------------------------------------------------

  event(run, { onChoose }) {
    const ev = run.currentEvent;
    const { root, body } = frame(ev.title, 'Event', run, { withPanel: true });

    body.appendChild(el('div', 'event-body', esc(ev.body)));
    body.appendChild(el('div', 'section-label', 'Your call'));
    const list = el('div', 'choice-list');
    ev.choices.forEach((c, i) => {
      const b = el('button', 'choice');
      b.appendChild(el('div', 'lbl', esc(c.label)));
      b.appendChild(el('div', 'det', esc(c.detail)));
      b.onclick = () => onChoose(i);
      list.appendChild(b);
    });
    body.appendChild(list);
    return this._show(root);
  }

  // --- garage --------------------------------------------------------------

  rest(run, { onRepair, onUpgrade }) {
    const { root, body } = frame('Garage', 'One job. Choose it.', run, { withPanel: true });

    body.appendChild(el('div', 'section-label', 'One job'));
    const list = el('div', 'choice-list');
    const repair = el('button', 'choice');
    repair.appendChild(el('div', 'lbl', 'Repair'));
    repair.appendChild(el('div', 'det',
      `Restore ${Math.round(run.maxDurability * 0.45)} Durability.`));
    repair.onclick = onRepair;
    list.appendChild(repair);

    for (const s of run.build.skills) {
      const maxed = (s.level ?? 1) >= (s.maxLevel ?? 5);
      const b = el('button', 'choice');
      b.appendChild(el('div', 'lbl', `Upgrade ${s.icon || ''} ${esc(s.name)} → Lv${(s.level ?? 1) + 1}`));
      b.appendChild(el('div', 'det', maxed ? 'Already at maximum.' : esc(s.desc((s.level ?? 1) + 1))));
      if (maxed) b.classList.add('disabled');
      else b.onclick = () => onUpgrade(s.id);
      list.appendChild(b);
    }
    body.appendChild(list);
    return this._show(root);
  }

  // --- pre-race briefing ---------------------------------------------------

  briefing(run, cfg, { onGo }) {
    const node = run.pending;
    const def = NODE_TYPES[node.type];
    const { root, body, foot, hint } = frame(
      cfg.boss ? cfg.boss.name : def.name,
      cfg.boss ? cfg.boss.title : run.biome.name,
      run, { withPanel: true },
    );

    if (cfg.boss) {
      body.appendChild(el('div', 'story',
        `${esc(cfg.boss.text)}<br><br><b>Objective:</b> ${esc(cfg.boss.objective)}`));
    }
    if (cfg.challenge) {
      body.appendChild(el('div', 'story',
        `<b>Challenge — ${esc(cfg.challenge.name)}:</b> ${esc(cfg.challenge.text)}<br>`
        + `Meeting it pays a bonus reward and 70 scrap.`));
    }
    if (cfg.modifiers?.length) {
      const row = el('div', 'modline');
      for (const m of cfg.modifiers) {
        row.appendChild(el('span', null, `${m.icon} <b>${esc(m.name)}</b> — ${esc(m.text)}`));
      }
      const box = el('div', 'story');
      box.appendChild(el('b', null, 'Race modifiers'));
      box.appendChild(row);
      body.appendChild(box);
    }

    body.appendChild(el('div', 'section-label', 'The race'));
    const tally = el('div', 'tally');
    tally.innerHTML =
      `<div class="item"><div class="v">${cfg.laps}</div><div class="k">Laps</div></div>` +
      `<div class="item"><div class="v">${cfg.rivals}</div><div class="k">Rivals</div></div>` +
      `<div class="item"><div class="v">${(1 + cfg.difficulty).toFixed(1)}</div><div class="k">Difficulty</div></div>` +
      `<div class="item"><div class="v">${Math.round(run.durability)}</div><div class="k">Durability</div></div>`;
    body.appendChild(tally);

    // The controls legend, which used to sit under the roster — three screens
    // and several minutes before anybody could use it. This is the last screen
    // before you are driving.
    hint.textContent =
      'W/S throttle & brake · A/D steer · SHIFT drift · 1-4 skills · F1 perf overlay';

    const go = el('button', 'btn primary', 'To the grid');
    go.onclick = onGo;
    foot.appendChild(go);
    return this._show(root);
  }

  // --- end of run ----------------------------------------------------------

  gameOver(summary, { onRestart }) {
    const won = summary.outcome === 'victory';
    const { root, body, foot } = frame(null, null, null, { centred: true });

    const hero = el('div', 'result-hero');
    hero.appendChild(el('div', 'big', won ? 'VICTORY' : 'DESTROYED'));
    hero.appendChild(el('div', 'sub', won
      ? `${summary.vehicle} · all ${summary.regionsCleared} regions`
      : `${summary.vehicle} · ${summary.cause || 'wrecked'} in region ${summary.regionsCleared + 1}`));
    body.appendChild(hero);

    const tally = el('div', 'tally');
    tally.innerHTML =
      `<div class="item"><div class="v">${summary.races}</div><div class="k">Races</div></div>` +
      `<div class="item"><div class="v">${summary.wins}</div><div class="k">Wins</div></div>` +
      `<div class="item"><div class="v">${summary.parts.length}</div><div class="k">Parts</div></div>` +
      `<div class="item"><div class="v">${summary.skills.length}</div><div class="k">Skills</div></div>` +
      `<div class="item"><div class="v">${summary.minutes.toFixed(0)}</div><div class="k">Minutes</div></div>`;
    body.appendChild(tally);

    // The north star: describe the machine, not the score.
    body.appendChild(el('div', 'story', storyOf(summary)));

    const again = el('button', 'btn primary', 'New run');
    again.onclick = onRestart;
    foot.appendChild(again);
    return this._show(root);
  }
}

/**
 * Turn a run summary into a sentence about the machine.
 *
 * The design brief's stated goal is that a player can look at the car at the
 * end and understand how it got there. This is the smallest honest version of
 * that: the vehicle it started as, the theme it grew, and what it ended up
 * being best at.
 */
function storyOf(s) {
  const parts = [];
  parts.push(`You started in <b>${esc(s.vehicle)}</b>.`);

  if (s.theme.length) {
    const lead = s.theme[0].split(' ')[0];
    parts.push(`Over ${s.races} races it became a <em>${esc(lead)}</em> machine`
      + (s.theme.length > 1 ? ` with ${esc(s.theme.slice(1).join(' and '))} running through it.` : '.'));
  } else {
    parts.push(`Over ${s.races} races it never settled into anything in particular.`);
  }

  if (s.parts.length) {
    parts.push(`It ended carrying <b>${s.parts.map(esc).join('</b>, <b>')}</b>.`);
  } else {
    parts.push('It ended as bare as it started.');
  }

  if (s.skills.length) parts.push(`Running ${s.skills.map(esc).join(', ')}.`);
  if (s.leading.length) parts.push(`Its strongest attributes were ${esc(s.leading.join(', '))}.`);

  parts.push(s.outcome === 'victory'
    ? 'It was enough.'
    : `It was not enough — ${esc(s.cause || 'wrecked')}.`);

  parts.push(`<br><br>Seed <b>${esc(s.seed)}</b>`);
  return parts.join(' ');
}
