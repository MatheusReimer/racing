import * as THREE from 'three';
import { ROAD_LIFT } from '../track/track.js';

// The dark patch under a car.
//
// Shadow maps are a High and Ultra feature, so on the two tiers most people
// will actually run, nothing in the game casts anything and every car sits on
// the road the way a sticker sits on a page. This is the cheap stand-in: one
// instanced quad per car, laid flat on the ground, multiplied into whatever is
// under it.
//
// It is drawn on every tier, not only where shadow maps are missing. A
// directional shadow map at 1024 across a 180 m frustum has texels the size of
// a wheel, and the one place it cannot resolve is the few centimetres directly
// beneath the car — which is the contact the eye is actually looking for. Where
// real shadows exist this is quieter, and it is doing a different job.

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uStrength;
varying vec2 vUv;
void main() {
  // An ellipse that fades from the middle out. Squared falloff, because a
  // linear one has a visible rim where it reaches zero.
  float d = length(vUv - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.22, 0.92, d);
  a *= a;
  gl_FragColor = vec4(uColor, a * uStrength);
}`;

/**
 * Clear of the tarmac, and of the road's own lift above the terrain.
 *
 * `groundAt` answers with the terrain, not with the surface being driven on —
 * the road mesh sits `ROAD_LIFT` above it. The first version of this cleared
 * the terrain by 35 mm and the road by minus 25, so every shadow was drawn
 * underneath the asphalt and the depth test threw all of them away. The light
 * pools solved the same problem the same way; this borrows their arithmetic.
 */
const LIFT = 0.05;

export class ContactShadows {
  constructor(scene, max = 24) {
    this.scene = scene;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      // Straight alpha, not multiply.
      //
      // Multiply is the better-looking choice in principle — it darkens what
      // is under it rather than laying grey over it — and measured against a
      // frozen frame it moved twelve pixels out of half a million. Whatever it
      // was doing against this renderer's float target, it was not darkening
      // the road, and a shadow nobody can measure is not a shadow.
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x0a0c10) },
        uStrength: { value: 0.55 },
      },
    });

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, this.material, max);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;   // after the road, before the transparent pass
    scene.add(this.mesh);

    this.max = max;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._fade = new THREE.Vector3(1, 1, 1);
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  /** Softer where a real shadow map is already doing most of the work. */
  applyQuality(q) {
    // Set by looking: 0.62 with no shadow map was there in the buffer and not
    // there to the eye, which is the same as not being there.
    this.material.uniforms.uStrength.value = q?.shadows ? 0.48 : 0.82;
  }

  /**
   * @param racers    the field; each carries its pose on `body`
   * @param traffic   civilians, whose pose is on the object itself
   * @param sizeOf    car -> { length, width }; the simulation does not know
   *                  how big a car is to look at, only how big it is to hit
   * @param groundAt  the road height under a point
   * @param sunDir    the key light's direction, so the patch falls away from
   *                  it instead of hiding under the car
   *
   * Two lists rather than one joined array, because joining them every frame
   * allocates a new array and six wrapper objects for a thing that runs at
   * sixty hertz and draws one quad each.
   */
  update(racers, traffic, sizeOf, groundAt, sunDir = null) {
    // Where the shadow goes, and how far.
    //
    // Centred under the car it is very nearly invisible: the chase camera sits
    // behind and above, so the car's own body occludes almost all of it —
    // measured against a frozen frame, a centred patch moved 571 pixels out of
    // half a million. A real shadow falls away from the light, and with the sun
    // low that is most of its length lying out where it can be seen.
    // How far a metre of height throws, clamped: a sun near the horizon would
    // otherwise throw a shadow the length of the straight.
    const throwPerM = sunDir ? Math.min(2.6, 1 / Math.max(0.22, sunDir.y)) : 0;
    // The bearing the shadow points along — away from the light.
    const bearing = sunDir ? Math.atan2(-sunDir.x, -sunDir.z) : 0;
    this._off = {
      dx: Math.sin(bearing), dz: Math.cos(bearing), bearing,
      throw: throwPerM * 1.25,   // roughly the height of a car's roof
    };

    let n = 0;
    for (const list of [racers, traffic]) {
      for (const item of list) {
        if (n >= this.max) break;
        if (item.alive === false) continue;
        const car = item.body ?? item;
        const size = sizeOf(item);
        n = this._place(n, car, size, groundAt);
      }
    }
    for (let i = n; i < this.max; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.count = this.max;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _place(n, car, size, groundAt) {
    {
      const ground = groundAt(car.x, car.z);
      // A car in the air throws a smaller, fainter patch, and one far enough up
      // throws none. This is the only cue a jump has that it left the road.
      const air = Math.max(0, car.y - ground);
      if (air > 2.2) return n;
      const lift = 1 - Math.min(1, air / 2.2);

      const o = this._off;
      const carLen = (size?.length ?? 4.4) * (1.02 + air * 0.14);
      const carWid = (size?.width ?? 1.9) * (1.10 + air * 0.14);

      // Aligned to the light's bearing, not the car's heading, and centred
      // half a throw along it — so the near end stays under the car and the
      // rest lies out where it can be seen. Offsetting a patch that was still
      // aligned to the car detached it: a grey smudge beside the car rather
      // than a shadow coming off it.
      const reach = o.throw;
      const len = Math.max(carLen, carWid) + reach;
      this._p.set(
        car.x + o.dx * reach * 0.5,
        ground + ROAD_LIFT + LIFT,
        car.z + o.dz * reach * 0.5);
      this._q.setFromAxisAngle(this._up, o.bearing);
      this._s.set(carWid * 1.05, 1, len);
      this._m.compose(this._p, this._q, this._s);
      // Fade by scaling toward nothing rather than by a per-instance uniform,
      // which an InstancedMesh cannot have without another attribute.
      if (lift < 1) this._m.scale(this._fade.set(lift, 1, lift));
      this.mesh.setMatrixAt(n++, this._m);
    }
    return n;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh);
  }
}
