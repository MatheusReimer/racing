import { StatBlock } from '../stats/statblock.js';
import { baseStats } from '../stats/attributes.js';
import { VEHICLE_BY_ID } from '../data/vehicles.js';

// The player's machine: a vehicle, its parts, and its skills.
//
// This is where the design brief's central claim has to be made true — that
// depth comes from parts *interacting*, not from parts having larger numbers.
// Two mechanisms carry that weight:
//
//   Tags   Every part and skill contributes tags (Electric, Explosive, Drift,
//          Trap...). Parts can read the tags of the whole build, so an item can
//          say "for each Electric source you carry" and mean it. This is what
//          turns a pile of items into a build.
//
//   Hooks  Parts register callbacks against named moments in a race — a drift
//          tick, a kill, a collision, crossing a heat threshold. A part that
//          only shifts a stat is a stat stick; a part that answers an event can
//          close a loop, which is what the brief asks every good item to do.
//
// Everything here is recomputed eagerly on change and cached, because the
// reward screen previews stat deltas constantly and must stay cheap.

/** Every moment a part can react to. Kept explicit so typos fail loudly. */
export const HOOKS = [
  'onRaceStart',
  'onTick',
  'onDrift',
  'onImpact',        // this car hit something
  'onDamageTaken',
  'onKill',
  'onSkillUse',
  'onBoost',
  'onHeatState',
  'onLap',
  'onAirborne',
  'onLanded',
  'modifyDamageDealt',
  'modifyDamageTaken',
  'onRaceEnd',
];

const HOOK_SET = new Set(HOOKS);

export class Build {
  constructor(vehicleId, { parts = [], skills = [] } = {}) {
    this.vehicle = VEHICLE_BY_ID[vehicleId];
    if (!this.vehicle) throw new Error(`unknown vehicle: ${vehicleId}`);
    this.parts = parts.slice();
    this.skills = skills.slice();

    this.stats = new StatBlock(baseStats());
    this._dirty = true;
    this.recompute();
  }

  // --- composition ---------------------------------------------------------

  get partSlots() {
    return (this.vehicle.partSlots ?? 6) + this.stats.mod('partSlots');
  }

  get skillSlots() {
    return (this.vehicle.skillSlots ?? 3) + this.stats.mod('skillSlots');
  }

  canAddPart() {
    return this.parts.length < this.partSlots;
  }

  addPart(part) {
    this.parts.push(part);
    this._dirty = true;
    this.recompute();
    return this;
  }

  removePart(part) {
    const i = this.parts.indexOf(part);
    if (i >= 0) {
      this.parts.splice(i, 1);
      this._dirty = true;
      this.recompute();
    }
    return this;
  }

  canAddSkill() {
    return this.skills.length < this.skillSlots;
  }

  addSkill(skill) {
    // Picking up a skill you already have levels it instead of duplicating it.
    // This is what makes the design brief's "mutable items" progression work
    // without a separate upgrade currency.
    const existing = this.skills.find((s) => s.id === skill.id);
    if (existing) {
      existing.level = Math.min(existing.maxLevel ?? 5, (existing.level ?? 1) + 1);
    } else {
      this.skills.push({ ...skill, level: skill.level ?? 1 });
    }
    this._dirty = true;
    this.recompute();
    return this;
  }

  upgradeSkill(skillId) {
    const s = this.skills.find((x) => x.id === skillId);
    if (!s) return false;
    if ((s.level ?? 1) >= (s.maxLevel ?? 5)) return false;
    s.level = (s.level ?? 1) + 1;
    this._dirty = true;
    this.recompute();
    return true;
  }

  // --- derived state -------------------------------------------------------

