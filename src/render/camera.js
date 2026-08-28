import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, angleDelta } from '../core/math.js';

// Chase camera.
//
// Most of the felt "speed" in a racing game is camera work, not vehicle speed,
// so this does a fair amount:
//
//   - it trails the car's *heading*, not its velocity, so a drift shows the
//     car sideways in frame instead of straightening it out
//   - FOV opens with speed, which is the strongest single cue
//   - the rig drops and tightens as speed rises
//   - impacts push the camera physically rather than adding random jitter
//
// The one rule everything here obeys: never move the camera in a way the
// player did not cause. Randomised handheld sway makes a driving game unplayable.

export class ChaseCamera {
  constructor(aspect) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.4, 1400);

    this.baseFov = 62;
    this.maxFovBoost = 26;

    this.distance = 9.2;
    this.height = 3.9;
    this.lookAhead = 7.5;

    // Smoothed state. The camera has its own position and yaw that chase the
    // targets, which is what gives it weight.
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.yaw = 0;
    this.fov = this.baseFov;
    this._initialised = false;

    // Impact response: a velocity-driven offset with a spring back to zero.
    this.shakeOffset = new THREE.Vector3();
    this.shakeVel = new THREE.Vector3();
    this.trauma = 0;

    this.lookBack = false;
    this._lookBackBlend = 0;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Snap to the target with no interpolation — race start, respawn, retry. */
  reset(body) {
    this._initialised = false;
    this.trauma = 0;
    this.shakeOffset.set(0, 0, 0);
    this.shakeVel.set(0, 0, 0);
    this._lookBackBlend = 0;
    this.update(0.016, body, {});
  }

  /**
   * @param body   VehicleBody to follow
   * @param opts   { lookBack, boosting, heatPct }
   */
  update(dt, body, opts = {}) {
    const speedFrac = clamp01(body.speed / Math.max(1, body.p.maxSpeed));

    // --- where the rig wants to be -----------------------------------------
    this._lookBackBlend = damp(this._lookBackBlend, opts.lookBack ? 1 : 0, 12, dt);
    const facing = body.yaw + Math.PI * this._lookBackBlend;

    // Trail the heading, but let a drift pull the camera partway toward the
    // direction of travel — enough to keep the road visible mid-slide without
    // hiding how sideways the car is.
    let targetYaw = facing;
    if (body.drifting && this._lookBackBlend < 0.5) {
      const velYaw = Math.atan2(body.vx, body.vz);
      targetYaw = facing + angleDelta(facing, velYaw) * 0.35;
    }

    if (!this._initialised) this.yaw = targetYaw;
    // Slower yaw chase at speed: a twitchy camera on a straight is nauseating.
    const yawRate = lerp(9, 4.5, speedFrac);
    this.yaw = this.yaw + angleDelta(this.yaw, targetYaw) * clamp01(yawRate * dt);

    // Rig geometry tightens and drops as speed rises.
    const dist = this.distance * lerp(1.0, 1.16, speedFrac) * (1 - this._lookBackBlend * 0.18);
    const hgt = this.height * lerp(1.0, 0.82, speedFrac);

    const bx = Math.sin(this.yaw), bz = Math.cos(this.yaw);
    const wantX = body.x - bx * dist;
    const wantZ = body.z - bz * dist;
    const wantY = body.y + hgt;

    if (!this._initialised) {
      this.pos.set(wantX, wantY, wantZ);
      this._initialised = true;
    } else {
      // Position follows faster than yaw so the car does not drift in frame.
      const posRate = lerp(11, 16, speedFrac);
      this.pos.x = damp(this.pos.x, wantX, posRate, dt);
      this.pos.z = damp(this.pos.z, wantZ, posRate, dt);
      this.pos.y = damp(this.pos.y, wantY, 8, dt);
    }

    // Never let the rig sink through the world.
    //
    // Height follows the car with damping, and the rig sits *behind* it — so on
    // a fast descent the camera lags above ground that is already falling away,
    // and on a crest it lags below ground that has risen behind the car. Either
    // way it ends up underneath the terrain, where every surface is backface
    // culled and the entire frame becomes flat sky. It reads as the world
    // having vanished, which is a very confusing symptom for a camera bug.
    //
    // `groundAt` samples the terrain under the *camera*, not under the car;
    // clamping to the car's ground height does not help when the ground behind
    // it is higher.
    if (opts.groundAt) {
      const floor = opts.groundAt(this.pos.x, this.pos.z) + 1.4;
      if (this.pos.y < floor) this.pos.y = floor;
    } else {
      const floor = (body.groundY ?? 0) + 1.4;
      if (this.pos.y < floor) this.pos.y = floor;
    }

    // --- look target --------------------------------------------------------
    // Aim ahead of the car along its heading, further at speed.
    const ahead = this.lookAhead * lerp(0.8, 1.6, speedFrac);
    const lfx = Math.sin(facing), lfz = Math.cos(facing);
    const lookX = body.x + lfx * ahead;
    const lookZ = body.z + lfz * ahead;
    const lookY = body.y + 1.5;

    this.look.x = damp(this.look.x, lookX, 12, dt);
    this.look.y = damp(this.look.y, lookY, 9, dt);
    this.look.z = damp(this.look.z, lookZ, 12, dt);

    // --- impact response ----------------------------------------------------
    // A damped spring rather than noise: hits read as the camera being shoved,
    // and it settles predictably instead of shimmering.
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - dt * 2.6);
    }
    const k = 90;      // spring constant
    const c = 13;      // damping
    this.shakeVel.x += (-this.shakeOffset.x * k - this.shakeVel.x * c) * dt;
    this.shakeVel.y += (-this.shakeOffset.y * k - this.shakeVel.y * c) * dt;
    this.shakeVel.z += (-this.shakeOffset.z * k - this.shakeVel.z * c) * dt;
    this.shakeOffset.addScaledVector(this.shakeVel, dt);

    // --- commit -------------------------------------------------------------
    const cam = this.camera;
    cam.position.set(
      this.pos.x + this.shakeOffset.x,
      this.pos.y + this.shakeOffset.y,
      this.pos.z + this.shakeOffset.z,
    );
    cam.lookAt(this.look);

    // Roll the camera slightly into a slide. Small, but it is most of what
    // makes a drift feel committed.
    const targetRoll = clamp(-body.slipAngle * 0.14 - body.yawRate * 0.05, -0.20, 0.20);
    this._roll = damp(this._roll ?? 0, targetRoll, 6, dt);
    cam.rotateZ(this._roll); // local-space, so it composes with lookAt

    // --- field of view ------------------------------------------------------
    const boostBonus = opts.boosting ? 8 : 0;
    const targetFov = this.baseFov + speedFrac * speedFrac * this.maxFovBoost + boostBonus;
    this.fov = damp(this.fov, targetFov, 5, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    return cam;
  }

  /**
   * Shove the camera. `dirX/dirZ` is the world direction of the hit; `force`
   * is roughly metres per second of camera velocity.
   */
  impact(dirX, dirZ, force) {
    const f = clamp(force, 0, 26);
    this.shakeVel.x += dirX * f * 0.16;
    this.shakeVel.z += dirZ * f * 0.16;
    this.shakeVel.y += f * 0.06;
    this.trauma = clamp01(this.trauma + f / 30);
  }

  /** Screen-space post effects driven by the camera's own state. */
  postFx(body) {
    const speedFrac = clamp01(body.speed / Math.max(1, body.p.maxSpeed));
    // Speed blur ramps in only in the top half of the range, so ordinary
    // driving stays crisp and going fast is visibly different.
    const t = clamp01((speedFrac - 0.45) / 0.55);
    return {
      speedBlur: t * t * 0.055 + (body.boostTimer > 0 ? 0.03 : 0),
      chroma: t * 0.10 + this.trauma * 0.10,
      exposure: 1.0,
      focusX: 0.5,
      focusY: 0.55,
    };
  }
}
