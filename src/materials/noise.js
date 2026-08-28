import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';

// Procedural texture generation. There are no image files in this project, so
// every surface in the game starts here.
//
// Textures are built once into DataTextures at load and cached by key. They are
// small (128-256 px) on purpose: the look is stylised and heavily fogged, so
// resolution buys nothing, while a few hundred KB of VRAM per surface and the
// upload cost do show up. Detail comes from the shader-side blending in
// library.js, not from pixel count.

const cache = new Map();

/** 2-D value noise with a seeded permutation. Tiles exactly at `period`. */
function makeNoise2D(seed, period) {
  const rng = new RNG(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();

  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smoothstep(xf), v = smoothstep(yf);
    const wrapI = (n) => ((n % period) + period) % period;
    const x0 = wrapI(xi), x1 = wrapI(xi + 1);
    const y0 = wrapI(yi), y1 = wrapI(yi + 1);
    const a = grid[y0 * period + x0], b = grid[y0 * period + x1];
    const c = grid[y1 * period + x0], d = grid[y1 * period + x1];
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
}

/** Layered value noise. `period` keeps every octave tileable. */
function fbm2D(seed, octaves = 4, period = 8) {
  const layers = [];
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: makeNoise2D(seed + o * 7919, period * (1 << o)), f: 1 << o, a: 1 / (1 << o) });
  }
  const norm = layers.reduce((s, l) => s + l.a, 0);
  return (x, y) => {
    let sum = 0;
    for (const l of layers) sum += l.a * l.n(x * l.f * period, y * l.f * period);
    return sum / norm;
  };
}

/** Worley/cellular noise — cracks, pebbles, ice facets. Tiles at `cells`. */
function worley2D(seed, cells = 6) {
  const rng = new RNG(seed);
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = rng.next();
    pts[i * 2 + 1] = rng.next();
  }
  return (x, y) => {
    const gx = x * cells, gy = y * cells;
    const cx = Math.floor(gx), cy = Math.floor(gy);
    let best = 1e9, second = 1e9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = ((cx + dx) % cells + cells) % cells;
        const iy = ((cy + dy) % cells + cells) % cells;
        const px = cx + dx + pts[(iy * cells + ix) * 2];
        const py = cy + dy + pts[(iy * cells + ix) * 2 + 1];
        const d = (px - gx) ** 2 + (py - gy) ** 2;
        if (d < best) { second = best; best = d; }
        else if (d < second) second = d;
      }
    }
    return { f1: Math.sqrt(best), f2: Math.sqrt(second) };
  };
}

