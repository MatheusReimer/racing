import { chargesOf } from '../data/skills.js';

// Pit stops: the one place scrap is spent while the race is still running.
//
// Everything else in the run spends scrap between races, where the decision is
// made calmly with the whole build in front of you. A pit is the same currency
// asked for under a different pressure: you are third, the car is at 40%, and
// the mechanic is eleven seconds away down a lane you cannot race on.
//
// That is the shape of it, and it is why a pit charges *twice*:
//
//   * time, which is not a number here but the geometry of the lane — it is
//     longer than the line it leaves and the limiter holds you to a crawl
//     along it — so a pit stop costs places, visibly, while you are in it;
//   * scrap, which is the same scrap that buys upgrades in the garage and
//     skills in the shop, so a stop is money not spent on the build.
//
// The second one is the whole point of the single currency. Saving is not free
// — hoarding through a race you then lose pays nothing at all — and spending is
// not free either, because the garage is waiting. There is no right answer,
// which is what makes it a decision.
//
// You choose a pit by *driving into it*. No menu, no pause: the game does not
// stop, and a screen at 200 km/h would be a different game. The service is
// applied on the way out, so a car that dips a wheel into the entry and thinks
// better of it is charged nothing.

/**
 * Speed the limiter holds in the lane, m/s. About 68 km/h.
 *
 * Set from the geometry rather than picked: the tightest taper any generated
 * lane has will hold about 76 km/h, and a limit above that would mean the
 * corner governed the lane and the limiter was decoration. Under it, the
 * limiter is the thing the player feels, which is the point.
 */
export const PIT_SPEED_LIMIT = 19;

/** Scrap per point of Durability, in the lane. */
const PIT_REPAIR_PER_POINT = 1.15;

/** Scrap per point of Energy. */
const PIT_FUEL_PER_POINT = 0.45;

/**
 * Scrap for one round back in a skill's magazine.
 *
 * Set against a race's purse, which is about 55 scrap for a mid-field finish.
 * At 22 a charge the first version wanted 220 to refill two skills, which is
 * four races for something that lasts one — a price nobody pays is not a sink,
 * it is a service that is not there. At 14, buying the three rounds that get
 * you to the flag costs roughly one race's pay, which is a decision.
 */
const PIT_RELOAD_PER_CHARGE = 14;

/** How long a car must be in the lane for the stop to count, seconds. */
export const PIT_MIN_TIME = 0.7;

/**
 * The services.
 *
 * `quote` says what this racer would get and what it would cost right now;
 * `apply` does that much of it. They are separate because the HUD has to show
 * the price on the approach, before anything is committed.
 *
 * A quote of zero means the service has nothing to offer — a full car at the
 * mechanic — and the lane charges nothing for it.
 */
export const PIT_SERVICES = {
  mechanic: {
    id: 'mechanic',
    name: 'Mechanic',
    short: 'REPAIR',
    blurb: 'mends up to 40% of the car, for scrap',
    icon: '\u{1F527}',
    color: '#5fd08a',
    quote(racer) {
      // Never the whole car. A pit that mends everything makes durability a
      // toll rather than a resource, and the garage between races is where a
      // wreck is supposed to be properly put right.
      const amount = Math.min(racer.maxDurability - racer.durability,
        racer.maxDurability * 0.40);
      return { amount, price: Math.ceil(amount * PIT_REPAIR_PER_POINT), unit: 'Durability' };
    },
    apply(racer, amount) {
      return `+${Math.round(racer.repair(amount))} Durability`;
    },
  },

  fuel: {
    id: 'fuel',
    name: 'Fuel Stop',
    short: 'ENERGY',
    blurb: 'refills Energy and dumps the heat',
    icon: '⛽',
    color: '#4fa3e3',
    quote(racer) {
      const amount = Math.min(racer.maxEnergy - racer.energy, racer.maxEnergy * 0.7);
      return { amount, price: Math.ceil(amount * PIT_FUEL_PER_POINT), unit: 'Energy' };
    },
    apply(racer, amount) {
      const got = racer.addEnergy(amount);
      // Fresh fuel and a few seconds stopped: the heat goes with it. Free, and
      // deliberately so — it is what makes the fuel stop worth taking on a car
      // that is not short of energy but is cooking.
      racer.heat = Math.max(0, racer.heat - 45);
      return `+${Math.round(got)} Energy`;
    },
  },

  armory: {
    id: 'armory',
    name: 'Armory',
    short: 'RELOAD',
    blurb: 'puts rounds back in your skills',
    icon: '\u{1F6E0}',
    color: '#e0954f',
    // Discrete rather than scaled: a charge is a whole use of a skill, so this
    // one buys them one at a time and stops when the money does.
    //
    // It also clears the cooldowns on the way out, free. You have just spent
    // ten seconds stationary in a lane; a skill still counting down after that
    // would be the lane charging you twice.
    quote(racer) {
      const empty = (racer.charges ?? []).reduce((a, c, i) => {
        const full = chargesOf(racer.build?.skills?.[i], racer.build?.stats);
        return a + Math.max(0, full - (c ?? full));
      }, 0);
      return { amount: empty, price: empty * PIT_RELOAD_PER_CHARGE, unit: 'charges' };
    },
    apply(racer, amount) {
      let loaded = 0;
      // One round at a time, into the emptiest magazine first: a partial reload
      // should leave every skill usable rather than one skill full and the
      // rest dry.
      for (let k = 0; k < amount; k++) {
        let worst = -1;
        let gap = 0;
        (racer.charges ?? []).forEach((c, i) => {
          const full = chargesOf(racer.build?.skills?.[i], racer.build?.stats);
          const missing = full - (c ?? full);
          if (missing > gap) { gap = missing; worst = i; }
        });
        if (worst < 0) break;
        racer.charges[worst] += 1;
        loaded++;
      }
      if (racer.cooldowns) racer.cooldowns.fill(0);
      return loaded === 1 ? '1 charge loaded' : `${loaded} charges loaded`;
    },
  },
};

