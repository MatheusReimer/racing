import { clamp } from './math.js';

// Fixed-timestep simulation, frame-paced rendering, and an explicit CPU budget.
//
// Three separate concerns get conflated in most browser game loops, so they are
// pulled apart here:
//
//   1. Simulation rate  — fixed 60 Hz. The vehicle model uses exponential grip
//      decay and impulse collisions, both unconditionally stable, so 60 Hz is
//      enough. Handling no longer changes with the display refresh rate.
//
//   2. Presentation rate — capped (default 60 fps). A raw requestAnimationFrame
//      loop runs at the panel's refresh rate; on a 144 Hz monitor that is 2.4x
//      the work for frames the simulation cannot distinguish. Early callbacks
//      return immediately, before any time bookkeeping, so skipped frames cost
//      one comparison.
//
//   3. CPU utilisation — measured, not assumed. `utilisation` is the fraction
//      of each frame interval actually spent doing work. The governor steers it
//      toward TARGET_UTILISATION by moving the quality tier, which is what
//      keeps a headroom margin instead of pegging a core.

export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;

// Catch-up limit. This is a real trade: too low and a slow frame silently
// makes the game run in slow motion, which for a driving game reads as the
// controls having died; too high and a slow frame does even more work and
// spirals. 8 steps covers 133 ms of simulation, and the presentation cap below
// drops to 30 fps when we cannot hold 60, which widens each frame's budget so
// this ceiling is reached far less often.
const MAX_STEPS_PER_FRAME = 8;

// Sustained pacing this far past the target means we are not holding the frame
// rate at all, whatever the CPU-side work timer says.
const PACING_BAIL = 1.5;

// Leave roughly 15% of every frame interval unused. The request was 80-90%;
// aiming at the middle gives the governor room to settle without oscillating.
export const TARGET_UTILISATION = 0.85;

const dtSeconds = (wall) => wall;

