import { ATTRIBUTES, ATTRIBUTE_BY_ID, GROUPS } from '../stats/attributes.js';
import { NODE_TYPES } from '../run/nodemap.js';
import { RARITY, SLOTS } from '../data/parts.js';
import { VEHICLES, VEHICLE_BY_ID } from '../data/vehicles.js';
import { SKILL_BY_ID } from '../data/skills.js';
import { Build } from '../build/build.js';
import { previewTrack } from '../track/preview.js';
import { COSMETICS, CRATE_RARITY } from '../data/cosmetics.js';
import { branchesOf, chargesOf } from '../data/skills.js';
import { clamp01 } from '../core/math.js';
import { summarise, PIP_COUNT } from '../stats/summary.js';
import { isLocked, unlockLabel } from '../data/unlocks.js';
import { vehicleThumbnails } from '../vehicle/thumbnails.js';

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

/**
 * What a skill does, as the player's copy of it does it.
 *
 * A branched skill's description depends on which branches were taken, so it
 * needs the instance and not only a level. Ones without branches never look at
 * the second argument, which is what lets both kinds sit in the same list.
 */
const descOf = (skill, level) => (typeof skill.desc === 'function'
  ? skill.desc(level ?? skill.level ?? 1, skill) : (skill.desc ?? ''));

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

const SVG_NS = 'http://www.w3.org/2000/svg';

const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const pathOf = (pts, close) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
  + (close ? ' Z' : '');

/**
 * The circuit, from above, the way a broadcast draws one.
 *
 * Two strokes on the same path: a wide one that is the road and a dashed hair
 * down the middle of it. That reads as tarmac at any size, where a single line
 * reads as a diagram. Branches are drawn under it — a shortcut leaves the road
 * and rejoins it, so it should look like a road that goes somewhere else, not
 * like an annotation.
 */
function circuitMap(preview) {
  const svg = svgEl('svg', {
    class: 'circuit',
    viewBox: '-8 -8 116 116',
    preserveAspectRatio: 'xMidYMid meet',
  });

  for (const branch of preview.branches) {
    svg.appendChild(svgEl('path', {
      d: pathOf(branch, false), class: 'circuit-branch-road',
    }));
    svg.appendChild(svgEl('path', {
      d: pathOf(branch, false), class: 'circuit-branch',
    }));
  }

  // The pit lane, in its service's colour: it is not a line you might take for
  // pace, so it must not read like the shortcuts.
  if (preview.pitLane) {
    svg.appendChild(svgEl('path', {
      d: pathOf(preview.pitLane, false), class: 'circuit-branch-road',
    }));
    svg.appendChild(svgEl('path', {
      d: pathOf(preview.pitLane, false), class: 'circuit-pit',
      style: preview.pitService ? `stroke:${preview.pitService.color}` : '',
    }));
  }

  svg.appendChild(svgEl('path', { d: pathOf(preview.outline, true), class: 'circuit-road' }));
  svg.appendChild(svgEl('path', { d: pathOf(preview.outline, true), class: 'circuit-line' }));

  // The start line, drawn across the road rather than along it.
  const a = preview.startAngle + Math.PI / 2;
  const r = 3.4;
  const { x, y } = preview.start;
  svg.appendChild(svgEl('line', {
    x1: (x - Math.cos(a) * r).toFixed(2), y1: (y - Math.sin(a) * r).toFixed(2),
    x2: (x + Math.cos(a) * r).toFixed(2), y2: (y + Math.sin(a) * r).toFixed(2),
    class: 'circuit-start',
  }));
  return svg;
}

