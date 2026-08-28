import * as THREE from 'three';
import { boxOf, prism, mergeFaceted, facetedMaterial, triCount } from '../world/shapes.js';
import { RNG } from '../core/rng.js';

// Civilian cars.
//
// Deliberately not built by `VehicleMesh`. A racer is ~30k triangles because it
// is two metres from the camera for the whole race; a hatchback you pass at
// 180 km/h is a silhouette, a roof colour and a pair of lights. Four bodies at
// a few hundred triangles each, instanced, is the whole budget this deserves —
// and keeping them visually plainer than the racers is what makes the racers
// read as the special things on the road.
//
// Lights are a second, unlit pass for the same reason the braziers have one:
// tail lights that respond to the scene lighting are not lights, they are red
// paint, and at night that difference is most of what tells you which way a car
// is facing before you are committed.

// Sized against the cars they share a road with.
//
// The racers used to be invented, and 4.5 to 5.6 m of invented; they are taken
// off real cars now and come out at 3.55 to 4.52. Traffic did not move, so a
// civilian van stood half again as long as the machine you were driving and
// two metres tall beside a car of 1.2 — which read, correctly, as the traffic
// being from a different game. These are the real figures for what each one is
// meant to be, so a hatchback is still bigger than a Peugeot 205 and a van is
// still a van, by the margin those actually differ by.
// Sized against the cars they share a road with, and now measured against them
// rather than against the real world.
//
// The racers are taken off real cars and come out between 3.55 and 4.52 m. Real
// civilian figures put a van at 5.05, which is correct and reads wrong: it
// stood longer than anything in the race, and the eye compares it to the car it
// is driving rather than to a catalogue. These sit inside the same band, with
// the same ordering between them — a van is still the biggest thing on the
// road, by the margin the grid can absorb.
// The same near-black the racers' glass uses, drawn on the unlit material.
//
// It was 0x11161d on the lit body material at metalness 0.18, so in sun the
// windows caught a specular highlight and read as pale blue-grey panels — the
// exact thing black glass was asked for to stop. Glazing is the darkest part
// of a car from outside in almost any light, and the way to draw that is to
// stop asking the lighting.
const TRAFFIC_GLASS = 0x070a0f;

// The tints a civilian's paint is multiplied by, one per car.
//
// Multipliers rather than colours: each body type already has a base — the
// van's cream, the estate's brown — and these shift it rather than replace it,
// so a van still reads as a van. Kept near 1 and mostly desaturated, because
// what is wanted is a street that is not one colour, not a rally paddock.
const PAINTS = [
  0xffffff, 0xf2f4f7, 0xd8dde4, 0xb9c0c8, 0x9aa2ab,
  0xd9c9b4, 0xc7d2dc, 0xb8c8bb, 0xe0c9c2, 0xcfc4d6,
  0xa8b4c4, 0xd6d0bc, 0x8f9aa6, 0xe6dcc8, 0xc2b8ae,
];

const BODIES = [
  // width, length, height, roof drop, colour
  { w: 1.70, l: 3.80, h: 0.58, roof: 0.48, c: 0x9aa0a8 },   // hatchback
  { w: 1.78, l: 4.30, h: 0.56, roof: 0.46, c: 0x6b7480 },   // saloon
  { w: 1.86, l: 4.55, h: 0.82, roof: 0.66, c: 0xb8b2a4 },   // van
  { w: 1.74, l: 4.20, h: 0.58, roof: 0.48, c: 0x7d5a4a },   // estate
];

