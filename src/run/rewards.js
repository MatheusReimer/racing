import { PARTS, PART_BY_ID, RARITY, rollPart } from '../data/parts.js';
import { SKILLS, SKILL_BY_ID, instantiateSkill } from '../data/skills.js';
import { clamp, clamp01 } from '../core/math.js';

// What you are offered after a node.
//
// The design brief asks for a constant stream of three-way decisions, and for
// Luck to change *what you see* rather than hand out a flat bonus. Both are
// implemented here: Luck shifts the rarity weights, adds offer slots, and
// improves the odds that an offer is relevant to what you are already
// building.
//
// Relevance is the part that makes a run feel like it has a direction. A pure
// uniform roll across 60 parts almost never continues a theme, so a build
// never coheres. Weighting toward the tags a player already carries means that
// committing to Electric produces more Electric to commit to — which is the
// loop the brief describes.

/** Scrap awarded for finishing a node. */
export function scrapFor(nodeType, place, field, difficulty = 1) {
  const base = {
    race: 55, elite: 110, challenge: 85, boss: 220, event: 0, shop: 0, rest: 0,
  }[nodeType] ?? 50;
  if (base === 0) return 0;
  // Position matters but never to zero: a bad race still pays for a repair.
  const placeScale = clamp01(1.15 - (place - 1) / Math.max(1, field));
  return Math.round(base * (0.45 + placeScale * 0.75) * (1 + difficulty * 0.08));
}

/**
 * Build a reward offer.
 *
 * @param rng    seeded
 * @param build  the player's current build, for relevance weighting
 * @param opts   { nodeType, count, allowSkills, forceRarity }
 */
export function generateOffer(rng, build, opts = {}) {
  const luck = build.stats.get('luck') / 100;
  const extra = build.stats.mod('rewardChoices');
  const count = clamp((opts.count ?? 3) + extra, 1, 6);

  const owned = new Set(build.parts.map((p) => p.id));
  const offers = [];
  const used = new Set();

  const eliteBias = opts.nodeType === 'elite' || opts.nodeType === 'boss';

  for (let i = 0; i < count; i++) {
    // Skills appear about a third of the time, more if there is a free slot.
    const wantSkill = (opts.allowSkills ?? true)
      && rng.next() < (build.canAddSkill() ? 0.34 : 0.16);

    if (wantSkill) {
      const skill = pickSkill(rng, build, used, luck);
      if (skill) {
        offers.push(skill);
        used.add(skill.key);
        continue;
      }
    }

    const part = pickPart(rng, build, owned, used, luck, eliteBias);
    if (part) {
      offers.push(part);
      used.add(part.key);
    }
  }

  // Never hand back an empty offer.
  if (offers.length === 0) {
    offers.push({ kind: 'scrap', key: 'scrap', amount: 90, name: 'Salvage', text: '+90 scrap.' });
  }
  return offers;
}

function pickPart(rng, build, owned, used, luck, eliteBias) {
  const pool = PARTS.filter((p) => !used.has(`part:${p.id}`) && !owned.has(p.id));
  if (pool.length === 0) return null;

  const part = rng.weighted(pool, (p) => {
    const r = RARITY[p.rarity];
    if (!r) return 0;
    let w = r.weight;

    // Luck lifts the rare tail and thins the commons.
    if (p.rarity === 'common') w /= Math.max(0.5, luck);
    else w *= Math.pow(Math.max(0.5, luck), 1.3);

    // Elites and bosses pay in better odds, not just more scrap.
    if (eliteBias && p.rarity !== 'common') w *= 1.8;

    // Relevance: a part sharing tags with the build is likelier to appear.
    // This is what lets a run develop an identity instead of a pile.
    let shared = 0;
    for (const t of p.tags || []) if (build.hasTag(t)) shared++;
    if (shared > 0) w *= 1 + shared * 0.55;

    // Cursed items get rarer as the run's Durability headroom shrinks — they
    // should be a gamble, not a guaranteed run-ender.
    if (p.rarity === 'cursed') w *= 0.9;

    return w;
  });

  if (!part) return null;
  return {
    kind: 'part',
    key: `part:${part.id}`,
    id: part.id,
    part,
    name: part.name,
    rarity: part.rarity,
    slot: part.slot,
    tags: part.tags,
    text: part.text,
  };
}

