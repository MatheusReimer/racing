import { clamp } from './math.js';
import { TARGET_UTILISATION } from './loop.js';

// Closed-loop quality control.
//
// The Loop measures what fraction of each frame interval is actually spent
// working. This module is the actuator: it moves a discrete quality tier so
// that measurement settles near the target, leaving deliberate headroom rather
// than consuming whatever the machine has.
//
// Asymmetry is intentional. Dropping quality is fast (a stuttering race is
// felt immediately); raising it is slow and requires a long clean stretch, so
// the tier does not hunt up and down across a corner with heavy particle load.

/**
 * Tier 0 is the floor that must hold on integrated graphics; tier 3 is what a
 * discrete GPU gets. `pixelRatio` is a multiplier on top of the device ratio,
 * which is separately capped — retina at native resolution is 4x the fill cost
 * for a stylised look that does not need it.
 */
export const QUALITY_TIERS = [
  {
    name: 'Low',
    pixelRatio: 0.70,
    maxPixelRatio: 1.0,
    // One pass, not none.
    //
    // Turning bloom off outright makes a tier change visible as the lighting
    // changing rather than as detail thinning — the glow on every lamp, trim
    // strip and explosion simply leaves, and the governor picks its moment by
    // load, which is the instant a race starts. One quarter-res blur is close
    // to free next to that, and it means dropping to Low looks like Low rather
    // than like a different game.
    bloom: true,
    bloomPasses: 1,
    // Nine taps a pixel, and this is the tier for machines that cannot hold
    // the rate. The render scale is lowest here anyway, so the upscale is
    // already doing some of the job.
    fxaa: false,
    shadows: false,
    shadowMapSize: 0,
    particleBudget: 260,
    tireMarkSegments: 220,
    drawDistance: 420,
    propDensity: 0.5,
    // How many lamps, signs and lit frontages get a pool of light on the road
    // under them. Pure fill rate: the quads are large and overlap, so this is
    // the night district's equivalent of the terrain's vertex count.
    lightPools: 110,
    // How finely the ground away from the road is tessellated. The terrain
    // covers the whole screen, so its vertex count moves the frame time more
    // than anything else the tier controls.
    terrainDetail: 0.4,
    anisotropy: 1,
  },
  {
    name: 'Medium',
    pixelRatio: 0.85,
    maxPixelRatio: 1.25,
    bloom: true,
    bloomPasses: 2,
    fxaa: true,
    shadows: false,
    shadowMapSize: 0,
    particleBudget: 650,
    tireMarkSegments: 420,
    drawDistance: 600,
    propDensity: 0.75,
    lightPools: 180,
    // How finely the ground away from the road is tessellated. The terrain
    // covers the whole screen, so its vertex count moves the frame time more
    // than anything else the tier controls.
    terrainDetail: 0.7,
    anisotropy: 2,
  },
  {
    name: 'High',
    pixelRatio: 1.0,
    maxPixelRatio: 1.5,
    bloom: true,
    bloomPasses: 3,
    fxaa: true,
    shadows: true,
    shadowMapSize: 1024,
    particleBudget: 1300,
    tireMarkSegments: 700,
    drawDistance: 800,
    propDensity: 1.0,
    lightPools: 280,
    // How finely the ground away from the road is tessellated. The terrain
    // covers the whole screen, so its vertex count moves the frame time more
    // than anything else the tier controls.
    terrainDetail: 1.0,
    anisotropy: 4,
  },
  {
    name: 'Ultra',
    pixelRatio: 1.0,
    maxPixelRatio: 2.0,
    bloom: true,
    bloomPasses: 4,
    fxaa: true,
    shadows: true,
    shadowMapSize: 2048,
    particleBudget: 2400,
    tireMarkSegments: 1100,
    drawDistance: 1000,
    propDensity: 1.0,
    lightPools: 380,
    // How finely the ground away from the road is tessellated. The terrain
    // covers the whole screen, so its vertex count moves the frame time more
    // than anything else the tier controls.
    terrainDetail: 1.0,
    anisotropy: 8,
  },
];

// Above this, we are eating into the safety margin: shed work.
const DEGRADE_ABOVE = 0.92;
// Below this, there is enough slack that a tier up should still clear target.
const UPGRADE_BELOW = 0.62;

// Frames arriving this much later than asked for means we are not holding the
// rate at all. This is a separate signal because `utilisation` only times our
// own code: GL work is submitted and then rasterised and presented after the
// frame returns, so a GPU-bound machine can report a comfortable 45% while
// frames actually arrive six times too slowly. Watching only the CPU-side timer
// means the governor sits at Ultra while the game runs at 9 fps.
const PACING_DEGRADE = 1.30;
const PACING_OK = 1.10;

