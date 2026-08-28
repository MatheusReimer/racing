// Direct test of the combat system: line a target up and confirm every skill
// actually lands. The playtest cannot answer this — an AI firing into empty
// road produces zero damage too, and looks identical to a broken weapon.
//
// The observation has to be continuous, not a snapshot at the end: an EMP
// lasts 1.6 s, so checking for it after four seconds of simulation proves
// nothing. Statuses are latched the moment they appear.

import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { BIOMES } from '../src/data/biomes.js';
import { instantiateSkill, SKILLS } from '../src/data/skills.js';

const DT = 1 / 60;
const STEPS = 300;
let fails = 0;

for (const def of SKILLS) {
  for (const level of [1, 5]) {
    const build = new Build('rotary');
    build.addSkill(instantiateSkill(def.id, level));

    const sim = new RaceSim({
      seed: 'CP', biome: BIOMES[0], playerBuild: build,
      config: { laps: 9, rivals: 2, difficulty: 1, countdown: 0 },
    });
    sim.state = 'racing';

    const shooter = sim.player;
    const target = sim.racers[1];
    const bystander = sim.racers[2];

    // Line them up along +Z. 9 m is inside every area skill's level-1 radius,
    // which is the range these are balanced for.
    shooter.body.place(0, 0, 0);
    shooter.body.vz = 30;
    target.body.place(0, 9, 0);
    target.body.vz = 29;
    bystander.body.place(5, 18, 0);
    bystander.body.vz = 29;
    shooter.maxEnergy = 999;
    shooter.energy = 999;
    target.maxDurability = target.durability = 400;

    const durBefore = target.durability;
    const selfBefore = shooter.durability;

    const trapsBefore = sim.combat.traps.length;
    const fired = sim.useSkill(shooter, 0);

    // Traps are dropped behind the shooter and stay put. Drive the target over
    // wherever they actually landed rather than over the shooter's live wake.
    const droppedTraps = sim.combat.traps.slice(trapsBefore).map((t) => ({ x: t.x, z: t.z }));

    let sawStatus = new Set();
    let sawSpin = false;
    let sawBoost = false;
    let sawInvuln = false;

    for (let i = 0; i < STEPS; i++) {
      if (droppedTraps.length && i > 12) {
        // March the target through each drop point in turn.
        const spot = droppedTraps[Math.min(droppedTraps.length - 1, Math.floor((i - 12) / 60))];
        target.body.x = spot.x;
        target.body.z = spot.z;
      }

      sim.combat.update(DT);
      for (const r of sim.racers) {
        r.body.step(DT, { throttle: 0.6, brake: 0, steer: 0, drift: false }, undefined, 0);
        sim.track.sample(r.body.x, r.body.z, r.sample);
      }

      // Latch transient evidence the instant it exists.
      for (const s of target.statuses || []) sawStatus.add(s.id);
      if (Math.abs(target.body.yawRate) > 1.2) sawSpin = true;
      if (target.body.gripPenalty < 0.9) sawStatus.add('grip-loss');
      if (shooter.body.boostTimer > 0) sawBoost = true;
      if (shooter.invulnTimer > 0) sawInvuln = true;
    }

    const dealt = durBefore - target.durability;
    const selfHarm = selfBefore - shooter.durability;
    const status = [...sawStatus].join(',');

    // What counts as "this skill did its job" depends on what it is for.
    let ok;
    let why = '';
    if (def.id === 'nitro' || def.id === 'grapple') {
      ok = sawBoost;
      why = 'no boost applied';
    } else if (def.id === 'shield') {
      ok = sawInvuln;
      why = 'no invulnerability applied';
    } else if (def.id === 'repair') {
      ok = fired !== false;
      why = 'did not fire';
    } else if (def.id === 'decoy') {
      ok = fired !== false && (level < 3 || true);
      why = 'did not fire';
    } else {
      ok = dealt > 0.5 || sawStatus.size > 0 || sawSpin;
      why = 'landed nothing on a target 9 m ahead';
    }

    if (!ok) fails++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${def.id.padEnd(18)} L${level}  ` +
      `dealt ${dealt.toFixed(1).padStart(6)}  ` +
      `self ${selfHarm.toFixed(1).padStart(5)}  ` +
      (status ? `[${status}] ` : '') +
      (sawSpin ? 'SPUN ' : '') + (sawBoost ? 'BOOST ' : '') + (sawInvuln ? 'SHIELD ' : '') +
      (ok ? '' : ` <- ${why}`),
    );

    if (selfHarm > 0.5) {
      console.log(`      WARNING: ${def.id} L${level} hurt its own user for ${selfHarm.toFixed(1)}`);
    }
  }
}

console.log(fails === 0 ? '\nevery skill lands' : `\n${fails} skill(s) do nothing`);
process.exit(fails ? 1 : 0);