  recompute() {
    const sb = this.stats;
    sb.clearSources();

    // Vehicle identity first, so parts read as modifications of a car.
    sb.add(this.vehicle.name, statDeltasToFlat(this.vehicle.stats), this.vehicle.rule?.mods);

    for (const p of this.parts) {
      sb.add(p.name, p.stats, p.mods);
    }
    for (const s of this.skills) {
      if (s.stats || s.mods) sb.add(s.name, s.stats, s.mods);
    }
    sb.recompute();

    // Tags, counted rather than just present: an item that scales "per
    // Electric source" needs the count, not a boolean.
    this.tagCounts = new Map();
    const bump = (t) => this.tagCounts.set(t, (this.tagCounts.get(t) || 0) + 1);
    for (const p of this.parts) for (const t of p.tags || []) bump(t);
    for (const s of this.skills) for (const t of s.tags || []) bump(t);
    for (const t of this.vehicle.tags || []) bump(t);
    this.tags = new Set(this.tagCounts.keys());

    // Flatten hooks once. Dispatch happens thousands of times per race; walking
    // the parts list each time would be wasteful.
    this.hooks = {};
    for (const name of HOOKS) this.hooks[name] = [];
    const collect = (source, owner) => {
      if (!source) return;
      for (const [name, fn] of Object.entries(source)) {
        if (!HOOK_SET.has(name)) {
          console.warn(`[build] "${owner}" registers unknown hook "${name}"`);
          continue;
        }
        this.hooks[name].push({ fn, owner, source: owner });
      }
    };
    collect(this.vehicle.rule?.hooks, this.vehicle.name);
    for (const p of this.parts) collect(p.hooks, p.name);
    for (const s of this.skills) collect(s.hooks, s.name);

    this.physics = sb.physics();
    this._dirty = false;
    return this;
  }

  // --- tag queries, for synergy items --------------------------------------

  hasTag(tag) {
    return this.tagCounts.has(tag);
  }

  countTag(tag) {
    return this.tagCounts.get(tag) || 0;
  }

  /** Distinct tags this build carries — used by "hybrid" payoff items. */
  get tagVariety() {
    return this.tagCounts.size;
  }

  // --- hook dispatch -------------------------------------------------------

  /**
   * Fire an event at every part that registered for it. `ctx` is mutable on
   * purpose: hooks communicate by writing to it (adding energy, cancelling
   * damage, requesting a boost).
   */
  fire(hookName, ctx) {
    const list = this.hooks[hookName];
    if (!list || list.length === 0) return ctx;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i].fn(ctx, this);
      } catch (err) {
        console.error(`[build] hook ${hookName} from "${list[i].owner}" threw:`, err);
      }
    }
    return ctx;
  }

  /**
   * Reducer-style hooks that transform a number. Each handler returns the new
   * value; a handler returning undefined leaves it unchanged.
   */
  reduce(hookName, value, ctx) {
    const list = this.hooks[hookName];
    if (!list || list.length === 0) return value;
    let v = value;
    for (let i = 0; i < list.length; i++) {
      try {
        const out = list[i].fn(v, ctx, this);
        if (typeof out === 'number' && Number.isFinite(out)) v = out;
      } catch (err) {
        console.error(`[build] hook ${hookName} from "${list[i].owner}" threw:`, err);
      }
    }
    return v;
  }

  // --- presentation --------------------------------------------------------

  /** The single line that describes what this build has become. */
  describe() {
    const s = this.stats.all();
    const notes = [];
    const top = Object.entries(s)
      .filter(([k]) => k !== 'weight')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k);
    if (this.tagCounts.size) {
      const [tag] = [...this.tagCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      notes.push(tag);
    }
    return { vehicle: this.vehicle.name, leading: top, theme: notes[0] || null };
  }

  snapshot() {
    return {
      vehicleId: this.vehicle.id,
      parts: this.parts.map((p) => p.id),
      skills: this.skills.map((s) => ({ id: s.id, level: s.level })),
      stats: { ...this.stats.all() },
    };
  }
}

/** Vehicle stat offsets are flat deltas, not percentages. */
function statDeltasToFlat(stats) {
  if (!stats) return null;
  const out = {};
  for (const [k, v] of Object.entries(stats)) out[k] = { flat: v, pct: 0 };
  return out;
}