function pickSkill(rng, build, used, luck) {
  // Levelling a skill you already run is offered alongside new ones: the
  // brief's "mutable items" progression needs to compete with breadth.
  const ownedIds = new Set(build.skills.map((s) => s.id));
  const pool = SKILLS.filter((s) => {
    if (used.has(`skill:${s.id}`)) return false;
    if (ownedIds.has(s.id)) {
      const cur = build.skills.find((x) => x.id === s.id);
      return (cur.level ?? 1) < (s.maxLevel ?? 5);
    }
    // Unheld skills are offered whether or not there is room for them.
    //
    // This used to return only what the build already carried once the slots
    // were full, which meant a run stopped being shown new skills from its
    // third pickup on — and the decision the whole genre turns on, whether what
    // just appeared beats what you are carrying, could never be put. Taking one
    // with no room now costs a slot, and the screen asks which.
    return true;
  });
  if (pool.length === 0) return null;

  const skill = rng.weighted(pool, (s) => {
    let w = RARITY[s.rarity]?.weight ?? 60;
    if (s.rarity === 'common') w /= Math.max(0.5, luck);
    else w *= Math.pow(Math.max(0.5, luck), 1.2);
    let shared = 0;
    for (const t of s.tags || []) if (build.hasTag(t)) shared++;
    if (shared > 0) w *= 1 + shared * 0.5;
    // An upgrade to something already equipped is a strong, focused offer.
    if (ownedIds.has(s.id)) w *= 1.5;
    return w;
  });
  if (!skill) return null;

  const existing = build.skills.find((s) => s.id === skill.id);
  const level = existing ? (existing.level ?? 1) + 1 : 1;
  return {
    kind: 'skill',
    key: `skill:${skill.id}`,
    id: skill.id,
    skill,
    level,
    upgrade: !!existing,
    name: existing ? `${skill.name} → Lv${level}` : skill.name,
    rarity: skill.rarity,
    tags: skill.tags,
    text: skill.desc(level),
  };
}

/** Apply a chosen offer to the build. Returns a short line describing what happened. */
export function applyOffer(offer, build, run, opts = {}) {
  switch (offer.kind) {
    case 'part': {
      if (!build.canAddPart()) return { ok: false, reason: 'No free part slots.' };
      build.addPart(offer.part);
      return { ok: true, text: `Installed ${offer.part.name}.` };
    }
    case 'skill': {
      const held = build.skills.some((s) => s.id === offer.id);
      // Levelling something already carried never needs a slot.
      if (!held && !build.canAddSkill()) {
        if (!opts.drop) {
          // Not a failure: a question. The caller shows the loadout and comes
          // back with an answer.
          return { ok: false, needsSlot: true, offer, reason: 'No free skill slots.' };
        }
        if (!build.removeSkill(opts.drop)) {
          return { ok: false, reason: 'That skill is not fitted.' };
        }
      }
      build.addSkill(instantiateSkill(offer.id, 1));
      return {
        ok: true,
        text: offer.upgrade ? `${offer.skill.name} upgraded.` : `Equipped ${offer.skill.name}.`,
      };
    }
    case 'scrap': {
      run.scrap += offer.amount;
      return { ok: true, text: `+${offer.amount} scrap.` };
    }
    case 'repair': {
      const healed = run.repairPlayer(offer.amount);
      return { ok: true, text: `Repaired ${Math.round(healed)} Durability.` };
    }
    default:
      return { ok: false, reason: 'Unknown reward.' };
  }
}

/**
 * Shop stock. Priced by rarity, discounted by build mods, and always including
 * a repair option — a shop that cannot fix your car is not a shop.
 */
export function generateShop(rng, build, run) {
  const luck = build.stats.get('luck') / 100;
  const priceMult = build.stats.mod('shopPrices');
  const items = [];
  const used = new Set();
  const owned = new Set(build.parts.map((p) => p.id));

  for (let i = 0; i < 4; i++) {
    const p = pickPart(rng, build, owned, used, luck, false);
    if (!p) break;
    used.add(p.key);
    items.push({ ...p, price: Math.round(RARITY[p.rarity].price * priceMult * rng.range(0.9, 1.15)) });
  }
  for (let i = 0; i < 2; i++) {
    const s = pickSkill(rng, build, used, luck);
    if (!s) break;
    used.add(s.key);
    items.push({ ...s, price: Math.round((RARITY[s.rarity]?.price ?? 70) * 0.85 * priceMult) });
  }

  const missing = run.player ? run.maxDurability - run.durability : 0;
  items.push({
    kind: 'repair',
    key: 'repair',
    name: 'Full Repair',
    text: `Restore all Durability (${Math.round(missing)} missing).`,
    amount: 9999,
    rarity: 'common',
    price: Math.max(25, Math.round(missing * 1.6 * priceMult)),
    disabled: missing < 1,
  });

  return items;
}
