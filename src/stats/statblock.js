import { ATTRIBUTE_IDS, ATTR_MIN, ATTR_MAX, baseStats, derive } from './attributes.js';
import { clamp } from '../core/math.js';

// Modifier stacking.
//
// Two channels, deliberately kept apart:
//
//   `stats`   — the 15 attributes. Flat adds first, then the summed percentage.
//               Percentages sum rather than compound, so three +25% engines are
//               +75% and not +95%. Additive stacking keeps a build's ceiling
//               legible and stops multiplicative runaway.
//
//   `mods`    — named tuning channels that are not attributes (heat generation,
//               energy cost, blast radius...). Multiplicative channels compound,
//               because "half cost" twice genuinely should be a quarter.
//
// A part author writes `topSpeed: 0.25` and gets +25%. The longhand
// `{ pct: 0.25, flat: 10 }` is available when a part needs both.

/**
 * Non-attribute channels. `mult` entries compound around 1; `add` entries sum
 * from 0. Defaults are the identity, so an unmodified build reads clean.
 */
export const MOD_CHANNELS = {
  // --- multiplicative (identity 1) ---
  energyCost: { kind: 'mult', desc: 'Energy price of using a skill' },
  skillCooldown: { kind: 'mult', desc: 'Skill cooldown duration' },
  blastRadius: { kind: 'mult', desc: 'Explosion radius' },
  projectileDamage: { kind: 'mult', desc: 'Damage from projectiles' },
  collisionDamage: { kind: 'mult', desc: 'Damage dealt by ramming' },
  damageTaken: { kind: 'mult', desc: 'Damage received, after armour' },
  electricDamage: { kind: 'mult', desc: 'Damage from Electric sources' },
  explosiveDamage: { kind: 'mult', desc: 'Damage from Explosive sources' },
  trapDamage: { kind: 'mult', desc: 'Damage from Trap sources' },
  driftEnergy: { kind: 'mult', desc: 'Energy earned while drifting' },
  shopPrices: { kind: 'mult', desc: 'Cost of everything in a shop' },
  boostPower: { kind: 'mult', desc: 'Strength of speed boosts' },

  // --- additive (identity 0) ---
  heatGen: { kind: 'add', desc: 'Passive heat generated per second' },
  energyOnKill: { kind: 'add', desc: 'Energy restored per wreck' },
  repairOnKill: { kind: 'add', desc: 'Durability restored per wreck' },
  boostOnKill: { kind: 'add', desc: 'Seconds of boost granted per wreck' },
  energyRegenFlat: { kind: 'add', desc: 'Extra energy per second' },
  rewardChoices: { kind: 'add', desc: 'Extra items offered after a race' },
  rerolls: { kind: 'add', desc: 'Extra reward rerolls per race' },
  skillSlots: { kind: 'add', desc: 'Extra equipped skill slots' },
  partSlots: { kind: 'add', desc: 'Extra part slots' },
  pickupRadius: { kind: 'add', desc: 'Metres of pickup magnetism' },
  collisionSpeedFloor: { kind: 'add', desc: 'Minimum fraction of speed kept through an impact' },
};

export const MOD_IDS = Object.keys(MOD_CHANNELS);

export function baseMods() {
  const out = {};
  for (const [id, ch] of Object.entries(MOD_CHANNELS)) out[id] = ch.kind === 'mult' ? 1 : 0;
  return out;
}

/** Normalise `0.25` and `{ pct: 0.25, flat: 10 }` into the same shape. */
function normaliseStatMod(v) {
  if (typeof v === 'number') return { flat: 0, pct: v };
  return { flat: v.flat || 0, pct: v.pct || 0 };
}

export class StatBlock {
  constructor(base = baseStats()) {
    this.base = { ...base };
    /** Contributions, retained so the UI can attribute every point to a source. */
    this.sources = [];
    this.final = { ...base };
    this.mods = baseMods();
    this._dirty = true;
  }

  /**
   * @param {string} label   shown in the stat breakdown tooltip
   * @param {object} stats   { topSpeed: 0.25, weight: { flat: 40 } }
   * @param {object} mods    { heatGen: 20, energyCost: 0.7 }
   */
  add(label, stats = null, mods = null) {
    this.sources.push({ label, stats: stats || null, mods: mods || null });
    this._dirty = true;
    return this;
  }

  removeByLabel(label) {
    const before = this.sources.length;
    this.sources = this.sources.filter((s) => s.label !== label);
    if (this.sources.length !== before) this._dirty = true;
    return this;
  }

  clearSources() {
    this.sources.length = 0;
    this._dirty = true;
    return this;
  }

