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

// How much rotation four loaded tyres can take out of a hit before the car
// starts turning, in radians per second of would-be spin. Set against the
// manoeuvre it exists for: a square nose-on shunt lands under it and a clip on
// the rear quarter does not.
const TYRE_YAW_HOLD = 1.1;
// And how much of that each end is good for. The front can be shoved a long way
// before the car changes direction, because the rear is what holds a heading;
// once the rear is the thing being shoved, very little is needed.
const FRONT_YAW_HOLD = 2.2;
const REAR_YAW_HOLD = 0.30;
// However hard you are hit, a car does not become a top. Beyond this it is
// already unrecoverable and more only looks silly.
const MAX_IMPACT_SPIN = 4.5;
// How fast a collision's rotation bleeds away. Around a second and a half to
// settle, which is long enough that being spun is a thing that happened to you
// and short enough that it is not the end of the race.
const IMPACT_SPIN_DECAY = 2.4;
// How firmly a barrier contact hands the car back pointing where it is going.
// Firm on purpose: a wall costing you time and paint is a mistake, a wall
// spinning you is the end of the race, and only one of those is interesting.
const WALL_STRAIGHTEN = 5.0;
// The jolt spring, in radians per second. Fast: a car body settles after a hit
// in a couple of tenths, not in a lazy wallow.
const JOLT_FREQ = 22;

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
    this.impactSpin = 0;
    this.joltPitch = 0;
    this.joltPitchVel = 0;
    this.joltRoll = 0;
    this.joltRollVel = 0;

    // Rotation a collision put on the car, kept apart from `yawRate`.
    //
    // `yawRate` is damped toward what the steering asks for every single step,
    // which is what makes the car obedient — and what would erase a spin the
    // frame after it started. A car that has been hit on the corner is not
    // steering, it is rotating, so that rotation is integrated alongside and
    // bleeds off on its own.
    this.impactSpin = 0;

    /** Seconds of asking the car to move while it does not. */
    this.stuckFor = 0;

    /** Seconds left of a barrier contact straightening the car out. */
    this.wallSteady = 0;
    /** The line of the rail last touched, which is what it straightens to. */
    this.wallYaw = null;

    // Last frame's pose, for drawing between two simulation steps.
    this.px = 0;
    this.py = 0;
    this.pz = 0;
    this.pyaw = 0;
    this.ppitch = 0;
    this.pbodyPitch = 0;
    this.pterrainPitch = 0;
    this.proll = 0;

    // Where the body is thrown by a hit, as a spring that returns to rest.
    // Purely what you see, but it is most of what makes contact read as
    // contact rather than as a change of number.
    this.joltPitch = 0;
    this.joltPitchVel = 0;
    this.joltRoll = 0;
    this.joltRollVel = 0;

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
    // Steering authority at a crawl.
    //
    // This was purely `speed / 3.5`, so a car at walking pace could not turn at
    // all — and nose-first into a barrier is exactly a car at walking pace.
    // Between that and the wall taking the heading, being stuck against
    // something was a state you sat in rather than drove out of, which is not
    // how it goes in the games this one is trying to feel like: there you scrape
    // a wall, straighten up and carry on.
    //
    // A driven wheel that is turned pivots a car even when the car is barely
    // moving, so the floor is conditional on the driver actually asking for
    // something. Lifting off still leaves you with nothing, which is right.
    const drive = Math.max(throttle, brake);
    const rampIn = clamp01(Math.max(speed / 3.5, drive * 0.38));
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

    // Steering and being hit both turn the car, and both have to be integrated.
    this.yaw = wrapAngle(this.yaw + (this.yawRate + this.impactSpin) * dt);
    this.impactSpin *= Math.exp(-IMPACT_SPIN_DECAY * dt);
    if (Math.abs(this.impactSpin) < 1e-3) this.impactSpin = 0;

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Coming off a wall pointed where you are going.
    //
    // The barrier response reflects the component going into the rail and
    // scrubs what runs along it, which is right — but it leaves the car with an
    // enormous slip angle, and the tyre model spends the next second turning
    // that into rotation. So a scrape at speed ended with the car swapping ends
    // a full second after it had stopped touching anything, which is not what
    // the wall did and not what any of the games this one is chasing do with a
    // wall: there you lose time and paint, you get straightened out, and you go.
    //
    // Pulled toward the wall's own line, remembered from the contact, not
    // toward the direction of travel. Travel is deflected a little more on each
    // step still in contact, so chasing it compounds: a five-degree brush came
    // out twenty degrees rotated, which is worse than what it replaced. The
    // wall's line does not move, and ending up parallel to the thing you
    // scraped is what scraping is.
    if (this.wallSteady > 0) {
      this.wallSteady -= dt;
      if (this.wallYaw != null) {
        let d = this.wallYaw - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.yaw = wrapAngle(this.yaw + d * (1 - Math.exp(-WALL_STRAIGHTEN * dt)));
      }
      this.yawRate *= Math.exp(-WALL_STRAIGHTEN * dt);
      this.impactSpin *= Math.exp(-WALL_STRAIGHTEN * dt);
    }

    // Genuinely stuck: asking the car to go and it is not going.
    //
    // Not "slow and off the racing line", which is what the readout used to
    // mean and which is mostly just driving on the verge. Wanting full throttle
    // and getting nowhere is a different thing, it is the only version of it a
    // player can act on, and it is rare — which is the point, because a warning
    // that fires while nothing is wrong teaches you to ignore the one that
    // matters.
    if (drive > 0.5 && speed < 2 && !this.airborne) this.stuckFor += dt;
    else this.stuckFor = 0;

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
    // The jolt: a critically damped spring back to level. Underdamped it wobbles
    // like a cartoon, overdamped it may as well not be there, so it is set at
    // the point where the body returns in one motion.
    const w = JOLT_FREQ;
    this.joltPitchVel += (-w * w * this.joltPitch - 2 * w * this.joltPitchVel) * dt;
    this.joltPitch += this.joltPitchVel * dt;
    this.joltRollVel += (-w * w * this.joltRoll - 2 * w * this.joltRollVel) * dt;
    this.joltRoll += this.joltRollVel * dt;
    this.bodyPitch += this.joltPitch;
    this.roll += this.joltRoll;

    this.pitch = this.terrainPitch + this.bodyPitch;

    return this;
  }

  /**
   * Remember where the car was, so the frame can be drawn between two steps.
   *
   * The simulation runs at a fixed 60 Hz and the screen does not, and the two
   * cannot be made to line up — requestAnimationFrame jitters, panels run at
   * 144, and the accumulator drifts across the step boundary either way. Drawn
   * at the last simulated pose regardless, a car at two hundred an hour repeats
   * one frame's position and then covers ninety centimetres in the next, which
   * is exactly what "the car teleports when I go fast" is. It is not a frame
   * rate problem: the loop has computed the fraction of a step it is ahead by
   * since the day it was written, and passed it to a renderer that threw it
   * away.
   *
   * Taken before the step rather than after, and before collisions rather than
   * after them, so the pair spans exactly one simulated instant.
   */
  savePose() {
    this.px = this.x;
    this.py = this.y;
    this.pz = this.z;
    this.pyaw = this.yaw;
    this.ppitch = this.pitch;
    this.pbodyPitch = this.bodyPitch;
    this.pterrainPitch = this.terrainPitch;
    this.proll = this.roll;
    return this;
  }

  /** Boost for `duration` seconds, adding `power` (fraction of max speed). */
  applyBoost(power, duration) {
    // Boosts refresh rather than stack, but a stronger one always wins.
    this.boostPower = Math.max(this.boostPower, power);
    this.boostTimer = Math.max(this.boostTimer, duration);
  }

  /**
   * A hit that landed somewhere, rather than everywhere.
   *
   * `applyImpulse` pushes the car's centre, which is right for a blast wave and
   * wrong for every collision: hitting a rival's rear quarter and hitting them
   * square in the back are the same event to it, and neither turns anybody. A
   * real contact acts at a point, and the further that point sits from the
   * centre of mass the more of the blow becomes rotation instead of shove.
   * That is the difference between being nudged and being put into a spin, and
   * it is most of what "it does not feel like a crash" was about.
   *
   * @param ix,iz         impulse in world space, newton-seconds
   * @param leverX,leverZ contact point relative to the centre of mass
   * @param yawInertia    the car's resistance to being spun, kg·m²
   */
  applyContactImpulse(ix, iz, leverX, leverZ, yawInertia) {
    const m = Math.max(1, this.p.mass);
    this.vx += ix / m;
    this.vz += iz / m;

    // The 2D cross product of the lever and the impulse is the angular one —
    // but only what the tyres cannot hold ever reaches the car.
    //
    // Rigid-body torque on its own says every contact rotates you, which is
    // true of a car on ice and of nothing else. Four loaded contact patches
    // generate a restoring moment, and under that threshold a hit is absorbed:
    // you can lean on somebody door to door and stay pointed where you were
    // going. Past it the rear steps out and you are a passenger. That threshold
    // is the whole difference between a PIT manoeuvre and a game where touching
    // anything ends your race — clipping a rival's rear quarter has to spin
    // *them* while your own nose-on contact stays under your tyres' hold.
    const torque = leverX * iz - leverZ * ix;
    const raw = torque / Math.max(1, yawInertia);
    const planted = this.airborne ? 0 : 1;
    // Which end of the car took it decides how much it can hold, and this is
    // the whole of why a PIT manoeuvre is a manoeuvre rather than a mutual
    // accident.
    //
    // The rigid-body torque is the same for both cars: a lateral shove between
    // two parallel cars offset along their length rotates each of them by the
    // same amount, in the same direction. Which is true, and is not what
    // happens, because the tyres are not the same at both ends. A side force
    // landing behind the centre of mass levers the rear out, and the rear has
    // no steering to catch it with. The same force ahead of the centre of mass
    // pushes the front, and the rear — still planted — holds the car straight.
    // So you clip their rear quarter, they come round, and you drive on.
    const alongCar = leverX * this.forwardX + leverZ * this.forwardZ;
    const end = alongCar < 0 ? REAR_YAW_HOLD : FRONT_YAW_HOLD;
    const hold = TYRE_YAW_HOLD * end * planted * this.gripPenalty;
    const excess = Math.max(0, Math.abs(raw) - hold);
    if (excess > 0) {
      this.impactSpin = clamp(this.impactSpin + Math.sign(raw) * excess,
        -MAX_IMPACT_SPIN, MAX_IMPACT_SPIN);
      // Breaking a tyre loose is what let the car rotate, so it is loose now.
      this.gripPenalty = Math.min(this.gripPenalty, 0.7);
      this.gripPenaltyTimer = Math.max(this.gripPenaltyTimer, 0.4);
    }

    this.jolt(ix / m, iz / m);
    return this;
  }

  /**
   * Throw the body about, without moving the car.
   *
   * Separate from the impulse because plenty of things hit a car without
   * changing where it is going very much — clipping a barrier, glancing off a
   * barrel — and the shudder is most of what tells you it happened. The blow is
   * resolved into the car's own frame, so being rear-ended pitches it and being
   * hit in the flank rolls it, rather than every contact producing the same
   * generic shake.
   *
   * @param dvx,dvz  the velocity the hit would have imparted, world space
   */
  jolt(dvx, dvz) {
    const fx = this.forwardX;
    const fz = this.forwardZ;
    const along = dvx * fx + dvz * fz;
    const across = dvx * -fz + dvz * fx;
    this.joltPitchVel += clamp(along * 0.05, -1.6, 1.6);
    this.joltRollVel += clamp(-across * 0.05, -1.6, 1.6);
    return this;
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
