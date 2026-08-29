import * as THREE from 'three';
import { VehicleMesh, visualProfile, DAMAGE_STATES } from '../vehicle/chassis.js';
import { Build } from '../build/build.js';
import { VEHICLES } from '../data/vehicles.js';
import { PART_BY_ID } from '../data/parts.js';
import { instantiateSkill } from '../data/skills.js';

// A showroom for the vehicle mesh generator.
//
// The design brief asks that a specialised build *look* specialised. That is a
// claim about this generator, and the only way to check it is to stand the
// extremes next to each other under flat light and look at them. Lives in the
// project (rather than in the tool that drives it) because it needs a real
// `three` import, which Vite can only resolve at transform time.

const CASES = {
  // One car, alone, for inspecting a specific artifact.
  //
  // `VEHICLE` picks which, and `BODY` overrides just the silhouette — so a body
  // type can be shaped and looked at before anything is committed to the roster.
  single: (opts = {}) => {
    const v = VEHICLES.find((x) => x.id === opts.vehicle) || VEHICLES[0];
    const build = new Build(v.id);
    const def = opts.bodyType ? { ...v, bodyType: opts.bodyType } : v;
    // `HEALTH` puts the car in a damage state, so one can be inspected close up
    // rather than only compared at four-across size.
    return [{ label: def.name, build, def, health: opts.health }];
  },

  // One car in each damage state, side by side.
  //
  // The states are meant to be told apart at a glance from a chase camera, and
  // the only way to know whether they are is to see them together. `VEHICLE`
  // picks which car wears them.
  damage: (opts = {}) => {
    const v = VEHICLES.find((x) => x.id === opts.vehicle) || VEHICLES[2];
    return DAMAGE_STATES.map((st, i) => ({
      label: `${v.name} · ${['untouched', 'hit', 'in trouble', 'wrecked'][i]}`,
      build: new Build(v.id),
      def: v,
      // Just inside the state, so this is the car at that threshold.
      health: i === 0 ? 1 : st.at - 0.001,
    }));
  },

  vehicles: () => VEHICLES.map((v) => {
    const build = new Build(v.id);
    if (v.startingSkill) build.addSkill(instantiateSkill(v.startingSkill, 1));
    return { label: v.name, build, def: v };
  }),

  // One chassis, pushed toward each archetype the brief names, so every visible
  // difference comes from the build rather than the vehicle.
  builds: () => ([
    ['Stock', []],
    ['Speed', ['velocity_core', 'hell_engine', 'featherframe']],
    ['Tank', ['heavy_armor', 'absolute_unit', 'reinforced_frame']],
    ['Impact', ['ram_prow', 'reinforced_bumper', 'flywheel']],
    ['Electric', ['storm_engine', 'lightning_tires', 'chain_lightning']],
    ['Everything', ['hell_engine', 'absolute_unit', 'ram_prow', 'storm_engine']],
  ]).map(([label, parts]) => {
    const build = new Build('rotary');
    for (const id of parts) {
      if (PART_BY_ID[id] && build.canAddPart()) build.addPart(PART_BY_ID[id]);
    }
    if (label === 'Electric') build.addSkill(instantiateSkill('electric_grenade', 1));
    return { label, build, def: build.vehicle };
  }),
};

/**
 * Replace whatever is on screen with a static row of cars and render it.
 * @returns per-car stats for the tool to print
 */
