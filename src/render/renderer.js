import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math.js';

// Renderer, HDR target, and a hand-rolled bloom composite.
//
// Three.js ships an EffectComposer, but it allocates a full-resolution target
// per pass and always runs them. Here bloom is a governed feature: the quality
// tier can switch it off entirely, and when it is on the blur runs at quarter
// resolution. On tier 0 the scene renders straight to the canvas with no
// intermediate target at all, which is most of what makes the low tier cheap.
//
// The bright-pass/blur/composite is deliberately small. Stylised neon trails
// and explosions over heavy fog do not need a physically-motivated bloom; they
// need a wide, cheap glow that survives at 0.7x render scale.

const FS_QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoftKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee so a surface drifting past the threshold ramps in rather than
  // popping, which is very visible on a moving trail.
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uDirection;   // texel-space step, one axis at a time
varying vec2 vUv;
void main() {
  // 9-tap Gaussian folded into 5 bilinear fetches.
  vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
  vec2 o1 = uDirection * 1.3846153846;
  vec2 o2 = uDirection * 3.2307692308;
  sum += texture2D(tDiffuse, vUv + o1) * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - o1) * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + o2) * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - o2) * 0.0702702703;
  gl_FragColor = sum;
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uVignette;
uniform float uChroma;      // radial chromatic split, driven by speed
uniform float uSpeedBlur;   // radial smear strength, driven by speed
uniform vec2  uFocus;       // screen point the smear radiates from
uniform vec3  uLift;        // grade: added to the blacks
uniform vec3  uGamma;       // grade: midtone curve
uniform vec3  uGain;        // grade: multiplied into the whites
uniform vec2  uTexel;       // 1 / scene render target size
uniform float uFxaa;        // 0 off, 1 on
varying vec2 vUv;

