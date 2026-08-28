import { clamp, clamp01, lerp, damp, wrapAngle } from '../core/math.js';

// The vehicle model. Pure motion — no Three.js, no rendering, no game rules —
// so it can be stepped headlessly by the balance and playtest tools.
//
// The core of it is a slip-angle model. Velocity lives in world space; each
// step it is decomposed into components along and across the car's heading:
//
//   - the forward component takes engine, brake and drag
//   - the lateral component is bled off by an exponential grip term
//   - steering rotates the *heading*, not the velocity
//
// Because the heading turns immediately but the velocity only follows as fast
// as grip permits, slip falls out of the model for free rather than being
// special-cased. A drift is not a separate mode bolted on top; it is what this
// model does when you cut the grip term.
//
// Exponential decay (`v *= exp(-k·dt)`) is used everywhere instead of linear
// subtraction because it is unconditionally stable and framerate-independent —
// which is what lets the simulation run at 60 Hz rather than 120 Hz, and is a
// large part of why the game leaves CPU headroom.

/** Slip angle, in radians, at which we consider the car to be sliding. */
const SLIP_DRIFT_THRESHOLD = 0.16;
/** Below this speed nothing counts as a drift; it is just parking. */
const DRIFT_MIN_SPEED = 9;
/** Handbrake cuts traction to this fraction, regardless of the Drift stat. */
const DRIFT_GRIP_CUT = 0.22;

const GRAVITY = 24;
// How far the wheels may sit from the surface and still count as touching it.
// Wheels are ~0.5 m across, so a few centimetres of gap over a crest or a rut
// is contact, not flight.
const CONTACT_TOLERANCE = 0.12;

/**
 * `grip`     multiplies the lateral decay rate — how hard it is to slide.
 * `resist`   is an explicit deceleration in m/s^2, not a multiplier. Sand
 *            costing "7 m/s^2" is something a designer can reason about;
 *            "2.6x drag" interacts with the top-speed curve in ways nobody
 *            can predict. A negative value is an accelerating pad.
 * `dragMult` scales only the aerodynamic term, which is small.
 */
export const SURFACES = {
  road:    { id: 'road',    grip: 1.00, resist:  0.0, dragMult: 1.00, damage: 0 },
  gravel:  { id: 'gravel',  grip: 0.70, resist:  3.0, dragMult: 1.20, damage: 0 },
  offroad: { id: 'offroad', grip: 0.62, resist:  4.5, dragMult: 1.40, damage: 0 },
  sand:    { id: 'sand',    grip: 0.48, resist:  7.0, dragMult: 1.60, damage: 0 },
  ice:     { id: 'ice',     grip: 0.20, resist:  0.0, dragMult: 0.90, damage: 0 },
  oil:     { id: 'oil',     grip: 0.12, resist:  0.0, dragMult: 1.00, damage: 0 },
  lava:    { id: 'lava',    grip: 0.80, resist:  2.0, dragMult: 1.10, damage: 11 },
  boost:   { id: 'boost',   grip: 1.05, resist: -6.0, dragMult: 0.80, damage: 0 },
};

export class VehicleBody {
  constructor(physics) {
    /** Derived physics from the StatBlock. Swapped wholesale when parts change. */
    this.p = physics;

    // --- pose ---
    this.x = 0;
    this.z = 0;
    this.y = 0;          // height above the track surface
    this.yaw = 0;        // heading, radians; +Z is yaw 0
    this.pitch = 0;         // terrainPitch + bodyPitch, for anything wanting the sum
    this.terrainPitch = 0;  // the car lying along the road's slope — turns the wheels too
    this.bodyPitch = 0;     // squat and dive on the springs — turns the body only
    this.roll = 0;       // visual only, driven by lateral load

    // --- motion ---
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.yawRate = 0;

    // --- derived, read by everything else ---
    this.speed = 0;        // magnitude, m/s
    this.forwardSpeed = 0; // signed, along heading
    this.lateralSpeed = 0; // signed, across heading
    this.slipAngle = 0;
    this.drifting = false;
    this.driftQuality = 0;   // 0..1, how well the slide is being held
    this.driftTime = 0;      // seconds in the current slide
    this.airborne = false;
    // How long the car has been off the ground. Used to keep a one-frame hop
    // off the HUD: a state that flickers is noise, not information.
    this.airTime = 0;
    this.groundY = 0;
    this._prevGroundY = 0;
    // Road gradient along the direction of travel. Drives the visual pitch and
    // is what makes a crest read as a crest.
    this.groundSlope = 0;

    // --- transient states applied by the game layer ---
    this.boostTimer = 0;
    this.boostPower = 0;   // additive fraction of max speed
    this.stunTimer = 0;    // EMP / freeze: no throttle, no steering
    this.gripPenaltyTimer = 0;
    this.gripPenalty = 1;

    this.surface = SURFACES.road;
    /** Set by the collision layer each step so effects can read the last hit. */
    this.lastImpactSpeed = 0;
  }