export function showGarage(game, mode = 'vehicles', aspect = 1400 / 620, opts = {}) {
  game.loop.stop();
  game.screens.clear();
  game.hud.hide();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);

  // Flat, neutral, three-point light: a showroom, not a biome.
  scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x2a2622, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(5, 7, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88bbff, 1.0);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  // An environment to reflect.
  //
  // Since the sky started baking itself into one, every material in the game
  // has had something to reflect except the ones in here — so this tool has
  // been quietly misrepresenting the thing it exists to judge: clear coat and
  // chrome both look like flat paint against a scene with no environment. A
  // three-stop gradient is enough; the point is that there is a sky above and
  // ground below rather than a void.
  {
    const env = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position);'
          + ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec3 vD; void main(){'
          + ' float h = clamp(vD.y, -1.0, 1.0);'
          + ' vec3 c = mix(vec3(0.30,0.33,0.38), vec3(0.62,0.72,0.88), clamp(h*2.0,0.0,1.0));'
          + ' c = mix(vec3(0.10,0.10,0.11), c, clamp(h*4.0+1.0,0.0,1.0));'
          + ' gl_FragColor = vec4(c, 1.0); }',
      }),
    );
    env.add(dome);
    const pmrem = new THREE.PMREMGenerator(game.renderer.gl);
    const rt = pmrem.fromScene(env, 0, 0.1, 100);
    scene.environment = rt.texture;
    scene.environmentIntensity = 1.0;
    dome.geometry.dispose();
    dome.material.dispose();
    pmrem.dispose();
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const specs = (CASES[mode] || CASES.vehicles)(opts);
  const meshes = [];
  const rows = [];
  const spacing = 8.6;
  // Three across for six cars, four for four. A fixed three left a run of four
  // cases with one orphan on a second row, half the size and behind the rest,
  // which is not a comparison.
  const cols = specs.length === 4 ? 4 : 3;

  specs.forEach((spec, i) => {
    const profile = visualProfile(spec.build.stats.all(), spec.build.tags, spec.def);
    const mesh = new VehicleMesh(profile, { shadows: false });
    const col = i % cols;
    const row = Math.floor(i / cols);

    // A static pose: three-quarter view, front wheels turned, so the nose,
    // flank, wheel detail and any wing are all visible at once.
    mesh.update(0.016, {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
      forwardSpeed: 0, slipAngle: 0, speed: 0,
      drifting: false, driftQuality: 0, boostTimer: 0,
      p: { maxSpeed: 46 },
    }, { heatPct: 0, steer: -0.5 });

    if (spec.health !== undefined) mesh.setDamage(spec.health);

    if (mode === 'single') {
      mesh.group.position.set(0, 0, 0);
      mesh.group.rotation.set(0, opts.yaw ?? Math.PI * 0.78, 0);
      // Optionally strip the painted shell so whatever sits underneath the car
      // is visible on its own.
      if (opts.hideBody) mesh.bodyMesh.visible = false;
      if (opts.hideWheels) for (const w of mesh.wheels) w.pivot.visible = false;
      if (opts.hideGlass && mesh.glassMesh) mesh.glassMesh.visible = false;
      if (opts.hideTrim) mesh.trimMesh.visible = false;
      if (opts.hideUnderglow) mesh.underglow.visible = false;
    } else {
      mesh.group.position.set((col - (cols - 1) / 2) * spacing, 0, row * -11.0);
      // `YAW` turns the whole row. A comparison of front-end damage seen from
      // behind the cars is not a comparison.
      mesh.group.rotation.set(0, opts.yaw ?? Math.PI * 0.82, 0);
    }
    scene.add(mesh.group);
    meshes.push(mesh);

    // Indexed or not: a generated body is merged and indexed, a hull is
    // de-indexed by construction and shares its buffers with every other car of
    // that shape.
    const count = (g) => (g ? (g.index?.count ?? g.attributes.position.count) : 0);
    const tris = (count(mesh.bodyGeo) + count(mesh.glassGeo) + count(mesh.trimGeo)) / 3;
    rows.push({
      label: spec.label,
      tris,
      len: +mesh.length.toFixed(2),
      wid: +mesh.width.toFixed(2),
      glow: '#' + mesh.glow.color.toString(16).padStart(6, '0'),
      parts: spec.build.parts.length,
    });
  });

  // Near eye level. Looking down from above flattens a car into a footprint and
  // hides exactly the proportions this render exists to judge.
  const cam = new THREE.PerspectiveCamera(38, aspect, 0.2, 300);
  if (mode === 'single') {
    // Low and close: an artifact under the car is only visible from near the
    // ground plane, which is exactly where a chase camera sits in play.
    const h = opts.eye ?? 0.55;
    // `DIST` scales the whole rig in, for looking at a crease rather than at a
    // silhouette. Judging a shading change from four metres away is judging
    // whether you can see it from four metres away.
    const d = opts.dist ?? 1;
    cam.position.set(4.2 * d, h, 5.6 * d);
    cam.lookAt(0, opts.aim ?? 0.55, 0);
  } else {
    // Backed off by however much wider than three the row is, so a four-across
    // comparison is not two cars and two halves.
    const pull = 1 + Math.max(0, cols - 3) * 0.34;
    cam.position.set(2.6 * pull, 3.4 * pull, 17.0 * pull);
    cam.lookAt(0.2, 0.70, -5.0);
  }

  // Bypass the game's bloom composite: this is a reference render, and the
  // point is to see the geometry, not the biome's grade.
  const gl = game.renderer.gl;
  gl.setRenderTarget(null);
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.15;
  for (let i = 0; i < 4; i++) gl.render(scene, cam);

  game.__garage = {
    scene, cam, meshes,
    render: () => gl.render(scene, cam),
    /**
     * Render and read the pixels back in the *same* frame.
     *
     * The context is created without `preserveDrawingBuffer`, so the colour
     * buffer is undefined once the frame ends, and the garage stops the game
     * loop so nothing repaints. A page screenshot therefore depends on the
     * compositor still holding the frame, which is timing rather than a
     * guarantee. Reading the canvas inside the frame that drew it removes the
     * race entirely.
     */
    grab: () => new Promise((resolve) => {
      requestAnimationFrame(() => {
        gl.render(scene, cam);
        resolve(gl.domElement.toDataURL('image/png'));
      });
    }),
  };
  return rows;
}
