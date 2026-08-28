import * as THREE from 'three';
import { VehicleMesh, visualProfile } from './chassis.js';
import { Build } from '../build/build.js';
import { VEHICLE_BY_ID, VEHICLES } from '../data/vehicles.js';
import { instantiateSkill } from '../data/skills.js';

// The car on the title screen, turning.
//
// Every chassis in this game is generated: the proportions, the wing, the ride
// height and the vents all come out of the build's stats. Picking a machine
// from a list of stat deltas therefore asks the player to choose a shape they
// have never seen, and the shape is most of what the choice is about.
//
// So the same generator that builds the car for a race builds one here and
// turns it on the spot. It is deliberately not the race scene: no biome, no
// fog, no bloom, no grade. A showroom's job is to show the object, and the
// biome's job is to make it hard to see.
//
// Cheap enough to leave running behind a menu — one car, three lights, and the
// menu is paced at 30 fps. It renders straight to the canvas through
// `Renderer.renderInset`, into the rectangle the title screen leaves for it.

/** How fast the turntable goes, in radians per second. */
const SPIN = 0.55;

// What the framing has to hold, in metres, measured off the roster rather than
// off any one car: the longest is 4.6 m, and a turntable shows it broadside
// once a revolution, so the horizontal case is half its length plus a margin.
// The vertical is its height plus what the camera's slight downward tilt adds
// of that same length.
const FRAME_HALF_WIDTH = 2.55;
const FRAME_HALF_HEIGHT = 1.10;

// Where the two framings apply. Between them the camera blends.
const BAND_ASPECT = 4.5;
const TALL_ASPECT = 1.8;

export class Showroom {
  constructor() {
    this.scene = new THREE.Scene();

    // Flat, neutral, three-point: the same reasoning as the dev garage. A key
    // that models the surfaces, a cool rim to separate the silhouette from the
    // background, and a hemisphere so nothing in shadow goes to black.
    this.scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x22262e, 1.5));
    this.key = new THREE.DirectionalLight(0xffffff, 2.4);
    this.key.position.set(5, 7, 6);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0x8ec5ff, 1.2);
    this.rim.position.set(-6, 3, -6);
    this.scene.add(this.rim);

    // A disc rather than a plane. The car is turning on a turntable and the
    // edge of the disc says so; a plane running off in every direction reads as
    // a floor, and then the missing walls become the thing you notice.
    this.floorGeo = new THREE.CircleGeometry(3.3, 64);
    this.floorGeo.rotateX(-Math.PI / 2);
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0x11151b, roughness: 0.78, metalness: 0.15,
    });
    this.floor = new THREE.Mesh(this.floorGeo, this.floorMat);
    this.floor.position.y = -0.01;
    this.scene.add(this.floor);

    this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.15, 120);
    // Close, and near eye level. The title screen's stage is a wide, short
    // band, so the height is what the framing is limited by there: back the
    // camera off far enough to fit the length and the car becomes a model on
    // a shelf. This is that tuned position, and `render` keeps it unless the
    // rectangle it is drawing into is too narrow to hold the car.
    this.target = new THREE.Vector3(0, 0.66, 0);
    this.camera.position.set(3.0, 1.40, 3.7);
    this.camera.lookAt(this.target);
    this.dir = this.camera.position.clone().sub(this.target);
    this.minDist = this.dir.length();
    this.dir.normalize();
    // The second framing, for a rectangle tall enough to be worth looking down
    // into. Fitting a car's length across a near-square stage leaves a lot of
    // vertical slack; raising the eye spends that on the car's top surfaces
    // instead of on empty air above it.
    this.dirTall = new THREE.Vector3(3.0, 1.45, 3.7).normalize();
    this._dir = new THREE.Vector3();

    this.mesh = null;
    this.vehicleId = null;
    this.yaw = Math.PI * 0.85;
  }

  /**
   * Show a vehicle, building it exactly the way a run would start it — with
   * its starting skill fitted, since that is the car the player gets.
   */
  setVehicle(id) {
    if (id === this.vehicleId) return;
    const def = VEHICLE_BY_ID[id] ?? VEHICLES[0];
    this.vehicleId = def.id;

    this._disposeMesh();
    const build = new Build(def.id);
    if (def.startingSkill) build.addSkill(instantiateSkill(def.startingSkill, 1));
    const profile = visualProfile(build.stats.all(), build.tags, def);
    this.mesh = new VehicleMesh(profile, { shadows: false });
    this.mesh.addTo(this.scene);

    // A pose, held: front wheels turned so the steering geometry reads, and no
    // motion state at all — a stationary car whose wheels are spinning is worse
    // than one that is plainly parked.
    this.mesh.update(0.016, {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
      forwardSpeed: 0, slipAngle: 0, speed: 0,
      drifting: false, driftQuality: 0, boostTimer: 0,
      p: { maxSpeed: 46 },
    }, { heatPct: 0, energyFrac: 1, boosting: false, steer: -0.35 });
  }

  update(dt) {
    this.yaw += dt * SPIN;
    if (this.mesh) this.mesh.group.rotation.y = this.yaw;
  }

  /**
   * @param aspect  the aspect of the rectangle this will be drawn into
   *
   * The same camera serves a band across the top of the title screen at an
   * aspect near eight and a near-square stage on the machine screen at one and
   * a third. A fixed position cannot do both: the vertical field is what the
   * `fov` fixes, so a narrower rectangle has a narrower *horizontal* field,
   * and at the tuned distance the machine screen cut a hand's width off each
   * end of the car. So the distance is fitted to the rectangle — and floored
   * at the tuned one, because the band was framed deliberately and pulling
   * closer there would crop it instead.
   */
  render(aspect) {
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    const tanY = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanX = tanY * aspect;
    const dist = Math.max(
      this.minDist,
      FRAME_HALF_WIDTH / tanX,
      FRAME_HALF_HEIGHT / tanY,
    );
    // Wide band keeps the tuned eye line; a squarer stage rises to look down
    // into it. Blended rather than switched, so a window being dragged never
    // makes the camera jump.
    const t = Math.min(1, Math.max(0, (BAND_ASPECT - aspect) / (BAND_ASPECT - TALL_ASPECT)));
    this._dir.copy(this.dir).lerp(this.dirTall, t).normalize();
    this.camera.position.copy(this._dir).multiplyScalar(dist).add(this.target);
    this.camera.lookAt(this.target);
    return this.camera;
  }

  _disposeMesh() {
    if (!this.mesh) return;
    this.mesh.dispose();
    this.mesh = null;
  }

  dispose() {
    this._disposeMesh();
    this.floorGeo.dispose();
    this.floorMat.dispose();
  }
}