function buildBody(spec, rng) {
  const { w, l, h, roof, c } = spec;
  // Bodywork apart from everything bolted to it. The four boxes painted `c`
  // are the only surfaces a car's colour belongs on; the bumpers, shuts,
  // mirrors, arches and tyres are the same on every car in the street. Keeping
  // them in separate lists is what lets one instanced draw carry a hundred
  // cars in a hundred colours without red tyres. See PAINT_MASK.
  const paint = [];
  const parts = [];
  // Where the bodywork starts above the road. A third of a metre is an
  // off-roader's clearance and it had every civilian car standing on stilts;
  // a saloon's floor is nearer sixteen centimetres.
  const rideH = 0.16;

  // Three volumes, not one.
  //
  // A civilian used to be a box with a smaller box on it, at a few hundred
  // triangles, on the argument that a car you pass at 180 is a silhouette. It
  // is not, when it is stopped across the road because you just hit it, and
  // there are only eighteen of them on a circuit — so the budget that argument
  // was protecting was never large. A bonnet, a cabin and a boot at slightly
  // different heights is what makes a shape read as a car rather than as a
  // crate, and it is still under two thousand triangles.
  const glass = [];
  const bonnet = l * 0.30;
  const cabinL = l * 0.42;
  const boot = l - bonnet - cabinL;
  const zNose = l / 2;

  // Lower body, stepped: the middle is fractionally wider and taller, the way
  // a car's waist is.
  paint.push(boxOf(w * 0.97, h * 0.86, bonnet, c,
    { y: rideH + h * 0.43, z: zNose - bonnet / 2, rng, variation: 0.04 }));
  paint.push(boxOf(w, h, cabinL, c,
    { y: rideH + h / 2, z: zNose - bonnet - cabinL / 2, rng, variation: 0.04 }));
  paint.push(boxOf(w * 0.98, h * 0.92, boot, c,
    { y: rideH + h * 0.46, z: -l / 2 + boot / 2, rng, variation: 0.04 }));

  // Greenhouse: a cabin box with a raked panel at each end, which is most of
  // the difference between a saloon and a shipping container.
  const cabY = rideH + h;
  const cabW = w * 0.88;
  paint.push(boxOf(cabW, roof, cabinL * 0.88, c,
    { y: cabY + roof / 2 - 0.04, z: zNose - bonnet - cabinL / 2, rng, variation: 0.03 }));
  for (const [iz, len] of [[1, 0.34], [-1, 0.28]]) {
    const g = boxOf(cabW * 0.98, roof * 0.96, cabinL * len, TRAFFIC_GLASS, {
      y: cabY + roof * 0.48,
      z: zNose - bonnet - cabinL / 2 + iz * cabinL * 0.5,
      rng,
      variation: 0,
    });
    g.rotateX(iz * 0.42);
    glass.push(g);
  }
  // Side glass as one dark band, as before: four panes at this range is spend
  // with nothing to show for it.
  glass.push(boxOf(cabW * 1.01, roof * 0.58, cabinL * 0.80, TRAFFIC_GLASS, {
    y: cabY + roof * 0.55, z: zNose - bonnet - cabinL / 2, rng, variation: 0,
  }));

  // Bumpers and a grille.
  for (const iz of [1, -1]) {
    parts.push(boxOf(w * 0.94, 0.16, 0.14, 0x2b2f35, {
      y: rideH + 0.16, z: iz * (l / 2 + 0.04), rng,
    }));
  }
  parts.push(boxOf(w * 0.52, h * 0.22, 0.06, 0x15181c,
    { y: rideH + h * 0.42, z: l / 2 + 0.02, rng }));

  // Mirrors. Two boxes, and the first thing that stops a car looking like a bar
  // of soap from the side.
  for (const ix of [-1, 1]) {
    parts.push(boxOf(0.16, 0.09, 0.10, 0x1b1f24, {
      x: ix * (w / 2 + 0.07), y: cabY + roof * 0.18,
      z: zNose - bonnet - cabinL * 0.22, rng,
    }));
  }

  // Shut lines and arch lips.
  //
  // Thin dark strips, twelve triangles each, and they are most of what stops a
  // civilian reading as a single moulded lump: an eye finds a car by its panel
  // gaps and its arches long before it counts its curves.
  const shut = 0.035;
  for (const ix of [-1, 1]) {
    for (const dz of [0.06, -0.30]) {
      parts.push(boxOf(shut, h * 0.72, 0.03, 0x1b1f24, {
        x: ix * (w / 2 + 0.005), y: rideH + h * 0.5,
        z: zNose - bonnet - cabinL * 0.5 + cabinL * dz, rng,
      }));
    }
    // Bonnet and boot shuts, across the top.
    for (const z of [zNose - bonnet, -l / 2 + boot]) {
      parts.push(boxOf(w * 0.92, 0.03, shut, 0x1b1f24,
        { x: 0, y: rideH + h * 0.86, z, rng }));
    }
    // A lip over each arch.
    for (const iz of [1, -1]) {
      parts.push(boxOf(0.10, 0.07, 0.62, 0x1f2429, {
        x: ix * (w / 2 - 0.02), y: rideH + h * 0.30, z: iz * l * 0.31, rng,
      }));
    }
  }

  // Wheels, with a rim face so they are not black discs.
  for (const ix of [-1, 1]) {
    for (const iz of [1, -1]) {
      const tyre = prism(16, 0.32, 0.32, 0.22, 0x15181c, { rng });
      tyre.rotateZ(Math.PI / 2);
      tyre.translate(ix * (w / 2 - 0.06), 0.32, iz * l * 0.31);
      parts.push(tyre);
      const rim = prism(12, 0.19, 0.19, 0.06, 0x6a7078, { rng });
      rim.rotateZ(Math.PI / 2);
      rim.translate(ix * (w / 2 - 0.03), 0.32, iz * l * 0.31);
      parts.push(rim);
    }
  }
  const painted = mergeFaceted(paint);
  const fitted = mergeFaceted(parts);
  const nPaint = painted.attributes.position.count;
  const body = mergeFaceted([painted, fitted]);
  // 1 on bodywork, 0 on everything else. The paint geometry goes in first, so
  // the split is a count rather than a search.
  const mask = new Float32Array(body.attributes.position.count);
  mask.fill(1, 0, nPaint);
  body.setAttribute('paintMask', new THREE.BufferAttribute(mask, 1));
  return { body, glass: mergeFaceted(glass) };
}

