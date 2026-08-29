import { RNG, randomSeedString } from '../core/rng.js';
import { Build } from '../build/build.js';
import { instantiateSkill } from '../data/skills.js';
import { generateMap, NODE_TYPES } from './nodemap.js';
import { generateOffer, generateShop, applyOffer, scrapFor } from './rewards.js';
import { biomeForRegion, drawItinerary, BIOMES } from '../data/biomes.js';
import { RUN_EVENTS } from '../data/events.js';
import { MODIFIERS, rollModifiers } from '../data/modifiers.js';
import { BOSSES, bossForRegion } from '../data/bosses.js';
import { clamp, clamp01 } from '../core/math.js';

// Run state: the thing that persists between races.
//
// The Run owns the build, the money, the map, and — importantly — the car's
// *condition*. Durability does not reset between races. That single decision
// is what turns a sequence of races into a run: it means a scrappy win costs
// something, that a Garage is a real choice against a Shop, and that the
// question at every node is "can I afford this" rather than "which button".
//
// Everything here is driven from one seed, so a run is reproducible end to end
// for bug reports and for seeded competition.

export const REGIONS_PER_RUN = 3;

export class Run {
  constructor({ seed = randomSeedString(), vehicleId = 'hatch', regions = REGIONS_PER_RUN } = {}) {
    this.seed = seed;
    this.rng = new RNG(seed);
    this.regionCount = regions;

    this.build = new Build(vehicleId);
    // Every machine arrives with one skill that expresses its identity, so the
    // first race has something to do besides steer and the vehicle rules that
    // key off skills are live from the start.
    if (this.build.vehicle.startingSkill) {
      this.build.addSkill(instantiateSkill(this.build.vehicle.startingSkill, 1));
    }
    this.scrap = 120;
    this.regionIndex = 0;
    this.map = generateMap(seed, 0);
    // Drawn up front from the run seed, so a run is still reproducible end to
    // end and the map screen can say where it is going.
    this.itinerary = drawItinerary(this.rng.fork('itinerary'), this.regionCount);
    this.biome = this.itinerary[0];

    // Car condition carries across races. This is the spine of the whole mode.
    this.maxDurability = this.build.physics.maxDurability;
    this.durability = this.maxDurability;

    this.state = 'map';   // map | race | reward | shop | event | rest | dead | victory
    this.pending = null;   // node being resolved
    this.offer = null;
    this.shopStock = null;
    this.currentEvent = null;
    this.rerollsLeft = 0;

    this.history = [];
    this.racesRun = 0;
    this.wins = 0;
    this.wrecks = 0;
    this.startedAt = Date.now();
  }

  // --- condition -----------------------------------------------------------

  /** Re-derive max durability after a part change, preserving damage taken. */
  syncBuild() {
    const frac = this.maxDurability > 0 ? this.durability / this.maxDurability : 1;
    this.build.recompute();
    this.maxDurability = this.build.physics.maxDurability;
    this.durability = clamp(this.maxDurability * frac, 0, this.maxDurability);
  }

  repairPlayer(amount) {
    const before = this.durability;
    this.durability = Math.min(this.maxDurability, this.durability + amount);
    return this.durability - before;
  }

  get durabilityFrac() {
    return clamp01(this.durability / Math.max(1, this.maxDurability));
  }

  get difficulty() {
    // Rises through a region and steps up between them.
    return this.regionIndex * 1.6 + this.map.depth * 0.16;
  }

  // --- map navigation ------------------------------------------------------

  availableNodes() {
    return this.map.options().filter((n) => !n.visited);
  }

  /** Enter a node. Returns the state the UI should switch to. */
  choose(node) {
    if (!this.map.enter(node)) return null;
    this.pending = node;

    switch (node.type) {
      case 'race':
      case 'elite':
      case 'challenge':
      case 'boss':
        this.state = 'race';
        return this.buildRaceConfig(node);
      case 'shop':
        this.shopStock = generateShop(this.rng.fork(`shop${node.id}`), this.build, this);
        this.state = 'shop';
        return null;
      case 'event':
        this.currentEvent = this.pickEvent(node);
        this.state = 'event';
        return null;
      case 'rest':
        this.state = 'rest';
        return null;
      default:
        this.state = 'map';
        return null;
    }
  }