// Slow motion is never acceptable — every control still works, at a fraction of
// the rate, which reads as the car having stopped responding. Shed a tier
// immediately rather than waiting out the usual hysteresis.
const RATIO_EMERGENCY = 0.85;

const DEGRADE_AFTER = 1.0;  // seconds of sustained pressure before dropping
const UPGRADE_AFTER = 4.0;  // seconds of sustained slack before raising
const CHANGE_COOLDOWN = 1.5; // a tier change itself costs frames; let it settle

export class QualityGovernor {
  constructor({ startTier = 2, onChange = null, locked = false } = {}) {
    this.tier = clamp(startTier, 0, QUALITY_TIERS.length - 1);
    this.onChange = onChange;
    /** When the player picks a tier by hand, stop steering it. */
    this.locked = locked;

    this.target = TARGET_UTILISATION;
    this._overTimer = 0;
    this._underTimer = 0;
    this._cooldown = 0;
    this._changes = 0;
    this.utilisation = 0;
    this.pacing = 1;
    this.realtimeRatio = 1;
  }

  get settings() {
    return QUALITY_TIERS[this.tier];
  }

  get name() {
    return QUALITY_TIERS[this.tier].name;
  }

  /**
   * Called once per rendered frame by the Loop.
   * @param m  { utilisation, pacing, realtimeRatio }
   */
  sample(m, dt) {
    if (this.locked) return;

    // Accept the old single-number form so nothing calling this breaks.
    const utilisation = typeof m === 'number' ? m : m.utilisation;
    const pacing = typeof m === 'number' ? 1 : (m.pacing ?? 1);
    const ratio = typeof m === 'number' ? 1 : (m.realtimeRatio ?? 1);

    this.utilisation = utilisation;
    this.pacing = pacing;
    this.realtimeRatio = ratio;

    // Emergency: the simulation is losing time. Drop immediately — the usual
    // one-second hysteresis is an eternity when the car has stopped answering.
    if (ratio < RATIO_EMERGENCY && this.tier > 0) {
      this._set(this.tier - 1, 'slow motion');
      return;
    }

    if (this._cooldown > 0) {
      this._cooldown -= dt;
      // Discard measurements taken while the last change is still settling.
      this._overTimer = 0;
      this._underTimer = 0;
      return;
    }

    const pressured = utilisation > DEGRADE_ABOVE || pacing > PACING_DEGRADE;
    const slack = utilisation < UPGRADE_BELOW && pacing < PACING_OK;

    if (pressured) {
      this._overTimer += dt;
      this._underTimer = 0;
    } else if (slack) {
      this._underTimer += dt;
      this._overTimer = 0;
    } else {
      // In the target band. Bleed both timers so a brief excursion does not
      // accumulate toward a change across unrelated moments.
      this._overTimer = Math.max(0, this._overTimer - dt * 0.5);
      this._underTimer = Math.max(0, this._underTimer - dt * 0.5);
    }

    if (this._overTimer >= DEGRADE_AFTER && this.tier > 0) {
      this._set(this.tier - 1, pacing > PACING_DEGRADE ? 'frame pacing' : 'cpu pressure');
    } else if (this._underTimer >= UPGRADE_AFTER && this.tier < QUALITY_TIERS.length - 1) {
      this._set(this.tier + 1, 'slack');
    }
  }

  _set(tier, reason) {
    if (tier === this.tier) return;
    const from = QUALITY_TIERS[this.tier].name;
    this.tier = tier;
    this._overTimer = 0;
    this._underTimer = 0;
    this._cooldown = CHANGE_COOLDOWN;
    this._changes++;
    if (this.onChange) this.onChange(this.settings, { from, reason });
  }

  /** Player override from the options menu. Disables automatic steering. */
  lockTo(tier) {
    this.locked = true;
    this._set(clamp(tier, 0, QUALITY_TIERS.length - 1), 'manual');
  }

  unlock() {
    this.locked = false;
    this._cooldown = CHANGE_COOLDOWN;
  }

  /**
   * A cheap one-shot guess so the first seconds are not spent climbing from
   * the floor or thrashing down from Ultra. Refined by measurement either way.
   */
  static detectStartTier() {
    // Deliberately conservative. `hardwareConcurrency` describes the CPU, and
    // nothing here can see the GPU — which is what actually decides whether
    // Ultra is affordable. Starting high and discovering otherwise costs the
    // player seconds of an unresponsive car; starting at Medium costs a few
    // seconds of climbing, which nobody notices.
    if (typeof navigator === 'undefined') return 1;
    const cores = navigator.hardwareConcurrency || 4;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    let tier = 1;
    if (cores >= 8) tier = 2;
    // A high-DPR panel costs fill rate before anything has been drawn.
    if (dpr > 2) tier -= 1;
    return clamp(tier, 0, 3);
  }
}
