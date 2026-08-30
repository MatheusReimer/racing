import * as THREE from 'three';
import { radialSprite } from '../materials/noise.js';
import { clamp } from '../core/math.js';
import { ROAD_LIFT } from '../track/track.js';

// Street lighting.
//
// The night district was lit by two things that are not lights. An emissive
// lamp head is a bright pixel: it says *there is a lamp there* and puts nothing
// on the road. A hemisphere light turned up until the tarmac was visible is a
// grey wash: it lifts the whole street by the same amount everywhere, which is
// exactly what a lit street does not look like. Between them the city read as a
// dark corridor with dots in it.
//
// What a street lamp actually is, from a car, is a pool of warm light on the
// road that arrives, passes under you and leaves. The scatter already spaces
// the lamps on a regular pitch for precisely that reason — "the rhythm of light
// pools going past is most of what reads as speed at night" — and then there
// were no pools.
//
// Real lights cannot pay for this. Three's forward renderer costs a shader
// permutation and per-fragment work for every light within range, and one city
// block holds forty. So the light is *drawn* rather than computed: an additive
// quad lying flat on the road with a radial falloff, and a billboard halo in
// the air at the source so the lamp itself reads through fog. One draw call
// each, however many lamps the circuit has.
//
// Where the light goes is not authored twice. Every glowing prop already ships
// a second, unlit geometry — the lamp head, the sign face, the lit windows —
// so a pool is placed under *that*, taking its colour from the same vertex
// colours the glow pass draws with. A prop whose glow moves takes its light
// with it, and a new glowing prop type is lit without a line being added here.

// Clear of the tarmac by enough that a quad spanning several road rings is
// never dipped under one of them by the road's own curvature. Small enough that
// nothing reads as floating from a chase camera.
const POOL_CLEARANCE = 0.09;

const POOL_VERT = /* glsl */`
attribute vec2 corner;     // [-1,1] across the quad
attribute vec3 tint;       // colour, already multiplied by intensity
attribute float shape;     // 0 = lamp pool, 1 = headlight beam
attribute vec2 cell;       // one light cube, in corner units, per axis
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vCorner;
varying vec2 vCell;
varying vec3 vTint;
varying float vShape;
varying float vFade;
void main() {
  vCorner = corner;
  vCell = cell;
  vTint = tint;
  vShape = shape;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Distance fade, carried here for the same reason the particles carry their
  // own: a ShaderMaterial gets none of Three's fog chunks, and additive light
  // that ignores fog stays crisp at 400 m and turns the horizon into a haze of
  // glowing coins.
  vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

// Light, in cells.
//
// The world is cubes and the light falling on it was a smooth gradient, which
// is the one surface in the frame that gave the grid away as a choice about
// geometry rather than a style. So the falloff is evaluated at the centre of a
// light cell rather than at the fragment, and its result is stepped into a
// small number of levels: a headlight is a mosaic of lit squares on the road,
// a lamp pool is a blocky disc, and both are made of the same size of cube as
// the things they are lit by.
//
// Two quantisations, and they do different jobs. Snapping *position* is what
// makes the light cubic. Snapping *intensity* is what stops each cube being an
// imperceptibly different shade from its neighbour — without it the mosaic is
// there and invisible, because a gradient sampled per cell is still a gradient.
const LIGHT_LEVELS = 5.0;

/**
 * How big a cube of light is, in metres.
 *
 * Chosen against the surfaces it lands on rather than against the beam: the
 * street furniture standing in it is on a twenty-centimetre cell and the near
 * ground is on a stepped ribbon of about a third of a metre, so light in the
 * same range reads as part of the same world. Much finer and the mosaic stops
 * being visible at speed, which is the only place anybody sees it.
 */
const LIGHT_CELL = 0.30;

const POOL_FRAG = /* glsl */`
varying vec2 vCorner;
varying vec2 vCell;
varying vec3 vTint;
varying float vShape;
varying float vFade;

