import { rollPart, PARTS, PART_BY_ID } from './parts.js';
import { instantiateSkill, SKILLS } from './skills.js';

// Run events.
//
// The brief asks events to be able to change a run permanently — offering
// upgrades, trades, risks, repairs, curses. So every event here has at least
// one choice with a real cost, and several can genuinely make a run worse.
// An event where all options are good is just a delayed reward screen.
//
// `when(run)` gates an event on run state, so "sell a part" never appears to a
// player who has no parts.

const pick = (rng, arr) => arr[Math.floor(rng.next() * arr.length)];

export const RUN_EVENTS = [
  {
    id: 'scrapyard',
    title: 'The Scrapyard',
    body: 'A hill of dead machines. The owner watches you from a deck chair and '
      + 'does not offer to help.',
    choices: [
      {
        label: 'Strip something useful',
        detail: 'Gain a random part. It might be cursed.',
        apply: (run, rng) => {
          if (!run.build.canAddPart()) return { text: 'No free part slots — you take 60 scrap instead.', scrap: (run.scrap += 60) };
          const part = rollPart(rng, { luck: run.build.stats.get('luck') / 100 });
          run.build.addPart(part);
          run.syncBuild();
          return { text: `You pull a ${part.name} out of the pile.` };
        },
      },
      {
        label: 'Sell him your scrap metal',
        detail: '+130 scrap.',
        apply: (run) => { run.scrap += 130; return { text: '+130 scrap.' }; },
      },
      {
        label: 'Leave',
        detail: 'Repair 20% Durability while you are stopped.',
        apply: (run) => {
          const h = run.repairPlayer(run.maxDurability * 0.2);
          return { text: `You patch the worst of it. +${Math.round(h)} Durability.` };
        },
      },
    ],
  },

  {
    id: 'roadside_mechanic',
    title: 'Roadside Mechanic',
    body: 'She looks at your car the way a doctor looks at a smoker.',
    choices: [
      {
        label: 'Full rebuild',
        detail: 'Costs 110 scrap. Repairs everything.',
        apply: (run) => {
          if (run.scrap < 110) return { text: 'You cannot afford it. She shrugs.' };
          run.scrap -= 110;
          const h = run.repairPlayer(run.maxDurability);
          return { text: `Fully repaired. +${Math.round(h)} Durability.` };
        },
      },
      {
        label: 'Let her tune it aggressively',
        detail: '+12% Top Speed permanently, -15% Durability.',
        apply: (run) => {
          run.build.stats.add('Aggressive Tune', { topSpeed: 0.12, durability: -0.15 });
          run.build.recompute();
          run.syncBuild();
          return { text: 'Faster. Thinner.' };
        },
      },
      {
        label: 'Decline',
        detail: 'Nothing happens.',
        apply: () => ({ text: 'You drive on.' }),
      },
    ],
  },

  {
    id: 'the_wager',
    title: 'The Wager',
    body: 'A driver with too many teeth offers to bet on your next race.',
    choices: [
      {
        label: 'Take the bet',
        detail: 'Risk 100 scrap on a coin flip for 260.',
        apply: (run, rng) => {
          if (run.scrap < 100) return { text: 'You have nothing to bet with.' };
          // Luck genuinely moves the odds — that is the whole point of the stat.
          const luck = run.build.stats.get('luck') / 100;
          const odds = Math.min(0.78, 0.45 * luck);
          if (rng.next() < odds) {
            run.scrap += 160;
            return { text: 'You win. +160 scrap.' };
          }
          run.scrap -= 100;
          return { text: 'You lose. -100 scrap.' };
        },
      },
      {
        label: 'Bet your paint instead',
        detail: 'Lose 25% Durability for 200 scrap.',
        apply: (run) => {
          run.durability = Math.max(1, run.durability - run.maxDurability * 0.25);
          run.scrap += 200;
          return { text: 'He takes a panel off with a crowbar. +200 scrap.' };
        },
      },
      { label: 'Walk away', detail: 'Nothing happens.', apply: () => ({ text: 'Wise.' }) },
    ],
  },

  {
    id: 'the_offer',
    title: 'An Unmarked Crate',
    body: 'It is humming. There is no label.',
    choices: [
      {
        label: 'Open it',
        detail: 'A random Epic or Legendary part. Might be Cursed.',
        apply: (run, rng) => {
          if (!run.build.canAddPart()) return { text: 'Nowhere to put it. You leave it.' };
          const pool = PARTS.filter((p) => ['epic', 'legendary', 'cursed'].includes(p.rarity)
            && !run.build.parts.some((x) => x.id === p.id));
          if (pool.length === 0) return { text: 'Empty. Of course.' };
          const part = pick(rng, pool);
          run.build.addPart(part);
          run.syncBuild();
          return { text: `${part.name}. ${part.text}` };
        },
      },
      {
        label: 'Sell it unopened',
        detail: '+180 scrap.',
        apply: (run) => { run.scrap += 180; return { text: '+180 scrap. You wonder about it later.' }; },
      },
    ],
  },

  {
    id: 'the_pit',
    title: 'Underground Pit',
    body: 'They will let you run one lap against their champion. No rules.',
    choices: [
      {
        label: 'Run it',
        detail: 'Take 20% damage, gain 220 scrap and a skill.',
        apply: (run, rng) => {
          run.durability = Math.max(1, run.durability - run.maxDurability * 0.2);
          run.scrap += 220;
          if (run.build.canAddSkill()) {
            const pool = SKILLS.filter((s) => !run.build.skills.some((x) => x.id === s.id));
            if (pool.length) {
              const s = pick(rng, pool);
              run.build.addSkill(instantiateSkill(s.id, 1));
              run.syncBuild();
              return { text: `Bloodied, richer, and carrying ${s.name}.` };
            }
          }
          return { text: 'Bloodied and richer. +220 scrap.' };
        },
      },
      { label: 'Not tonight', detail: 'Nothing happens.', apply: () => ({ text: 'You keep driving.' }) },
    ],
  },

  {
    id: 'shrine',
    title: 'The Shrine of Speed',
    body: 'Someone has welded a hundred wing mirrors into a shape that watches you.',
    choices: [
      {
        label: 'Offer your armour',
        detail: '-30% Armor, +25% Top Speed.',
        apply: (run) => {
          run.build.stats.add('Shrine of Speed', { armor: -0.3, topSpeed: 0.25 });
          run.build.recompute();
          run.syncBuild();
          return { text: 'Lighter. Louder. Less protected.' };
        },
      },
      {
        label: 'Offer your speed',
        detail: '-20% Top Speed, +45% Durability.',
        apply: (run) => {
          run.build.stats.add('Shrine of Iron', { topSpeed: -0.2, durability: 0.45 });
          run.build.recompute();
          run.syncBuild();
          return { text: 'Slower. Considerably harder to kill.' };
        },
      },
      {
        label: 'Offer scrap',
        detail: '-150 scrap, +1 reroll per race for the rest of the run.',
        apply: (run) => {
          if (run.scrap < 150) return { text: 'It is not interested in poverty.' };
          run.scrap -= 150;
          run.build.stats.add('Shrine Favour', null, { rerolls: 1 });
          run.build.recompute();
          return { text: 'The mirrors turn away. You feel luckier.' };
        },
      },
    ],
  },

  {
    id: 'hitchhiker',
    title: 'The Hitchhiker',
    body: 'She is holding a toolbox and a very specific expression.',
    when: (run) => run.build.skills.length > 0,
    choices: [
      {
        label: 'Let her work on a skill',
        detail: 'Upgrade a random equipped skill by one level.',
        apply: (run, rng) => {
          const upgradable = run.build.skills.filter((s) => (s.level ?? 1) < (s.maxLevel ?? 5));
          if (!upgradable.length) return { text: 'Everything is already maxed. She is impressed.' };
          const s = pick(rng, upgradable);
          run.build.upgradeSkill(s.id);
          run.syncBuild();
          return { text: `${s.name} is now level ${s.level}.` };
        },
      },
      {
        label: 'Ask her to strip weight',
        detail: '-25 Weight, -20% Armor.',
        apply: (run) => {
          run.build.stats.add('Stripped', { weight: { flat: -25 }, armor: -0.2 });
          run.build.recompute();
          run.syncBuild();
          return { text: 'Several things you needed are now on the roadside.' };
        },
      },
      { label: 'Drive past', detail: 'Nothing happens.', apply: () => ({ text: 'She waves anyway.' }) },
    ],
  },

  {
    id: 'fuel_depot',
    title: 'Abandoned Fuel Depot',
    body: 'Most of the tanks are empty. Most.',
    choices: [
      {
        label: 'Siphon everything',
        detail: '+20% Energy permanently, +8 Heat generation.',
        apply: (run) => {
          run.build.stats.add('Depot Fuel', { energy: 0.2 }, { heatGen: 8 });
          run.build.recompute();
          run.syncBuild();
          return { text: 'It burns hot. It burns well.' };
        },
      },
      {
        label: 'Take only what is safe',
        detail: '+10% Energy.',
        apply: (run) => {
          run.build.stats.add('Clean Fuel', { energy: 0.1 });
          run.build.recompute();
          run.syncBuild();
          return { text: 'Sensible.' };
        },
      },
    ],
  },
];

export const EVENT_BY_ID = Object.fromEntries(RUN_EVENTS.map((e) => [e.id, e]));
