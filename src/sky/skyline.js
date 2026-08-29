import * as THREE from 'three';
import { RNG } from '../core/rng.js';

// What is out there, past everything the scatter can afford to place.
//
// A city district's horizon ended at the fog and then there was gradient. The
// props already build a skyline, but they are real objects standing on real
// ground inside a 360 m band — going further means paying for geometry nobody
// will ever drive to, and the fog eats it before it is tall enough to matter.
//
// So this is a matte. Both meshes use the dome's own trick — the vertex shader
// forces w into z, which puts them on the far plane — so:
//
//   * they are always behind every real object, because at depth 1.0 the depth
//     test rejects them anywhere geometry has already drawn;
//   * they never need fogging, since nothing is nearer or further than
//     anything else out there;
//   * they cost two draw calls and about nine hundred triangles, whatever the
//     circuit does.
//
// The price is no parallax: the towers turn with the camera but do not slide
// past each other as it moves. At the distance they are meant to read as —
// several kilometres — that is what they would do anyway.

const FAR_VERT = /* glsl */`
attribute float aLit;
attribute float aHeight;
varying float vLit;
varying float vHeight;
void main() {
  vLit = aLit;
  vHeight = aHeight;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FAR_FRAG = /* glsl */`
uniform vec3 uHorizon;
uniform vec3 uSilhouette;
uniform vec3 uWindow;
uniform float uFade;
uniform float uWindowMix;
varying float vLit;
varying float vHeight;
void main() {
  // Bases dissolve into the horizon, tops stand against the sky. Without this
  // the skyline is a cut-out sitting on a line.
  float t = smoothstep(0.0, uFade, vHeight);
  vec3 tower = mix(uHorizon, uSilhouette, t);
  if (vLit > 0.5) {
    // By day a lit window is a speck on a silhouette nobody can resolve, and
    // it reads as noise — so uWindowMix fades them back into the tower rather
    // than switching them to black, which is what a zeroed colour did.
    gl_FragColor = vec4(mix(tower, uWindow, uWindowMix), 1.0);
    return;
  }
  gl_FragColor = vec4(tower, 1.0);
}`;

const PLANE_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
varying float vPhase;
void main() {
  vPhase = aPhase;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
  // Small and constant: an airliner at cruise is a moving point, not a shape.
  gl_PointSize = 2.6;
}`;