float shapeAt(vec2 p) {
  // Pool: quadratic falloff from the centre, reaching zero at the rim so the
  // edge of the quad is never a visible seam across the tarmac.
  float r = length(p);
  float pool = 1.0 - clamp(r, 0.0, 1.0);
  pool *= pool;

  // Beam: local +Y runs away from the car. It fans out with distance and dies
  // before the far edge; the near ramp stops it starting as a hard line drawn
  // across the bumper.
  float t = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
  float halfWidth = mix(0.34, 1.0, t);
  float lat = clamp(abs(p.x) / halfWidth, 0.0, 1.0);
  float falloff = 1.0 - t;
  float beam = (1.0 - lat * lat) * falloff * falloff * smoothstep(0.0, 0.12, t);

  return mix(pool, beam, vShape);
}

void main() {
  // The centre of the light cube this fragment is inside.
  vec2 q = (floor(vCorner / vCell) + 0.5) * vCell;
  float f = shapeAt(q) * vFade;

  // Stepped, and the bottom step is dropped rather than dimmed: a cube either
  // has light in it or it does not, and a ring of near-black cubes round the
  // edge is a smudge with corners.
  f = floor(f * ${LIGHT_LEVELS.toFixed(1)} + 0.5) / ${LIGHT_LEVELS.toFixed(1)};
  if (f <= 0.0) discard;
  gl_FragColor = vec4(vTint * f, 1.0);
}`;

const HALO_VERT = /* glsl */`
attribute float size;
attribute vec3 tint;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vTint;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  // Near fade: a halo is a stand-in for glare, and glare that fills the screen
  // when you drive under the lamp reads as a bug rather than as a light.
  float near = smoothstep(1.5, 9.0, dist);
  vFade = near * (1.0 - smoothstep(uFogNear, uFogFar, dist));
  vTint = tint;
  gl_PointSize = clamp(size * (300.0 / max(dist, 0.1)), 1.0, 220.0);
  gl_Position = projectionMatrix * mv;
}`;

// A halo, in cells too.
//
// This one is quantised in *screen* space rather than in the world, and that is
// the honest thing rather than a shortcut: a halo is not a surface, it is glare
// — the light the air and the eye do with a bright thing, drawn as a sprite
// facing the camera. It has no place in the world to be cubic in. So it is
// cubic in the only space it exists in, which also means its cubes stay the
// same size on screen as the lamp recedes, exactly as glare does.
const HALO_CELLS = 7.0;

const HALO_FRAG = /* glsl */`
uniform sampler2D uSprite;
varying vec3 vTint;
varying float vFade;
void main() {
  // The centre of the cell this fragment is in, sampled once for the whole
  // cell so the sprite's gradient comes out as blocks.
  vec2 q = (floor(gl_PointCoord * ${HALO_CELLS.toFixed(1)}) + 0.5) / ${HALO_CELLS.toFixed(1)};
  float a = texture2D(uSprite, q).a * vFade;
  a = floor(a * ${LIGHT_LEVELS.toFixed(1)} + 0.5) / ${LIGHT_LEVELS.toFixed(1)};
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vTint * a, 1.0);
}`;

/**
 * Where a prop's light comes from, read out of the prop's own glow geometry.
 *
 * Returns the centroid of the emissive geometry in the prop's local frame, the
 * average of its vertex colours, and how much emissive surface there is — the
 * last standing in for how bright the thing is, so a full shop sign throws more
 * light than a single traffic lamp without either being given a number here.
 *
 * Cached per geometry: three variants of a type share one answer.
 */
const _descriptors = new WeakMap();

function describeGlow(geo) {
  const cached = _descriptors.get(geo);
  if (cached) return cached;

  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const n = pos?.count ?? 0;
  if (!n) {
    const empty = { x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, area: 0 };
    _descriptors.set(geo, empty);
    return empty;
  }

  let x = 0, y = 0, z = 0, r = 0, g = 0, b = 0;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    x += pos.getX(i); y += pos.getY(i); z += pos.getZ(i);
    if (pos.getY(i) < minY) minY = pos.getY(i);
    if (col) { r += col.getX(i); g += col.getY(i); b += col.getZ(i); }
  }
  x /= n; y /= n; z /= n;
  if (col) { r /= n; g /= n; b /= n; } else { r = g = b = 1; }

  // Vertex colours are written in linear space by the shape builders and the
  // brightest of the three is what the eye calls the hue, so normalise against
  // it: a light's colour is its hue, and its brightness belongs to `area`.
  const peak = Math.max(r, g, b, 1e-4);
  const out = {
    x, y, z,
    r: r / peak, g: g / peak, b: b / peak,
    // Bounding-box diagonal of the emissive geometry, which scales with how
    // much of it there is without needing the triangle areas.
    area: Math.max(0.2, _spread(pos)),
    // A tall spread of lit windows should light the pavement from the bottom of
    // it, not from halfway up the building.
    baseY: minY,
  };
  _descriptors.set(geo, out);
  return out;
}

function _spread(pos) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return Math.hypot(x1 - x0, y1 - y0, z1 - z0);
}

/**
 * Additive quads lying on the road: lamp pools and headlight beams.
 *
 * The buffer is one contiguous run. Static pools are written once at build time
 * and occupy the front of it; the dynamic beams are rewritten every frame into
 * the slots immediately after, so the draw range stays a single span and there
 * is never a hole of stale triangles between the two.
 */
export class LightPools {
  constructor(scene, { maxStatic = 260, maxDynamic = 32 } = {}) {
    this.maxStatic = maxStatic;
    this.maxDynamic = maxDynamic;
    this.max = maxStatic + maxDynamic;
    this.staticCount = 0;
    this.dynamicCount = 0;

    this.pos = new Float32Array(this.max * 4 * 3);
    this.corner = new Float32Array(this.max * 4 * 2);
    this.tint = new Float32Array(this.max * 4 * 3);
    this.shape = new Float32Array(this.max * 4);
    // A light cube is a fixed size in metres, and the shader works in the
    // quad's own [-1,1] coordinates, so each quad carries the conversion. It
    // differs per quad because a beam is eighteen metres long and a lamp pool
    // is four across.
    this.cell = new Float32Array(this.max * 4 * 2);

    const geo = new THREE.BufferGeometry();
    const dyn = THREE.DynamicDrawUsage;
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(dyn));
    geo.setAttribute('corner', new THREE.BufferAttribute(this.corner, 2).setUsage(dyn));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(dyn));
    geo.setAttribute('shape', new THREE.BufferAttribute(this.shape, 1).setUsage(dyn));
    geo.setAttribute('cell', new THREE.BufferAttribute(this.cell, 2).setUsage(dyn));

    const idx = new Uint32Array(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);

    // Every corner of every quad is written before it is drawn, so the unit
    // square is baked in once rather than re-uploaded with the positions.
    for (let i = 0; i < this.max; i++) {
      this.corner.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
    }
    geo.getAttribute('corner').needsUpdate = true;

    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      uniforms: { uFogNear: { value: 140 }, uFogFar: { value: 480 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Light lands on the road, and the road is what the depth buffer holds
      // there. Without the offset the quad z-fights the tarmac it is lying on.
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // After the tyre marks: a lamp lights a skid the same as it lights the road.
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  setFog(near, far) {
    this.material.uniforms.uFogNear.value = near;
    this.material.uniforms.uFogFar.value = far;
  }

  /**
   * Lay one quad flat, centred at (cx, cz), `halfX` metres across and `halfY`
   * along (fx, fz).
   *
   * The two heights are the near and far edges rather than one plane, so a beam
   * eighteen metres long follows a road that is climbing instead of burying its
   * far end in the rise.
   */
  _quad(slot, cx, cz, fx, fz, halfX, halfY, yNear, yFar, r, g, b, shape) {
    // The perpendicular is taken as (-fz, fx) rather than (fz, -fx) so the
    // quad's winding puts its front face upward. With the other one the normal
    // points at the ground, and every pool is quietly back-face culled.
    const rx = -fz, rz = fx;
    const ax = rx * halfX, az = rz * halfX;
    const bx = fx * halfY, bz = fz * halfY;

    const p = slot * 12;
    const P = this.pos;
    P[p + 0] = cx - ax - bx; P[p + 1] = yNear; P[p + 2] = cz - az - bz;
    P[p + 3] = cx + ax - bx; P[p + 4] = yNear; P[p + 5] = cz + az - bz;
    P[p + 6] = cx - ax + bx; P[p + 7] = yFar;  P[p + 8] = cz - az + bz;
    P[p + 9] = cx + ax + bx; P[p + 10] = yFar; P[p + 11] = cz + az + bz;

    const t = slot * 12;
    const T = this.tint;
    for (let i = 0; i < 4; i++) {
      T[t + i * 3] = r; T[t + i * 3 + 1] = g; T[t + i * 3 + 2] = b;
    }
    const s = slot * 4;
    this.shape[s] = shape; this.shape[s + 1] = shape;
    this.shape[s + 2] = shape; this.shape[s + 3] = shape;

    // Corner units per light cube. Clamped so a very small pool cannot ask for
    // a cell bigger than itself and come out as one lit square.
    const c = slot * 8;
    const cx2 = Math.min(0.5, LIGHT_CELL / Math.max(0.05, halfX));
    const cy2 = Math.min(0.5, LIGHT_CELL / Math.max(0.05, halfY));
    for (let i = 0; i < 4; i++) {
      this.cell[c + i * 2] = cx2;
      this.cell[c + i * 2 + 1] = cy2;
    }
  }

  /**
   * Place a pool under every glowing prop on the circuit.
   *
   * @param props     the scatter's prop list
   * @param library   the prop library `PropsMesh` built, for the glow geometry
   * @param groundAt  (x, z) -> road surface height
   */
  buildStatic(props, library, groundAt) {
    let slot = 0;
    for (let i = 0; i < props.length && slot < this.maxStatic; i++) {
      const p = props[i];
      const entry = library[p.type];
      const levels = entry?.glowLevels;
      if (!levels) continue;

      // Exactly the geometry `PropsMesh` will draw for this prop, so the pool
      // cannot end up under a variant that is not the one standing there.
      const bodyPool = entry.levels?.[Math.min(p.lod ?? 0, entry.levels.length - 1)];
      const lod = Math.min(p.lod ?? 0, levels.length - 1);
      const glowPool = levels[lod]?.length ? levels[lod] : levels[0];
      if (!glowPool?.length) continue;
      const variant = (p.variant ?? 0) % (bodyPool?.length || 1);
      const d = describeGlow(glowPool[variant % glowPool.length]);
      if (d.area <= 0) continue;

      const scale = p.scale ?? 1;
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      // Prop local -> world: rotation about Y, then the prop's own position.
      const lx = d.x * scale, lz = d.z * scale;
      const wx = p.x + lx * cos + lz * sin;
      const wz = p.z - lx * sin + lz * cos;

      // How high the light hangs decides everything about the pool it throws: a
      // lamp on an eight-metre boom washes a wide, soft disc, a sign at head
      // height puts a tight bright patch right under itself.
      const height = Math.max(0.4, d.baseY * scale);
      const radius = clamp(2.0 + height * 0.95, 2.6, 15);
      // Inverse-square would be right for a point source and wrong here: these
      // are broad emitters and the pool is already spread over `radius`, so the
      // falloff that matters is how thinly the same light is smeared.
      const power = clamp(d.area * scale * 0.24, 0.16, 1.5) / (1 + height * 0.16);

      const y = groundAt(wx, wz) + ROAD_LIFT + POOL_CLEARANCE;
      this._quad(slot, wx, wz, 0, 1, radius, radius, y, y,
        d.r * power, d.g * power, d.b * power, 0);
      slot++;
    }

    this.staticCount = slot;
    this._flush();
  }

  /** Rewrite the headlight beams. One quad per lit car, per frame. */
  update(racers, traffic, groundAt) {
    const base = this.staticCount;
    let n = 0;

    const beam = (x, z, yaw, speed, r, g, b, gain) => {
      if (n >= this.maxDynamic) return;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      // Faster cars look further down the road. This is a real cue and not
      // decoration: the beam reaching further is what tells you the speed you
      // are carrying before the number does.
      const len = 13 + Math.min(speed, 90) * 0.30;
      const half = len * 0.5;
      // The quad starts at the bumper, so its centre is half a length ahead.
      const cx = x + fx * half, cz = z + fz * half;
      const yNear = groundAt(x, z) + ROAD_LIFT + POOL_CLEARANCE;
      const yFar = groundAt(x + fx * len, z + fz * len) + ROAD_LIFT + POOL_CLEARANCE;
      this._quad(base + n, cx, cz, fx, fz, len * 0.26, half, yNear, yFar,
        r * gain, g * gain, b * gain, 1);
      n++;
    };

    for (const racer of racers) {
      if (!racer.alive) continue;
      const b = racer.body;
      // The player's own beam is the one that has to read; five rivals in a
      // pack throwing the same one washes the road out on the grid.
      beam(b.x, b.z, b.yaw, b.speed, 1.0, 0.95, 0.82, racer.isPlayer ? 0.30 : 0.14);
    }
    for (const car of traffic) {
      if (!car.alive) continue;
      // Oncoming traffic faces the other way, and its lights are the first
      // thing that says so.
      beam(car.x, car.z, car.yaw, car.speed, 1.0, 0.96, 0.86, 0.16);
    }

    this.dynamicCount = n;
    this._flush();
  }

  _flush() {
    const quads = this.staticCount + this.dynamicCount;
    this.geo.setDrawRange(0, quads * 6);
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('tint').needsUpdate = true;
    this.geo.getAttribute('shape').needsUpdate = true;
    this.geo.getAttribute('cell').needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/**
 * The glare around a light source.
 *
 * A lamp head is a few centimetres of geometry, so past thirty metres it is
 * smaller than a pixel and flickers in and out as the car moves. A halo is what
 * keeps a street of lamps reading as a street of lamps all the way to the fog:
 * a soft additive billboard whose size is in world units, so it shrinks with
 * distance without ever vanishing between samples.
 */
export class LightHalos {
  constructor(scene, max = 260) {
    this.max = max;
    this.count = 0;

    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.tint = new Float32Array(max * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: {
        uSprite: { value: radialSprite(64, 2.6) },
        uFogNear: { value: 140 },
        uFogFar: { value: 480 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
  }

  setFog(near, far) {
    this.material.uniforms.uFogNear.value = near;
    this.material.uniforms.uFogFar.value = far;
  }

  add(x, y, z, size, r, g, b) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.size[i] = size;
    this.tint[i * 3] = r; this.tint[i * 3 + 1] = g; this.tint[i * 3 + 2] = b;
  }

  commit() {
    this.geo.setDrawRange(0, this.count);
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('size').needsUpdate = true;
    this.geo.getAttribute('tint').needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.points.parent?.remove(this.points);
  }
}

/**
 * Both systems, wired to a circuit's props.
 *
 * Only built for districts whose palette says `night`. In daylight a pool of
 * lamplight on the road is invisible at best and a pale smear at worst, and the
 * fill rate it costs buys nothing.
 */
export class StreetLighting {
  constructor(scene, { props, library, groundAt, quality, fogDensity }) {
    const budget = quality?.lightPools ?? 220;
    this.pools = new LightPools(scene, {
      maxStatic: budget,
      maxDynamic: 32,
    });
    this.halos = new LightHalos(scene, budget + 32);

    this.pools.buildStatic(props, library, groundAt);
    this._buildHalos(props, library);
    this.setFog(fogDensity);
  }

  _buildHalos(props, library) {
    for (const p of props) {
      const entry = library[p.type];
      const levels = entry?.glowLevels;
      if (!levels) continue;
      const bodyPool = entry.levels?.[Math.min(p.lod ?? 0, entry.levels.length - 1)];
      const lod = Math.min(p.lod ?? 0, levels.length - 1);
      const glowPool = levels[lod]?.length ? levels[lod] : levels[0];
      if (!glowPool?.length) continue;
      const variant = (p.variant ?? 0) % (bodyPool?.length || 1);
      const d = describeGlow(glowPool[variant % glowPool.length]);
      if (d.area <= 0) continue;

      const scale = p.scale ?? 1;
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      const lx = d.x * scale, lz = d.z * scale;
      this.halos.add(
        p.x + lx * cos + lz * sin,
        p.y + d.y * scale,
        p.z - lx * sin + lz * cos,
        clamp(d.area * scale * 0.6, 0.9, 5),
        d.r, d.g, d.b,
      );
    }
    this.halos.commit();
  }

  setFog(density) {
    // The same band the particles use, so light and smoke dissolve together.
    const far = Math.min(600, 2.2 / Math.max(0.0008, density ?? 0.004));
    this.pools.setFog(far * 0.4, far);
    this.halos.setFog(far * 0.4, far);
  }

  update(racers, traffic, groundAt) {
    this.pools.update(racers, traffic, groundAt);
  }

  dispose() {
    this.pools.dispose();
    this.halos.dispose();
  }
}