// FXAA, the compact one.
//
// The renderer asks for no MSAA — it is expensive on a scaled buffer and does
// nothing for the alpha-tested and shader-drawn edges here — and the render
// scale plus the dither were standing in for it. That works for gradients and
// not for silhouettes, and a low-poly game is nothing but silhouettes: every
// hard edge crawls as the car moves, which is exactly the frame in which it
// gets looked at.
//
// Nine taps, run on the scene buffer before bloom and grading, which is where
// geometry edges live. Luma is measured on a tone-compressed copy: the buffer
// is HDR-linear, and next to a highlight of forty everything is an edge.
vec3 fxaa(sampler2D tex, vec2 uv) {
  vec3 m  = texture2D(tex, uv).rgb;
  if (uFxaa < 0.5) return m;

  vec3 nw = texture2D(tex, uv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 ne = texture2D(tex, uv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 sw = texture2D(tex, uv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 se = texture2D(tex, uv + vec2( 1.0,  1.0) * uTexel).rgb;

  const vec3 W = vec3(0.299, 0.587, 0.114);
  float lNW = dot(nw / (1.0 + nw), W);
  float lNE = dot(ne / (1.0 + ne), W);
  float lSW = dot(sw / (1.0 + sw), W);
  float lSE = dot(se / (1.0 + se), W);
  float lM  = dot(m  / (1.0 + m),  W);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  // Flat enough to leave alone. Skipping here is most of the pixels.
  if (lMax - lMin < max(0.028, lMax * 0.125)) return m;

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;

  vec3 a = 0.5 * (texture2D(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb
                + texture2D(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tex, uv - dir * 0.5).rgb
                           + texture2D(tex, uv + dir * 0.5).rgb);
  float lB = dot(b / (1.0 + b), W);
  // The wider average can overshoot on a thin bright line; fall back when it
  // lands outside the neighbourhood it was meant to blend within.
  return (lB < lMin || lB > lMax) ? a : b;
}

// ACES filmic approximation (Narkowicz). Cheap, and holds saturation in the
// highlights, which matters when half the screen is an explosion.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Linear -> sRGB. Three applies this automatically when it renders to the
// canvas, but only by injecting <colorspace_fragment> into *its* shaders. A
// hand-written composite pass gets no such treatment, so without this the
// whole frame is written linear onto an sRGB surface and every lit surface
// reads several stops too dark while unlit ones look fine.
vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92,
             1.055 * pow(max(c, vec3(0.0)), vec3(0.41666667)) - 0.055,
             step(vec3(0.0031308), c));
}

void main() {
  vec2 dir = vUv - uFocus;
  vec3 col;

  if (uSpeedBlur > 0.001) {
    // Radial blur: a handful of taps along the vector away from the focus
    // point. This is the single strongest speed cue in the whole renderer.
    col = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 6; i++) {
      float t = float(i) / 5.0;
      float w = 1.0 - t * 0.6;
      col += texture2D(tDiffuse, vUv - dir * t * uSpeedBlur).rgb * w;
      total += w;
    }
    col /= total;
  } else {
    // Only when the frame is not already being smeared: six radial taps have
    // resolved the edges more thoroughly than FXAA would, and doing both is
    // paying twice for one result.
    col = fxaa(tDiffuse, vUv);
  }

  if (uChroma > 0.001) {
    float amt = uChroma * length(dir);
    col.r = texture2D(tDiffuse, vUv - dir * amt).r;
    col.b = texture2D(tDiffuse, vUv + dir * amt).b;
  }

  col += texture2D(tBloom, vUv).rgb * uBloomStrength;
  col *= uExposure;
  col = aces(col);

  // Lift, gamma, gain — after the tonemap, in display-referred space, which is
  // where a colourist grades. Before it, a lift is a change of exposure and the
  // filmic curve eats it.
  //
  // This is what makes six districts feel like six places rather than one
  // engine with the fog recoloured: the palette sets what is *in* a scene, and
  // this sets how the film that shot it was developed.
  col = pow(max(col * uGain + uLift, 0.0), uGamma);

  float vig = 1.0 - uVignette * dot(vUv - 0.5, vUv - 0.5) * 2.2;
  col *= clamp(vig, 0.0, 1.0);

  col = linearToSRGB(col);

  // Dither after the transfer function, in display space, where banding
  // actually lives. Very visible across the large fog gradients these biomes
  // are built from.
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (d - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}`;

export class Renderer {
  constructor(canvas, quality) {
    this.canvas = canvas;
    this.quality = quality;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,        // resolved by render scale + the dither instead
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping happens in the composite pass; when bloom is off we let
    // Three do it instead (see `render`).
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.enabled = false;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.setClearColor(0x000000, 1);

    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;

    this.exposure = 1.34;
    // Bloom is added *before* exposure and tonemapping, so the threshold is
    // compared against raw linear radiance. Ordinary sunlit surfaces in this
    // lighting reach 0.4-0.9 there, so a threshold below 1 captures the road
    // and the sand and adds a uniform glow over the whole frame — the scene
    // renders correctly and then gets washed out on the way to the screen.
    // Above LDR white, only genuinely overbright things qualify: the sun disc,
    // the emissive trim, particles, explosions.
    this.bloomStrength = 0.45;
    this.bloomThreshold = 1.15;
    this.vignette = 0.22;
    this.chroma = 0;
    this.speedBlur = 0;
    this.focus = new THREE.Vector2(0.5, 0.55);

    this._buildPasses();
    this.applyQuality(quality.settings);
    this.resize();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  _buildPasses() {
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FS_QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1.15 }, uSoftKnee: { value: 0.5 } },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FS_QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2() } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FS_QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, tBloom: { value: null },
        uBloomStrength: { value: 0.45 }, uExposure: { value: 1.0 },
        uVignette: { value: 0.22 }, uChroma: { value: 0.0 },
        uSpeedBlur: { value: 0.0 }, uFocus: { value: new THREE.Vector2(0.5, 0.55) },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uFxaa: { value: 1 },
      },
    });

    this.quad = new THREE.Mesh(geo, this.brightMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    // A 1x1 black stand-in so the composite shader has a valid bloom sampler
    // even on tiers where the bloom chain is never allocated.
    this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blackTex.needsUpdate = true;
  }

  applyQuality(q) {
    this.q = q;
    this.useBloom = q.bloom;
    this.blurPasses = q.bloomPasses;
    this.gl.shadowMap.enabled = q.shadows;
    if (q.shadows) this.gl.shadowMap.needsUpdate = true;
    this.maxAnisotropy = Math.min(q.anisotropy, this.gl.capabilities.getMaxAnisotropy());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.q?.maxPixelRatio ?? 1.5);
    const scale = (this.q?.pixelRatio ?? 1) * dpr;

    this.width = Math.max(1, Math.floor(w * scale));
    this.height = Math.max(1, Math.floor(h * scale));
    this.pixelRatio = scale;

    // The drawing buffer gets the device ratio; the scene's render scale does
    // not apply to it.
    //
    // These are two different dials that were being read as one. `pixelRatio`
    // is a performance dial on the expensive HDR scene pass — render at 85% and
    // upscale, and the stylised look survives it. The canvas is the cheap final
    // surface, and it was pinned to CSS pixels: on a display at device ratio 2
    // the scene rendered 1920 wide, resolved into a 1280 canvas, and the browser
    // stretched that back to 2560. The middle number was paid for and thrown
    // away, and the menu turntable — which draws straight to the canvas and
    // skips the composite entirely — was left at a third of the resolution the
    // screen could show.
    //
    // Capped by `maxPixelRatio`, which is 1.0 on the lowest tier: the machines
    // that must hold the frame rate see no change at all.
    this.gl.setPixelRatio(1);              // we manage the buffer size ourselves
    this.gl.setSize(Math.max(1, Math.floor(w * dpr)), Math.max(1, Math.floor(h * dpr)), false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    this._allocTargets();
  }

  _allocTargets() {
    const dispose = (rt) => rt && rt.dispose();

    // The blur chain is what a low tier gives up. The scene target is not:
    // every tier composites through it, so that dropping a tier costs detail
    // rather than changing what the game looks like.
    if (!this.useBloom) {
      dispose(this.bloomA); this.bloomA = null;
      dispose(this.bloomB); this.bloomB = null;
    }

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    dispose(this.sceneRT);
    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, opts);

    // Quarter resolution for the glow. At the blur radii we use, going higher
    // is not distinguishable but costs four times the fill.
    const bw = Math.max(1, this.width >> 2);
    const bh = Math.max(1, this.height >> 2);
    const bopts = { ...opts, depthBuffer: false };
    dispose(this.bloomA);
    dispose(this.bloomB);
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, bopts);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, bopts);
  }

  _blit(material, target) {
    this.quad.material = material;
    this.gl.setRenderTarget(target);
    this.gl.render(this.quadScene, this.quadCamera);
  }

  /** Wipe the canvas. */
  clear() {
    this.gl.setRenderTarget(null);
    this.gl.setScissorTest(false);
    this.gl.setViewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clear();
  }

  /**
   * Render a scene into one rectangle of the canvas, in CSS pixels, and leave
   * the rest of the frame untouched.
   *
   * For the menu showroom, which is a lit object on a plain background sitting
   * in a hole the screen's layout leaves for it. It goes straight to the canvas
   * and skips the whole bloom composite deliberately: that chain exists to give
   * a biome its grade, and a showroom wants none of it. Scissoring rather than
   * clearing means whatever the menu drew behind survives around the edges.
   *
   * @param rect  { x, y, width, height } in CSS pixels, y measured from the top
   */
  renderInset(scene, camera, rect) {
    const gl = this.gl;
    const canvas = this.canvas;
    // Measured off the canvas rather than taken from `pixelRatio`: that field
    // sizes the offscreen HDR target, and the drawing buffer this is writing to
    // is a different size again.
    const sx = canvas.width / Math.max(1, canvas.clientWidth);
    const sy = canvas.height / Math.max(1, canvas.clientHeight);

    const w = Math.max(1, Math.round(rect.width * sx));
    const h = Math.max(1, Math.round(rect.height * sy));
    const x = Math.round(rect.x * sx);
    // GL counts rows from the bottom of the buffer, the DOM from the top.
    const y = Math.max(0, canvas.height - Math.round(rect.y * sy) - h);

    gl.setRenderTarget(null);
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.1;
    gl.setViewport(x, y, w, h);
    gl.setScissor(x, y, w, h);
    gl.setScissorTest(true);
    // `render` clears for us, and inside the scissor.
    gl.render(scene, camera);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, canvas.width, canvas.height);
  }

  /**
   * @param scene   the world
   * @param camera  the active camera
   * @param fx      { speedBlur, chroma, exposure, focusX, focusY } per-frame
   */
  render(scene, camera, fx = {}) {
    const gl = this.gl;

    // Every tier goes through the composite.
    //
    // The low tiers used to skip it and render straight to the canvas, letting
    // Three tonemap instead — which drops the vignette, the chroma and the
    // speed blur along with the bloom. So the governor changing tier did not
    // read as less detail, it read as the lighting changing: the countdown ran
    // at one tier, the race put the load up and dropped it, and the whole image
    // shifted the instant the lights went out. What a low tier gives up now is
    // the blur chain, which is the expensive part; one fullscreen pass is not.
    gl.toneMapping = THREE.NoToneMapping;

    // 1. Scene into the HDR target.
    gl.setRenderTarget(this.sceneRT);
    gl.clear();
    gl.render(scene, camera);

    if (this.useBloom) {
      // 2. Bright pass at quarter res.
      this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.brightMat.uniforms.uThreshold.value = this.bloomThreshold;
      this._blit(this.brightMat, this.bloomA);

      // 3. Separable blur, ping-ponging. Each pass widens the kernel.
      const bw = this.bloomA.width;
      const bh = this.bloomA.height;
      for (let i = 0; i < this.blurPasses; i++) {
        const spread = 1 + i * 1.6;
        this.blurMat.uniforms.tDiffuse.value = this.bloomA.texture;
        this.blurMat.uniforms.uDirection.value.set(spread / bw, 0);
        this._blit(this.blurMat, this.bloomB);

        this.blurMat.uniforms.tDiffuse.value = this.bloomB.texture;
        this.blurMat.uniforms.uDirection.value.set(0, spread / bh);
        this._blit(this.blurMat, this.bloomA);
      }
    }

    // 4. Composite to the canvas.
    const u = this.compositeMat.uniforms;
    u.tDiffuse.value = this.sceneRT.texture;
    u.tBloom.value = this.bloomA ? this.bloomA.texture : this.blackTex;
    u.uBloomStrength.value = this.useBloom ? this.bloomStrength : 0;
    u.uExposure.value = fx.exposure ?? this.exposure;
    u.uVignette.value = this.vignette;
    u.uChroma.value = fx.chroma ?? this.chroma;
    u.uSpeedBlur.value = fx.speedBlur ?? this.speedBlur;
    u.uFocus.value.set(fx.focusX ?? 0.5, fx.focusY ?? 0.55);
    // The scene buffer's size, not the canvas's: FXAA runs before the upscale,
    // where the geometry edges are.
    u.uTexel.value.set(1 / Math.max(1, this.sceneRT.width), 1 / Math.max(1, this.sceneRT.height));
    u.uFxaa.value = this.quality?.settings?.fxaa === false ? 0 : 1;

    const g = fx.grade;
    u.uLift.value.set(...(g?.lift ?? [0, 0, 0]));
    // Stored as the gamma a colourist would name, which the shader wants the
    // reciprocal of — so **above one brightens that channel's midtones** and
    // below one darkens them. Worth stating: the first pass at these tables was
    // written the other way round and every district was graded backwards.
    const gm = g?.gamma ?? [1, 1, 1];
    u.uGamma.value.set(1 / gm[0], 1 / gm[1], 1 / gm[2]);
    u.uGain.value.set(...(g?.gain ?? [1, 1, 1]));
    this._blit(this.compositeMat, null);
  }

  /**
   * Compile the scene's programs before anything is timed.
   *
   * Three compiles a material's program the first time it draws with it, so an
   * entire scene's worth arrives in whichever frame first shows it — which for
   * a race is the frame the countdown ends. Asking for them up front costs the
   * same total and spends it where a pause is already expected.
   *
   * A camera is wanted but not required: `compile` uses it to work out which
   * lights each material will see, and without one the lit variants are still
   * built, just against the scene's lights alone.
   */
  precompile(scene, camera) {
    if (!scene) return this;
    const cam = camera ?? new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    try {
      this.gl.compile(scene, cam);
    } catch {
      // A driver that will not precompile is not a reason to fail to start a
      // race; it just means the hitch stays where it was.
    }
    return this;
  }

  get aspect() {
    return window.innerWidth / Math.max(1, window.innerHeight);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.sceneRT?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.gl.dispose();
  }
}
