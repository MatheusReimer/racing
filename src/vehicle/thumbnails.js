import * as THREE from 'three';
import { VehicleMesh, visualProfile } from './chassis.js';
import { Build } from '../build/build.js';
import { VEHICLES } from '../data/vehicles.js';
import { instantiateSkill } from '../data/skills.js';

// The roster's six cars, at thumbnail size.
//
// There are no art assets in this game, so there is no folder of car pictures
// to point the roster at — and there should not be one. A hand-drawn icon
// would be a promise the chassis generator never made: it would go stale the
// first time a body's proportions were retuned, and it would be wrong the
// moment a paint was equipped. So the thumbnails are the same generator,
// rendered once.
//
// Once, and then cached. A GL context is not free and neither are six chassis,
// so this runs on the first machine screen of a session and then hands back
// the same data URLs until the paint changes. The renderer it uses is its own,
// disposed the moment the last car is drawn: browsers cap live WebGL contexts
// somewhere around sixteen, and the game's real one is not a context to spend.
//
// Everything here is guarded. A machine that refuses the context — a software
// stack with no GL, a tab that has already spent its budget — gets a roster of
// name cards instead of a broken screen, which is what `null` means to the
// caller.

const W = 320;
const H = 200;

// The pose. Front three-quarter from the driver's side: it shows the face, the
// shoulder line and one flank, which is what tells a hatch from a coupe at
// thumbnail size. A broadside profile shows more car and less identity.
const YAW = Math.PI * 0.62;

let cache = null;
let cacheKey = null;

const lookKey = (look) =>
  `${look?.baseColor ?? ''}|${look?.accentColor ?? ''}|${look?.rimTint ?? ''}`;

/**
 * Data URLs for every machine on the roster, keyed by vehicle id.
 *
 * @param look  the equipped cosmetics, as `Profile.look()` returns them
 * @returns Map<string, string>, empty if this machine cannot render them
 */
export function vehicleThumbnails(look = null) {
  const key = lookKey(look);
  if (cache && cacheKey === key) return cache;

  const out = new Map();
  let gl = null;
  try {
    gl = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    gl.setPixelRatio(1);
    gl.setSize(W, H, false);
    gl.setClearColor(0x000000, 0);
    // The same grade the turntable is drawn under, so a card and the car it
    // selects are lit alike. A thumbnail a shade brighter than the stage reads
    // as a different paint.
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.1;
  } catch {
    return out;
  }

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x22262e, 1.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(5, 7, 6);
  scene.add(keyLight);
  const rim = new THREE.DirectionalLight(0x8ec5ff, 1.2);
  rim.position.set(-6, 3, -6);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(30, W / H, 0.15, 120);

  try {
    for (const def of VEHICLES) {
      const build = new Build(def.id);
      if (def.startingSkill) build.addSkill(instantiateSkill(def.startingSkill, 1));
      const profile = visualProfile(build.stats.all(), build.tags, def, look);
      const mesh = new VehicleMesh(profile, { shadows: false });
      mesh.addTo(scene);
      mesh.group.rotation.y = YAW;
      // Parked, wheels straight ahead. The turntable turns its front wheels to
      // show the steering geometry; at 320 pixels that reads as a car pulling
      // out of the card rather than as a detail.
      mesh.update(0.016, {
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
        forwardSpeed: 0, slipAngle: 0, speed: 0,
        drifting: false, driftQuality: 0, boostTimer: 0,
        p: { maxSpeed: 46 },
      }, { heatPct: 0, energyFrac: 1, boosting: false, steer: 0 });

      // Framed off the car actually built rather than off a constant: the
      // roster spans a 3.7 m roadster and a 4.6 m rally car, and a fixed
      // distance either crops one or strands the other in empty space.
      frameCar(camera, mesh.group);
      gl.render(scene, camera);
      out.set(def.id, gl.domElement.toDataURL('image/webp', 0.86));

      mesh.dispose();
    }
  } catch {
    out.clear();
  }

  // The lights and the geometry go with it; nothing here outlives the call.
  gl.dispose();
  gl.forceContextLoss?.();

  cache = out;
  cacheKey = key;
  return out;
}

/** Fit the car in the frame, with a little air around it. */
function frameCar(camera, group) {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const tanX = tanY * camera.aspect;
  // Half the diagonal of the footprint, because the car is turned: at this yaw
  // its width on screen is neither its length nor its breadth.
  const halfW = Math.hypot(size.x, size.z) * 0.5;
  const dist = Math.max(halfW / tanX, (size.y * 0.5) / tanY) * 1.22;
  camera.position.set(0.62, 0.40, 1).normalize().multiplyScalar(dist).add(centre);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
}

/** Drop the cache — the paint changed, or the session is done with it. */
export function clearThumbnailCache() {
  cache = null;
  cacheKey = null;
}