  /** Race parameters for a node — this is where node type becomes gameplay. */
  buildRaceConfig(node) {
    const rng = this.rng.fork(`race${this.regionIndex}:${node.id}`);
    const difficulty = this.difficulty;

    const cfg = {
      seed: `${this.seed}:${this.regionIndex}:${node.id}`,
      biome: this.biome,
      laps: 2,
      rivals: 5,
      difficulty,
      nodeType: node.type,
      modifiers: rollModifiers(rng, node.type, this.regionIndex),
      challenge: null,
      boss: null,
    };

    if (node.type === 'elite') {
      cfg.difficulty = difficulty + 1.4;
      cfg.rivals = 6;
      cfg.rivalArchetypes = ['hunter', 'tank', 'bomber', 'hunter', 'disruptor', 'racer'];
    }

    if (node.type === 'challenge') {
      cfg.challenge = rng.pick(CHALLENGES);
      cfg.laps = cfg.challenge.laps ?? 2;
    }

    if (node.type === 'boss') {
      const boss = bossForRegion(this.regionIndex);
      cfg.boss = boss;
      cfg.difficulty = difficulty + 2.2;
      cfg.laps = boss.laps ?? 3;
      cfg.rivals = boss.rivals ?? 4;
      cfg.rivalArchetypes = boss.archetypes;
      cfg.modifiers = [...cfg.modifiers, ...(boss.modifiers || [])];
      cfg.lengthScale = boss.lengthScale ?? 1;
    }

    this.pendingConfig = cfg;
    return cfg;
  }

  // --- resolving a race ----------------------------------------------------

  /**
   * @param result  from RaceSim: { outcome, place, time, field }
   * @param racer   the player's Racer, for carrying condition back out
   */
  finishRace(result, racer) {
    // A race started outside the map (the sandbox entry point used by the
    // tools) has no node behind it. Fall back to a plain race rather than
    // dereferencing null — this is a public entry point.
    const node = this.pending || { type: 'race', outcome: null };
    this.racesRun++;
    this.durability = Math.max(0, racer.durability);

    const challenge = this.pendingConfig?.challenge;
    let challengeMet = false;
    if (challenge) challengeMet = challenge.check(racer, result);

    if (result.outcome === 'destroyed' || this.durability <= 0) {
      this.state = 'dead';
      this.deathCause = result.outcome === 'destroyed' ? 'Destroyed' : 'Wrecked';
      this.history.push({ node: node.type, outcome: 'destroyed' });
      return { dead: true };
    }

    if (result.place === 1) this.wins++;

    // Between-race servicing. Damage carrying between races is the spine of
    // the mode, but with no recovery at all a run is over in two races and no
    // build ever forms. A modest automatic repair keeps attrition meaningful
    // while leaving the Garage and the Shop as the real answers to a bad race.
    this.repairPlayer(this.maxDurability * 0.25);

    const scrap = scrapFor(node.type, result.place, result.field ?? 6, this.difficulty)
      + (challengeMet ? 70 : 0);
    this.scrap += scrap;

    node.outcome = { place: result.place, time: result.time, challengeMet };
    this.history.push({
      node: node.type, place: result.place, time: result.time, scrap, challengeMet,
    });

    // Better finishes and met challenges buy better offers.
    const offerRng = this.rng.fork(`offer${this.regionIndex}:${node.id}`);
    const bonus = (result.place === 1 ? 1 : 0) + (challengeMet ? 1 : 0);
    this.offer = generateOffer(offerRng, this.build, {
      nodeType: node.type,
      count: 3 + (node.type === 'elite' || node.type === 'boss' ? 1 : 0) + bonus,
    });
    this.rerollsLeft = 1 + this.build.stats.mod('rerolls');
    this.state = 'reward';

    return { dead: false, scrap, challengeMet, place: result.place };
  }

  takeOffer(offer, opts = {}) {
    const res = applyOffer(offer, this.build, this, opts);
    // A skill with nowhere to go is a question, not a refusal: the run stays
    // exactly where it was until the caller comes back with which one goes.
    if (res.needsSlot) return res;
    if (!res.ok) return res;
    this.syncBuild();
    this.afterReward();
    return res;
  }

  skipOffer() {
    // Skipping pays: a build that already knows what it is should not be
    // punished for refusing an item that would dilute it.
    this.scrap += 45;
    this.afterReward();
    return { ok: true, text: '+45 scrap for passing.' };
  }

  reroll() {
    if (this.rerollsLeft <= 0) return false;
    this.rerollsLeft--;
    this.offer = generateOffer(this.rng.fork(`reroll${this.racesRun}:${this.rerollsLeft}`),
      this.build, { nodeType: this.pending?.type });
    return true;
  }

  afterReward() {
    this.offer = null;
    if (this.pending?.type === 'boss') this.advanceRegion();
    else this.state = 'map';
  }

  advanceRegion() {
    this.regionIndex++;
    if (this.regionIndex >= this.regionCount) {
      this.state = 'victory';
      return;
    }
    this.biome = this.itinerary[this.regionIndex] ?? biomeForRegion(this.regionIndex);
    this.map = generateMap(this.seed, this.regionIndex);
    // A region transition repairs a slice of the car — the run should get
    // harder, but arriving at a new region already dead is not difficulty.
    this.repairPlayer(this.maxDurability * 0.35);
    this.state = 'map';
  }

