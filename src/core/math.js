// Small numeric helpers used across every subsystem. Kept dependency-free so
// the physics and generators can be exercised in node without a WebGL context.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const smoothstep = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};

export const smootherstep = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Framerate-independent exponential approach. `rate` is roughly "how many
 * e-folds per second"; higher converges faster. Use this instead of naive
 * `a += (b - a) * k` which changes behaviour with the timestep.
 */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Move `a` toward `b` by at most `maxDelta`. */
export const approach = (a, b, maxDelta) => {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
};

/** Shortest signed angular difference from `a` to `b`, in (-PI, PI]. */
export const angleDelta = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

export const wrapAngle = (a) => {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
};

/** Wrap `v` into [0, m). Correct for negative inputs, unlike `%`. */
export const wrap = (v, m) => ((v % m) + m) % m;

export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
};

export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

/** Deterministic 1-D value noise. Used where a seeded RNG stream is overkill. */
export const hash1 = (n) => {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
};

export const valueNoise1 = (x) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = smoothstep(f);
  return lerp(hash1(i), hash1(i + 1), u);
};

/** Layered value noise in one dimension. */
export const fbm1 = (x, octaves = 4, lacunarity = 2, gain = 0.5) => {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise1(x * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
};

/** Format a number of metres-per-second as the km/h the HUD shows. */
export const msToKmh = (ms) => ms * 3.6;
