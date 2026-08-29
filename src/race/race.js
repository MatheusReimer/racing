import * as THREE from 'three';
import { RaceSim } from './sim.js';
import { TrackMesh } from '../track/mesh.js';
import { Sky } from '../sky/sky.js';
import { ChaseCamera } from '../render/camera.js';
import { VehicleMesh, visualProfile } from '../vehicle/chassis.js';
import { FX } from '../fx/fx.js';
import { PropsMesh } from '../world/propsmesh.js';
import { TrafficMesh } from './trafficmesh.js';
import { StreetLighting } from '../fx/lights.js';

export { makeDefaultRivalBuild } from './sim.js';

// The presentation layer over RaceSim: scene, meshes, sky, camera.
//
// Every rule lives in the base class. This file may not decide anything — a
// behaviour added here would exist in the played game but not in the balance
// runs, and the two would silently disagree about what the game is. What it
// does instead is subscribe: the simulation calls `onBarrierHit`, `onCarHit`
// and `onWreck`, and this turns those into camera shoves and effects.

export class Race extends RaceSim {
  constructor({ seed, biome, playerBuild, config = {}, quality, events }) {
    super({ seed, biome, playerBuild, config, events });

    this.quality = quality;

    this.scene = new THREE.Scene();
    this.sky = new Sky(this.scene);
    this.sky.apply(biome, quality.settings);

    this.trackMesh = new TrackMesh(this.track, biome, quality.settings).addTo(this.scene);
    this.propsMesh = new PropsMesh(this.props, biome, quality.settings, seed).addTo(this.scene);
    this.trafficMesh = this.traffic.length
      ? new TrafficMesh(this.traffic, quality.settings, seed).addTo(this.scene)
      : null;
    this.camera = new ChaseCamera(this._aspect());
    this.fx = new FX(this.scene, events, quality.settings);
    this._groundAt = (x, z) => this.track.groundAt(x, z);
    this.fx.setFog(biome.palette.fogDensity ?? 0.004);

    // Lamplight on the tarmac, for the districts that have lamps. In daylight
    // it is invisible at best and a pale smear at worst, so it is not built.
    this.lighting = biome.palette.night
      ? new StreetLighting(this.scene, {
        props: this.props,
        library: this.propsMesh.library,
        groundAt: this._groundAt,
        quality: quality.settings,
        fogDensity: biome.palette.fogDensity,
      })
      : null;

    // The base constructor already created the racers; give them bodies.
    this.meshes = new Map();
    for (const racer of this.racers) this._buildMesh(racer);

    // Simulation -> presentation. These callbacks are the only channel.
    this.onBarrierHit = (racer, dirX, dirZ, approach) => {
      if (!racer.isPlayer) return;
      this.camera.impact(dirX, dirZ, approach);
      this.events?.emit('fx:impact', {
        x: racer.body.x, y: racer.body.y + 0.6, z: racer.body.z,
        strength: approach, kind: 'barrier',
      });
    };

    this.onCarHit = (a, b, nx, nz, approach) => {
      if (a.isPlayer) this.camera.impact(-nx, -nz, approach * 0.8);
      if (b.isPlayer) this.camera.impact(nx, nz, approach * 0.8);
      this.events?.emit('fx:impact', {
        x: (a.body.x + b.body.x) / 2, y: 0.7, z: (a.body.z + b.body.z) / 2,
        strength: approach, kind: 'car',
      });
    };

    this.onPropSmashed = (prop, racer, speed) => {
      this.events?.emit('fx:propSmashed', { prop, racer, speed });
    };
    this.onPropHit = (prop, racer, speed) => {
      if (racer.isPlayer) this.camera.impact(0, 0, speed * 0.7);
      this.events?.emit('fx:impact', {
        x: prop.x, y: prop.y + 0.6, z: prop.z, strength: speed, kind: 'prop',
      });
    };

    this.onWreck = (killer, victim) => {
      this.events?.emit('fx:explosion', {
        x: victim.body.x, y: victim.body.y + 0.8, z: victim.body.z, radius: 6, power: 1,
      });
    };
  }

  _aspect() {
    return typeof window === 'undefined'
      ? 16 / 9
      : window.innerWidth / Math.max(1, window.innerHeight);
  }

  _buildMesh(racer) {
    const profile = visualProfile(
      racer.build.stats.all(),
      racer.build.tags,
      racer.isPlayer ? racer.build.vehicle : {
        ...racer.build.vehicle,
        color: racer.archetype?.color || racer.build.vehicle.color,
      },
    );
    const mesh = new VehicleMesh(profile, this.quality.settings).addTo(this.scene);
    // The collision footprint comes from the mesh, so the visual and physical
    // sizes cannot drift apart as parts change the car's proportions.
    racer.radius = mesh.radius;
    racer.halfWidth = mesh.width * 0.5;
    racer.halfLength = mesh.length * 0.5;
    this.meshes.set(racer, mesh);
  }

  render(dt, alpha) {
    for (const [racer, mesh] of this.meshes) {
      mesh.group.visible = racer.alive;
      if (!racer.alive) continue;
      mesh.update(dt, racer.body, {
        heatPct: racer.heat,
        energyFrac: racer.energyFrac,
        boosting: racer.body.boostTimer > 0,
        steer: racer.input.steer,
        // The brake lights need to know, and nothing else was telling them.
        brake: racer.input.brake,
        // How beaten the car should look. The mesh turns this into one of four
        // states and only does work when it crosses between them.
        healthFrac: racer.maxDurability > 0
          ? racer.durability / racer.maxDurability : 1,
      }, alpha);
    }

    this.camera.update(dt, this.player.body, {
      lookBack: this.player.input.lookBack,
      boosting: this.player.body.boostTimer > 0,
      // One projection per frame, so the rig can be kept above the terrain
      // under itself rather than under the car.
      groundAt: this._groundAt,
      alpha,
    });
    this.propsMesh.syncDestroyed();
    this.trafficMesh?.sync(alpha);
    this.lighting?.update(this.racers, this.traffic, this._groundAt);
    this.fx.update(dt, this.racers, this.combat, this.camera.camera.position);
    this.sky.update(dt, this.camera.camera.position);
    return this.camera.camera;
  }

  postFx() {
    return this.camera.postFx(this.player.body);
  }

  resize(aspect) {
    this.camera.setAspect(aspect);
  }

  applyQuality(q) {
    this.sky.configureShadows(q);
    this.fx.applyQuality(q);
  }

  dispose() {
    this.lighting?.dispose();
    this.fx.dispose();
    this.propsMesh.dispose();
    this.trafficMesh?.dispose();
    this.trackMesh.dispose();
    for (const m of this.meshes.values()) m.dispose();
    this.meshes.clear();
    this.sky.dispose();
  }
}
