import * as THREE from 'three';

// The pieces a car loses, falling.
//
// This is the half of the voxel look that is not a look: a decimated body could
// only be repainted when it was hurt, because its triangles describe a surface
// and a surface cannot have a bite taken out of it. A body of cells can stop
// having some — and the cells it stops having are cubes, with a size and a
// colour, which is to say they are already debris. Nothing has to be invented
// to make a panel shed; it sheds what it was made of.
//
// One instanced mesh for every car on the road. A cube is twelve triangles and
// a bad race throws a few hundred, so the whole system is a rounding error
// against one car body.

/** How long a piece lies on the road before it goes. */
const LIFE = 6.0;
const GRAVITY = 22;
/** What a piece keeps of its speed when it lands. Concrete is not a trampoline. */
const BOUNCE = 0.28;
const FRICTION = 0.86;

export class Debris {
  constructor(scene, max = 400) {
    this.max = max;
    this.n = 0;
    // Unit cube; each piece scales its own instance, because a car's cells are
    // 3 cm and a building's are half a metre.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: false, roughness: 0.78, metalness: 0.05, flatShading: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    scene.add(this.mesh);

    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.spin = new Float32Array(max * 3);
    this.rot = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.age = new Float32Array(max);
    this.colour = new THREE.Color();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._t = new THREE.Vector3();
  }

  /**
   * Throw a handful of pieces.
   *
   * @param cells  what `VoxBody.chip` returned, already in world coordinates
   * @param vx     the car's own velocity, so a piece keeps going the way the
   *               car was: debris that drops straight down reads as scenery
   *               falling, not as a car losing a corner
   */
  burst(cells, vx = 0, vy = 0, vz = 0, spread = 3.2) {
    for (const c of cells) {
      // Oldest piece first when full. A cap that refuses new pieces would drop
      // exactly the ones somebody is looking at.
      const i = this.n < this.max ? this.n++ : this._oldest();
      const o = i * 3;
      this.p[o] = c.x; this.p[o + 1] = c.y; this.p[o + 2] = c.z;
      this.v[o] = vx + (Math.random() - 0.5) * spread;
      this.v[o + 1] = vy + Math.random() * spread * 0.8 + 1.5;
      this.v[o + 2] = vz + (Math.random() - 0.5) * spread;
      this.spin[o] = (Math.random() - 0.5) * 14;
      this.spin[o + 1] = (Math.random() - 0.5) * 14;
      this.spin[o + 2] = (Math.random() - 0.5) * 14;
      this.rot[o] = 0; this.rot[o + 1] = 0; this.rot[o + 2] = 0;
      this.size[i] = c.size;
      this.age[i] = 0;
      this.mesh.setColorAt(i, this.colour.setRGB(c.r, c.g, c.b));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = this.n;
  }

  _oldest() {
    let worst = 0;
    for (let i = 1; i < this.n; i++) if (this.age[i] > this.age[worst]) worst = i;
    return worst;
  }

  update(dt, groundAt = null) {
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      this.age[i] += dt;
      if (this.age[i] > LIFE) {
        // Swap the last one down into this slot rather than compacting the
        // whole array; order does not mean anything here.
        const last = --this.n;
        if (last !== i) {
          for (let k = 0; k < 3; k++) {
            this.p[o + k] = this.p[last * 3 + k];
            this.v[o + k] = this.v[last * 3 + k];
            this.spin[o + k] = this.spin[last * 3 + k];
            this.rot[o + k] = this.rot[last * 3 + k];
          }
          this.size[i] = this.size[last];
          this.age[i] = this.age[last];
          this.mesh.getColorAt(last, this.colour);
          this.mesh.setColorAt(i, this.colour);
        }
        i--;
        continue;
      }

      this.v[o + 1] -= GRAVITY * dt;
      this.p[o] += this.v[o] * dt;
      this.p[o + 1] += this.v[o + 1] * dt;
      this.p[o + 2] += this.v[o + 2] * dt;

      const floor = (groundAt ? groundAt(this.p[o], this.p[o + 2]) : 0) + this.size[i] * 0.5;
      if (this.p[o + 1] < floor) {
        this.p[o + 1] = floor;
        this.v[o + 1] = -this.v[o + 1] * BOUNCE;
        this.v[o] *= FRICTION;
        this.v[o + 2] *= FRICTION;
        for (let k = 0; k < 3; k++) this.spin[o + k] *= FRICTION;
      }
      for (let k = 0; k < 3; k++) this.rot[o + k] += this.spin[o + k] * dt;

      this._e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]);
      this._q.setFromEuler(this._e);
      this._t.set(this.p[o], this.p[o + 1], this.p[o + 2]);
      // Shrinking out at the end, so a piece leaves rather than blinking.
      const k = Math.min(1, (LIFE - this.age[i]) / 0.8);
      this._s.setScalar(this.size[i] * k);
      this._m.compose(this._t, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.n = 0; this.mesh.count = 0; }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
