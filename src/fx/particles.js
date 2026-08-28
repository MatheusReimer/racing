import * as THREE from 'three';
import { radialSprite } from '../materials/noise.js';
import { clamp01, lerp } from '../core/math.js';

// Particles and tyre marks.
//
// One pooled Points cloud for every particle in the game, drawn in a single
// call. The alternative — a mesh per effect — costs a draw call and a matrix
// update per spark, and a heavy collision emits forty of them at once.
//
// The pool is fixed at the quality tier's budget and never grows. When it is
// full, the oldest particle is recycled rather than a new one allocated: a
// dropped spark during an explosion is invisible, a GC pause during one is not.
//
// Everything is simulated on the CPU into a shared Float32Array. At the
// budgets here (260-2400) that is cheaper than the state changes a GPU
// simulation would need, and it keeps particles able to read the same physics
// values the rest of the game uses.

const PARTICLE_VERT = /* glsl */`
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float uFogNear;
uniform float uFogFar;
varying float vAlpha;
varying vec3 vTint;
void main() {
  vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;

  // Fade out as a particle approaches the camera. Effects are emitted at the
  // car, which on a chase camera is three metres away: a single smoke puff at
  // that range covers the viewport, and a hundred of them hide the world. This
  // is the term that makes a dense effect readable instead of a wipe.
  float near = smoothstep(0.6, 5.0, dist);

  // And fade with distance, so a trail dissolves into the biome's fog rather
  // than staying crisp at 400 m. The particle shader cannot use Three's fog
  // chunk, so it carries its own.
  float far = 1.0 - smoothstep(uFogNear, uFogFar, dist);

  vAlpha = alpha * near * far;

  gl_PointSize = clamp(size * (300.0 / max(dist, 0.1)), 1.0, 90.0);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */`
