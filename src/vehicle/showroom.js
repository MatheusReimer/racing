import * as THREE from 'three';
import { VehicleMesh, visualProfile } from './chassis.js';
import { Build } from '../build/build.js';
import { VEHICLE_BY_ID, VEHICLES } from '../data/vehicles.js';
import { instantiateSkill } from '../data/skills.js';
import { Sky } from '../sky/sky.js';
import { BIOME_BY_ID } from '../data/biomes.js';
import { RNG } from '../core/rng.js';
import { paintMarkings } from '../track/markings.js';

// The car on the title screen, turning.
//
// Every chassis in this game is generated: the proportions, the wing, the ride
// height and the vents all come out of the build's stats. Picking a machine
// from a list of stat deltas therefore asks the player to choose a shape they
// have never seen, and the shape is most of what the choice is about.
//
// So the same generator that builds the car for a race builds one here and
// turns it on the spot.
//
// It stands in a place rather than in a void. The argument for the void was
// that a biome's job is to make the car hard to see — true of a biome the car
// is *in*, lit by its sky and hazed by its fog, and not true of one kept
// behind the car. So the district is split in two here: its dome, its distant
// towers and its fog are the backdrop, and its lighting rig is switched off,
// because the car is lit by the neutral three-point rig below and nothing
// else. Depth behind the subject, studio light on it — which is how a car is
// actually photographed.
//
// The dome pays for itself twice over: it is also baked into the environment
// map, and without one the chrome, the glass and the paint are reflecting
// nothing, which is most of why a car in a void reads as plastic.
//
// Still cheap enough to leave running behind a menu — one car, a dome, a
// silhouette and a ground plane, at 30 fps. It renders straight to the canvas
// through `Renderer.renderInset`, into the rectangle the title leaves for it.

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

/** The district the showroom borrows its backdrop from. */
const BACKDROP_BIOME = 'downtown';

/** How far the ground runs before the fog has finished with it. */
const GROUND_RADIUS = 760;

/** Half the carriageway, in metres: an eighteen-metre road, so four lanes. */
const ROAD_HALF = 9;

/** How much of it exists. Past this the fog has closed anyway. */
const ROAD_LENGTH = 900;

// How far the centre line sits from the turntable, in metres.
//
// The car spins on the origin, and a road centred there parks it astride its
// own double yellow — which is the one arrangement a road can be in that says
// nobody thought about it. Offset by a lane and a half, so the car stands in
// the near carriageway with the centre line off its flank.
const ROAD_OFFSET = 5.4;

// The district's own fog is tuned for a car crossing it at speed, with the
// things worth seeing between fifty and three hundred metres out. Nothing here
// is moving and the subject is four metres away, so at that density the towers
// never arrive and the backdrop is a flat wash of fog colour. Thinned until the
// horizon is a horizon again.
const FOG_DENSITY = 0.0016;