export class Loop {
  constructor({ update, render, onStats, governor = null }) {
    this.update = update;
    this.render = render;
    this.onStats = onStats;
    this.governor = governor;

    this.running = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.frame = 0;
    this.elapsed = 0;

    /** Global time scale. Slow-mo on a big hit, 0 while paused. */
    this.timeScale = 1;

    /**
     * Presentation cap. Menus and map screens drop this to 30 — they are a
     * static gradient and some DOM, and a run spends real time sitting in them.
     */
    this.maxFps = 60;

    /**
     * Fraction of the frame interval spent *in our own code*, smoothed.
     *
     * This is not the whole cost. GL commands are submitted here but rasterised
     * and presented after `render()` returns, so on a GPU-bound machine this
     * number can read a comfortable 45% while frames actually arrive 110 ms
     * apart. It must never be the only signal.
     */
    this.utilisation = 0;

    /**
     * Real interval between presented frames, over the interval we asked for.
     * 1.0 means we are hitting the target; 6.0 means frames are arriving six
     * times too slowly. This catches everything `utilisation` cannot see.
     */
    this.pacing = 1;

    /**
     * Simulated seconds per real second. Below 1 the game is in slow motion —
     * every input still works, just slower, which is indistinguishable from
     * broken controls.
     */
    this.realtimeRatio = 1;

    /** Set when the presentation cap was lowered to recover real time. */
    this.pacingRelief = false;

    this._nextRenderAt = 0;
    this._raf = 0;
    this._tick = (now) => this._step(now);

    // Rolling frame-time window for the perf overlay and the profiler tool.
    this._samples = new Float32Array(120);
    this._sampleCount = 0;
    this._sampleIndex = 0;
    this._statTimer = 0;
    this._workEma = 0;
    this._intervalEma = 0;
    this._ratioEma = 1;
    this._behindFor = 0;
    this._aheadFor = 0;
    this._lastFrameAt = 0;
    this._baseMaxFps = 60;

    this._onVisibility = () => {
      // A hidden tab still gets throttled rAF callbacks in some browsers, and
      // an audio-driven game keeps synthesising. Stop outright instead.
      if (typeof document === 'undefined') return;
      if (document.hidden) this.pause();
      else this.resume();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this._nextRenderAt = this.lastTime;
    this.accumulator = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /** Suspend without losing state. Time does not accumulate while paused. */
  pause() {
    if (!this.running) return;
    this._wasRunning = true;
    this.stop();
  }

  resume() {
    if (this.running || !this._wasRunning) return;
    this._wasRunning = false;
    this.start();
  }

  /**
   * Presentation rate for the current context. Racing wants every frame it can
   * afford; a menu does not.
   */
  setMode(mode) {
    this._baseMaxFps = mode === 'race' ? 60 : mode === 'menu' ? 30 : 15;
    this.maxFps = this._baseMaxFps;
    this.pacingRelief = false;
    this._behindFor = 0;
    this._aheadFor = 0;
  }

  _step(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    // --- Frame pacing -------------------------------------------------------
    // Bail before touching any clocks: a skipped frame must not consume the
    // wall time it spanned, or the simulation would lose it.
    const interval = this.maxFps > 0 ? 1000 / this.maxFps : 0;
    if (interval > 0) {
      // 0.7 ms of slack absorbs rAF jitter, so a 60 fps cap on a 60 Hz panel
      // does not systematically drop every other frame.
      if (now + 0.7 < this._nextRenderAt) return;
      this._nextRenderAt += interval;
      // Resync after a hitch rather than trying to claw back missed frames.
      if (this._nextRenderAt < now) this._nextRenderAt = now + interval;
    }

    const workStart = now;

    let wall = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // A background tab, a GC pause, or a breakpoint must not teleport the car.
    if (wall > 0.25) wall = 0.25;

    // --- Simulation ---------------------------------------------------------
    this.accumulator += wall * this.timeScale;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.update(FIXED_DT);
      this.accumulator -= FIXED_DT;
      this.elapsed += FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    // --- Presentation -------------------------------------------------------
    // Fraction of a physics step we are ahead of the last simulated state, so
    // visuals can interpolate instead of stuttering at non-multiple refresh.
    const alpha = this.accumulator / FIXED_DT;
    this.render(wall, alpha);
    this.frame++;

    // --- Measurement --------------------------------------------------------
    const workMs = performance.now() - workStart;
    this._samples[this._sampleIndex] = workMs;
    this._sampleIndex = (this._sampleIndex + 1) % this._samples.length;
    if (this._sampleCount < this._samples.length) this._sampleCount++;

    // Utilisation is work against the interval we intend to hold, not against
    // the time that happened to elapse — otherwise a slow frame would flatter
    // itself by widening its own denominator.
    const budgetMs = interval > 0 ? interval : 16.667;
    this._workEma = this._workEma === 0 ? workMs : this._workEma + (workMs - this._workEma) * 0.1;
    this.utilisation = clamp(this._workEma / budgetMs, 0, 4);

    // Pacing: the gap between frames that were actually presented. This is the
    // signal that sees GPU and compositor cost, which `utilisation` is blind to.
    const intervalMs = this._lastFrameAt ? now - this._lastFrameAt : budgetMs;
    this._lastFrameAt = now;
    this._intervalEma = this._intervalEma === 0
      ? intervalMs
      : this._intervalEma + (intervalMs - this._intervalEma) * 0.1;
    this.pacing = clamp(this._intervalEma / budgetMs, 0, 12);

    // Simulated versus real time. Anything under 1 is slow motion.
    const simulated = steps * FIXED_DT;
    const ratio = wall > 1e-6 ? clamp(simulated / (wall * this.timeScale || wall), 0, 1.5) : 1;
    this._ratioEma += (ratio - this._ratioEma) * 0.08;
    this.realtimeRatio = this._ratioEma;

    // If we cannot hold the target rate, halve the presentation cap rather than
    // letting the simulation fall behind. A wider frame budget lets the same
    // catch-up ceiling cover far more time: at a 30 fps target, 8 steps span
    // 133 ms against a 33 ms budget, which is ample.
    this._paceRelief(dtSeconds(wall));

    if (this.governor) {
      this.governor.sample({
        utilisation: this.utilisation,
        pacing: this.pacing,
        realtimeRatio: this.realtimeRatio,
      }, wall);
    }

    this._statTimer += wall;
    if (this._statTimer >= 0.5 && this.onStats) {
      this._statTimer = 0;
      this.onStats(this.stats());
    }
  }

  /**
   * Trade frame rate for real time.
   *
   * Running the simulation slower than the wall clock is the worst failure mode
   * a driving game has: every control still works, at a fraction of the rate,
   * and the player reports that the car stopped responding. Halving the
   * presentation cap is strictly better — the game looks choppier but stays in
   * real time and stays controllable.
   */
  _paceRelief(dt) {
    const behind = this.pacing > PACING_BAIL || this.realtimeRatio < 0.9;
    if (behind) {
      this._behindFor += dt;
      this._aheadFor = 0;
    } else {
      this._aheadFor += dt;
      this._behindFor = 0;
    }

    if (!this.pacingRelief && this._behindFor > 0.75 && this._baseMaxFps > 20) {
      this.pacingRelief = true;
      this.maxFps = Math.max(20, Math.round(this._baseMaxFps / 2));
      this._behindFor = 0;
      this._intervalEma = 0;
    } else if (this.pacingRelief && this._aheadFor > 4) {
      this.pacingRelief = false;
      this.maxFps = this._baseMaxFps;
      this._aheadFor = 0;
      this._intervalEma = 0;
    }
  }

  /** Frame-time distribution over the last ~120 rendered frames. */
  stats() {
    if (this._sampleCount === 0) {
      return { fps: 0, p50: 0, p99: 0, worst: 0, utilisation: 0, pacing: 1, realtimeRatio: 1, pacingRelief: false };
    }
    const arr = Array.from(this._samples.slice(0, this._sampleCount)).sort((a, b) => a - b);
    const at = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    const p50 = at(0.5);
    return {
      // Reported fps is what we actually present, which the cap bounds.
      fps: Math.min(this.maxFps || Infinity, p50 > 0 ? 1000 / p50 : 0),
      p50,
      p99: at(0.99),
      worst: arr[arr.length - 1],
      utilisation: this.utilisation,
      pacing: this.pacing,
      realtimeRatio: this.realtimeRatio,
      pacingRelief: this.pacingRelief,
    };
  }

  dispose() {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
  }
}
