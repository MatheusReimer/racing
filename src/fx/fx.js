import * as THREE from 'three';
import { ParticleSystem, TireMarks, PRESETS } from './particles.js';
import { clamp01, lerp } from '../core/math.js';
import { DAMAGE_STATES, damageLevel } from '../vehicle/chassis.js';

// The effects layer.
//
// Subscribes to the event bus and turns simulation events into things you can
// see. It reads the world and never writes to it: no effect here can change a
// race outcome, which is what keeps the balance runs (which have no FX at all)
// honest about what the game does.
//
// Continuous effects — tyre smoke, engine heat haze, boost plumes — are driven
// from vehicle state each frame rather than from events, because they are
// properties of how the car is being driven rather than discrete moments.

export class FX {
  constructor(scene, events, quality) {
    this.scene = scene;
    this.events = events;
    // Two clouds, because a single draw call cannot mix blend modes and
    // additive smoke is not smoke. Split roughly 60/40 toward the emissive
    // side, which is where the density actually goes.
    const budget = quality.particleBudget ?? 1200;
    this.additive = new ParticleSystem(scene, Math.round(budget * 0.7), true);
    // The alpha cloud is the one that can hide the world, so it gets the
    // smaller share and a hard ceiling of its own.
    this.alphaCloud = new ParticleSystem(scene, Math.round(budget * 0.3), false);
    this.particles = {
      emit: (preset, x, y, z, n, opts) => {
        const sys = PRESETS[preset]?.additive === false ? this.alphaCloud : this.additive;
        sys.emit(preset, x, y, z, n, opts);
      },
      update: (dt) => { this.additive.update(dt); this.alphaCloud.update(dt); },
      clear: () => { this.additive.clear(); this.alphaCloud.clear(); },
    };
    this.marks = new TireMarks(scene, quality.tireMarkSegments ?? 700);
    this.unsubscribe = [];

    // Live projectile and trap markers, keyed by the simulation object's id.
    this.markers = new Map();
    this.shockwaves = [];

    this._sphere = new THREE.SphereGeometry(0.5, 8, 6);
    this._ringGeo = new THREE.RingGeometry(0.9, 1, 32);
    this._ringGeo.rotateX(-Math.PI / 2);

    this._bind();
  }

  _bind() {
    const on = (type, fn) => this.unsubscribe.push(this.events.on(type, fn));

    on('fx:impact', (e) => {
      const n = Math.min(28, 4 + Math.round(e.strength * 1.6));
      this.particles.emit('spark', e.x, e.y, e.z, n, { speed: 5 + e.strength });
      this.particles.emit('debris', e.x, e.y, e.z, Math.round(n * 0.4), { speed: 4 + e.strength * 0.7 });
      if (e.strength > 9) {
        this.particles.emit('smoke', e.x, e.y + 0.3, e.z, 5, { speed: 2.5 });
      }
    });

    on('fx:explosion', (e) => {
      const power = clamp01(e.power ?? 1);
      const color = e.tags?.includes('Electric') ? 0x6fd9ff
        : e.tags?.includes('Ice') ? 0x9fe8ff : 0xff7a2b;
      this.particles.emit('fire', e.x, e.y, e.z, Math.round(16 + power * 22), {
        speed: 6 + power * 12, color, spread: e.radius * 0.3,
      });
      this.particles.emit('smoke', e.x, e.y + 0.5, e.z, Math.round(8 + power * 10), {
        speed: 3 + power * 4, spread: e.radius * 0.4,
      });
      this.particles.emit('spark', e.x, e.y, e.z, Math.round(12 + power * 18), {
        speed: 10 + power * 16, color,
      });
      this._shockwave(e.x, e.y + 0.2, e.z, e.radius ?? 6, color, 0.45);
    });

    on('fx:shockwave', (e) => {
      this._shockwave(e.x, 0.4, e.z, e.radius, e.color ?? 0x6fd9ff, 0.6);
      this.particles.emit('electric', e.x, 0.6, e.z, 22, {
        speed: e.radius * 0.9, color: e.color ?? 0x6fd9ff, spread: 2,
      });
    });

    on('fx:hit', (e) => {
      const b = e.racer.body;
      const color = e.tags?.includes('Electric') ? 0x6fd9ff
        : e.tags?.includes('Fire') ? 0xff6a2b : 0xffc266;
      this.particles.emit('spark', b.x, b.y + 0.8, b.z, 8, { speed: 7, color });
    });

    on('fx:status', (e) => {
      const b = e.racer.body;
      if (e.id === 'electrified') {
        this.particles.emit('electric', b.x, b.y + 0.8, b.z, 10, { speed: 4, spread: 2 });
      } else if (e.id === 'burning') {
        this.particles.emit('fire', b.x, b.y + 0.6, b.z, 8, { speed: 2 });
      }
    });

    on('fx:repair', (e) => {
      const b = e.racer.body;
      this.particles.emit('boost', b.x, b.y + 1, b.z, 14, { speed: 3, color: 0x7ddc8f });
    });

    on('fx:projectile', (p) => this._addMarker(p, 0.35,
      p.tags?.includes('Electric') ? 0x6fd9ff : 0xffa040));
    on('fx:trap', (t) => this._addMarker(t, 0.5,
      t.visual === 'spike_strip' ? 0xb8c0cc
        : t.visual === 'oil' ? 0x2a2a30 : 0xff5555));
    on('fx:despawn', (o) => this._removeMarker(o));

    on('fx:propSmashed', (e) => {
      const { prop, speed } = e;
      const n = Math.min(26, 8 + Math.round(speed * 0.6));
      this.particles.emit('debris', prop.x, prop.y + 0.5, prop.z, n, { speed: 4 + speed * 0.5 });
      this.particles.emit('smoke', prop.x, prop.y + 0.4, prop.z, 5, { speed: 2.5 });
      if (prop.emissive != null) {
        this.particles.emit('fire', prop.x, prop.y + 0.6, prop.z, 12,
          { speed: 5, color: prop.emissive });
      } else {
        this.particles.emit('spark', prop.x, prop.y + 0.5, prop.z, 8, { speed: 6 });
      }
    });

    on('race:rescue', (e) => {
      const b = e.racer.body;
      this.particles.emit('smoke', b.x, b.y + 0.5, b.z, 14, { speed: 4 });
    });
  }

