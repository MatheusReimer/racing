// Seeded, splittable random. Every procedural decision in a run flows through
// one of these so a seed reproduces a run exactly: same map, same track
// layouts, same reward offers, same rival roster.

/** 32-bit string hash, used to derive named sub-streams from a parent seed. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed = 1) {
    this.seed = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
    this.state = this.seed;
  }

  /** mulberry32 — small, fast, good enough distribution for content rolls. */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [lo, hi). */
  range(lo, hi) {
    return lo + this.next() * (hi - lo);
  }

  /** Integer in [lo, hi] inclusive. */
  int(lo, hi) {
    return Math.floor(lo + this.next() * (hi - lo + 1));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  /** Symmetric float in [-a, a). */
  spread(a) {
    return this.range(-a, a);
  }

  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher-Yates, in place. Returns the same array for chaining. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Take `n` distinct entries. Returns fewer if the pool is smaller. */
  sample(arr, n) {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, Math.min(n, copy.length));
  }

  /**
   * Weighted pick. `weightOf` maps an entry to a non-negative number.
   * Entries with weight <= 0 can never be chosen.
   */
  weighted(arr, weightOf) {
    let total = 0;
    for (const it of arr) {
      const w = weightOf(it);
      if (w > 0) total += w;
    }
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const it of arr) {
      const w = weightOf(it);
      if (w <= 0) continue;
      r -= w;
      if (r <= 0) return it;
    }
    return arr[arr.length - 1];
  }

  /** Approximately normal, mean 0, stddev 1 (sum of 3 uniforms, cheap). */
  gaussian() {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  /**
   * Derive an independent named stream. The child is a pure function of
   * (this.seed, name), so streams stay reproducible even if the parent is
   * advanced a different number of times.
   */
  fork(name) {
    return new RNG((this.seed ^ hashString(name)) >>> 0);
  }

  clone() {
    const r = new RNG(this.seed);
    r.state = this.state;
    return r;
  }
}

/** Human-typeable run seeds: 6 chars from an unambiguous alphabet. */
const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomSeedString() {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += SEED_ALPHABET[Math.floor(Math.random() * SEED_ALPHABET.length)];
  }
  return s;
}