const PLANE_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uSteady;
uniform vec3 uBlink;
varying float vPhase;
void main() {
  // Round, not square: a 3px quad with corners reads as a dead pixel.
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  // One in three flashes; the rest are the steady navigation light.
  float blink = step(0.86, fract(uTime * 0.55 + vPhase));
  gl_FragColor = vec4(mix(uSteady, uBlink, blink), 1.0);
}`;

/** Radius the matte is built at. Only directions survive the far-plane trick. */
const R = 900;

/**
 * A band of towers on the horizon, and a few aircraft crossing above it.
 *
 * @param opts.seed     so a district's skyline is the same every time it loads
 * @param opts.towers   how many, around the whole circle
 * @param opts.aircraft how many lights are up there
 */
export class Skyline {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const rng = new RNG(opts.seed ?? 'skyline');

    this.material = new THREE.ShaderMaterial({
      vertexShader: FAR_VERT,
      fragmentShader: FAR_FRAG,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color('#0d1424') },
        uSilhouette: { value: new THREE.Color('#161d2e') },
        uWindow: { value: new THREE.Color('#ffd9a0') },
        uFade: { value: 0.22 },
        uWindowMix: { value: 0 },
      },
    });

    this.mesh = new THREE.Mesh(buildTowers(rng, opts.towers ?? 54), this.material);
    this.mesh.frustumCulled = false;
    // After the dome, which writes no depth and would otherwise paint over it.
    this.mesh.renderOrder = 1001;
    scene.add(this.mesh);

    this.planeMat = new THREE.ShaderMaterial({
      vertexShader: PLANE_VERT,
      fragmentShader: PLANE_FRAG,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uSteady: { value: new THREE.Color('#fff2d8') },
        uBlink: { value: new THREE.Color('#ff5a4a') },
      },
    });

    this.planes = [];
    const n = opts.aircraft ?? 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      phase[i] = rng.next();
      this.planes.push({
        // Each crosses the sky on its own heading, at its own height and pace.
        azimuth: rng.range(0, Math.PI * 2),
        elevation: 0.18 + rng.range(0, 0.26),
        speed: (rng.bool(0.5) ? 1 : -1) * (0.006 + rng.range(0, 0.010)),
      });
    }
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.planeMesh = new THREE.Points(geo, this.planeMat);
    this.planeMesh.frustumCulled = false;
    this.planeMesh.renderOrder = 1002;
    scene.add(this.planeMesh);

    this._writePlanes();
  }

  /** Take the district's colours, so the matte is not a different city. */
  apply(palette) {
    const u = this.material.uniforms;
    u.uHorizon.value.set(palette.sky?.[0] ?? '#0d1424');
    u.uSilhouette.value.set(palette.skylineColor ?? palette.fog ?? '#161d2e');
    u.uWindow.value.set(palette.skylineWindow ?? '#ffd9a0');
    // Lit windows and aircraft lights are night things. By day they are specks
    // on a silhouette nobody can resolve.
    u.uWindowMix.value = palette.night ? 1 : 0;
    this.planeMesh.visible = !!palette.night;
  }

  update(dt, cameraPos) {
    this.mesh.position.copy(cameraPos);
    this.planeMesh.position.copy(cameraPos);
    this.planeMat.uniforms.uTime.value += dt;
    for (const p of this.planes) p.azimuth += p.speed * dt;
    this._writePlanes();
  }

  _writePlanes() {
    const pos = this.planeMesh.geometry.getAttribute('position');
    this.planes.forEach((p, i) => {
      const ce = Math.cos(p.elevation);
      pos.setXYZ(i,
        Math.cos(p.azimuth) * ce * R,
        Math.sin(p.elevation) * R,
        Math.sin(p.azimuth) * ce * R);
    });
    pos.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.planeMesh.geometry.dispose();
    this.planeMat.dispose();
    this.scene.remove(this.mesh, this.planeMesh);
  }
}

/**
 * The towers, as one merged buffer.
 *
 * Built at a radius rather than as a flat backdrop so the band wraps the whole
 * circle: a driver on a loop faces every direction, and a skyline that only
 * exists to the north is worse than none. Each tower is three quads — the two
 * faces you can see from inside the ring, and a cap — because at this distance
 * a box's far side is never visible and is a third of the geometry.
 */
function buildTowers(rng, count) {
  const pos = [];
  const lit = [];
  const hgt = [];
  const maxH = 260;

  // Height is per *vertex*, not per tower: passing the tower's own height made
  // the gradient a flat tint on each one — short towers uniformly pale, tall
  // ones uniformly dark — rather than a fade up from the base.
  const quad = (a, b, c, d, isLit) => {
    for (const v of [a, b, c, a, c, d]) {
      pos.push(v[0], v[1], v[2]);
      lit.push(isLit ? 1 : 0);
      hgt.push(v[1] / maxH);
    }
  };

  for (let i = 0; i < count; i++) {
    // Jittered around an even spacing: perfectly regular towers read as a fence.
    const a = ((i + rng.range(-0.35, 0.35)) / count) * Math.PI * 2;
    const halfWidth = rng.range(0.008, 0.020);          // radians of arc
    // A few are much taller than the rest. A skyline of one height is a wall.
    const h = rng.bool(0.16) ? rng.range(150, maxH) : rng.range(38, 120);

    const a0 = a - halfWidth;
    const a1 = a + halfWidth;
    const p = (ang, y) => [Math.cos(ang) * R, y, Math.sin(ang) * R];
    // Front face, and one side, so a tower has a lit edge and a dark one.
    quad(p(a0, 0), p(a1, 0), p(a1, h), p(a0, h), false);
    const aSide = a1 + halfWidth * 0.5;
    quad(p(a1, 0), p(aSide, 0), p(aSide, h * 0.94), p(a1, h * 0.94), false);

    // A handful of lit floors, as thin bands across the face.
    const floors = Math.floor(h / 26);
    for (let f = 1; f < floors; f++) {
      if (!rng.bool(0.42)) continue;
      const y = (f / floors) * h;
      const band = Math.max(1.2, h * 0.012);
      const inset = halfWidth * 0.18;
      quad(p(a0 + inset, y), p(a1 - inset, y),
        p(a1 - inset, y + band), p(a0 + inset, y + band), true);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aLit', new THREE.BufferAttribute(new Float32Array(lit), 1));
  geo.setAttribute('aHeight', new THREE.BufferAttribute(new Float32Array(hgt), 1));
  return geo;
}
