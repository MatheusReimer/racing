import * as THREE from 'three';
import { clamp01 } from '../core/math.js';
import { Skyline } from './skyline.js';

// Sky dome and the lighting rig that goes with it.
//
// The dome is a single inverted sphere with a three-stop gradient, a sun disc,
// and a band of drifting haze — no cubemap, no atmospheric scattering integral,
// no PMREM bake.
//
// It is drawn *last* among the opaque objects rather than first. The vertex
// shader forces the dome onto the far plane and it writes no depth, so where it
// is drawn makes no difference to the picture and every difference to the cost:
// first, it shades every pixel of the frame and is then painted over by the
// road, the buildings and the cars; last, the depth buffer already holds all of
// them and the early-z test throws the dome away everywhere except the sky the
// player can actually see. On a street circuit walled by frontages that is most
// of the screen, and it is fill rate that decides whether a weak GPU holds the
// frame rate.
//
// A gradient dome instead of real sky is a deliberate trade. These biomes are
// heavily fogged by design, so the horizon colour matters enormously and the
// zenith barely shows. Matching `fog.color` to the horizon stop is what makes
// distant geometry dissolve instead of ending at a visible line.

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
uniform float uSunStrength;
uniform float uHaze;
uniform float uTime;
uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
// x = cos(outer radius), y = cos(inner radius): the disc's soft edge, as
// cosines so the fragment never needs an acos.
uniform vec2  uMoonEdge;
uniform float uSkyCell;
uniform float uMoonStrength;
varying vec3 vDir;

// Hash-based value noise, just enough for a drifting haze band.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}

/**
 * The sky, on a grid.
 *
 * Everything in this world is cells and the dome behind it was a perfectly
 * smooth ramp — the one surface that gave the style away as a decision about
 * geometry rather than a way of seeing. Snapping the *direction* rather than
 * the colour is what makes it cubic: every expression below reads the snapped
 * direction instead of the raw one, so the gradient, the sun, the moon and the
 * haze all become
 * constant across a cell at once, and none of them needed changing to do it.
 *
 * The azimuth step widens as the elevation climbs, because a band of constant
 * angular width narrows toward the pole and cells that go thin near the zenith
 * are stripes, not cubes.
 */
vec3 voxelDir(vec3 v) {
  vec3 d = normalize(v);
  float el = asin(clamp(d.y, -1.0, 1.0));
  el = floor(el / uSkyCell + 0.5) * uSkyCell;
  float cs = max(0.12, cos(el));
  float azStep = uSkyCell / cs;
  float az = atan(d.z, d.x);
  az = floor(az / azStep + 0.5) * azStep;
  return vec3(cs * cos(az), sin(el), cs * sin(az));
}

