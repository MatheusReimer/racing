import { RNG, randomSeedString } from '../core/rng.js';
import { Build } from '../build/build.js';
import { instantiateSkill } from '../data/skills.js';
import { RARITY } from '../data/parts.js';
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

/**
 * What a point of Durability costs in the garage.
 *
 * Set against what a race pays: a mid-field finish is worth about 55 scrap, and
 * a full 45% repair on a 140-point car is 63 points. At 1.4 that is 88 scrap —
 * most of a race, which is the weight this decision should carry.
 */
const REPAIR_PER_POINT = 1.4;

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
  /**
   * Take back what the pits spent during a race.
   *
   * The race is lent the run's scrap rather than handed a reference to it, so
   * this is where the two are reconciled. Clamped, because a race that somehow
   * reports spending more than the player had must not push the run negative:
   * the sim already refuses to sell what it cannot be paid for, and this is the
   * second lock on the same door.
   */
  spendInRace(amount) {
    const paid = Math.max(0, Math.min(this.scrap, Math.round(amount || 0)));
    this.scrap -= paid;
    return paid;
  }

  finishRace(result, racer) {
    // A race started outside the map (the sandbox entry point used by the
    // tools) has no node behind it. Fall back to a plain race rather than
    // dereferencing null — this is a public entry point.
    const node = this.pending || { type: 'race', outcome: null };
    this.racesRun++;
    // A racer that reports no durability took no damage as far as this run is
    // concerned. `Math.max(0, undefined)` is NaN, and a NaN durability used to
    // stay quietly inside the car — now the garage prices against it, so it
    // would leak into the player's scrap and poison the whole economy.
    this.durability = Number.isFinite(racer.durability)
      ? Math.max(0, racer.durability) : this.durability;

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

  /**
   * Work in the garage, priced.
   *
   * The garage was free — the one node that exists purely to spend money was
   * the one node that took none, while a greedy run finished holding three and
   * a half times what it managed to spend (`tools/economy-probe.mjs`).
   *
   * Priced by what is actually restored, so topping up a healthy car is cheap
   * and dragging a wreck back is not, and never refused for want of funds: it
   * does what the money covers. A garage that turns you away because you are
   * poor is a node wasted on the run that needed it most.
   */
  repairQuote() {
    const missing = Math.max(0, this.maxDurability - this.durability);
    const want = Math.min(missing, this.maxDurability * 0.45);
    return { amount: want, price: Math.ceil(want * REPAIR_PER_POINT) };
  }

  /**
   * Leave the garage having done nothing.
   *
   * There has to be a way out that costs nothing. Both jobs can now refuse —
   * repair when the car is whole, an upgrade when the scrap is not there — and
   * a player who can afford neither was stuck on the screen with no exit.
   */
  leaveRest() {
    this.state = 'map';
    return { ok: true };
  }

  restRepair() {
    const quote = this.repairQuote();
    if (quote.amount <= 0) return { ok: false, reason: 'Nothing to put right.' };

    // Pro rata, never all-or-nothing.
    //
    // Half the price buys half the repair. A garage that turned away a broken
    // car because the wallet was short would be the one node in the run that
    // punishes you for needing it, and the player who most needs it is exactly
    // the one who cannot pay in full.
    const share = Math.min(1, this.scrap / Math.max(1, quote.price));

    // But nothing at all is a refusal, not a transaction. Below this the stop
    // is not worth the node it costs — the garage is a whole map node, and
    // spending it to be told you bought two points of Durability, or none, is
    // worse for the player than being turned away while they still have the
    // choice to go somewhere else.
    if (share < 0.05) {
      return { ok: false, reason: this.scrap > 0
        ? `${quote.price} scrap for a repair. You have ${this.scrap}.`
        : 'No scrap. Nothing anyone can do.' };
    }

    const paid = Math.min(this.scrap, quote.price);
    const healed = this.repairPlayer(quote.amount * share);
    this.scrap -= paid;
    this.state = 'map';
    return {
      ok: true,
      text: share >= 1
        ? `Repaired ${Math.round(healed)} Durability for ${paid} scrap.`
        : `${paid} scrap bought ${Math.round(healed)} Durability`
          + ` — ${Math.round(share * 100)}% of the job, which is what it covered.`,
    };
  }

  /** What a branch or a level costs, before it is bought. */
  upgradeQuote(skillId, branchId = null) {
    const s = this.build.skills.find((x) => x.id === skillId);
    if (!s) return null;
    const rarity = RARITY[s.rarity]?.price ?? 60;
    if (branchId) {
      const branch = s.branches?.find((b) => b.id === branchId);
      if (!branch) return null;
      const rank = s.picks?.[branchId] ?? 0;
      // The second rank down a branch costs more than the first: specialising
      // should be a decision each time, not once.
      return Math.ceil(rarity * (0.55 + rank * 0.45));
    }
    return Math.ceil(rarity * (0.4 + (s.level ?? 1) * 0.18));
  }

  /**
   * What has already been put toward this upgrade, across earlier visits.
   *
   * Held on the skill instance rather than on the run, so it travels with the
   * skill: trade the skill away and the part-payment goes with it, which is
   * the honest answer — you paid a mechanic to work on a thing you no longer
   * own.
   */
  upgradePaid(skillId, branchId = null) {
    const s = this.build.skills.find((x) => x.id === skillId);
    return s?.paid?.[branchId ?? 'lv'] ?? 0;
  }

  restUpgrade(skillId, branchId = null) {
    const price = this.upgradeQuote(skillId, branchId);
    if (price == null) return { ok: false, reason: 'That work cannot be done.' };

    const s = this.build.skills.find((x) => x.id === skillId);
    if (!s) return { ok: false, reason: 'That work cannot be done.' };

    // A rank is discrete — there is no half of a branch to fit — so unlike a
    // repair this cannot be *delivered* in part. What it can do is be paid for
    // in part: scrap goes onto the job and stays there between visits, and the
    // rank lands on the visit that finishes paying for it.
    //
    // That keeps the one rule the economy runs on — you always get what your
    // money is worth — without pretending half a branch exists.
    const key = branchId ?? 'lv';
    s.paid = s.paid ?? {};
    const already = s.paid[key] ?? 0;
    const owed = Math.max(0, price - already);
    const pay = Math.min(this.scrap, owed);
    // The same floor a repair has, and for the same reason: the garage is a
    // whole map node, and spending it to put three scrap onto a forty-scrap
    // job is worse for the player than being turned away while they can still
    // go somewhere else.
    if (owed > 0 && pay < price * 0.05) {
      return { ok: false, reason: this.scrap > 0
        ? `${owed} scrap still owed on that. You have ${this.scrap}.`
        : 'No scrap to put toward it.' };
    }

    this.scrap -= pay;
    const paid = already + pay;
    const label = branchId
      ? `${s.name}: ${s.branches?.find((x) => x.id === branchId)?.name ?? branchId}`
      : s.name;

    if (paid < price) {
      s.paid[key] = paid;
      this.state = 'map';
      return {
        ok: true,
        partial: true,
        text: `${pay} scrap onto ${label}. ${price - paid} more and it is yours.`,
      };
    }

    const ok = this.build.upgradeSkill(skillId, branchId);
    if (!ok) {
      // Refund rather than pocket it: the work could not be done, so it was
      // never sold. Nothing here has changed the build.
      this.scrap += pay;
      return { ok: false, reason: 'That work cannot be done.' };
    }
    // The rank is in. The next one down this branch is a new job at a new
    // price, so the pot starts again rather than carrying over.
    s.paid[key] = 0;
    this.syncBuild();
    this.state = 'map';
    const now = this.build.skills.find((x) => x.id === skillId) ?? s;
    const done = branchId
      ? `${now.name}: ${now.branches?.find((x) => x.id === branchId)?.name ?? branchId}`
      : `${now.name} is now level ${now.level}`;
    return {
      ok: true,
      text: already > 0
        ? `${done}. −${pay} scrap, on top of the ${already} already down.`
        : `${done}. −${pay} scrap.`,
    };
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