  setBase(base) {
    this.base = { ...base };
    this._dirty = true;
    return this;
  }

  /** Recompute `final` and `mods`. Cheap enough to call whenever a part changes. */
  recompute() {
    const flat = {};
    const pct = {};
    for (const id of ATTRIBUTE_IDS) {
      flat[id] = 0;
      pct[id] = 0;
    }
    const mods = baseMods();

    for (const src of this.sources) {
      if (src.stats) {
        for (const [id, raw] of Object.entries(src.stats)) {
          if (!(id in flat)) continue; // ignore typos rather than corrupting the block
          const m = normaliseStatMod(raw);
          flat[id] += m.flat;
          pct[id] += m.pct;
        }
      }
      if (src.mods) {
        for (const [id, v] of Object.entries(src.mods)) {
          const ch = MOD_CHANNELS[id];
          if (!ch) continue;
          if (ch.kind === 'mult') mods[id] *= v;
          else mods[id] += v;
        }
      }
    }

    const final = {};
    for (const id of ATTRIBUTE_IDS) {
      final[id] = clamp((this.base[id] + flat[id]) * (1 + pct[id]), ATTR_MIN, ATTR_MAX);
    }

    this.final = final;
    this.mods = mods;
    this._flat = flat;
    this._pct = pct;
    this._dirty = false;
    return final;
  }

  get(id) {
    if (this._dirty) this.recompute();
    return this.final[id];
  }

  mod(id) {
    if (this._dirty) this.recompute();
    const v = this.mods[id];
    if (v === undefined) return MOD_CHANNELS[id]?.kind === 'mult' ? 1 : 0;
    return v;
  }

  all() {
    if (this._dirty) this.recompute();
    return this.final;
  }

  /** Derived physics for the current attributes. Recomputed on demand. */
  physics() {
    const s = this.all();
    return {
      maxSpeed: derive.maxSpeed(s),
      engineAccel: derive.engineAccel(s),
      gripRate: derive.gripRate(s),
      corneringAccel: derive.corneringAccel(s),
      yawResponse: derive.yawResponse(s),
      driftSpeedKeep: derive.driftSpeedKeep(s),
      driftSteerBonus: derive.driftSteerBonus(s),
      driftGripScrub: derive.driftGripScrub(s),
      driftIdealSlip: derive.driftIdealSlip(s),
      driftBandWidth: derive.driftBandWidth(s),
      driftEnergyRate: derive.driftEnergyRate(s) * this.mod('driftEnergy'),
      steerRate: derive.steerRate(s),
      brakeDecel: derive.brakeDecel(s),
      mass: derive.mass(s),
      impactForce: derive.impactForce(s) * this.mod('collisionDamage'),
      damageReduction: derive.damageReduction(s),
      maxDurability: derive.maxDurability(s),
      maxEnergy: derive.maxEnergy(s),
      energyRegen: derive.energyRegen(s) + this.mod('energyRegenFlat'),
      heatGainScale: derive.heatGainScale(s),
      heatCoolRate: derive.heatCoolRate(s),
      passiveHeat: this.mod('heatGen'),
      weaponDamageScale: derive.weaponDamageScale(s),
      weaponSpeedScale: derive.weaponSpeedScale(s),
      weaponHoming: derive.weaponHoming(s),
      weaponSpread: derive.weaponSpread(s),
      luckScale: derive.luckScale(s),
    };
  }

  /**
   * Per-source contribution to one attribute, for the "where did this number
   * come from" tooltip. Returns entries in the order the parts were equipped.
   */
  breakdown(id) {
    const rows = [{ label: 'Base', flat: this.base[id], pct: 0 }];
    for (const src of this.sources) {
      if (!src.stats || !(id in src.stats)) continue;
      const m = normaliseStatMod(src.stats[id]);
      if (m.flat === 0 && m.pct === 0) continue;
      rows.push({ label: src.label, flat: m.flat, pct: m.pct });
    }
    return rows;
  }

  /**
   * Preview the stats this block *would* have with one extra source, without
   * mutating it. This is what makes the reward screen able to show green and
   * red deltas before the player commits.
   */
  preview(label, stats, mods) {
    const copy = new StatBlock(this.base);
    copy.sources = this.sources.slice();
    copy.add(label, stats, mods);
    copy.recompute();
    return copy;
  }

  /** Signed differences from `other` to `this`, for delta display. */
  diffFrom(other) {
    const a = other.all();
    const b = this.all();
    const out = {};
    for (const id of ATTRIBUTE_IDS) {
      const d = b[id] - a[id];
      if (Math.abs(d) > 0.01) out[id] = d;
    }
    return out;
  }
}