/** A label-and-value list. Aligned, so a column of facts reads as a column. */
function factRows(pairs) {
  const box = el('div', 'facts');
  for (const [k, v] of pairs) {
    const row = el('div', 'fact');
    row.appendChild(el('span', 'k', esc(k)));
    row.appendChild(el('span', 'v', esc(v)));
    box.appendChild(row);
  }
  return box;
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
  // How many times you get to use it in a race. A skill's power means nothing
  // without its magazine — three uses of a big one and five of a small one is
  // the whole comparison — and this was the number the player could not see.
  if (offer.kind === 'skill' && offer.skill) {
    const mag = chargesOf(offer.skill, build?.stats);
    card.appendChild(el('div', 'card-ammo',
      `${mag} use${mag === 1 ? '' : 's'} a race · ${offer.skill.cooldown ?? 1}s between`));
  }
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
/**
 * What the player owns, and what is on the car.
 *
 * Everything in the catalogue is listed, owned or not: a locker that hides what
 * you have not got is a list of what you have, and the reason to open a crate
 * is knowing what is still in there.
 */
function lockerPanel(profile, onEquip) {
  const box = el('div', 'locker');
  for (const [slot, label] of [['paint', 'Paint'], ['rim', 'Wheels']]) {
    box.appendChild(el('div', 'section-label', label));
    const grid = el('div', 'locker-grid');
    for (const item of COSMETICS.filter((c) => c.slot === slot)) {
      const key = `${slot}:${item.id}`;
      const owned = profile.has(key);
      const on = profile.equipped[slot] === key;
      const chip = el('button', `swatch${owned ? '' : ' locked'}${on ? ' on' : ''}`);
      chip.title = owned ? item.name : `${item.name} — not found yet`;
      chip.style.setProperty('--a', item.base ?? item.tint ?? '#6b7078');
      chip.style.setProperty('--b', item.accent ?? item.tint ?? '#39404a');
      chip.style.setProperty('--rarity', (CRATE_RARITY[item.rarity] ?? {}).color ?? '#9aa5b1');
      if (owned) chip.onclick = () => onEquip?.(key);
      grid.appendChild(chip);
    }
    box.appendChild(grid);
  }
  const total = COSMETICS.length;
  const have = COSMETICS.filter((c) => profile.has(`${c.slot}:${c.id}`)).length;
  box.appendChild(el('div', 'locker-count', `${have} of ${total} found`));
  return box;
}

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

  // Forwarded whole, not field by field. This used to name the six options it
  // knew about, so every option `machine` gained afterwards was silently
  // dropped on the way through and the screen fell back to its defaults.
  title(opts) {
    return this.machine(opts.vehicleId, opts);
  }

  // --- one machine, in detail ----------------------------------------------

  /**
   * A crate, opened.
   *
   * One screen, one item, one button. A crate that has to be clicked through a
   * sequence of animations is a slot machine's ceremony, and there is nothing
   * being sold here to justify it — the reward is the thing, so the screen
   * shows the thing.
   */
  crate(item, { onClose, remaining = 0 }) {
    const { root, body, foot, hint } = frame(null, null, null, { centred: true });

    const rar = CRATE_RARITY[item.rarity] ?? CRATE_RARITY.common;
    const hero = el('div', 'result-hero');
    hero.appendChild(el('div', 'sub', esc(rar.name)));
    hero.appendChild(el('div', 'big crate-name', esc(item.name)));
    hero.appendChild(el('div', 'sub', item.slot === 'paint' ? 'Paint' : 'Wheels'));
    hero.style.setProperty('--rarity', rar.color);
    body.appendChild(hero);

    const swatch = el('div', 'crate-swatch');
    for (const c of [item.base, item.accent, item.tint].filter(Boolean)) {
      const chip = el('div', 'chip');
      chip.style.background = c;
      swatch.appendChild(chip);
    }
    body.appendChild(swatch);

    hint.textContent = remaining > 0
      ? `${remaining} more to open` : 'Yours, on every car, from now on';
    const go = el('button', 'btn primary', remaining > 0 ? 'Open the next' : 'Good');
    go.onclick = onClose;
    foot.appendChild(go);
    return this._show(root);
  }

  /**
   * The screen between picking a machine off the roster and committing to it.
   *
   * Three columns and a strip. The car is the middle one at the size it
   * deserves; what it *is* sits to its left and what it *starts with* to its
   * right, so a comparison between two machines is two glances at fixed
   * positions rather than a scroll. The strip along the bottom is the roster
   * itself — every machine visible at once, because the decision is between
   * six things and a decision you have to page through is a decision made on
   * whichever one you saw last.
   *
   * The five bars are a summary and say so; the fifteen attributes they reduce
   * are one click away and nothing is hidden that the race will use. That is
   * the screen's one concession to the house rule about never showing a number
   * without showing what it does — the number is still here, it just is not
   * the first thing asked of a player choosing a shape.
   */
  machine(vehicleId, {
    onStart, onSwitch, lastSummary, profile, onEquip,
    seed, runNumber = 1, onReseed, garageOpen = false, onGarage,
  }) {
    const v = VEHICLE_BY_ID[vehicleId];
    const { root, body, foot } = frame(
      'Select your ride', 'Choose your car and start your run', null,
    );
    root.classList.add('screen--machine');
    root.querySelector('.screen-head')
      .prepend(el('div', 'screen-overline', 'Rogue Racer'));
    root.style.setProperty('--machine', v.accent || v.color);
    root.style.setProperty('--machine-body', v.color);

    // The run this is about to be, named in the corner. The seed is shown
    // because it is the one input to a run the player can hold on to: a run
    // worth repeating is a string worth reading, and it is rerollable from the
    // footer rather than fixed at the moment the button is pressed.
    const meta = el('div', 'machine-meta');
    meta.appendChild(el('div', 'run-no', `Run ${String(runNumber).padStart(2, '0')}`));
    if (seed) {
      const row = el('div', 'seed-row');
      row.appendChild(el('span', 'seed-lbl', 'Seed'));
      row.appendChild(el('span', 'seed-val', esc(seed)));
      meta.appendChild(row);
    }
    if (lastSummary) {
      meta.appendChild(el('div', 'meta-last', esc(
        `Last: ${lastSummary.vehicle} — ${lastSummary.outcome === 'victory'
          ? 'took the tournament' : `wrecked after ${lastSummary.races} races`}`)));
    }
    root.appendChild(meta);

    const wrap = el('div', 'machine');

    // --- what it is ---
    const build = new Build(v.id);
    const stats = build.stats.all();

    const card = el('div', 'machine-card');
    card.appendChild(el('h2', 'machine-name', esc(v.name)));
    card.appendChild(el('div', 'machine-class', esc(v.class || v.bodyType)));
    card.appendChild(el('div', 'machine-identity', esc(v.identity)));

    const summary = el('div', 'summary');
    for (const row of summarise(stats)) {
      const r = el('div', 'sumrow');
      r.title = row.note;
      r.appendChild(el('span', 'nm', esc(row.name)));
      const pips = el('div', 'pips');
      for (let i = 0; i < PIP_COUNT; i++) {
        pips.appendChild(el('span', `pip${i < row.pips ? ' on' : ''}`));
      }
      r.appendChild(pips);
      r.appendChild(el('span', 'vl', String(row.pips)));
      summary.appendChild(r);
    }
    card.appendChild(summary);
    card.appendChild(el('div', 'machine-quote', esc(v.tagline)));

    // The whole specification, in absolutes, computed by the same StatBlock
    // the race will run on — folded away rather than dropped, because it is
    // reference and reference does not need to be the loudest thing on screen.
    const spec = el('div', 'machine-spec');
    for (const group of Object.values(GROUPS)) {
      const attrs = ATTRIBUTES.filter((a) => a.group === group.id);
      if (!attrs.length) continue;
      spec.appendChild(el('h4', 'machine-group', esc(group.name)));
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
        spec.appendChild(row);
      }
    }
    const toggle = el('button', 'spec-toggle', 'Full specification');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => {
      const open = spec.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide specification' : 'Full specification';
    };
    card.appendChild(toggle);
    card.appendChild(spec);
    wrap.appendChild(card);

    // --- the car ---
    const stage = el('div', 'machine-stage');
    const at = VEHICLES.findIndex((x) => x.id === v.id);
    for (const [dir, cls] of [[-1, 'prev'], [1, 'next']]) {
      // Past a locked machine rather than into it: an arrow that lands on a
      // card the button underneath refuses is an arrow that stops working.
      const n = VEHICLES.length;
      let other = null;
      for (let step = 1; step <= n; step++) {
        const cand = VEHICLES[(((at + dir * step) % n) + n) % n];
        if (!isLocked(cand.id, profile)) { other = cand; break; }
      }
      if (!other || other.id === v.id) continue;
      const b = el('button', `stage-nav ${cls}`, dir < 0 ? '‹' : '›');
      b.title = other.name;
      b.onclick = () => onSwitch(other.id);
      stage.appendChild(b);
    }
    wrap.appendChild(stage);

    // --- what it starts with ---
    const side = el('div', 'machine-side');
    const skill = SKILL_BY_ID[v.startingSkill];
    if (skill) {
      side.appendChild(el('div', 'section-label', 'Special skill'));
      const sc = el('div', 'skillcard');
      sc.appendChild(el('div', 'ic', skill.icon || '◆'));
      const tx = el('div', 'tx');
      const hd = el('div', 'hd');
      hd.appendChild(el('span', 'nm', esc(skill.name)));
      hd.appendChild(el('span', 'badge', 'Active'));
      tx.appendChild(hd);
      tx.appendChild(el('div', 'ds',
        esc(typeof skill.desc === 'function' ? skill.desc(1) : skill.desc || '')));
      if (skill.cooldown) {
        tx.appendChild(el('div', 'cd',
          `Cooldown ${skill.cooldown}s · ${skill.cost} Energy`));
      }
      sc.appendChild(tx);
      side.appendChild(sc);
    }

    if (v.rule) {
      side.appendChild(el('div', 'section-label', 'Starting perk'));
      const p = el('div', 'perk');
      p.appendChild(el('div', 'ic', v.rule.icon || '◆'));
      const tx = el('div', 'tx');
      tx.appendChild(el('div', 'nm', esc(v.rule.name || 'Rule')));
      tx.appendChild(el('div', 'ds', esc(v.rule.text)));
      p.appendChild(tx);
      side.appendChild(p);
    }

    side.appendChild(el('div', 'section-label', 'Loadout'));
    const slots = el('div', 'tally tally--tight');
    slots.innerHTML =
      `<div class="item"><div class="v">${build.partSlots}</div><div class="k">Part slots</div></div>`
      + `<div class="item"><div class="v">${build.skillSlots}</div><div class="k">Skill slots</div></div>`;
    side.appendChild(slots);

    // Named, not blank. What the empty slots are for is the reason to take one
    // machine over another with fewer of them.
    const empty = el('div', 'perk empty');
    empty.appendChild(el('div', 'ic', '🔒'));
    const etx = el('div', 'tx');
    etx.appendChild(el('div', 'nm', 'Empty slots'));
    etx.appendChild(el('div', 'ds', 'Parts and skills found on the run fill these. Nothing carries over.'));
    empty.appendChild(etx);
    side.appendChild(empty);

    wrap.appendChild(side);
    body.appendChild(wrap);

    // --- the roster ---
    const roster = el('div', 'roster');
    const track = el('div', 'roster-track');
    const thumbs = vehicleThumbnails(profile?.look?.() ?? null);
    for (const other of VEHICLES) {
      const locked = isLocked(other.id, profile);
      const b = el('button',
        `rcard${other.id === v.id ? ' on' : ''}${locked ? ' locked' : ''}`);
      b.style.setProperty('--card', other.accent || other.color);

      const thumb = el('div', 'rthumb');
      const url = thumbs.get(other.id);
      // No thumbnail is a real outcome, not a failure to handle: a machine
      // that would not give the generator a GL context still gets a card, and
      // the card still says which machine it is.
      if (url) thumb.style.backgroundImage = `url("${url}")`;
      b.appendChild(thumb);

      if (locked) {
        b.appendChild(el('div', 'rname', 'Locked'));
        b.appendChild(el('div', 'runlock', esc(unlockLabel(other.id))));
        b.disabled = true;
      } else {
        b.appendChild(el('div', 'rname', esc(other.name)));
        const sk = SKILL_BY_ID[other.startingSkill];
        if (sk?.icon) b.appendChild(el('div', 'rbadge', sk.icon));
        b.onclick = () => onSwitch(other.id);
      }
      track.appendChild(b);
    }
    roster.appendChild(track);
    body.appendChild(roster);

    // --- commit ---
    const reseed = el('button', 'btn', 'New seed');
    reseed.title = 'Roll a different run. Nothing about the car changes.';
    reseed.onclick = () => onReseed?.();
    const go = el('button', 'btn primary', 'Select car');
    go.onclick = () => onStart(v.id);
    const garage = el('button', 'btn', 'Garage');
    garage.title = 'Paint and wheels you have found.';
    garage.onclick = () => onGarage?.(true);
    foot.appendChild(reseed);
    foot.appendChild(go);
    foot.appendChild(garage);

    // The locker, over the screen rather than beside it. It is the one thing
    // here that is not about choosing a car, and on a screen whose whole job
    // is a choice between six cars it was competing with the roster.
    if (garageOpen) {
      const ov = el('div', 'overlay');
      const box = el('div', 'overlay-box');
      box.appendChild(el('div', 'overlay-title', 'Garage'));
      box.appendChild(lockerPanel(profile, onEquip));
      const done = el('button', 'btn', 'Done');
      done.onclick = () => onGarage?.(false);
      box.appendChild(done);
      ov.appendChild(box);
      ov.onclick = (e) => { if (e.target === ov) onGarage?.(false); };
      root.appendChild(ov);
    }

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

    // What the icons mean, for the types this region actually contains.
    //
    // The map was seven glyphs and a tooltip: the route is the run's central
    // decision and the screen expected you to hover each node to find out what
    // you were choosing between. Only the types on this map are listed, so the
    // key describes the choice in front of you rather than the game in general.
    const present = [];
    for (const nd of run.map.nodes) if (!present.includes(nd.type)) present.push(nd.type);
    if (present.length) {
      body.appendChild(el('div', 'section-label', 'What these are'));
      const key = el('div', 'map-key');
      for (const type of present) {
        const d = NODE_TYPES[type];
        if (!d) continue;
        const item = el('div', 'map-key-item');
        item.appendChild(el('span', 'ic', d.icon));
        const text = el('div', 'tx');
        text.appendChild(el('div', 'nm', esc(d.name)));
        text.appendChild(el('div', 'ds', esc(d.desc)));
        item.appendChild(text);
        key.appendChild(item);
      }
      body.appendChild(key);
    }

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

  /**
   * Which skill goes, so a new one can come in.
   *
   * The screen that makes a full loadout a decision rather than a wall. It only
   * appears when it has to: taking a skill with a free slot never asks, and
   * levelling one already carried never asks either.
   */
  swapSkill(run, offer, { onSwap, onCancel }) {
    const { root, body, foot, hint } = frame(
      `Fit the ${offer.skill?.name ?? offer.name}?`,
      'Your skill slots are full', run,
    );

    body.appendChild(el('div', 'machine-identity', esc(offer.text)));
    body.appendChild(el('div', 'section-label', 'Give up'));

    const list = el('div', 'choice-list');
    for (const s of run.build.skills) {
      const b = el('button', 'choice');
      b.appendChild(el('div', 'lbl', `${s.icon || ''} ${esc(s.name)} — Lv${s.level ?? 1}`));
      // What it does *now*, at the level it is actually at: the comparison is
      // against the thing you have, not against its entry in a catalogue.
      b.appendChild(el('div', 'det', esc(descOf(s, s.level ?? 1))));
      // Scrap already put toward a rank on this skill goes with it. Losing 40
      // scrap of part-paid upgrade to a swap you would not have made is the
      // kind of thing a player should be told before, not after.
      const down = Object.values(s.paid ?? {}).reduce((a, v) => a + (v || 0), 0);
      if (down > 0) {
        b.appendChild(el('div', 'warn', `${down} scrap already paid toward an upgrade`
          + ' on this — it goes with it.'));
      }
      b.onclick = () => onSwap(s.id);
      list.appendChild(b);
    }
    body.appendChild(list);

    hint.textContent = 'Nothing is lost until you choose';
    const back = el('button', 'btn', 'Keep what I have');
    back.onclick = onCancel;
    foot.appendChild(back);
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

  rest(run, { onRepair, onUpgrade, onLeave }) {
    const { root, body, foot } =
      frame('Garage', 'One job. Choose it.', run, { withPanel: true });

    body.appendChild(el('div', 'section-label', 'One job'));
    const list = el('div', 'choice-list');
    const quote = run.repairQuote();
    // What the money on hand actually covers. A repair is sold pro rata, so
    // the honest number to show is not the full job's price but the share of
    // the job this player is about to get — worked out here rather than
    // discovered in the toast afterwards.
    const share = quote.price > 0 ? Math.min(1, run.scrap / quote.price) : 1;
    const partial = share < 1 && share >= 0.05;
    const broke = quote.amount > 0 && share < 0.05;

    const repair = el('button', 'choice');
    repair.appendChild(el('div', 'lbl', 'Repair'));
    repair.appendChild(el('div', 'det', quote.amount <= 0
      ? 'Nothing to put right.'
      : broke
        ? `${quote.price} scrap for the job. You have ${run.scrap}.`
        : partial
          ? `${Math.round(share * 100)}% of the job — ${Math.round(quote.amount * share)}`
            + ` of ${Math.round(quote.amount)} Durability, which is all your`
            + ` ${run.scrap} covers.`
          : `Restore ${Math.round(quote.amount)} Durability.`));
    // The price sits with the thing, not in a corner: a garage is a shop and
    // this was the one node in the game that took no money at all.
    if (quote.amount > 0 && !broke) {
      repair.appendChild(el('div', 'price',
        `${Math.min(quote.price, run.scrap)} scrap`));
      repair.onclick = onRepair;
    } else {
      repair.classList.add('disabled');
      if (broke) repair.classList.add('unaffordable');
    }
    list.appendChild(repair);

    for (const s of run.build.skills) {
      // A skill with branches offers its branches; one without offers a level,
      // which is what every skill did before any of them had branches.
      if (s.branches?.length) {
        for (const br of branchesOf(s)) {
          const b = el('button', 'choice');
          b.appendChild(el('div', 'lbl',
            `${s.icon || ''} ${esc(s.name)} — ${esc(br.name)}${br.rank ? ` ${br.rank + 1}` : ''}`));
          // What this pick would give, not what the branch is in the abstract.
          b.appendChild(el('div', 'det', br.maxed
            ? 'Nothing more down this road.' : esc(br.desc(br.rank + 1))));
          const price = run.upgradeQuote(s.id, br.id);
          const down = run.upgradePaid(s.id, br.id);
          const owed = Math.max(0, price - down);
          // The remaining, not the sticker price: an upgrade can be paid off
          // across visits, so what it costs *you* is what is still owed.
          if (!br.maxed) b.appendChild(el('div', 'price', `${owed} scrap`));
          if (!br.maxed && down > 0) {
            b.appendChild(el('div', 'part', `${down} of ${price} already down`));
          }
          // Used up is never; broke is only until the next race, and you can
          // still put something toward it today.
          if (br.maxed) b.classList.add('disabled');
          else if (run.scrap <= 0) { b.classList.add('disabled', 'unaffordable'); }
          else b.onclick = () => onUpgrade(s.id, br.id);
          list.appendChild(b);
        }
        continue;
      }

      const maxed = (s.level ?? 1) >= (s.maxLevel ?? 5);
      const b = el('button', 'choice');
      b.appendChild(el('div', 'lbl', `Upgrade ${s.icon || ''} ${esc(s.name)} → Lv${(s.level ?? 1) + 1}`));
      b.appendChild(el('div', 'det', maxed ? 'Already at maximum.' : esc(descOf(s, (s.level ?? 1) + 1))));
      const price = run.upgradeQuote(s.id);
      const down = run.upgradePaid(s.id);
      const owed = Math.max(0, price - down);
      if (!maxed) b.appendChild(el('div', 'price', `${owed} scrap`));
      if (!maxed && down > 0) {
        b.appendChild(el('div', 'part', `${down} of ${price} already down`));
      }
      if (maxed) b.classList.add('disabled');
      else if (run.scrap <= 0) { b.classList.add('disabled', 'unaffordable'); }
      else b.onclick = () => onUpgrade(s.id);
      list.appendChild(b);
    }
    body.appendChild(list);

    const leave = el('button', 'btn', 'Leave it');
    leave.onclick = onLeave;
    foot.appendChild(leave);
    return this._show(root);
  }

  // --- pre-race briefing ---------------------------------------------------

  briefing(run, cfg, { onGo }) {
    const node = run.pending;
    const def = NODE_TYPES[node.type];
    const biome = cfg.biome ?? run.biome;
    const { root, body, foot, hint } = frame(
      cfg.boss ? cfg.boss.name : def.name,
      cfg.boss ? cfg.boss.title : biome.name,
      run,
    );
    root.classList.add('screen--briefing');

    const wrap = el('div', 'briefing');

    // The circuit, generated from the race's own seed. Not an illustration of
    // one: it is the loop that is about to be driven, and its shape says more
    // about the next two minutes than any of the numbers beside it.
    const left = el('div', 'briefing-map');
    let preview = null;
    try {
      preview = previewTrack(cfg.seed, biome, {
        difficulty: cfg.difficulty,
        lengthScale: cfg.lengthScale,
        // What the pit sells depends on what this car can use, so the briefing
        // has to ask the same question the race will.
        racer: { build: run.build },
      });
    } catch {
      // A briefing that cannot draw the circuit is still a briefing. Better a
      // screen with no map than no screen.
      preview = null;
    }
    if (preview) {
      left.appendChild(circuitMap(preview));
      const legend = el('div', 'circuit-legend');
      legend.innerHTML =
        '<span class="k start">Start / finish</span>'
        + (preview.branches.length ? '<span class="k branch">Shortcut</span>' : '')
        + (preview.pitService
          ? `<span class="k pit" style="--pit-color:${preview.pitService.color}">`
            + `${esc(preview.pitService.name)}</span>` : '');
      left.appendChild(legend);
    }
    wrap.appendChild(left);

    const info = el('div', 'briefing-info');

    if (cfg.boss) {
      info.appendChild(el('div', 'section-label', 'Who you are up against'));
      info.appendChild(el('div', 'machine-identity', esc(cfg.boss.text)));
      info.appendChild(el('div', 'rule', `Objective: ${esc(cfg.boss.objective)}`));
    }

    info.appendChild(el('div', 'section-label', 'The circuit'));
    info.appendChild(el('div', 'machine-identity', esc(biome.tagline)));
    if (preview) {
      const c = preview.stats;
      const total = (c.length * cfg.laps) / 1000;
      info.appendChild(factRows([
        ['Lap', `${c.length} m`],
        ['Race', `${total.toFixed(1)} km over ${cfg.laps} lap${cfg.laps === 1 ? '' : 's'}`],
        ['Corners', `${c.corners}, tightest ${c.tightest} m`],
        ['Shortcuts', c.shortcuts ? `${c.shortcuts} branches off the racing line` : 'none'],
        ['Road', `${c.width} m wide, ${c.climb} m of climb`],
        // The pit is a decision made at speed with no screen in front of it,
        // so the last calm chance to know what is down there is here.
        ...(preview.pitService
          ? [['Pit lane', `${preview.pitService.name} — ${preview.pitService.blurb}`]] : []),
      ]));
    }

    info.appendChild(el('div', 'section-label', 'The race'));
    const tally = el('div', 'tally tally--tight');
    tally.innerHTML =
      `<div class="item"><div class="v">${cfg.laps}</div><div class="k">Laps</div></div>`
      + `<div class="item"><div class="v">${cfg.rivals}</div><div class="k">Rivals</div></div>`
      + `<div class="item"><div class="v">${(1 + cfg.difficulty).toFixed(1)}</div><div class="k">Difficulty</div></div>`
      + `<div class="item"><div class="v">${Math.round(run.durability)}</div><div class="k">Durability</div></div>`;
    info.appendChild(tally);

    if (cfg.challenge) {
      info.appendChild(el('div', 'section-label', 'Challenge'));
      info.appendChild(el('div', 'rule',
        `${esc(cfg.challenge.name)} — ${esc(cfg.challenge.text)} `
        + 'Meeting it pays a bonus reward and 70 scrap.'));
    }

    if (cfg.modifiers?.length) {
      info.appendChild(el('div', 'section-label', 'Conditions'));
      for (const m of cfg.modifiers) {
        const line = el('div', 'machine-skill');
        line.appendChild(el('div', 'lbl', `${m.icon || ''} ${esc(m.name)}`));
        line.appendChild(el('div', 'det', esc(m.text)));
        info.appendChild(line);
      }
    }

    wrap.appendChild(info);
    body.appendChild(wrap);

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