void main() {
  vec3 d = uSkyCell > 0.0 ? voxelDir(vDir) : normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);

  // Two-stage gradient. The lower stop is compressed hard toward the horizon
  // because that is the band the player actually looks at while driving.
  float t1 = clamp(h * 2.6, 0.0, 1.0);
  float t2 = clamp((h - 0.32) * 1.7, 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, t1);
  col = mix(col, uZenith, t2);

  // Sun: a soft disc plus a wide bloom-feeding halo. On the snapped direction
  // it comes out as a cluster of cells with a stepped corona, which is the
  // brightest thing in the frame and so the one that has to agree.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float disc = pow(sd, 1.0 / max(uSunSize, 1e-3));
  float halo = pow(sd, 6.0) * 0.35;
  col += uSunColor * (disc * 2.4 + halo) * uSunStrength;

  // Moon. A disc with a soft rim and a wide halo, plus the same value noise
  // used for the haze mottling its face — a flat white dot reads as a bug.
  if (uMoonStrength > 0.0) {
    float md = dot(d, uMoonDir);
    float disc = smoothstep(uMoonEdge.x, uMoonEdge.y, md);
    if (disc > 0.0) {
      // Coordinates across the moon's face, for the mare.
      vec3 up = abs(uMoonDir.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0);
      vec3 rx = normalize(cross(up, uMoonDir));
      vec3 ry = cross(uMoonDir, rx);
      vec2 uv = vec2(dot(d, rx), dot(d, ry)) * 46.0;
      float mare = 0.80 + 0.20 * noise(uv);
      col = mix(col, uMoonColor * mare, disc * uMoonStrength);
    }
    float glow = pow(max(md, 0.0), 340.0) * 0.5 + pow(max(md, 0.0), 24.0) * 0.05;
    col += uMoonColor * glow * uMoonStrength;
  }

  // Haze band sitting on the horizon, drifting slowly.
  float band = exp(-abs(h) * 5.0);
  float n = noise(vec2(atan(d.z, d.x) * 2.2 + uTime * 0.012, h * 5.0));
  col = mix(col, uHorizon * 1.12, band * uHaze * (0.55 + n * 0.45));

  // Below the horizon fades to the ground haze so the dome never shows an
  // edge where it meets the terrain.
  col = mix(col, uHorizon * 0.72, clamp(-h * 3.0, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(scene, gl = null) {
    this.scene = scene;
    // The GL context, only so the dome can be baked into an environment map.
    // Without one the sky still draws; the world simply has nothing to reflect.
    this.gl = gl;
    this.pmrem = null;
    this.envRT = null;

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
        uSunStrength: { value: 1 },
        uHaze: { value: 0.55 },
        uTime: { value: 0 },
        uMoonDir: { value: new THREE.Vector3(-0.55, 0.42, 0.72).normalize() },
        uMoonColor: { value: new THREE.Color('#e8eefb') },
        uMoonEdge: { value: new THREE.Vector2(Math.cos(0.030), Math.cos(0.026)) },
        uMoonStrength: { value: 0 },
        // Radians per sky cell. About two and a half degrees, which puts
        // thirty-odd bands between the horizon and the zenith — enough that
        // the sky reads as built and few enough that a band is a shape rather
        // than a dither. Zero turns the grid off entirely.
        uSkyCell: { value: 0.045 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // After every opaque object, and still before the transparent pass — the
    // two lists are sorted and drawn separately, so a large renderOrder here
    // cannot push the dome past the particles or the light pools.
    this.mesh.renderOrder = 1000;
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

    // The far matte — distant towers and aircraft — for districts that ask for
    // one. Built on demand so a desert pays nothing for a skyline.
    this.skyline = null;

    this.time = 0;
  }

  /** Where the sun is, in azimuth, so the moon can be put somewhere else. */
  static _azimuth(p) { return p.sunAzimuth ?? 2.1; }

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

    // The moon, for districts that say they are at night. It is drawn in the
    // dome's own shader rather than as a billboard, so it costs no draw call
    // and cannot end up in front of anything.
    //
    // It defaults to where the sun is, because at night the sun *is* the moon:
    // the palette's own note on the city says "the moon is the key", and a moon
    // painted anywhere else leaves the shadows pointing at nothing. The sun's
    // disc is switched off when there is one, so the two do not overlap.
    // A stripped biome gets no moon either. It is the last object in the frame
    // once the road goes, and it is drawn in the dome's shader rather than as
    // an object, so removing every mesh in the scene would not have touched it.
    // Indoors there is no sky to put one in: the dome is a ceiling.
    const moon = (biome.stripped || biome.indoor) ? null : p.moon;
    u.uMoonStrength.value = moon ? (moon.strength ?? 1) : 0;
    u.uSunStrength.value = moon ? 0 : 1;
    if (moon) {
      const mElev = moon.elevation ?? (elev * Math.PI * 0.5);
      const mAzim = moon.azimuth ?? Sky._azimuth(p);
      u.uMoonDir.value.set(
        Math.cos(mAzim) * Math.cos(mElev),
        Math.sin(mElev),
        Math.sin(mAzim) * Math.cos(mElev),
      ).normalize();
      u.uMoonColor.value.set(moon.color ?? '#e8eefb');
      const r = moon.size ?? 0.030;
      u.uMoonEdge.value.set(Math.cos(r), Math.cos(r * 0.88));
    }

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

    // Distant towers, past anything the scatter can afford to place. On by
    // default where a district is a city; a palette can say otherwise.
    const wantsSkyline = !biome.stripped && !biome.indoor && (p.skyline ?? !!biome.city);
    if (wantsSkyline && !this.skyline) {
      this.skyline = new Skyline(this.scene, { seed: `skyline:${biome.id}` });
    } else if (!wantsSkyline && this.skyline) {
      this.skyline.dispose();
      this.skyline = null;
    }
    this.skyline?.apply(p);

    this._bakeEnvironment(p);

    this.configureShadows(quality);

    // Fog colour must track the horizon stop, or the dissolve shows a seam.
    this.scene.fog = new THREE.FogExp2(new THREE.Color(p.fog), p.fogDensity ?? 0.004);
    this.scene.background = null; // the dome is the background
  }

  /**
   * Bake the dome into the environment every material reflects.
   *
   * Without this the project's PBR is a lie. `metalness` means "this surface's
   * colour comes from what it reflects", and it is set to 0.75 on chrome trim,
   * 0.55 on glass, 0.45 on wet asphalt and up to 0.58 on car paint — with
   * nothing in the scene to reflect, the diffuse term goes to zero and all
   * that is left is the specular highlight of three lights. Every chrome
   * bumper in the game has been drawing as a near-black facet.
   *
   * The source is the dome itself rather than a hand-made gradient, so the
   * reflection is the sky that is actually overhead: change a biome's palette
   * and its reflections follow, including the moon.
   *
   * Done once per race, at load. A prefiltered map is what makes roughness
   * mean anything — a raw cube reflects a mirror image into a matte panel.
   */
  _bakeEnvironment(palette) {
    if (!this.gl) return;
    this.pmrem = this.pmrem || new THREE.PMREMGenerator(this.gl);

    // A scene holding only the sky, sharing the dome's material so the bake is
    // the same shader the player is looking at.
    const only = new THREE.Scene();
    const dome = new THREE.Mesh(this.mesh.geometry, this.material);
    dome.frustumCulled = false;
    only.add(dome);

    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(only, 0, 0.1, 100);
    only.remove(dome);

    this.scene.environment = this.envRT.texture;
    // Reflection, not a second ambient.
    //
    // At 1.0 this adds a full sky's worth of light to every surface, on top of
    // rigs that six palettes were tuned against before it existed — so every
    // car came out a stop and a half hot and a strong red rendered the colour
    // of cooked salmon. The environment's job here is to give metal, glass and
    // wet tarmac something to reflect; the hemisphere light is what lights the
    // scene, and it was already doing it.
    this.scene.environmentIntensity = palette.envIntensity ?? 0.5;
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
    this.skyline?.update(dt, cameraPos);

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
    this.scene.environment = null;
    this.envRT?.dispose();
    this.envRT = null;
    this.pmrem?.dispose();
    this.pmrem = null;
    this.skyline?.dispose();
    this.skyline = null;
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh, this.sun, this.sun.target, this.fill, this.hemi);
  }
}
