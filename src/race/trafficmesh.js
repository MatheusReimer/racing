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
const BODIES = [
  // width, length, height, roof drop, colour
  { w: 1.76, l: 4.08, h: 0.62, roof: 0.50, c: 0x9aa0a8 },   // hatchback
  { w: 1.82, l: 4.70, h: 0.60, roof: 0.48, c: 0x6b7480 },   // saloon
  { w: 1.94, l: 5.05, h: 0.90, roof: 0.72, c: 0xb8b2a4 },   // van
  { w: 1.79, l: 4.60, h: 0.62, roof: 0.50, c: 0x7d5a4a },   // estate
];

function buildBody(spec, rng) {
  const { w, l, h, roof, c } = spec;
  const parts = [];
  // Where the bodywork starts above the road. A third of a metre is an
  // off-roader's clearance and it had every civilian car standing on stilts;
  // a saloon's floor is nearer sixteen centimetres.
  const rideH = 0.16;

  parts.push(boxOf(w, h, l, c, { y: rideH + h / 2, rng, variation: 0.05 }));
  // Cabin, set back and narrower — the one shape difference that separates a
  // van from a saloon at distance.
  parts.push(boxOf(w * 0.88, roof, l * 0.46, c, {
    y: rideH + h + roof / 2 - 0.04, z: -l * 0.06, rng, variation: 0.04,
  }));
  // Glass as one dark band right round, rather than four panes.
  parts.push(boxOf(w * 0.90, roof * 0.60, l * 0.44, 0x11161d, {
    y: rideH + h + roof * 0.55, z: -l * 0.06, rng,
  }));
  // Bumpers.
  for (const iz of [1, -1]) {
    parts.push(boxOf(w * 0.94, 0.16, 0.14, 0x2b2f35, {
      y: rideH + 0.16, z: iz * (l / 2 + 0.04), rng,
    }));
  }
  // Wheels: four short cylinders, no tread. Nobody is looking.
  for (const ix of [-1, 1]) for (const iz of [1, -1]) {
    const g = prism(10, 0.32, 0.32, 0.22, 0x15181c, { rng });
    g.rotateZ(Math.PI / 2);
    g.translate(ix * (w / 2 - 0.06), 0.32, iz * l * 0.31);
    parts.push(g);
  }
  return mergeFaceted(parts);
}

function buildLights(spec) {
  const { w, l, h } = spec;
  const parts = [];
  const y = 0.34 + h * 0.62;
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
    this.bodyGeos = BODIES.map((b) => buildBody(b, rng));
    this.lightGeos = BODIES.map((b) => buildLights(b));

    this.bodyMat = facetedMaterial({ roughness: 0.62, metalness: 0.18 });
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
      for (const m of [body, light]) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = false;   // they move every frame; the bounds would be stale
        m.matrixAutoUpdate = false;
        this.group.add(m);
      }
      mine.forEach((car, i) => this.slots.set(car, { kind, index: i }));
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