  _addMarker(obj, size, color) {
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const mesh = new THREE.Mesh(this._sphere, mat);
    mesh.scale.setScalar(size * (obj.kind === 'trap' ? 2.2 : 1.6));
    mesh.position.set(obj.x, obj.y + 0.4, obj.z);
    this.scene.add(mesh);
    this.markers.set(obj.id, { mesh, mat, obj, color });
  }

  _removeMarker(obj) {
    const m = this.markers.get(obj.id);
    if (!m) return;
    this.scene.remove(m.mesh);
    m.mat.dispose();
    this.markers.delete(obj.id);
  }

  _shockwave(x, y, z, radius, color, life) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this._ringGeo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.5);
    this.scene.add(mesh);
    this.shockwaves.push({ mesh, mat, t: 0, life, radius });
  }

  /**
   * Per-frame continuous effects, driven by how the cars are being driven.
   * @param racers  every live competitor
   * @param combat  the CombatSystem, for live projectile positions
   */
  update(dt, racers, combat, cameraPos = null) {
    this.particles.update(dt);

    for (const r of racers) {
      if (!r.alive) continue;
      const b = r.body;

      // Continuous emitters are rate-limited per second, not per frame. A
      // per-frame probability emits twice as much at 120 fps as at 60, and at
      // any rate a chase camera sits close enough that a few extra puffs are
      // the difference between an effect and an opaque wall.
      const rates = (r._fxRates ||= { smoke: 0, boost: 0, heat: 0, dust: 0, damage: 0 });
      const isPlayer = r.isPlayer;

      // Five rivals at a third of the player's rate is still 1.7x the player's
      // output, and their smoke sits between the camera and the road. Cut it
      // hard, and skip anyone the camera cannot see anyway.
      let share = isPlayer ? 1 : 0.14;
      if (!isPlayer && cameraPos) {
        const d = Math.hypot(b.x - cameraPos.x, b.z - cameraPos.z);
        if (d > 70) {
          rates.smoke = rates.boost = rates.heat = rates.dust = rates.damage = 0;
          continue;
        }
        share *= 1 - Math.min(0.8, d / 90);
      }

      if (b.drifting && b.speed > 10) {
        const q = b.driftQuality;
        const rear = 1.4;
        // Emitted at both rear wheels below, so this is half the visible rate.
        rates.smoke += dt * (5 + q * 7) * share;
        const puffs = Math.floor(rates.smoke);
        rates.smoke -= puffs;

        for (const side of [-1, 1]) {
          const wx = b.x - b.forwardX * rear + b.rightX * side * 0.9;
          const wz = b.z - b.forwardZ * rear + b.rightZ * side * 0.9;
          this.marks.mark(`${r.name}${side}`, wx, wz, b.y, b.forwardX, b.forwardZ, 0.34,
            0.35 + q * 0.65);
          if (puffs > 0) {
            this.particles.emit('tireSmoke', wx, b.y + 0.15, wz, puffs, { speed: 1.6 });
          }
        }
      } else {
        rates.smoke = 0;
        this.marks._last.delete(`${r.name}-1`);
        this.marks._last.delete(`${r.name}1`);
      }

      if (b.boostTimer > 0) {
        rates.boost += dt * 26 * share;
        const n = Math.floor(rates.boost);
        rates.boost -= n;
        if (n > 0) {
          this.particles.emit('boost', b.x - b.forwardX * 2.3, b.y + 0.45, b.z - b.forwardZ * 2.3, n, {
            speed: 4, dirX: -b.forwardX, dirZ: -b.forwardZ,
          });
        }
      } else rates.boost = 0;

      // Damage: a car in trouble smokes from the engine bay, and the rate comes
      // from the same table the mesh takes its states from — so the smoke starts
      // in the frame the bonnet lifts rather than at some threshold of its own.
      //
      // The wrecked state's rate is never reached from here: durability hitting
      // zero clears `alive`, and this loop skips a car that is not. That entry
      // is what a wreck should smoke like if one is ever left on the road, and
      // it is what the garage renders.
      const health = r.maxDurability > 0 ? r.durability / r.maxDurability : 1;
      const smokeRate = DAMAGE_STATES[damageLevel(health)].smoke;
      if (smokeRate > 0) {
        rates.damage += dt * smokeRate * 9 * share;
        const n = Math.floor(rates.damage);
        rates.damage -= n;
        if (n > 0) {
          // Out of the bonnet, and carried back over the car by its own speed.
          this.particles.emit('smoke',
            b.x + b.forwardX * 1.25, b.y + 0.78, b.z + b.forwardZ * 1.25, n, {
              speed: 1.1, dirX: -b.forwardX * 0.5, dirZ: -b.forwardZ * 0.5,
            });
        }
      } else rates.damage = 0;

      // Heat: a car near meltdown should look like it.
      if (r.heat > 70) {
        rates.heat += dt * ((r.heat - 70) / 30) * 12 * share;
        const n = Math.floor(rates.heat);
        rates.heat -= n;
        if (n > 0) this.particles.emit('fire', b.x, b.y + 0.9, b.z, n, { speed: 1.2 });
      } else rates.heat = 0;

      // Off-track dust.
      if (!r.sample.onTrack && b.speed > 8) {
        rates.dust += dt * 5 * share;
        const n = Math.floor(rates.dust);
        rates.dust -= n;
        if (n > 0) {
          this.particles.emit('smoke', b.x, b.y + 0.15, b.z, n, {
            speed: 2, color: 0xbfa477, sizeScale: 0.7, opacity: 0.22,
          });
        }
      } else rates.dust = 0;
    }

    // Live projectile markers follow their simulation objects.
    for (const [id, m] of this.markers) {
      const o = m.obj;
      if (o.dead) { this._removeMarker(o); continue; }
      m.mesh.position.set(o.x, o.y + 0.4, o.z);
      if (o.kind === 'projectile') {
        m.trail = (m.trail ?? 0) + dt * 30;
        const n = Math.floor(m.trail);
        m.trail -= n;
        if (n > 0) {
          this.particles.emit('fire', o.x, o.y, o.z, n, {
            speed: 0.6, color: m.color, sizeScale: 0.5,
          });
        }
      } else {
        // Traps pulse so they are visible on a busy road.
        const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.18;
        m.mesh.scale.setScalar(1.1 * pulse);
      }
    }

    // Expanding shockwave rings.
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.t += dt;
      const f = s.t / s.life;
      if (f >= 1) {
        this.scene.remove(s.mesh);
        s.mat.dispose();
        this.shockwaves.splice(i, 1);
        continue;
      }
      s.mesh.scale.setScalar(lerp(0.5, s.radius, f));
      s.mat.opacity = 0.8 * (1 - f) ** 1.5;
    }
  }

  applyQuality(q) {
    const budget = q.particleBudget ?? 1200;
    this.additive.setBudget(Math.round(budget * 0.7));
    this.alphaCloud.setBudget(Math.round(budget * 0.3));
  }

  /**
   * Match the particle distance fade to the biome's fog. A dense biome hides
   * particles sooner, which is both correct and cheaper.
   */
  setFog(density) {
    // FogExp2 has no near/far, so derive a visually equivalent band from it.
    const far = Math.min(600, 2.2 / Math.max(0.0008, density));
    this.additive.setFog(far * 0.35, far);
    this.alphaCloud.setFog(far * 0.35, far);
  }

  clear() {
    this.particles.clear();
    this.marks.clear();
    for (const [, m] of this.markers) { this.scene.remove(m.mesh); m.mat.dispose(); }
    this.markers.clear();
    for (const s of this.shockwaves) { this.scene.remove(s.mesh); s.mat.dispose(); }
    this.shockwaves.length = 0;
  }

  dispose() {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clear();
    this.additive.dispose();
    this.alphaCloud.dispose();
    this.marks.dispose();
    this._sphere.dispose();
    this._ringGeo.dispose();
  }
}