/**
 * Which service this circuit's pit lane offers.
 *
 * One per circuit, drawn from the seed, so a race's pit is part of that race —
 * the player reads it on the briefing and decides whether the run wants it,
 * rather than finding out at the entry.
 *
 * Drawn from what the car could actually use, not from the whole list. An
 * Armory on a car carrying no skills is a lane that can never do anything, and
 * a third of circuits rolled one: the feature would have been dead as often as
 * it was alive, on a car whose build simply had not got there yet.
 *
 * @param rng    a fork of the race's seed
 * @param track  the generated track; its pit lane is the branch flagged isPit
 * @param racer  the player's car, for what its build can make use of
 */
export function assignPit(rng, track, racer = null) {
  const lane = track?.branches?.find((b) => b.isPit);
  if (!lane) return null;
  const ids = Object.keys(PIT_SERVICES).filter((id) => {
    if (id !== 'armory') return true;
    return (racer?.build?.skills?.length ?? racer?.cooldowns?.length ?? 0) > 0;
  });
  return { lane, service: PIT_SERVICES[ids[rng.int(0, ids.length - 1)]] };
}

/**
 * Buy as much of a service as the money on hand covers.
 *
 * Partial rather than all-or-nothing, which is the opposite of how the garage
 * prices an upgrade — and deliberately. The garage can refuse because you can
 * walk away from it having lost nothing. By the time this is called the lane
 * has already been driven and the time already paid, so refusing outright
 * would take the price twice and hand back nothing.
 *
 * @returns { paid, text } or null if there was nothing to sell
 */
export function servePit(service, racer, scrap) {
  // A wheel change, free, whatever the lane sells.
  //
  // You stopped. Somebody was standing there. Charging for the tyre would be
  // charging twice for a stop you already paid five seconds for — and it is
  // what makes the lane worth taking on a car that is otherwise fine, which
  // is the only reason a puncture is a decision rather than a tax.
  let wheel = null;
  if (racer.body?.speedPenaltyTimer > 0) {
    racer.body.speedPenalty = 1;
    racer.body.speedPenaltyTimer = 0;
    const st = racer.statuses?.findIndex((x) => x.id === 'punctured');
    if (st != null && st >= 0) racer.statuses.splice(st, 1);
    wheel = 'Wheel changed';
  }

  const quote = service.quote(racer);
  if (!(quote.amount > 0)) return wheel ? { paid: 0, text: wheel } : null;
  const join = (t) => (wheel ? `${wheel} · ${t}` : t);
  if (quote.price <= 0) return { paid: 0, text: join(service.apply(racer, quote.amount)) };

  const share = Math.min(1, scrap / quote.price);
  if (share <= 0) {
    return { paid: 0, text: wheel ? `${wheel} · no scrap for anything else` : 'No scrap. Nothing done.' };
  }

  // Floored for the discrete services: a third of a charge is not a thing to
  // hand out, and rounding up would sell what was not paid for.
  const amount = quote.unit === 'charges'
    ? Math.floor(quote.amount * share) : quote.amount * share;
  if (!(amount > 0)) {
    return { paid: 0, text: wheel ? `${wheel} · not enough scrap for more` : 'Not enough scrap.' };
  }

  const paid = Math.min(scrap, Math.ceil(quote.price * (amount / quote.amount)));
  const text = service.apply(racer, amount);
  // The same phrasing the garage uses, because it is the same rule: the share
  // of the price you could pay is the share of the job you get.
  return {
    paid,
    text: join(share >= 1 ? text : `${text} — ${Math.round(share * 100)}%`),
  };
}