function buildLights(spec) {
  const { w, l, h } = spec;
  const parts = [];
  const y = 0.34 + h * 0.62;
  // Lamps and glass share this geometry because they share a material, not
  // because they are the same thing: both want to be drawn without the
  // lighting having a say. See TRAFFIC_GLASS.
  // Reds at the back, whites at the front, in the local frame. The renderer
  // never has to know which way the car is going; the geometry does.
  for (const ix of [-1, 1]) {
    parts.push(boxOf(0.22, 0.12, 0.06, 0xff2a1e, { x: ix * w * 0.34, y, z: -l / 2 - 0.02 }));
    parts.push(boxOf(0.24, 0.12, 0.06, 0xfff0d0, { x: ix * w * 0.34, y, z: l / 2 + 0.02 }));
  }
  return mergeFaceted(parts);
}

export class TrafficMesh {
  constructor(cars, quality = {}, seed = 7) {
    this.group = new THREE.Group();
    this.cars = cars;

    const rng = new RNG(`traffic:${seed}`);
    const built = BODIES.map((b) => buildBody(b, rng));
    this.bodyGeos = built.map((x) => x.body);
    // Glass rides with the lamps, on the unlit material.
    this.lightGeos = BODIES.map((b, i) => mergeFaceted([buildLights(b), built[i].glass]));

    // Lit like the cars you are racing, not like scenery.
    //
    // At metalness 0.18 a civilian's paint barely answered the sun or the sky,
    // so a street of them read as flat grey cutouts moving past bodywork that
    // did answer. The racers sit between 0.30 and 0.58; a civilian is a duller
    // finish than a tuner's, not a different substance.
    this.bodyMat = facetedMaterial({ roughness: 0.52, metalness: 0.34 });
    this.bodyMat.onBeforeCompile = (shader) => {
      // Per-car paint, restricted to the bodywork.
      //
      // `instanceColor` multiplies the whole vertex colour, which on this
      // geometry means a red car gets red tyres, a red bumper and red mirrors.
      // The mask says which surfaces are paint, and the tint is mixed toward
      // white everywhere else — so one draw call carries a street of colours
      // and the furniture stays the colour furniture is.
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute float paintMask;\nvoid main() {')
        .replace(
          'vColor.xyz *= instanceColor.xyz;',
          'vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, paintMask );',
        );
    };
    // Two materials compiled from the same source need different keys or Three
    // hands the second one the first one's program.
    this.bodyMat.customProgramCacheKey = () => 'traffic-paint';
    this.lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

    // One instanced draw per body type, for bodies and for lights.
    this.bodies = [];
    this.lights = [];
    this.slots = new Map();
    let tris = 0;

    for (let kind = 0; kind < BODIES.length; kind++) {
      const mine = cars.filter((c) => (c.kind ?? 0) === kind);
      if (mine.length === 0) { this.bodies.push(null); this.lights.push(null); continue; }

      const body = new THREE.InstancedMesh(this.bodyGeos[kind], this.bodyMat, mine.length);
      const light = new THREE.InstancedMesh(this.lightGeos[kind], this.lightMat, mine.length);
      // A car with no shadow is a sticker on the road. Civilians cast none at
      // all while every racer did, which is most of why they read as pasted on
      // rather than driving. One extra shadow-pass draw per body type.
      body.castShadow = !!quality?.shadows;
      body.receiveShadow = !!quality?.shadows;
      for (const m of [body, light]) {
        m.frustumCulled = false;   // they move every frame; the bounds would be stale
        m.matrixAutoUpdate = false;
        this.group.add(m);
      }
      // A colour per car. Same four shapes, a hundred different cars.
      body.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(mine.length * 3), 3);
      mine.forEach((car, i) => {
        this.slots.set(car, { kind, index: i });
        const t = PAINTS[new RNG(`paint:${seed}:${kind}:${i}`).int(0, PAINTS.length - 1)];
        const col = new THREE.Color(t);
        body.instanceColor.setXYZ(i, col.r, col.g, col.b);
      });
      body.instanceColor.needsUpdate = true;
      this.bodies.push(body);
      this.lights.push(light);
      tris += (triCount(this.bodyGeos[kind]) + triCount(this.lightGeos[kind])) * mine.length;
    }

    this.stats = { cars: cars.length, draws: this.bodies.filter(Boolean).length * 2, tris };
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * Follow the simulation. Called every frame; traffic never stops moving.
   *
   * Between two simulated poses, like the racers: civilian cars run at 60 to
   * 100 km/h and are the thing you are threading between at speed, so they
   * stutter just as visibly as the car you are driving.
   */
  sync(alpha = 1) {
    const a = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
    for (const car of this.cars) {
      const slot = this.slots.get(car);
      if (!slot) continue;
      const px = car.px ?? car.x;
      const py = car.py ?? car.y;
      const pz = car.pz ?? car.z;
      const pyaw = car.pyaw ?? car.yaw;
      let dy = car.yaw - pyaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this._p.set(px + (car.x - px) * a, py + (car.y - py) * a, pz + (car.z - pz) * a);
      this._q.setFromAxisAngle(this._up, pyaw + dy * a);
      this._m.compose(this._p, this._q, this._s);
      this.bodies[slot.kind]?.setMatrixAt(slot.index, this._m);
      this.lights[slot.kind]?.setMatrixAt(slot.index, this._m);
    }
    for (const m of this.bodies) if (m) m.instanceMatrix.needsUpdate = true;
    for (const m of this.lights) if (m) m.instanceMatrix.needsUpdate = true;
  }

  addTo(scene) {
    scene.add(this.group);
    return this;
  }

  dispose() {
    for (const m of [...this.bodies, ...this.lights]) m?.dispose();
    for (const g of [...this.bodyGeos, ...this.lightGeos]) g?.dispose();
    this.bodyMat.dispose();
    this.lightMat.dispose();
    this.group.parent?.remove(this.group);
  }
}
