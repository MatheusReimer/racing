// Geometry gate for the track generator. Every circuit the game can produce
// must be drivable: closed, non-self-intersecting, and free of corners tighter
// than a car can physically take. Run across many seeds — a layout bug that
// shows up in 1 seed in 200 is a run-ending bug in play.

import { generateTrack } from '../src/track/track.js';
import { previewTrack } from '../src/track/preview.js';
import { RaceSim } from '../src/race/sim.js';
import { Build } from '../src/build/build.js';
import { EventBus } from '../src/core/events.js';
import { BIOMES } from '../src/data/biomes.js';
import { RNG } from '../src/core/rng.js';
import { StatBlock } from '../src/stats/statblock.js';
import { baseStats } from '../src/stats/attributes.js';

const SEEDS = Number(process.argv[2] || 120);

const phys = new StatBlock(baseStats()).physics();
// Tightest radius the baseline car can hold at a realistic corner speed.
const cornerSpeed = phys.maxSpeed * 0.45;
const minRadiusDrivable = (cornerSpeed * cornerSpeed) / phys.corneringAccel;

/** Do segments a-b and c-d cross? Used to prove the loop never overlaps itself. */
function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

let fails = 0;
const stats = { len: [], minR: [], branches: [], width: [], sharp: [] };

for (let i = 0; i < SEEDS; i++) {
  const biome = BIOMES[i % BIOMES.length];
  const rng = new RNG(1000 + i);
  const track = generateTrack(rng, biome, { difficulty: i % 4 });
  const p = track.path;
  const problems = [];

  // --- closure ---
  const a = p.pointAt(0, {});
  const b = p.pointAt(p.length - 0.01, {});
  const gap = Math.hypot(a.x - b.x, a.z - b.z);
  if (gap > 3) problems.push(`open loop, ${gap.toFixed(1)}m gap`);

  // --- length sanity ---
  if (p.length < 900 || p.length > 5000) problems.push(`length ${p.length.toFixed(0)}m out of range`);

  // --- curvature: is every corner actually takeable? ---
  let minR = Infinity;
  let sharpCount = 0;
  for (let s = 0; s < p.length; s += 4) {
    const c = Math.abs(p.curvatureAt(s, 8));
    const r = c > 1e-6 ? 1 / c : Infinity;
    if (r < minR) minR = r;
    if (r < 22) sharpCount++;
  }
  // The limit is geometric, not a fixed number.
  //
  // This was a hardcoded 12 m while the drivable radius was computed two dozen
  // lines above and used only for display. When the arcade handling pass raised
  // cornering grip, tighter corners became *easier*, and the constant started
  // failing tracks the car had just got better at — a 10.8 m hairpin is taken
  // at 53 km/h with the current grip.
  //
  // What actually breaks is a corner tighter than the road is wide, because
  // then the inside edge folds through itself and there is no line at all.
  const hw = track.halfWidthAt(0);
  const foldRadius = hw * 1.15;
  if (minR < foldRadius) {
    problems.push(`corner radius ${minR.toFixed(1)}m is tighter than the road is wide `
      + `(${hw.toFixed(1)}m half-width) — the inside edge folds through itself`);
  }

  // --- self-intersection ---
  const step = 3;
  const pts = [];
  for (let s = 0; s < p.length; s += step) pts.push(p.pointAt(s, {}));
  const n = pts.length;
  let crossings = 0;
  // Skip neighbours: adjacent segments share an endpoint by construction.
  for (let x = 0; x < n && crossings === 0; x++) {
    for (let y = x + 4; y < n - 1; y++) {
      if (x === 0 && y === n - 2) continue;
      if (segmentsCross(pts[x], pts[(x + 1) % n], pts[y], pts[(y + 1) % n])) { crossings++; break; }
    }
  }
  if (crossings) problems.push('centreline self-intersects');

  // --- projection round-trip: project(pointAt(s)) must return s ---
  let maxErr = 0;
  for (let k = 0; k < 40; k++) {
    const s = (k / 40) * p.length;
    const pt = p.pointAt(s, {});
    const pr = p.project(pt.x, pt.z, {});
    let d = Math.abs(p.deltaAlong(s, pr.s));
    maxErr = Math.max(maxErr, d);
    if (pr.dist > 1.5) problems.push(`project() off-curve by ${pr.dist.toFixed(2)}m`);
  }
  if (maxErr > 4) problems.push(`project() round-trip error ${maxErr.toFixed(2)}m`);

  // --- lateral offset sign convention ---
  {
    const s = p.length * 0.3;
    const right = p.offsetPoint(s, 6, {});
    const pr = p.project(right.x, right.z, {});
    if (pr.side < 4) problems.push(`offsetPoint/project sign mismatch (side=${pr.side.toFixed(2)})`);
  }

  // --- branches ---
  for (const br of track.branches) {
    if (!Number.isFinite(br.path.length) || br.path.length < 10) problems.push('degenerate branch');
    if (br.kind === 'shortcut' && br.saving < -5) {
      problems.push(`shortcut ${br.id} is ${(-br.saving).toFixed(0)}m LONGER than the main line`);
    }
  }

  // --- sample() must resolve anywhere on the surface ---
  for (let k = 0; k < 30; k++) {
    const s = (k / 30) * p.length;
    const hw = track.halfWidthAt(s);
    const pt = p.offsetPoint(s, (k % 5 - 2) * hw * 0.4, {});
    const smp = track.sample(pt.x, pt.z, {});
    if (!smp.onTrack) problems.push(`sample() says off-track at lateral within half-width (s=${s.toFixed(0)})`);
    if (!Number.isFinite(smp.groundY)) problems.push('sample() groundY not finite');
  }

  stats.len.push(p.length);
  stats.minR.push(minR);
  stats.branches.push(track.branches.length);
  stats.width.push(track.baseWidth);
  stats.sharp.push(sharpCount);

  if (problems.length) {
    fails++;
    if (fails <= 12) {
      console.log(`FAIL seed ${1000 + i} (${biome.id}): ${problems.join('; ')}`);
    }
  }
}