export class Showroom {
  /**
   * @param gl  the renderer's WebGLRenderer, only so the dome can be baked
   *            into an environment map. Without one the backdrop still draws
   *            and the car simply has nothing to reflect.
   */
  constructor(gl = null) {
    this.scene = new THREE.Scene();

    // Flat, neutral, three-point: the same reasoning as the dev garage. A key
    // that models the surfaces, a cool rim to separate the silhouette from the
    // background, and a hemisphere so nothing in shadow goes to black.
    this.scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x22262e, 1.5));
    this.key = new THREE.DirectionalLight(0xffffff, 2.4);
    this.key.position.set(5, 7, 6);
    // The key casts, and its frustum is drawn tight around the turntable.
    //
    // A car with no shadow is a car pasted onto a photograph of a road: the
    // contact with the ground is the one cue that says it is standing on it
    // rather than hovering. The race cannot afford this — its shadow camera
    // spans a hundred and eighty metres, so at 1024 the texels are the size of
    // a wheel and it falls back to a painted blob. Fourteen metres of frustum
    // at the same resolution is a texel per centimetre, which is a real shadow
    // with the wheel arches in it, and nothing else in this scene casts.
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 0.035;
    {
      const c = this.key.shadow.camera;
      c.left = -7; c.right = 7; c.top = 7; c.bottom = -7;
      c.near = 1; c.far = 34;
      c.updateProjectionMatrix();
    }
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0x8ec5ff, 1.2);
    this.rim.position.set(-6, 3, -6);
    this.scene.add(this.rim);

    // The road the car is standing on.
    //
    // A turntable in a void asks the viewer to accept a disc floating in fog,
    // and every light landing on it then has nothing to be reflecting off. A
    // road answers that: the sheen down its surface is a wet carriageway under
    // a city, the markings say which way it runs and how wide it is, and the
    // car is somewhere a car belongs.
    //
    // The markings are the game's own — `paintMarkings` teaches a road material
    // to draw its centre line, its lane divides and its edge lines in the
    // fragment shader from `aLane`, which carries (across, along, half-width,
    // is-branch). That attribute is the entire contract, so a straight strip
    // gets the same paint the circuit does, at the same real widths, with no
    // second layer of geometry to z-fight with.
    this.roadGeo = new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LENGTH, 4, 160);
    this.roadGeo.rotateX(-Math.PI / 2);
    {
      const pos = this.roadGeo.attributes.position;
      const lane = new Float32Array(pos.count * 4);
      for (let i = 0; i < pos.count; i++) {
        lane[i * 4 + 0] = pos.getX(i) / ROAD_HALF;        // across, -1..1
        lane[i * 4 + 1] = pos.getZ(i) + ROAD_LENGTH / 2;  // along, metres, positive
        lane[i * 4 + 2] = ROAD_HALF;
        lane[i * 4 + 3] = 0;                              // never a branch
      }
      this.roadGeo.setAttribute('aLane', new THREE.BufferAttribute(lane, 4));
    }
    // Wet. The district this borrows from is explicit that its road is the
    // brightest thing in frame and that the shine is what sells it, and with
    // the sky baked into an environment map there is finally something for a
    // metallic surface to reflect.
    this.roadMat = paintMarkings(new THREE.MeshStandardMaterial({
      color: 0x0e1116, roughness: 0.62, metalness: 0.22,
    }), BIOME_BY_ID[BACKDROP_BIOME]?.palette ?? {});
    this.road = new THREE.Mesh(this.roadGeo, this.roadMat);
    this.road.position.set(ROAD_OFFSET, 0.01, 0);
    this.road.receiveShadow = true;
    this.scene.add(this.road);

    // The ground either side. Kept very dark and very matte: a directional
    // light does not fall off, so the key that models the car also lands on
    // seven hundred metres of it, and any albedo at all turns the verge into
    // the brightest thing in the picture. It is here so the road has edges and
    // the city has something to stand on.
    this.groundGeo = new THREE.CircleGeometry(GROUND_RADIUS, 48);
    this.groundGeo.rotateX(-Math.PI / 2);
    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x090c11, roughness: 1, metalness: 0,
    });
    this.ground = new THREE.Mesh(this.groundGeo, this.groundMat);
    this.ground.position.y = -0.02;
    this.scene.add(this.ground);

    // Sky, distant towers, fog and the environment bake — the whole backdrop
    // in one object, pointed at a night district.
    this.sky = new Sky(this.scene, gl);
    this.sky.apply(BIOME_BY_ID[BACKDROP_BIOME] ?? BIOME_BY_ID.industrial, { shadows: false });

    // ...and then its lighting rig is silenced. `apply` points a sun, a fill
    // and a hemisphere at the district's palette, which is right for a car on
    // that district's road and wrong for one on a turntable: a night street's
    // rig renders the car as a dark shape with a moon on its roof. The three
    // lights above stay the only thing lighting the car.
    this.sky.sun.intensity = 0;
    this.sky.fill.intensity = 0;
    this.sky.hemi.intensity = 0;

    // Set after `apply`, which installs the district's own.
    this.scene.fog.density = FOG_DENSITY;

    this._buildStage();

    // Far enough to hold the backdrop. At 120 m the ground disc was being cut
    // off a few car lengths out and everything standing on it went with the
    // clip, which is why the first backdrop was a gradient and nothing else.
    this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.15, 1200);
    // Close, and near eye level. The title screen's stage is a wide, short
    // band, so the height is what the framing is limited by there: back the
    // camera off far enough to fit the length and the car becomes a model on
    // a shelf. This is that tuned position, and `render` keeps it unless the
    // rectangle it is drawing into is too narrow to hold the car.
    this.target = new THREE.Vector3(0, 0.66, 0);
    // Eye level, near enough to the car's own waistline.
    //
    // This used to sit at 1.40, which put the lens seventeen degrees below the
    // horizontal — and seventeen is also the half-angle of the lens, so the
    // horizon landed exactly on the top edge of the picture and the world
    // behind the car was entirely ground. Nothing standing on that ground
    // could be seen: a backdrop built at three hundred metres projected off
    // the top of the frame, every window in it included.
    //
    // Dropped until there is sky. The car is seen along its flank with a
    // little of the roof rather than looked down on, which is the angle a car
    // is photographed from anyway, and there is now room above the horizon for
    // somewhere to be.
    this.camera.position.set(3.0, 1.10, 3.7);
    this.camera.lookAt(this.target);
    this.dir = this.camera.position.clone().sub(this.target);
    this.minDist = this.dir.length();
    this.dir.normalize();
    // The second framing, for a rectangle tall enough to be worth looking down
    // into. Fitting a car's length across a near-square stage leaves a lot of
    // vertical slack; raising the eye spends that on the car's top surfaces
    // instead of on empty air above it.
    //
    // Lowered with it, and this is the one that actually governs the machine
    // screen: the stage there is near enough to `TALL_ASPECT` that `render`
    // blends nine tenths of the way onto this vector, so the eye line the
    // screen gets is this one and not the one above. Raising it to look down
    // into a square stage was the whole reason the horizon sat off the top of
    // the picture.
    this.dirTall = new THREE.Vector3(3.0, 0.62, 3.7).normalize();
    this._dir = new THREE.Vector3();

    this.mesh = null;
    this.vehicleId = null;
    // Front three-quarter, the angle a car is photographed from: it shows the
    // face, the shoulder and one flank at once. The turntable moves off it
    // immediately, but this is the pose the screen opens on.
    this.yaw = Math.PI * 0.62;
  }

  /**
   * What stands along the road.
   *
   * Detail is spent by distance, and the usual order is reversed. A game
   * budgets most of its triangles near the camera because the camera moves and
   * everything eventually becomes near; this picture is static, one car deep,
   * and rendered behind a menu at thirty frames. So the near field is modelled
   * — facades with plinths, floor bands, framed windows and lit shopfronts —
   * and the far field stays the flat boxes it always was, because at four
   * hundred metres through this fog a modelled window and a painted one are
   * the same two pixels.
   *
   * The city is a grid either side of the carriageway rather than a ring of
   * towers at random bearings: buildings do not stand in a circle, and the
   * arrangement is read long before any one building is.
   *
   * Everything is placed in road coordinates — `x` across from the centre
   * line, `z` along it — and instanced by material, so the whole street is
   * seven draw calls however many boxes are in it.
   */
  _buildStage() {
    this.stage = new THREE.Group();
    this.disposables = [];
    this.instances = [];
    const rng = new RNG('showroom:street');
    const keep = (x) => { this.disposables.push(x); return x; };

    const boxGeo = keep(new THREE.BoxGeometry(1, 1, 1));
    const cylGeo = keep(new THREE.CylinderGeometry(1, 1, 1, 6));

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    const at = (x, y, z, yaw, sx, sy, sz) => {
      pv.set(x, y, z);
      q.setFromAxisAngle(UP, yaw);
      sv.set(sx, sy, sz);
      return m.clone().compose(pv, q, sv);
    };

    // Sodium low, fluorescent high, the odd cold one. A street lit in a single
    // colour reads as a filter over the picture rather than as windows.
    const L = {
      rng, at,
      concrete: [], trim: [], metal: [], glass: [], lit: [], sign: [], far: [],
      masts: [], beacons: [],
      WARM: new THREE.Color('#ffc27a'),
      PALE: new THREE.Color('#dfe7f5'),
      COLD: new THREE.Color('#9fd0ff'),
      SIGN_GREEN: new THREE.Color(0.5, 1.6, 0.9),
      SIGNS: [
        new THREE.Color(2.2, 0.9, 0.7), new THREE.Color(0.8, 1.4, 2.2),
        new THREE.Color(2.0, 1.7, 0.7), new THREE.Color(1.6, 0.8, 2.0),
      ],
    };

    // --- the near street, modelled ---
    //
    // Both sides and well down the road. The camera looks along the
    // carriageway, so the row on its far side fills the frame and the row
    // behind it costs a matrix and shows nothing — which is cheaper than
    // working out which is which, and stays right if the framing moves.
    // Set well back, and broken up. At fifteen metres past the rail a
    // four-storey building stands thirty degrees up — it fills the frame, and
    // a continuous row of them on both sides walls the corridor off entirely,
    // taking the skyline and most of the sky with it. Pushed to thirty-four,
    // gapped a third of the time, and stopped short of the vanishing point, it
    // becomes what it was meant to be: something to look past.
    // Beside the camera, not down the road.
    //
    // Where these stand decides whether they are foreground or a blindfold.
    // The lens points along the carriageway, so the middle of the picture is
    // the corridor and the corridor is where the city shows; a building put
    // far down it lands exactly on the vanishing point. Kept level with the
    // car and a little ahead of it, the same building lands at the edge of the
    // frame instead, where a foreground belongs — near enough to be read,
    // clear of everything worth seeing past it.
    // Low near, tall far — and the arithmetic decides, not the taste.
    //
    // This lens has about ten degrees of sky above the horizon. A four-storey
    // building thirty metres away subtends thirty, so wherever it stands
    // inside the field of view it takes the skyline with it; there is no
    // placement that saves it. Two storeys at forty metres subtends eleven and
    // sits along the horizon instead, which is also what is actually built
    // beside a road on the edge of a city — depots, shopfronts and garages,
    // with the towers behind them.
    //
    // Nothing is lost by it: everything modelled here — the shopfront, the
    // canopy, the fascia, the framed windows — lives in the first two storeys,
    // which is the part the camera could see either way.
    for (const face of [1, -1]) {
      const line = ROAD_OFFSET - face * (ROAD_HALF + 39);
      let z = -150;
      while (z < 46) {
        const d = rng.range(12, 20);
        if (!rng.bool(0.34)) {                    // a gap: a side street
          this._facade(L, {
            x: line - face * rng.range(2, 7),
            z: z + d / 2,
            w: rng.range(14, 24),
            d,
            // Mostly single-storey, and that is the whole negotiation between
            // the two halves of this scene. The near buildings and the far
            // city want the same ten degrees of sky; a second storey at forty
            // metres takes another four of them, and there are not four to
            // spare now that there is a city up there worth seeing.
            floors: rng.bool(0.78) ? 1 : 2,
            face,
            shop: rng.bool(0.7),
            escape: rng.bool(0.3),
          });
        }
        // Wide gaps on purpose. An unbroken parade of low-rise is a wall with
        // windows in it, and the breaks are what let the towers behind show
        // through — which is the only thing telling the eye there is a behind.
        z += d + rng.range(7, 26);
      }
    }

    // Roadside furniture near the car, which is detail that costs the frame
    // nothing: it all sits below the eye line, so it fills the verge without
    // standing between the camera and the city.
    for (const side of [-1, 1]) {
      const x = ROAD_OFFSET + side * (ROAD_HALF - 0.4);
      for (let z = -70; z < 40; z += 3.2) {
        // Jersey barriers along the hard shoulder: a splayed foot and a
        // narrower top, which is two boxes and reads correctly at this size.
        L.trim.push(at(x, 0.22, z, 0, 0.62, 0.44, 3.0));
        L.trim.push(at(x, 0.62, z, 0, 0.34, 0.4, 3.0));
      }
    }

    // A pair of marker posts with reflectors, close enough to read.
    for (let z = -60; z < 30; z += 12) {
      const x = ROAD_OFFSET - (ROAD_HALF + 1.1);
      L.metal.push(at(x, 0.55, z, 0, 0.1, 1.1, 0.1));
      L.lit.push({
        matrix: at(x + 0.08, 0.92, z, 0, 0.05, 0.16, 0.16),
        tint: L.WARM.clone().multiplyScalar(1.2),
      });
    }

    this._gantry(L, -74);

    // --- the far city, cheap ---
    //
    // Every row is sized so its roofline lands near ten degrees, which is all
    // the sky this lens has above the horizon: a twenty-six metre building is
    // a wall across the whole picture at fifty metres and a skyline at a
    // hundred and fifty.
    // Nine rows out to a kilometre, packed almost shoulder to shoulder.
    //
    // Depth in a skyline comes from how many rooflines the eye can count, not
    // from how big any of them is: four sparse rows read as four rows, and
    // nine dense ones read as a city, because past the third the individual
    // buildings stop being countable and become a mass. The fog grades them
    // for free — the far rows arrive already half dissolved — so the only cost
    // of another row is a matrix.
    //
    // Every row is still sized so its roofline lands near ten degrees, which
    // is all the sky this lens has above the horizon.
    const ROWS = [
      { off: 150, depth: 38, hi: [12, 26], lit: 0.26, detail: true },
      { off: 215, depth: 44, hi: [16, 36], lit: 0.25, detail: true },
      { off: 295, depth: 52, hi: [20, 48], lit: 0.24, detail: true },
      { off: 390, depth: 60, hi: [24, 62], lit: 0.22, detail: true },
      { off: 500, depth: 68, hi: [28, 76], lit: 0.20, detail: true },
      { off: 625, depth: 78, hi: [32, 90], lit: 0.17, detail: false },
      { off: 765, depth: 88, hi: [34, 104], lit: 0.14, detail: false },
      { off: 920, depth: 98, hi: [36, 118], lit: 0.11, detail: false },
      { off: 1090, depth: 110, hi: [38, 132], lit: 0.08, detail: false },
    ];

    for (const side of [-1, 1]) {
      for (const row of ROWS) {
        // Packed, and run well past the road's own length: the rows furthest
        // out subtend so little that a gap in one is a hole in the skyline.
        const step = row.depth * 0.95;
        for (let z = -ROAD_LENGTH; z < ROAD_LENGTH; z += step) {
          if (rng.bool(0.1)) continue;
          const w = row.depth * rng.range(0.6, 1.0);
          const d = row.depth * rng.range(0.6, 1.0);
          const h = rng.range(row.hi[0], row.hi[1]);
          const x = ROAD_OFFSET + side * (row.off + rng.spread(row.depth * 0.28));
          const cz = z + rng.spread(step * 0.22);

          L.far.push(at(x, h / 2, cz, 0, w, h, d));

          let topY = h;
          if (rng.bool(0.6)) {
            const sh = rng.range(0.14, 0.32) * h;
            L.far.push(at(x, h + sh / 2, cz, 0,
              w * rng.range(0.45, 0.75), sh, d * rng.range(0.45, 0.75)));
            topY = h + sh;
          }
          if (row.detail) {
            for (let k = rng.int(0, 3); k > 0; k--) {
              const bw = rng.range(1.6, 4.4);
              const bh = rng.range(1.4, 3.6);
              L.far.push(at(x + rng.spread(w * 0.3), topY + bh / 2,
                cz + rng.spread(d * 0.3), 0, bw, bh, bw));
            }
          }
          if (h > 48 && rng.bool(0.45)) {
            const mh = rng.range(6, 15);
            L.masts.push(at(x, topY + mh / 2, cz, 0, 0.3, mh, 0.3));
            L.beacons.push(at(x, topY + mh + 0.6, cz, 0, 1.2, 1.2, 1.2));
          }

          const cols = Math.max(2, Math.round(d / 3.6));
          const rows = Math.max(3, Math.round(h / 4.2));
          const faceX = x - side * (w / 2 + 0.4);
          for (let ci = 0; ci < cols; ci++) {
            for (let ri = 0; ri < rows; ri++) {
              if (!rng.bool(row.lit)) continue;
              const y = ((ri + 0.5) / rows) * h * 0.9 + h * 0.05;
              L.lit.push({
                matrix: at(faceX, y, cz + ((ci + 0.5) / cols - 0.5) * d * 0.84,
                  0, 0.5, (h / rows) * 0.44, (d / cols) * 0.52),
                tint: (rng.bool(0.12) ? L.COLD : (y < h * 0.4 ? L.WARM : L.PALE))
                  .clone().multiplyScalar(rng.range(0.35, 1.0)),
              });
            }
          }
        }
      }
    }

    // --- road furniture ---

    // Guard rail down both verges: a rail on posts, which is what stops the
    // tarmac ending in nothing.
    for (const side of [-1, 1]) {
      const x = ROAD_OFFSET + side * (ROAD_HALF + 0.7);
      for (let z = -ROAD_LENGTH / 2; z < ROAD_LENGTH / 2; z += 4) {
        L.metal.push(at(x, 0.38, z, 0, 0.12, 0.76, 0.12));
        L.metal.push(at(x, 0.62, z + 2, 0, 0.1, 0.26, 4.0));
      }
    }

    // Street lighting, past the car. A column at fifteen metres is eight
    // metres of pole straight up the middle of the picture; the same column at
    // sixty is a light on a road.
    for (const side of [-1, 1]) {
      const x = ROAD_OFFSET + side * (ROAD_HALF + 1.6);
      for (let z = -ROAD_LENGTH / 2; z < ROAD_LENGTH / 2; z += 46) {
        if (Math.abs(z) < 52) continue;
        L.metal.push(at(x, 4.2, z, 0, 0.13, 8.4, 0.13));
        L.metal.push(at(x - side * 1.1, 8.3, z, 0, 2.4, 0.16, 0.22));
        L.lit.push({
          matrix: at(x - side * 2.0, 8.15, z, 0, 0.75, 0.2, 0.4),
          tint: L.WARM.clone().multiplyScalar(1.5),
        });
      }
    }

    // --- materials, and one mesh per material ---

    // Lighter than the far city, and that is the point of separating them: a
    // plinth, a sill and a floor band are only worth modelling if something
    // can tell them apart, and at the far city's albedo the whole elevation
    // resolves to one black rectangle whatever is carved into it.
    const concrete = keep(new THREE.MeshStandardMaterial({
      color: 0x232a35, roughness: 0.95, metalness: 0,
    }));
    const trim = keep(new THREE.MeshStandardMaterial({
      color: 0x333c4a, roughness: 0.85, metalness: 0.05,
    }));
    const metal = keep(new THREE.MeshStandardMaterial({
      color: 0x3d4655, roughness: 0.5, metalness: 0.5,
    }));
    // Unlit windows: dark and glossy, so they still catch the sky.
    const glass = keep(new THREE.MeshStandardMaterial({
      color: 0x070a10, roughness: 0.16, metalness: 0.7,
    }));
    const far = keep(new THREE.MeshStandardMaterial({
      color: 0x0b1018, roughness: 1, metalness: 0,
    }));
    // Unlit: a lamp costs no light, and cannot be dimmed by the fact that the
    // only rig in this scene is pointed at the car.
    const emissive = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const beaconMat = keep(new THREE.MeshBasicMaterial({ color: 0xff5a4a }));

    this._instance(boxGeo, concrete, L.concrete);
    this._instance(boxGeo, trim, L.trim);
    this._instance(boxGeo, metal, L.metal);
    this._instance(boxGeo, glass, L.glass);
    this._instance(boxGeo, far, L.far);
    this._instance(cylGeo, metal, L.masts);
    this._instance(boxGeo, beaconMat, L.beacons);
    this._instance(boxGeo, emissive, L.sign.map((s) => s.matrix),
      L.sign.map((s) => s.tint));
    this.windows = this._instance(boxGeo, emissive, L.lit.map((s) => s.matrix),
      L.lit.map((s) => s.tint));

    // Light to see it by.
    //
    // Everything above is modelled and none of it was visible, because the
    // only rig in this scene is three lights aimed at a car on a turntable —
    // so a facade with a plinth, sills and floor bands rendered as exactly the
    // same black rectangle as a bare box would have. These are the sodium
    // lamps the columns are already carrying, given the job the columns imply.
    //
    // Four of them, ranged so they die before they reach the car: the car's
    // lighting was tuned and is not up for renegotiation by the scenery.
    for (const [x, z] of [[-34, -18], [-34, -70], [46, -30], [46, -86]]) {
      const lamp = new THREE.PointLight(0xffb765, 190, 62, 2);
      lamp.position.set(x, 7.5, z);
      this.stage.add(lamp);
    }

    this.scene.add(this.stage);
  }

  /**
   * One low-rise building beside the road, built out of its parts.
   *
   * This is where the triangles go, and deliberately: the picture is static
   * and one car deep, so the usual budget — cheap near, cheaper far — is
   * exactly backwards here. Nothing moves, nothing streams, and the camera
   * never leaves this spot, so the near field can afford to be modelled and
   * the far field can stay the flat boxes it already is.
   *
   * What separates a facade from a slab is not resolution, it is *layers*: a
   * plinth that stands proud, a band at every floor, sills and lintels that
   * cast the windows into the wall, a parapet with a lip on it. Each one is a
   * box, and each one gives the light something to break on. The windows are
   * the same idea — a pane set back inside four framing members rather than a
   * bright rectangle painted onto a wall.
   *
   * @param L     the instance lists to emit into
   * @param o     { x, z, w, d, floors, face } — `face` is -1 or +1 in x, the
   *              direction the front elevation looks
   */
  _facade(L, o) {
    const { rng, at } = L;
    const FLOOR = 3.4;
    const h = o.floors * FLOOR;
    const front = o.x + o.face * (o.w / 2);

    // The mass, and a plinth around its foot that stands a little proud.
    L.concrete.push(at(o.x, h / 2, o.z, 0, o.w, h, o.d));
    L.trim.push(at(o.x, 0.9, o.z, 0, o.w + 0.5, 1.8, o.d + 0.5));

    // A parapet with a lip: two boxes, because a roof that stops at the wall
    // reads as a cut and a roof with an edge on it reads as a roof.
    L.concrete.push(at(o.x, h + 0.45, o.z, 0, o.w + 0.3, 0.9, o.d + 0.3));
    L.trim.push(at(o.x, h + 0.95, o.z, 0, o.w + 0.55, 0.16, o.d + 0.55));

    // A band at every floor line.
    for (let f = 1; f < o.floors; f++) {
      L.trim.push(at(front + o.face * 0.14, f * FLOOR, o.z, 0, 0.3, 0.26, o.d + 0.2));
    }

    // The window grid on the front elevation. Bays are a fixed width, so a
    // wider building gets more windows rather than wider ones.
    const bays = Math.max(2, Math.round(o.d / 2.6));
    const bw = (o.d / bays) * 0.56;
    for (let f = 0; f < o.floors; f++) {
      const groundFloor = f === 0;
      for (let b = 0; b < bays; b++) {
        const bz = o.z + ((b + 0.5) / bays - 0.5) * o.d;
        if (groundFloor && o.shop) continue;   // the shopfront takes this row

        const y = f * FLOOR + FLOOR * 0.55;
        const wh = FLOOR * 0.52;

        // The opening: a pane set back into the wall.
        const paneX = front - o.face * 0.16;
        const on = rng.bool(0.46);
        const pane = at(paneX, y, bz, 0, 0.1, wh, bw);
        if (on) {
          L.lit.push({
            matrix: pane,
            tint: (rng.bool(0.14) ? L.COLD : (f < 2 ? L.WARM : L.PALE))
              .clone().multiplyScalar(rng.range(0.4, 1.0)),
          });
        } else {
          L.glass.push(pane);
        }

        // Frame: sill, lintel, two jambs. Four boxes per window is most of
        // this building's triangle count and all of its texture.
        const fx = front + o.face * 0.06;
        L.trim.push(at(fx, y - wh / 2 - 0.09, bz, 0, 0.34, 0.18, bw + 0.34));
        L.trim.push(at(fx, y + wh / 2 + 0.07, bz, 0, 0.26, 0.14, bw + 0.34));
        L.metal.push(at(fx, y, bz - bw / 2 - 0.08, 0, 0.2, wh, 0.16));
        L.metal.push(at(fx, y, bz + bw / 2 + 0.08, 0, 0.2, wh, 0.16));
        // A mullion down the middle of the pane, so a window is two lights.
        L.metal.push(at(fx, y, bz, 0, 0.16, wh, 0.09));

        // An air conditioner under one window in five.
        if (f > 0 && rng.bool(0.2)) {
          L.metal.push(at(front + o.face * 0.4, y - wh / 2 - 0.5, bz,
            0, 0.8, 0.6, bw * 0.7));
        }
      }
    }

    // The ground floor, if this one is a shop: a deep lit window, a fascia
    // above it and a canopy over the pavement. A lit interior at street level
    // is the single thing that most says the road goes somewhere.
    if (o.shop) {
      const y = FLOOR * 0.5;
      L.lit.push({
        matrix: at(front - o.face * 0.2, y, o.z, 0, 0.12, FLOOR * 0.6, o.d * 0.82),
        tint: L.WARM.clone().multiplyScalar(rng.range(0.4, 0.72)),
      });
      // Mullions across the shopfront.
      for (let k = 0; k <= 5; k++) {
        L.metal.push(at(front + o.face * 0.02, y, o.z + (k / 5 - 0.5) * o.d * 0.82,
          0, 0.24, FLOOR * 0.64, 0.12));
      }
      // Fascia, and a sign band on it.
      L.trim.push(at(front + o.face * 0.22, FLOOR * 0.92, o.z, 0, 0.5, 0.7, o.d * 0.9));
      L.sign.push({
        matrix: at(front + o.face * 0.5, FLOOR * 0.92, o.z, 0, 0.12, 0.42, o.d * 0.6),
        tint: L.SIGNS[rng.int(0, L.SIGNS.length - 1)],
      });
      // Canopy, reaching over the pavement.
      L.metal.push(at(front + o.face * 0.85, FLOOR * 0.74, o.z, 0, 1.5, 0.1, o.d * 0.9));
      L.lit.push({
        matrix: at(front + o.face * 0.85, FLOOR * 0.68, o.z, 0, 1.2, 0.05, o.d * 0.8),
        tint: L.WARM.clone().multiplyScalar(0.34),
      });
    }

    // A fire escape on some of them: a stringer with landings and a rail.
    if (o.escape) {
      const ez = o.z + o.d * 0.34;
      for (let f = 1; f < o.floors; f++) {
        const y = f * FLOOR;
        L.metal.push(at(front + o.face * 0.75, y, ez, 0, 1.5, 0.09, 1.5));   // landing
        L.metal.push(at(front + o.face * 1.4, y + 0.5, ez, 0, 0.07, 1.0, 1.5)); // rail
        L.metal.push(at(front + o.face * 0.75, y + 0.5, ez + 0.72, 0, 1.5, 1.0, 0.07));
        // The flight down to the landing below.
        if (f > 1) {
          L.metal.push(at(front + o.face * 1.05, y - FLOOR / 2, ez - 0.8,
            0, 0.9, 0.08, 2.6));
        }
      }
    }
  }

  /**
   * A sign gantry over the carriageway.
   *
   * The one piece of highway furniture that reads as highway at any distance:
   * two columns, a truss between them, and a board hung off it. It also does
   * something the buildings cannot — it crosses the road, so it puts a hard
   * horizontal at a known distance and gives the corridor a measurable depth.
   */
  _gantry(L, z) {
    const { at } = L;
    const left = ROAD_OFFSET - ROAD_HALF - 1.4;
    const right = ROAD_OFFSET + ROAD_HALF + 1.4;
    const span = right - left;
    const top = 7.6;

    for (const x of [left, right]) {
      L.metal.push(at(x, top / 2, z, 0, 0.42, top, 0.42));
      L.trim.push(at(x, 0.35, z, 0, 1.1, 0.7, 1.1));            // footing
    }
    // The truss: two chords and the diagonals between them.
    L.metal.push(at((left + right) / 2, top, z, 0, span, 0.22, 0.3));
    L.metal.push(at((left + right) / 2, top + 1.1, z, 0, span, 0.22, 0.3));
    for (let i = 0; i < 16; i++) {
      const x = left + (i + 0.5) / 16 * span;
      L.metal.push(at(x, top + 0.55, z, 0, 0.12, 1.2, 0.16));
    }
    // Boards, one over each carriageway, with a light strip under them.
    for (const s of [-1, 1]) {
      const cx = ROAD_OFFSET + s * ROAD_HALF * 0.5;
      L.sign.push({
        matrix: at(cx, top + 2.2, z, 0, ROAD_HALF * 0.82, 2.3, 0.16),
        tint: L.SIGN_GREEN,
      });
      L.metal.push(at(cx, top + 3.45, z, 0, ROAD_HALF * 0.86, 0.16, 0.3));
      L.lit.push({
        matrix: at(cx, top + 3.3, z + 0.22, 0, ROAD_HALF * 0.7, 0.1, 0.1),
        tint: L.PALE.clone().multiplyScalar(0.8),
      });
    }
  }

  /**
   * One InstancedMesh from a list of matrices, added to the stage.
   *
   * @param tints  optional per-instance colours, multiplied into the material
   */
  _instance(geo, mat, matrices, tints = null) {
    if (!matrices.length) return null;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
      if (tints) inst.setColorAt(i, tints[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // The city lines a road that runs off both edges of the picture and is
    // never wholly out of view; culling it per-instance would cost more than
    // drawing it.
    inst.frustumCulled = false;
    this.instances.push(inst);
    this.stage.add(inst);
    return inst;
  }

  /**
   * Show a vehicle, building it exactly the way a run would start it — with
   * its starting skill fitted, since that is the car the player gets.
   */
  setVehicle(id, look = null) {
    // The look is part of the identity here, not a tweak on top: changing a
    // paint has to rebuild the car, and the early return was keyed on the id
    // alone — so equipping something while looking at it changed nothing.
    const key = `${id}|${look?.baseColor ?? ''}|${look?.accentColor ?? ''}|${look?.rimTint ?? ''}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    const def = VEHICLE_BY_ID[id] ?? VEHICLES[0];
    this.vehicleId = def.id;

    this._disposeMesh();
    const build = new Build(def.id);
    if (def.startingSkill) build.addSkill(instantiateSkill(def.startingSkill, 1));
    const profile = visualProfile(build.stats.all(), build.tags, def, look);
    this.mesh = new VehicleMesh(profile, { shadows: true });
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
    // The dome rides the camera, and the aircraft over the city keep moving.
    this.sky.update(dt, this.camera.position);
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
    this.roadGeo.dispose();
    this.roadMat.dispose();
    this.groundGeo.dispose();
    this.groundMat.dispose();
    for (const i of this.instances) i.dispose();
    for (const d of this.disposables) d.dispose();
    this.sky.dispose();
  }
}