function makeTexture(size, writer, { srgb = true, repeat = 1 } = {}) {
  const data = new Uint8Array(size * size * 4);
  const px = { r: 255, g: 255, b: 255, a: 255 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      writer(x / size, y / size, px, x, y);
      const i = (y * size + x) * 4;
      data[i] = px.r; data[i + 1] = px.g; data[i + 2] = px.b; data[i + 3] = px.a;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const hexToRgb = (hex) => {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
};

/**
 * Asphalt: fine aggregate speckle over a broad blotch, plus sparse cracks from
 * the second Worley distance. The cracks are what stop a long straight from
 * reading as flat colour at speed.
 */
export function asphaltTexture(baseHex, seed = 1, size = 256) {
  const key = `asphalt:${baseHex}:${seed}:${size}`;
  if (cache.has(key)) return cache.get(key);
  const base = hexToRgb(baseHex);
  const grain = fbm2D(seed, 4, 16);
  const blotch = fbm2D(seed + 101, 3, 4);
  const cell = worley2D(seed + 202, 5);

  const tex = makeTexture(size, (u, v, px) => {
    const g = grain(u, v);
    const b = blotch(u, v);
    const { f1, f2 } = cell(u, v);
    const crack = 1 - clamp01((f2 - f1) * 7);
    // Centred near 1.0: the base colour already carries the darkness, and
    // multiplying a dark linear base by a dark multiplier crushes the road to
    // black once lighting is applied.
    let l = 0.98 + (g - 0.5) * 0.40 + (b - 0.5) * 0.20;
    l *= 1 - crack * 0.42;
    px.r = clamp01(base.r * l) * 255;
    px.g = clamp01(base.g * l) * 255;
    px.b = clamp01(base.b * l) * 255;
    px.a = 255;
  });
  cache.set(key, tex);
  return tex;
}

/** Loose ground: sand, dirt, snow. Dune-scale ripples over fine grain. */
export function groundTexture(aHex, bHex, seed = 1, size = 256, rippleFreq = 3, grain = 0.28) {
  const key = `ground:${aHex}:${bHex}:${seed}:${rippleFreq}:${grain}`;
  if (cache.has(key)) return cache.get(key);
  const a = hexToRgb(aHex), b = hexToRgb(bHex);
  const broad = fbm2D(seed, 4, 4);
  const fine = fbm2D(seed + 55, 3, 24);

  const tex = makeTexture(size, (u, v, px) => {
    const ripple = Math.sin((u * rippleFreq + broad(u, v) * 1.6) * Math.PI * 2) * 0.5 + 0.5;
    const t = clamp01(broad(u, v) * 0.65 + ripple * 0.35);
    // Fine grain is dirt and gravel. On a city pavement it is wrong twice: it
    // is not what pavement looks like, and at a grazing angle with low
    // anisotropy it aliases into a band of glitter beside the kerb.
    const l = 0.96 + (fine(u, v) - 0.5) * grain;
    px.r = clamp01(lerp(a.r, b.r, t) * l) * 255;
    px.g = clamp01(lerp(a.g, b.g, t) * l) * 255;
    px.b = clamp01(lerp(a.b, b.b, t) * l) * 255;
    px.a = 255;
  });
  cache.set(key, tex);
  return tex;
}

/** Panelled industrial metal with rust bleeding from the seams. */
export function metalTexture(baseHex, rustHex, seed = 1, size = 256) {
  const key = `metal:${baseHex}:${rustHex}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const base = hexToRgb(baseHex), rust = hexToRgb(rustHex);
  const rustField = fbm2D(seed, 4, 6);
  const grain = fbm2D(seed + 31, 2, 32);

  const tex = makeTexture(size, (u, v, px) => {
    // Panel seams on an 8x8 grid.
    const su = Math.abs((u * 8) % 1 - 0.5) * 2;
    const sv = Math.abs((v * 8) % 1 - 0.5) * 2;
    const seam = clamp01((Math.max(su, sv) - 0.88) * 9);
    const r = clamp01((rustField(u, v) - 0.42) * 2.4 + seam * 0.35);
    const l = (0.82 + (grain(u, v) - 0.5) * 0.28) * (1 - seam * 0.4);
    px.r = clamp01(lerp(base.r, rust.r, r) * l) * 255;
    px.g = clamp01(lerp(base.g, rust.g, r) * l) * 255;
    px.b = clamp01(lerp(base.b, rust.b, r) * l) * 255;
    px.a = 255;
  });
  cache.set(key, tex);
  return tex;
}

/** Ice: large facets from Worley, with a cold tint in the fractures. */
export function iceTexture(baseHex, seed = 1, size = 256) {
  const key = `ice:${baseHex}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const base = hexToRgb(baseHex);
  const cell = worley2D(seed, 4);
  const fine = fbm2D(seed + 9, 3, 16);

  const tex = makeTexture(size, (u, v, px) => {
    const { f1, f2 } = cell(u, v);
    const edge = clamp01(1 - (f2 - f1) * 6);
    const l = 0.88 + (fine(u, v) - 0.5) * 0.16 + edge * 0.22;
    px.r = clamp01(base.r * l * 0.96) * 255;
    px.g = clamp01(base.g * l) * 255;
    px.b = clamp01(base.b * l * 1.05) * 255;
    px.a = 255;
  });
  cache.set(key, tex);
  return tex;
}

/**
 * A normal map derived from a height field. Cheap finite differences — good
 * enough for the shallow relief these surfaces need.
 */
export function normalFromHeight(heightFn, size = 128, strength = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const h = (x, y) => heightFn(((x % size) + size) % size / size, ((y % size) + size) % size / size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function roadNormal(seed = 1) {
  const key = `roadNormal:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const f = fbm2D(seed + 777, 3, 20);
  const tex = normalFromHeight((u, v) => f(u, v), 128, 2.4);
  cache.set(key, tex);
  return tex;
}

/** A soft radial sprite, used for every particle in the game. */
export function radialSprite(size = 64, falloff = 2.2) {
  const key = `radial:${size}:${falloff}`;
  if (cache.has(key)) return cache.get(key);
  const tex = makeTexture(size, (u, v, px) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.pow(clamp01(1 - d), falloff);
    px.r = px.g = px.b = 255;
    px.a = a * 255;
  }, { srgb: false });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, tex);
  return tex;
}

export function disposeTextureCache() {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}