  setPhysics(physics) {
    this.p = physics;
  }

  // Three.js is right-handed with Y up, so a camera looking down -Z sees +X on
  // its right. A car whose forward is +Z therefore has its own right-hand side
  // at -X: right = cross(forward, up) = (-cos yaw, sin yaw). Getting this
  // backwards silently mirrors the whole car — steering, slip sign, body lean
  // and the AI's avoidance all invert together, so it looks self-consistent
  // while being reversed.
  get forwardX() { return Math.sin(this.yaw); }
  get forwardZ() { return Math.cos(this.yaw); }
  get rightX()   { return -Math.cos(this.yaw); }
  get rightZ()   { return Math.sin(this.yaw); }

  place(x, z, yaw) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.y = 0;
    this.yawRate = 0;
    this.speed = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.drifting = false;
    this.driftTime = 0;
  }

  /** Current effective top speed, including boosts. */
  maxSpeedNow() {
    return this.p.maxSpeed * (1 + this.boostPower);
  }

  /**
   * @param dt       fixed timestep
   * @param input    { throttle, brake, steer, drift }
   * @param surface  entry from SURFACES
   * @param groundY  track surface height under the car
   */
  step(dt, input, surface = SURFACES.road, groundY = 0) {
    const p = this.p;
    this.surface = surface;
    this.groundY = groundY;

    // Timers ---------------------------------------------------------------
    if (this.boostTimer > 0) {
      this.boostTimer -= dt;
      if (this.boostTimer <= 0) {
        this.boostTimer = 0;
        this.boostPower = 0;
      }
    }
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.gripPenaltyTimer > 0) {
      this.gripPenaltyTimer -= dt;
      if (this.gripPenaltyTimer <= 0) this.gripPenalty = 1;
    }

    const stunned = this.stunTimer > 0;
    const throttle = stunned ? 0 : clamp01(input.throttle || 0);
    const brake = stunned ? 0 : clamp01(input.brake || 0);
    const steerIn = stunned ? 0 : clamp(input.steer || 0, -1, 1);
    const wantDrift = !stunned && !!input.drift;

    // Decompose velocity into the heading frame ------------------------------
    const fx = this.forwardX, fz = this.forwardZ;
    const rx = this.rightX, rz = this.rightZ;
    let vFwd = this.vx * fx + this.vz * fz;
    let vLat = this.vx * rx + this.vz * rz;

    const speed = Math.hypot(this.vx, this.vz);
    const maxSpeed = this.maxSpeedNow();

    // Slip -------------------------------------------------------------------
    // atan2 against |vFwd| so reversing does not read as a 180-degree slide.
    this.slipAngle = Math.atan2(vLat, Math.max(1.5, Math.abs(vFwd)));
    const absSlip = Math.abs(this.slipAngle);

    // The handbrake *causes* a slide; it must not require one to already be in
    // progress, or drifting can never start from a clean line.
    const fastEnough = speed > DRIFT_MIN_SPEED;
    const nowDrifting = fastEnough && (wantDrift || absSlip > SLIP_DRIFT_THRESHOLD * 2);
    if (nowDrifting) this.driftTime += dt;
    else this.driftTime = 0;
    this.drifting = nowDrifting;

    // Drift quality peaks in a controlled band. Sliding barely, or spinning
    // out entirely, both pay nothing — the Energy is for holding the middle.
    if (nowDrifting) {
      // The window is centred on the angle *this* car is built to hold, so a
      // high-Drift machine is not penalised for running the bigger slide it is
      // capable of. What separates builds is the payout rate, not the geometry.
      const ideal = p.driftIdealSlip;
      const width = p.driftBandWidth;
      const shape = Math.exp(-((absSlip - ideal) ** 2) / (2 * width * width));
      const speedFactor = clamp01((speed - DRIFT_MIN_SPEED) / (maxSpeed * 0.45));
      this.driftQuality = shape * speedFactor;
    } else {
      this.driftQuality = 0;
    }

    // Longitudinal forces ----------------------------------------------------
    if (this.airborne) {
      // No traction in the air: only drag, and steering has almost no bite.
      vFwd -= vFwd * 0.06 * dt;
    } else {
      // Engine, with falloff so power dies out as we approach top speed. The
      // cubic holds most of its power through the midrange and then collapses,
      // which is what makes a high top speed feel like a long climb.
      if (throttle > 0) {
        const frac = clamp01(vFwd / maxSpeed);
        const falloff = 1 - frac * frac * frac;
        vFwd += throttle * p.engineAccel * falloff * dt;
      } else if (brake === 0) {
        // Engine braking. Kept separate from aerodynamic drag so that coasting
        // feels responsive without dragging the attainable top speed down.
        const coast = 3.5 * dt;
        vFwd -= Math.sign(vFwd) * Math.min(Math.abs(vFwd), coast);
      }

      // Brake, or reverse once we are essentially stopped.
      if (brake > 0) {
        if (vFwd > 0.5) {
          vFwd -= Math.min(vFwd, brake * p.brakeDecel * dt);
        } else {
          const reverseMax = maxSpeed * 0.32;
          if (vFwd > -reverseMax) vFwd -= brake * p.engineAccel * 0.55 * dt;
        }
      }

      // Drifting scrubs forward speed. A high Drift stat keeps nearly all of
      // it; a low one turns every slide into a costly mistake.
      if (nowDrifting) {
        const scrub = (1 - p.driftSpeedKeep) * absSlip * 2.2;
        vFwd -= vFwd * scrub * dt;
      }

      // Surface resistance, as a flat deceleration.
      const resist = surface.resist ?? 0;
      if (resist > 0) {
        vFwd -= Math.sign(vFwd) * Math.min(Math.abs(vFwd), resist * dt);
      } else if (resist < 0 && vFwd >= 0) {
        vFwd -= resist * dt; // boost pad
      }
    }

    // Aerodynamic drag only. Small by design: the engine falloff above is what
    // sets top speed, so drag must not fight it or the cap becomes unreachable.
    const dragMult = surface.dragMult ?? 1;
    vFwd -= vFwd * 0.035 * dragMult * dt;
    vFwd -= vFwd * Math.abs(vFwd) * 0.00022 * dragMult * dt;

    // Lateral grip -----------------------------------------------------------
    let gripRate = p.gripRate * (surface.grip ?? 1) * this.gripPenalty;
    // Breaking traction is mechanical and fixed; how much momentum the slide
    // then costs you is the Drift attribute's job.
    if (nowDrifting) gripRate *= DRIFT_GRIP_CUT * p.driftGripScrub;
    if (this.airborne) gripRate *= 0.05;
    vLat *= Math.exp(-gripRate * dt);

    // Steering ---------------------------------------------------------------
    // Two independent limits, which is how Grip and Turning stay distinct:
    //
    //   Grip    caps the *sustainable* yaw rate. Holding a corner requires
    //           lateral acceleration v*omega; the tyres can only supply
    //           `corneringAccel`, so omega <= corneringAccel / v. Without this
    //           term the heading outruns the tyres at speed and every corner
    //           ends in a spin.
    //
    //   Turning caps the yaw rate at low speed (hairpin tightness) and sets how
    //           fast the car converges on it (agility).
    const latAccelCap = p.corneringAccel * (surface.grip ?? 1) * this.gripPenalty;
    const gripYawLimit = latAccelCap / Math.max(7, speed);

    // How far past the tyres' limit the driver may command. Ordinary cornering
    // allows a sliver (that sliver is the slip angle you always carry); the
    // handbrake allows a great deal, and the Drift stat says how much.
    // Rescaled with `corneringAccel` when handling went arcade. What matters is
    // the product `latAccelCap * overshoot`, because that is the yaw rate the
    // driver may command; raising grip by 1.6x and leaving these alone let a
    // handbrake slide reach 57 degrees and bleed most of the speed. Matched to
    // the previous product so the drift *geometry* is unchanged and only the
    // grip underneath it moved.
    const overshoot = nowDrifting ? 0.94 + p.driftSteerBonus * 0.47 : 1.05;

    // The tyres resist rotation but never prevent it: on ice you can still
    // point the nose, you just do not change direction. Without this floor the
    // car understeers helplessly on low-grip surfaces instead of sliding.
    const yawFloor = p.steerRate * 0.35 * (nowDrifting ? 1.0 : 0.55);

    let yawCap = Math.min(p.steerRate, Math.max(gripYawLimit * overshoot, yawFloor));
    if (this.airborne) yawCap *= 0.18;

    // Front-tyre saturation. Past a certain slip the car stops answering the
    // wheel; this is what makes the slide settle at an angle instead of
    // compounding into an unrecoverable spin.
    const slipLimit = nowDrifting ? 0.45 + p.driftSteerBonus * 0.55 : 0.30;
    const saturation = 1 / (1 + (absSlip / slipLimit) ** 2);

    // A stationary car cannot steer, but a crawling one certainly can — and
    // ramping authority in over 8 m/s left a car nose-first against a barrier
    // with no way to point itself away from it. 3.5 m/s still forbids spinning
    // on the spot while making extrication possible.
    const rampIn = clamp01(speed / 3.5);
    // Reversing inverts the steering, as it does in a real car.
    const dirSign = vFwd < -0.5 ? -1 : 1;

    // Negated: `forward = (sin yaw, cos yaw)` matches Three's Y rotation, which
    // means *increasing* yaw swings the nose toward +X — the car's left. So a
    // positive steer input (the D key, "go right") has to decrease yaw.
    const targetYawRate = -steerIn * yawCap * rampIn * saturation * dirSign;
    this.yawRate = damp(this.yawRate, targetYawRate, p.yawResponse, dt);

    // Recompose --------------------------------------------------------------
    // Critically, this uses the basis the velocity was decomposed on, *before*
    // the heading is advanced below. Recomposing onto the new heading would
    // rigidly weld the velocity to the chassis: the car could never point
    // anywhere except where it was going, slip angle would be zero by
    // construction, and drifting could not exist. The one-step lag between
    // heading and velocity is the entire model.
    this.vx = fx * vFwd + rx * vLat;
    this.vz = fz * vFwd + rz * vLat;

    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Vertical ---------------------------------------------------------------
    // The wheels stay on the road unless there is a real gap.
    //
    // This compared against a 1 mm tolerance, which is not a tolerance at all:
    // at 40 m/s a 2% downgrade drops the surface 13 mm in a single step, and
    // the track is rolling terrain. The car was therefore "airborne" 12-13% of
    // the time driving in a straight line, with a worst gap of 54 mm — five
    // centimetres. Airborne cuts grip to 5% and the yaw ceiling to 18%, so this
    // read from the seat as the car going dead on every crest and dip, for no
    // reason the player could see, and put AIRBORNE on the HUD while all four
    // wheels were on the road.
    //
    // The tolerance scales with how fast the surface is falling away, so
    // following the terrain is contact and a real launch still separates.
    const groundDrop = Math.max(0, this._prevGroundY - groundY);

    // The road's gradient along the direction of travel, measured rather than
    // sampled: rise over the distance actually covered this step. Below a
    // couple of centimetres of travel the quotient is noise, so it holds.
    const travelled = Math.hypot(this.vx, this.vz) * dt;
    if (travelled > 0.02) {
      const along = (groundY - this._prevGroundY) / travelled;
      this.groundSlope = along * (vFwd < 0 ? -1 : 1);
    }
    this._prevGroundY = groundY;
    const contact = CONTACT_TOLERANCE + groundDrop * 2;

    if (this.y > groundY + contact || this.vy > 0) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= groundY) {
        this.y = groundY;
        // Landing kills vertical momentum and briefly upsets the tyres.
        if (this.vy < -6) {
          this.gripPenalty = 0.55;
          this.gripPenaltyTimer = 0.35;
        }
        this.vy = 0;
        this.airborne = false;
        this.airTime = 0;
      } else {
        this.airborne = true;
        this.airTime += dt;
      }
    } else {
      this.y = groundY;
      this.vy = 0;
      this.airborne = false;
      this.airTime = 0;
    }

    // Bookkeeping ------------------------------------------------------------
    this.forwardSpeed = vFwd;
    this.lateralSpeed = vLat;
    this.speed = Math.hypot(this.vx, this.vz);

    // Visual body attitude. Purely cosmetic, but it is most of what sells
    // weight and speed to the player, so it is derived from real quantities.
    const accelG = (vFwd - (this._prevFwd ?? vFwd)) / Math.max(dt, 1e-5);
    this._prevFwd = vFwd;
    // Pitch is squat/dive *plus* the slope the car is standing on. Without the
    // terrain term the car stays level while the road tilts underneath it,
    // which is most of the reason the track's elevation was invisible: a hill
    // you do not lean into is not a hill, it is a change of horizon.
    //
    // Reported separately, because they are not the same motion and the renderer
    // has to do different things with them. Lying along a slope turns the whole
    // car, tyres included — that is what being on a hill is. Squatting under
    // power turns the body over its suspension while the tyres stay where they
    // are. Summed into one angle and applied to one node, whichever of the two
    // the renderer assumed was wrong: the car climbed a hill with its wheels
    // level, or it dived under braking by driving them into the road.
    this.terrainPitch = damp(this.terrainPitch,
      -Math.atan(clamp(this.groundSlope, -0.45, 0.45)), 8, dt);

    // Two degrees, not seven. Suspension travel is a few centimetres and the
    // wheelbase is metres, so the angle a real car reaches under its hardest
    // braking is small — the old ±0.12 rad put the nose of a four-metre car
    // twenty centimetres into the tarmac, which is most of why it kept ending up
    // there.
    this.bodyPitch = damp(this.bodyPitch, clamp(-accelG * 0.0035, -0.035, 0.035), 8, dt);
    // Body roll, likewise. Three and a half degrees, chosen against the cars
    // rather than by taste: the bodies carry their real ride heights now, about
    // a hundred millimetres of sill clearance, and a half-width of eight hundred
    // — so five degrees of lean puts the sill through the road and three and a
    // half does not. Seventeen, which is what this was, is a boat.
    this.roll = damp(this.roll, clamp(vLat * 0.004 + this.yawRate * 0.045, -0.06, 0.06), 9, dt);

    // Kept as the sum for anything that just wants "which way is the car
    // tilted" — the camera and the HUD read it, and neither cares why.
    this.pitch = this.terrainPitch + this.bodyPitch;

    return this;
  }

  /** Boost for `duration` seconds, adding `power` (fraction of max speed). */
  applyBoost(power, duration) {
    // Boosts refresh rather than stack, but a stronger one always wins.
    this.boostPower = Math.max(this.boostPower, power);
    this.boostTimer = Math.max(this.boostTimer, duration);
  }

  /** Instantaneous velocity change, in world space. Used by collisions and blasts. */
  applyImpulse(ix, iz, ignoreMass = false) {
    const m = ignoreMass ? 1 : this.p.mass / 1200;
    this.vx += ix / m;
    this.vz += iz / m;
  }

  /** Knock the car away from a point — explosions, rams, shockwaves. */
  applyBlast(px, pz, force, radius) {
    const dx = this.x - px;
    const dz = this.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > radius || d < 1e-4) return 0;
    const falloff = 1 - d / radius;
    const mag = force * falloff * falloff;
    this.applyImpulse((dx / d) * mag, (dz / d) * mag);
    // Blasts also upset the tyres, which is how a light car gets launched.
    this.gripPenalty = Math.min(this.gripPenalty, 0.5);
    this.gripPenaltyTimer = Math.max(this.gripPenaltyTimer, 0.4);
    return falloff;
  }

  /** Lose control for `t` seconds — EMP, freeze, heavy hits. */
  stun(t) {
    this.stunTimer = Math.max(this.stunTimer, t);
  }

  /** Launch off a ramp. */
  launch(vy) {
    this.vy = Math.max(this.vy, vy);
    this.airborne = true;
  }

  /** Direction the car is actually travelling, which is not its heading. */
  velocityAngle() {
    return Math.atan2(this.vx, this.vz);
  }

  /** km/h, for the HUD. */
  get kmh() {
    return this.speed * 3.6;
  }
}
