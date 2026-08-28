import { clamp, clamp01, lerp } from '../core/math.js';

// All audio, synthesised at runtime. There are no sound files in this project.
//
// The engine is the hard part and the one that matters most, because it is the
// only continuous feedback the player has about speed while their eyes are on
// the corner. It is built as a small additive stack — a fundamental plus two
// harmonics plus filtered noise — whose pitch and filter track the same
// `forwardSpeed` the physics uses, with a synthetic gearbox layered on top so
// acceleration has shape instead of being one long glide.
//
// Everything is routed through a master compressor: an explosion during a
// heavy drift would otherwise clip hard, and a limiter is cheaper than
// carefully budgeting the gain of every effect.

const GEARS = [0.0, 0.14, 0.30, 0.48, 0.68, 0.86, 1.0];

export class Audio {
  constructor(events) {
    this.events = events;
    this.ctx = null;
    this.enabled = true;
    this.masterVolume = 0.55;
    this.started = false;
    this.unsubscribe = [];

    // The browser will not allow audio until the user has interacted, so
    // creation is deferred to the first gesture rather than attempted at boot
    // and failing silently.
    this._resume = () => this.start();
    window.addEventListener('pointerdown', this._resume, { once: true });
    window.addEventListener('keydown', this._resume, { once: true });
  }

  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.started = true;

    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // A reusable noise buffer. Generating white noise per effect is a
    // surprisingly large allocation cost during an explosion.
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this._buildEngine();
    this._bind();
  }

  _bind() {
    const on = (t, fn) => this.unsubscribe.push(this.events.on(t, fn));
    on('audio:impact', (e) => this.impact(e.strength, e.isPlayer));
    on('fx:explosion', (e) => this.explosion(e.power ?? 1, e.tags));
    on('fx:shockwave', () => this.zap(0.7));
    on('race:skill', (e) => this.skill(e.skill));
    on('race:wreck', () => this.explosion(1.4));
    on('race:start', () => this.startLights());
  }

  // --- engine --------------------------------------------------------------

  _buildEngine() {
    const ctx = this.ctx;
    this.engine = {};

    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    this.engine.bus = bus;

    // Body filter: shapes the whole engine, opening up with load.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 700;
    body.Q.value = 1.4;
    body.connect(bus);
    this.engine.body = body;

    // Additive stack. The fundamental carries the pitch; the harmonics are
    // what make it read as an engine rather than a synth tone.
    this.engine.oscs = [];
    for (const [type, mult, gain] of [
      ['sawtooth', 1.0, 0.34],
      ['square', 2.0, 0.15],
      ['sawtooth', 0.5, 0.22],
      ['triangle', 3.0, 0.07],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 60 * mult;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(body);
      o.start();
      this.engine.oscs.push({ o, g, mult });
    }

    // Induction / exhaust noise.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 500;
    nf.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = 0.10;
    noise.connect(nf); nf.connect(ng); ng.connect(bus);
    noise.start();
    this.engine.noise = { src: noise, filter: nf, gain: ng };

    // Tyre scrub, driven by slip angle.
    const skid = ctx.createBufferSource();
    skid.buffer = this.noiseBuffer;
    skid.loop = true;
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 2400;
    sf.Q.value = 3.5;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    skid.connect(sf); sf.connect(sg); sg.connect(this.master);
    skid.start();
    this.engine.skid = { src: skid, filter: sf, gain: sg };

    // Wind, driven by raw speed.
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'highpass';
    wf.frequency.value = 900;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    wind.connect(wf); wf.connect(wg); wg.connect(this.master);
    wind.start();
    this.engine.wind = { src: wind, filter: wf, gain: wg };
  }

  /**
   * Drive the engine from the player's car. Called every rendered frame.
   * @param body    VehicleBody
   * @param opts    { throttle, heatPct }
   */
  updateEngine(body, opts = {}) {
    if (!this.started || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const e = this.engine;

    const frac = clamp01(Math.abs(body.forwardSpeed) / Math.max(1, body.p.maxSpeed));

    // Synthetic gearbox: find which band we are in and map to an RPM that
    // resets each shift. Without this the pitch is one long glide and the car
    // has no sense of working for its speed.
    let gear = 0;
    while (gear < GEARS.length - 2 && frac > GEARS[gear + 1]) gear++;
    const lo = GEARS[gear];
    const hi = GEARS[gear + 1] ?? 1;
    const within = hi > lo ? (frac - lo) / (hi - lo) : 0;
    const rpm = 0.28 + clamp01(within) * 0.72;

    const throttle = opts.throttle ?? 0;
    const fundamental = 48 + rpm * 128 + (body.boostTimer > 0 ? 22 : 0);

    for (const { o, mult } of e.oscs) {
      o.frequency.setTargetAtTime(fundamental * mult, t, 0.035);
    }

    // Load opens the filter — the difference between coasting and pulling.
    const openness = 520 + rpm * 1500 + throttle * 900 + frac * 500;
    e.body.frequency.setTargetAtTime(openness, t, 0.05);

    const level = 0.10 + throttle * 0.16 + frac * 0.12;
    e.bus.gain.setTargetAtTime(this.enabled ? level : 0, t, 0.06);

    e.noise.filter.frequency.setTargetAtTime(320 + rpm * 900, t, 0.06);
    e.noise.gain.gain.setTargetAtTime(0.05 + throttle * 0.09, t, 0.06);

    // Skid: slip angle above the audible threshold, scaled by speed.
    const slip = Math.abs(body.slipAngle);
    const skidLevel = clamp01((slip - 0.12) * 2.2) * clamp01(body.speed / 18) * 0.20;
    e.skid.gain.gain.setTargetAtTime(skidLevel, t, 0.05);
    e.skid.filter.frequency.setTargetAtTime(1800 + slip * 2400, t, 0.08);

    e.wind.gain.gain.setTargetAtTime(frac * frac * 0.09, t, 0.1);
    e.wind.filter.frequency.setTargetAtTime(700 + frac * 2200, t, 0.1);
  }

  silenceEngine() {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.engine.bus.gain.setTargetAtTime(0, t, 0.08);
    this.engine.skid.gain.gain.setTargetAtTime(0, t, 0.08);
    this.engine.wind.gain.gain.setTargetAtTime(0, t, 0.08);
  }

  // --- one-shots -----------------------------------------------------------

  _noise(duration, { type = 'lowpass', freq = 800, q = 1, gain = 0.3, sweepTo = null }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo != null) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + duration);
    f.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  _tone(freq, duration, { type = 'sine', gain = 0.2, sweepTo = null, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g); g.connect(this.master);
    o.start(t);
    o.stop(t + duration + 0.05);
  }

  impact(strength, isPlayer = false) {
    if (!this.started || !this.enabled) return;
    const s = clamp(strength / 20, 0.15, 1.4);
    const vol = (isPlayer ? 0.42 : 0.2) * s;
    // Body panel: a broadband crunch with a downward filter sweep.
    this._noise(0.16 + s * 0.14, {
      type: 'lowpass', freq: 2600 * s, sweepTo: 180, gain: vol, q: 0.8,
    });
    // The thud underneath it.
    this._tone(90 * (0.8 + s * 0.4), 0.22, { type: 'sine', gain: vol * 0.9, sweepTo: 40 });
  }

  explosion(power = 1, tags = []) {
    if (!this.started || !this.enabled) return;
    const p = clamp(power, 0.3, 2.5);
    if (tags?.includes('Electric')) { this.zap(p); return; }
    this._noise(0.5 * p, { type: 'lowpass', freq: 1800, sweepTo: 90, gain: 0.35 * p, q: 1.2 });
    this._tone(70, 0.45 * p, { type: 'sine', gain: 0.34 * p, sweepTo: 28 });
    this._noise(0.9 * p, { type: 'bandpass', freq: 320, q: 0.6, gain: 0.14 * p });
  }

  zap(power = 1) {
    if (!this.started || !this.enabled) return;
    this._noise(0.22 * power, { type: 'bandpass', freq: 3400, q: 6, gain: 0.24 * power, sweepTo: 900 });
    this._tone(1400, 0.16, { type: 'square', gain: 0.10 * power, sweepTo: 260 });
  }

  skill(skill) {
    if (!this.started || !this.enabled) return;
    const tags = skill.tags || [];
    if (tags.includes('Electric')) this.zap(0.8);
    else if (tags.includes('Speed')) {
      // Boost: a rising sweep, which is the clearest "you are now faster" cue.
      this._tone(220, 0.42, { type: 'sawtooth', gain: 0.16, sweepTo: 900 });
      this._noise(0.4, { type: 'highpass', freq: 400, sweepTo: 3200, gain: 0.12 });
    } else if (tags.includes('Defense')) {
      this._tone(420, 0.34, { type: 'sine', gain: 0.16, sweepTo: 700 });
    } else if (tags.includes('Ice')) {
      this._noise(0.3, { type: 'highpass', freq: 2400, gain: 0.16, sweepTo: 5200 });
    } else {
      this._noise(0.14, { type: 'bandpass', freq: 900, q: 2, gain: 0.16 });
      this._tone(160, 0.16, { type: 'square', gain: 0.10, sweepTo: 90 });
    }
  }

  startLights() {
    if (!this.started || !this.enabled) return;
    this._tone(880, 0.35, { type: 'square', gain: 0.16 });
  }

  countdownBeep(final = false) {
    if (!this.started || !this.enabled) return;
    this._tone(final ? 880 : 440, final ? 0.4 : 0.14, { type: 'square', gain: 0.14 });
  }

  ui(kind = 'click') {
    if (!this.started || !this.enabled) return;
    if (kind === 'click') this._tone(620, 0.05, { type: 'triangle', gain: 0.07 });
    else if (kind === 'confirm') this._tone(760, 0.14, { type: 'triangle', gain: 0.10, sweepTo: 1100 });
    else if (kind === 'deny') this._tone(180, 0.16, { type: 'square', gain: 0.09, sweepTo: 110 });
  }

  setVolume(v) {
    this.masterVolume = clamp01(v);
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.silenceEngine();
  }

  dispose() {
    for (const off of this.unsubscribe) off();
    window.removeEventListener('pointerdown', this._resume);
    window.removeEventListener('keydown', this._resume);
    if (this.ctx) this.ctx.close();
  }
}