uniform sampler2D uSprite;
varying float vAlpha;
varying vec3 vTint;
void main() {
  vec4 tex = texture2D(uSprite, gl_PointCoord);
  if (tex.a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vTint, tex.a * vAlpha);
}`;

/**
 * `additive` decides which of the two clouds a preset lands in. It is not a
 * stylistic choice: additive blending only ever brightens, so smoke drawn that
 * way glows white instead of obscuring what is behind it. Emissive effects
 * (sparks, fire, arcs) add light; particulate ones (smoke, dust, debris)
 * occlude, and must be alpha blended and darker than the scene.
 */
export const PRESETS = {
  spark: { additive: true, life: [0.3, 0.6], size: [0.28, 0.7], drag: 2.6, gravity: 16, color: 0xffc266, spread: 9, fade: 2.4 },
  fire: { additive: true, life: [0.28, 0.6], size: [0.8, 1.8], drag: 2.4, gravity: -4.0, color: 0xff6a2b, spread: 5, grow: 1.4, fade: 2.6 },
  electric: { additive: true, life: [0.18, 0.4], size: [0.35, 0.9], drag: 1.0, gravity: 0, color: 0x6fd9ff, spread: 14, fade: 3.2 },
  boost: { additive: true, life: [0.22, 0.45], size: [0.6, 1.3], drag: 3.2, gravity: 1.5, color: 0x4fd1ff, spread: 3, grow: 1.5, fade: 2.8 },

  smoke: { additive: false, life: [0.6, 1.2], size: [0.9, 1.7], maxSize: 2.6, drag: 1.8, gravity: -1.0, color: 0x55504a, spread: 2.2, grow: 1.5, fade: 1.5, opacity: 0.17 },
  tireSmoke: { additive: false, life: [0.35, 0.8], size: [0.6, 1.2], maxSize: 1.9, drag: 2.4, gravity: -0.5, color: 0xa39c93, spread: 1.6, grow: 1.5, fade: 1.7, opacity: 0.13 },
  debris: { additive: false, life: [0.7, 1.5], size: [0.2, 0.45], drag: 1.2, gravity: 22, color: 0x3a342c, spread: 11, fade: 1.5, opacity: 0.85 },
};

export class ParticleSystem {
  constructor(scene, budget = 1200, additive = true) {
    this.scene = scene;
    this.additive = additive;
    this.max = budget;
    this.count = 0;
    this.cursor = 0;

    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.size = new Float32Array(this.max);
    this.alpha = new Float32Array(this.max);
    this.tint = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.drag = new Float32Array(this.max);
    this.grav = new Float32Array(this.max);
    this.grow = new Float32Array(this.max);
    this.fade = new Float32Array(this.max);
    this.peak = new Float32Array(this.max);
    this.maxSize = new Float32Array(this.max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uSprite: { value: radialSprite(64, 2.0) },
        uFogNear: { value: 120 },
        uFogFar: { value: 420 },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);

    this._color = new THREE.Color();
  }

  /** Match the particle fade to the biome's fog so trails dissolve with it. */
  setFog(near, far) {
    this.material.uniforms.uFogNear.value = near;
    this.material.uniforms.uFogFar.value = far;
  }

  setBudget(n) {
    // Shrinking is free; growing would mean reallocating every buffer, so the
    // pool is sized for the highest tier and the draw range is what moves.
    this.max = Math.min(n, this.pos.length / 3);
  }

  /**
   * @param preset  key of PRESETS
   * @param x,y,z   origin
   * @param n       how many
   * @param opts    { color, speed, dirX, dirZ, spread, sizeScale }
   */
  emit(preset, x, y, z, n, opts = {}) {
    const p = PRESETS[preset] || PRESETS.spark;
    const color = opts.color != null ? opts.color : p.color;
    this._color.set(color);
    const speed = opts.speed ?? p.spread;
    const spread = opts.spread ?? 1;

    for (let k = 0; k < n; k++) {
      const i = this._next();
      const i3 = i * 3;

      this.pos[i3] = x + (Math.random() - 0.5) * spread;
      this.pos[i3 + 1] = y + (Math.random() - 0.5) * spread * 0.5;
      this.pos[i3 + 2] = z + (Math.random() - 0.5) * spread;

      // Random direction, biased along an optional axis so an impact throws
      // sparks away from the surface rather than spherically.
      const a = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.25) * Math.PI;
      const s = speed * (0.4 + Math.random() * 0.9);
      this.vel[i3] = Math.cos(a) * Math.cos(el) * s + (opts.dirX ?? 0) * s * 0.8;
      this.vel[i3 + 1] = Math.sin(el) * s * 0.7 + (opts.dirY ?? 0) * s;
      this.vel[i3 + 2] = Math.sin(a) * Math.cos(el) * s + (opts.dirZ ?? 0) * s * 0.8;

      const lf = lerp(p.life[0], p.life[1], Math.random());
      this.life[i] = lf;
      this.maxLife[i] = lf;
      this.size[i] = lerp(p.size[0], p.size[1], Math.random()) * (opts.sizeScale ?? 1);
      this.peak[i] = (opts.opacity ?? p.opacity ?? 1);
      this.alpha[i] = this.peak[i];
      this.drag[i] = p.drag;
      this.grav[i] = p.gravity;
      this.grow[i] = p.grow ?? 1;
      this.maxSize[i] = p.maxSize ?? (p.size[1] * 2.5);
      this.fade[i] = p.fade ?? 1.5;
      this.tint[i3] = this._color.r;
      this.tint[i3 + 1] = this._color.g;
      this.tint[i3 + 2] = this._color.b;
    }
  }

  _next() {
    // Ring buffer: at capacity the oldest particle is overwritten. Dropping a
    // spark mid-explosion is invisible; allocating during one is not.
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (this.count < this.max) this.count++;
    return i;
  }

  update(dt) {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const i3 = i * 3;

      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] = (this.vel[i3 + 1] - this.grav[i] * dt) * d;
      this.vel[i3 + 2] *= d;

      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      // Do not sink through the road.
      if (this.pos[i3 + 1] < 0.05) {
        this.pos[i3 + 1] = 0.05;
        this.vel[i3 + 1] *= -0.2;
      }

      const t = clamp01(this.life[i] / this.maxLife[i]);
      this.alpha[i] = Math.pow(t, this.fade[i]) * this.peak[i];
      if (this.grow[i] !== 1) {
        this.size[i] = Math.min(this.maxSize[i], this.size[i] + (this.grow[i] - 1) * dt * 2);
      }
    }

    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.geo.attributes.tint.needsUpdate = true;
  }

  clear() {
    this.alpha.fill(0);
    this.life.fill(0);
    this.count = 0;
    this.cursor = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}

/**
 * Tyre marks: a ribbon of quads laid down behind a sliding car.
 *
 * Kept as one growing geometry with a fixed vertex budget and a write cursor,
 * for the same reason as the particles — the alternative is a mesh per skid
 * and a drifting car lays down several per second.
 */
export class TireMarks {
  constructor(scene, budget = 700) {
    this.max = budget;
    this.cursor = 0;
    this.count = 0;

    this.pos = new Float32Array(this.max * 4 * 3);
    this.alpha = new Float32Array(this.max * 4);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));

    const idx = new Uint32Array(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.01) discard;
          // Darken the road, never paint on it.
          //
          // This wrote an absolute grey (0.04) blended over whatever was
          // underneath. Rubber is not a colour you add, it is light you take
          // away — and on any surface darker than that grey, which is most of
          // the track once it is in shadow, an absolute value paints *lighter*
          // than the tarmac. The marks then read as a pale smear trailing the
          // rear wheels, which looks like a shadow under the car rather than a
          // skid. Multiplying can only ever darken.
          float k = 1.0 - clamp(vAlpha, 0.0, 1.0) * 0.55;
          gl_FragColor = vec4(k, k, k, 1.0);
        }`,
      transparent: true,
      // Explicit rather than THREE.MultiplyBlending, which in r180 demands
      // premultipliedAlpha and warns every frame otherwise. dst * src is what
      // is wanted and this states it directly.
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    this._last = new Map();
  }

  /** Lay a segment for one wheel. `key` identifies the wheel across frames. */
  mark(key, x, z, y, dirX, dirZ, width, strength) {
    const prev = this._last.get(key);
    this._last.set(key, { x, z, y });
    if (!prev) return;

    const dx = x - prev.x;
    const dz = z - prev.z;
    const len = Math.hypot(dx, dz);
    // Skip micro-segments (parked) and teleports (respawn).
    if (len < 0.25 || len > 8) return;

    const nx = -dz / len * width * 0.5;
    const nz = dx / len * width * 0.5;

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (this.count < this.max) this.count++;

    const v = i * 4 * 3;
    const yy = y + 0.03;
    this.pos[v + 0] = prev.x + nx; this.pos[v + 1] = yy; this.pos[v + 2] = prev.z + nz;
    this.pos[v + 3] = prev.x - nx; this.pos[v + 4] = yy; this.pos[v + 5] = prev.z - nz;
    this.pos[v + 6] = x + nx; this.pos[v + 7] = yy; this.pos[v + 8] = z + nz;
    this.pos[v + 9] = x - nx; this.pos[v + 10] = yy; this.pos[v + 11] = z - nz;

    const a = clamp01(strength);
    this.alpha.fill(a, i * 4, i * 4 + 4);

    this.geo.setDrawRange(0, this.count * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }

  clear() {
    this.alpha.fill(0);
    this.count = 0;
    this.cursor = 0;
    this._last.clear();
    this.geo.setDrawRange(0, 0);
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