  // --- shop ----------------------------------------------------------------

  buy(item, opts = {}) {
    if (item.disabled) return { ok: false, reason: 'Nothing to buy.' };
    if (this.scrap < item.price) return { ok: false, reason: 'Not enough scrap.' };
    if (item.kind === 'part' && !this.build.canAddPart()) {
      return { ok: false, reason: 'No free part slots.' };
    }

    this.scrap -= item.price;
    const res = applyOffer(item, this.build, this, opts);
    if (!res.ok) {
      this.scrap += item.price;   // refund a purchase we could not apply
      // A full skill loadout is the same question here as on the reward
      // screen, and asking it is not a failure. Without this the shop simply
      // refused to sell skills once the slots were full, refunding in silence.
      return res;
    }
    this.syncBuild();
    item.sold = true;
    return res;
  }

  leaveShop() {
    this.shopStock = null;
    this.state = 'map';
  }

  // --- garage --------------------------------------------------------------

  restRepair() {
    const healed = this.repairPlayer(this.maxDurability * 0.45);
    this.state = 'map';
    return { ok: true, text: `Repaired ${Math.round(healed)} Durability.` };
  }

  restUpgrade(skillId, branchId = null) {
    const ok = this.build.upgradeSkill(skillId, branchId);
    if (!ok) return { ok: false, reason: 'That work cannot be done.' };
    this.syncBuild();
    this.state = 'map';
    const s = this.build.skills.find((x) => x.id === skillId);
    if (branchId) {
      const b = s.branches?.find((x) => x.id === branchId);
      return { ok: true, text: `${s.name}: ${b?.name ?? branchId}.` };
    }
    return { ok: true, text: `${s.name} is now level ${s.level}.` };
  }

  // --- events --------------------------------------------------------------

  pickEvent(node) {
    const rng = this.rng.fork(`event${this.regionIndex}:${node.id}`);
    const pool = RUN_EVENTS.filter((e) => !e.when || e.when(this));
    const chosen = rng.pick(pool) || RUN_EVENTS[0];
    return { ...chosen, rng };
  }

  resolveEvent(choiceIndex) {
    const ev = this.currentEvent;
    if (!ev) return { ok: false };
    const choice = ev.choices[choiceIndex];
    if (!choice) return { ok: false };
    const result = choice.apply(this, ev.rng) || {};
    this.currentEvent = null;
    if (this.durability <= 0) {
      this.state = 'dead';
      this.deathCause = 'Wrecked';
      return { ...result, dead: true };
    }
    this.state = 'map';
    return { ok: true, ...result };
  }

  // --- summary -------------------------------------------------------------

  /**
   * The story of the run, as the design brief's north star asks for: not a
   * score, but an account of what the car became and how.
   */
  summary() {
    const s = this.build.stats.all();
    const tags = [...this.build.tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    const top = Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return {
      seed: this.seed,
      vehicle: this.build.vehicle.name,
      regionsCleared: this.regionIndex,
      races: this.racesRun,
      wins: this.wins,
      scrap: this.scrap,
      parts: this.build.parts.map((p) => p.name),
      skills: this.build.skills.map((k) => `${k.name} Lv${k.level ?? 1}`),
      theme: tags.slice(0, 3).map(([t, n]) => `${t} x${n}`),
      leading: top.map(([k, v]) => `${k} ${Math.round(v)}`),
      minutes: (Date.now() - this.startedAt) / 60000,
      outcome: this.state === 'victory' ? 'victory' : this.state === 'dead' ? 'destroyed' : 'in progress',
      cause: this.deathCause || null,
    };
  }
}

/** Challenge rules. Each is a different way to be good at a race. */
export const CHALLENGES = [
  {
    id: 'flawless', name: 'Flawless',
    text: 'Finish without dropping below 70% Durability.',
    check: (racer) => racer.durabilityFrac >= 0.7,
  },
  {
    id: 'demolition', name: 'Demolition',
    text: 'Wreck at least 2 rivals.',
    check: (racer) => racer.stats.kills >= 2,
  },
  {
    id: 'velocity', name: 'Velocity',
    text: 'Reach 200 km/h.',
    check: (racer) => racer.stats.topSpeed >= 200,
  },
  {
    id: 'sideways', name: 'Sideways',
    text: 'Spend 8 seconds drifting.',
    check: (racer) => racer.stats.drifted >= 8,
  },
  {
    id: 'clean', name: 'Clean Line',
    text: 'Spend under 4 seconds off track.',
    check: (racer) => racer.stats.offTrack < 4,
  },
  {
    id: 'podium', name: 'Podium or Nothing',
    text: 'Finish first.',
    laps: 3,
    check: (racer, result) => result.place === 1,
  },
];
