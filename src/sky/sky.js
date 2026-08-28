import * as THREE from 'three';
import { clamp01 } from '../core/math.js';

// Sky dome and the lighting rig that goes with it.
//
// The dome is a single inverted sphere with a three-stop gradient, a sun disc,
// and a band of drifting haze. It is drawn first with depth writes off, so it
// costs one full-screen worth of fill and nothing else — no cubemap, no
// atmospheric scattering integral, no PMREM bake.
//
// That is a deliberate trade. These biomes are heavily fogged by design, so
// the horizon colour matters enormously and the zenith barely shows. Matching
// `fog.color` to the horizon stop is what makes distant geometry dissolve
// instead of ending at a visible line.

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // Force w = z so the dome always lands on the far plane.
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */`
uniform vec3  uHorizon;
uniform vec3  uMid;
uniform vec3  uZenith;
uniform vec3  uSunColor;
uniform vec3  uSunDir;
uniform float uSunSize;
uniform float uHaze;
uniform float uTime;
varying vec3 vDir;

// Hash-based value noise, just enough for a drifting haze band.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}

void main() {
  float h = clamp(vDir.y, -1.0, 1.0);

  // Two-stage gradient. The lower stop is compressed hard toward the horizon
  // because that is the band the player actually looks at while driving.
  float t1 = clamp(h * 2.6, 0.0, 1.0);
  float t2 = clamp((h - 0.32) * 1.7, 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, t1);
  col = mix(col, uZenith, t2);

  // Sun: a soft disc plus a wide bloom-feeding halo.
  float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
  float disc = pow(sd, 1.0 / max(uSunSize, 1e-3));
  float halo = pow(sd, 6.0) * 0.35;
  col += uSunColor * (disc * 2.4 + halo);

  // Haze band sitting on the horizon, drifting slowly.
  float band = exp(-abs(h) * 5.0);
  float n = noise(vec2(atan(vDir.z, vDir.x) * 2.2 + uTime * 0.012, h * 5.0));
  col = mix(col, uHorizon * 1.12, band * uHaze * (0.55 + n * 0.45));

  // Below the horizon fades to the ground haze so the dome never shows an
  // edge where it meets the terrain.
  col = mix(col, uHorizon * 0.72, clamp(-h * 3.0, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.scene = scene;

    const geo = new THREE.SphereGeometry(1, 32, 16);
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color('#c98d5a') },
        uMid: { value: new THREE.Color('#e8b878') },
        uZenith: { value: new THREE.Color('#f2d6a8') },
        uSunColor: { value: new THREE.Color('#ffd9a0') },
        uSunDir: { value: new THREE.Vector3(0.4, 0.3, -0.8) },
        uSunSize: { value: 0.0016 },
        uHaze: { value: 0.55 },
        uTime: { value: 0 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    // Lighting rig. Three lights total: a key that casts, a cool fill from the
    // opposite side so shadowed bodywork does not go black, and a hemisphere
    // for ground bounce.
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = false;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0xffffff, 0.5);
    scene.add(this.fill);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.7);
    scene.add(this.hemi);

    this.time = 0;
  }

  /** Point the whole rig at a biome's palette. */
  apply(biome, quality) {
    const p = biome.palette;
    const u = this.material.uniforms;
    u.uHorizon.value.set(p.sky[0]);
    u.uMid.value.set(p.sky[1]);
    u.uZenith.value.set(p.sky[2]);
    u.uSunColor.value.set(p.sun);
    u.uHaze.value = p.haze ?? 0.55;

    // Sun elevation is per-biome: Inferno sits almost on the horizon for long
    // raking shadows, the Frozen Highway is a flat overcast.
    const elev = p.sunAngle ?? 0.35;
    const azim = p.sunAzimuth ?? 2.1;
    const dir = new THREE.Vector3(
      Math.cos(azim) * Math.cos(elev * Math.PI * 0.5),
      Math.sin(elev * Math.PI * 0.5),
      Math.sin(azim) * Math.cos(elev * Math.PI * 0.5),
    ).normalize();
    u.uSunDir.value.copy(dir);

    this.sun.position.copy(dir).multiplyScalar(160);
    this.sun.color.set(p.sun);
    this.sun.intensity = p.sunIntensity ?? 3.1;

    // Intensities come from the palette, with the daytime numbers as defaults.
    //
    // They used to be constants multiplying the palette's colours, which works
    // while the palette is bright and collapses when it is not: a night sky of
    // #0d1424 driving a hemisphere light at 1.45 contributes essentially
    // nothing, so the city rendered as a black screen with neon in it. A night
    // district needs a rig that does not follow its own sky colour — the
    // street is lit by lamps that are not in this model, and `fill` standing in
    // for their spill is what makes the road readable.
    this.fill.position.set(-dir.x, 0.5, -dir.z).multiplyScalar(100);
    this.fill.color.set(p.fillColor ?? p.ambient);
    this.fill.intensity = p.fillIntensity ?? 0.85;

    this.hemi.color.set(p.hemiColor ?? p.sky[1]);
    this.hemi.groundColor.set(p.ground);
    this.hemi.intensity = p.hemiIntensity ?? 1.45;

    this.configureShadows(quality);

    // Fog colour must track the horizon stop, or the dissolve shows a seam.
    this.scene.fog = new THREE.FogExp2(new THREE.Color(p.fog), p.fogDensity ?? 0.004);
    this.scene.background = null; // the dome is the background
  }

  configureShadows(quality) {
    const on = !!quality?.shadows;
    this.sun.castShadow = on;
    if (!on) return;
    const size = quality.shadowMapSize || 1024;
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    // The shadowed region follows the car; only what is near it needs to cast.
    cam.left = -90; cam.right = 90;
    cam.top = 90; cam.bottom = -90;
    cam.near = 1; cam.far = 420;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.6;
    cam.updateProjectionMatrix();
  }

  /** Keep the dome and the shadow frustum centred on the camera each frame. */
  update(dt, cameraPos) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.mesh.position.copy(cameraPos);
    this.mesh.scale.setScalar(1); // depth trick makes the radius irrelevant

    if (this.sun.castShadow) {
      const d = this.material.uniforms.uSunDir.value;
      this.sun.position.set(
        cameraPos.x + d.x * 150,
        cameraPos.y + d.y * 150,
        cameraPos.z + d.z * 150,
      );
      this.sun.target.position.copy(cameraPos);
      this.sun.target.updateMatrixWorld();
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh, this.sun, this.sun.target, this.fill, this.hemi);
  }
}