const q = (arr, f) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * f))];
};
const fmt = (arr, d = 0) =>
  `min ${q(arr, 0).toFixed(d)}  p50 ${q(arr, 0.5).toFixed(d)}  max ${q(arr, 1).toFixed(d)}`;

console.log(`\n${SEEDS - fails}/${SEEDS} circuits passed`);
console.log(`  length (m)      ${fmt(stats.len)}`);
console.log(`  min radius (m)  ${fmt(stats.minR, 1)}   [baseline car needs ~${minRadiusDrivable.toFixed(0)}m at ${(cornerSpeed * 3.6).toFixed(0)} km/h]`);
console.log(`  sharp corners   ${fmt(stats.sharp)}   (radius < 22 m samples)`);
console.log(`  branches        ${fmt(stats.branches)}`);

// --- the circuit on the briefing is the circuit that gets raced -------------
//
// `previewTrack` draws the pre-race map by generating the track itself, from
// the race's seed, forking its RNG the way `RaceSim` does. If those two ever
// stop agreeing — a different fork label, an option the sim passes and the
// preview does not — nothing errors: the briefing simply shows a circuit that
// is not the one you are about to drive, which is worse than showing none.
{
  console.log('\nThe briefing map matches the circuit the sim builds:\n');
  let bad = 0;
  let worst = '';
  for (let i = 0; i < 12; i++) {
    const seed = `preview-${i}`;
    const biome = BIOMES[i % BIOMES.length];
    const opts = { difficulty: (i % 4) * 0.5, lengthScale: 1 + (i % 3) * 0.15 };

    const sim = new RaceSim({
      seed, biome, playerBuild: new Build('hatch'), events: new EventBus(),
      config: { laps: 1, rivals: 0, ...opts },
    });
    const shown = previewTrack(seed, biome, opts);

    // Length is the cheap fingerprint. Shape is the real one: two circuits can
    // share a length and be nothing alike, so the sim's centreline is put
    // through the same normalisation the preview uses — written out here
    // rather than imported, because a probe that reuses the code it is
    // checking only proves that code agrees with itself — and compared point
    // for point.
    const dLen = Math.abs(sim.track.length - shown.stats.length);
    const drift = shapeDrift(sim.track, shown.outline);
    if (dLen > 1 || drift > 0.25) {
      bad++;
      if (!worst) worst = `${biome.id}: length off by ${dLen.toFixed(1)} m, shape by ${drift.toFixed(2)}`;
    }
  }
  if (bad) fails++;
  console.log(`  12 circuits, ${bad} where the map is not the track`.padEnd(52)
    + (bad ? `FAIL ${worst}` : 'ok'));
}

/** Worst distance, in preview units, between the drawn outline and the track. */
function shapeDrift(track, outline) {
  const pts = track.path.points;
  const branches = (track.branches ?? []).map((b) => b.path.points);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const set of [pts, ...branches]) {
    for (const p of set) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const offX = (span - (maxX - minX)) / 2;
  const offZ = (span - (maxZ - minZ)) / 2;
  if (pts.length !== outline.length) return 99;
  let worstD = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = ((pts[i].x - minX + offX) / span) * 100;
    const y = 100 - ((pts[i].z - minZ + offZ) / span) * 100;
    worstD = Math.max(worstD, Math.hypot(x - outline[i].x, y - outline[i].y));
  }
  return worstD;
}

process.exit(fails > 0 ? 1 : 0);
