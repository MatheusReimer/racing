import { Loop } from './core/loop.js';
import { QualityGovernor } from './core/perf.js';
import { Input } from './core/input.js';
import { EventBus } from './core/events.js';
import { Renderer } from './render/renderer.js';
import { Race } from './race/race.js';
import { HUD } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { Run } from './run/run.js';
import { Build } from './build/build.js';
import { BIOMES } from './data/biomes.js';
import { randomSeedString } from './core/rng.js';
import { Audio } from './audio/audio.js';
import { Showroom } from './vehicle/showroom.js';

// Bootstrap and the top-level state machine.
//
// Three things live for the whole session — the renderer, the loop and the
// input — and everything else is swapped underneath them. Races, maps and
// shops come and go; the GL context and the frame pacing never restart, which
// is what makes transitions instant and keeps the quality governor's
// measurements continuous across them.
//
// The Run owns all game state. This class owns presentation and routing, and
// deliberately holds no rules of its own.

class Game {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.uiRoot = document.getElementById('ui');
    this.events = new EventBus();

    this.quality = new QualityGovernor({
      startTier: QualityGovernor.detectStartTier(),
      onChange: (settings, info) => this._onQualityChange(settings, info),
    });

    this.renderer = new Renderer(this.canvas, this.quality);
    this.input = new Input(window);
    this.hud = new HUD(this.uiRoot);
    this.screens = new Screens(this.uiRoot);
    this.hud.setQualityName(this.quality.name);
    this.hud.hide();
    this.audio = new Audio(this.events);

    this.run = null;
    this.scene = null;
    this.showroom = null;
    this.lastSummary = null;

    this.loop = new Loop({
      update: (dt) => this.update(dt),
      render: (dt, alpha) => this.render(dt, alpha),
      governor: this.quality,
      onStats: (s) => { this.lastStats = s; },
    });

    window.addEventListener('resize', () => {
      this.scene?.resize(window.innerWidth / Math.max(1, window.innerHeight));
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1') { e.preventDefault(); this.hud.showPerf = !this.hud.showPerf; }
      if (e.code === 'F2') { e.preventDefault(); this._cycleQuality(); }
    });

    this.events.on('race:over', (result) => this._onRaceOver(result));
  }

  // --- infrastructure ------------------------------------------------------

  _onQualityChange(settings, info) {
    this.renderer.applyQuality(settings);
    this.scene?.applyQuality(settings);
    this.hud.setQualityName(this.quality.name);
    console.info(`[quality] ${info.from} -> ${this.quality.name} (${info.reason})`);
  }

  _cycleQuality() {
    this.quality.lockTo((this.quality.tier + 1) % 4);
  }

  _disposeScene() {
    if (!this.scene) return;
    this.scene.dispose();
    this.scene = null;
  }

  /**
   * The showroom only draws while a screen is offering it a stage, so leaving
   * the title screen stops it without anything having to say so. The scene
   * itself is kept: rebuilding a chassis costs more than the memory does, and
   * the player comes back here after every run.
   */
  _renderShowroom(dt) {
    const rect = this.screens.showroomRect();
    if (!rect || !this.showroom) {
      // The canvas is only ever painted inside the stage, so the last car drawn
      // would sit there under the next menu until something else wrote over it.
      if (this._showroomDrawn) { this.renderer.clear(); this._showroomDrawn = false; }
      return;
    }
    this._showroomDrawn = true;
    this.showroom.update(dt);
    const camera = this.showroom.render(rect.width / Math.max(1, rect.height));
    this.renderer.renderInset(this.showroom.scene, camera, rect);
  }

  // --- routing -------------------------------------------------------------

  showTitle() {
    this._disposeScene();
    this.hud.hide();
    this.loop.setMode('menu');
    this.input.enabled = false;
    this.showroom = this.showroom || new Showroom();
    this.screens.title({
      lastSummary: this.lastSummary,
      onStart: (vehicleId) => this.startRun(vehicleId),
      onPreview: (vehicleId) => this.showroom?.setVehicle(vehicleId),
    });
  }

  startRun(vehicleId) {
    this.quickMode = false;
    // `forcedSeed` lets the UI-flow harness pin the map so the set of screens it
    // visits — and therefore the set of checks it runs — is the same every time.
    this.run = new Run({ seed: this.forcedSeed || randomSeedString(), vehicleId });
    this.showMap();
  }

  showMap() {
    this._disposeScene();
    this.hud.hide();
    this.loop.setMode('menu');
    this.input.enabled = false;
    this.screens.map(this.run, {
      onChoose: (node) => this.enterNode(node),
    });
  }

  enterNode(node) {
    const cfg = this.run.choose(node);
    switch (this.run.state) {
      case 'race':
        this.screens.briefing(this.run, cfg, { onGo: () => this.startRace(cfg) });
        break;
      case 'shop':
        this.showShop();
        break;
      case 'event':
        this.showEvent();
        break;
      case 'rest':
        this.showRest();
        break;
      default:
        this.showMap();
    }
  }

  showShop() {
    this.screens.shop(this.run, {
      onBuy: (item) => {
        const res = this.run.buy(item);
        this.screens.toast(res.ok ? res.text : res.reason);
        if (res.ok) this.showShop();
      },
      onLeave: () => { this.run.leaveShop(); this.showMap(); },
    });
  }

  showEvent() {
    this.screens.event(this.run, {
      onChoose: (i) => {
        const res = this.run.resolveEvent(i);
        if (res.text) this.screens.toast(res.text);
        if (res.dead) this.endRun();
        else this.showMap();
      },
    });
  }

  showRest() {
    this.screens.rest(this.run, {
      onRepair: () => {
        const r = this.run.restRepair();
        this.screens.toast(r.text);
        this.showMap();
      },
      onUpgrade: (id) => {
        const r = this.run.restUpgrade(id);
        this.screens.toast(r.ok ? r.text : r.reason);
        this.showMap();
      },
    });
  }

  // --- racing --------------------------------------------------------------

  startRace(cfg) {
    this._disposeScene();
    this.screens.clear();

    this.scene = new Race({
      seed: cfg.seed,
      biome: cfg.biome,
      playerBuild: this.run.build,
      quality: this.quality,
      events: this.events,
      config: {
        laps: cfg.laps,
        rivals: cfg.rivals,
        difficulty: cfg.difficulty,
        rivalArchetypes: cfg.rivalArchetypes,
        lengthScale: cfg.lengthScale,
        nodeType: cfg.nodeType,
      },
    });

    // The car arrives in the condition the run left it in. This is the whole
    // point of the mode, so it is applied here explicitly rather than being
    // inferred from the build.
    this.scene.player.maxDurability = this.run.maxDurability;
    this.scene.player.durability = this.run.durability;

    // Race modifiers apply to the entire field.
    this.activeModifiers = cfg.modifiers || [];
    for (const m of this.activeModifiers) m.apply?.(this.scene);

    this.hud.setSkills(this.run.build.skills);
    this.hud.setLapTotal(cfg.laps);
    this.hud.show();
    this.loop.setMode('race');
    this.input.enabled = true;

    this.scene.resize(window.innerWidth / Math.max(1, window.innerHeight));
    this.scene.camera.reset(this.scene.player.body);
  }

  _onRaceOver(result) {
    this.input.enabled = false;

    // A sandbox race is not a run node: it must not award scrap, advance the
    // map, or push the player into a reward screen they never earned.
    if (this.quickMode) {
      console.info('[quickRace] over:', result);
      return;
    }

    const racer = this.scene.player;
    const outcome = this.run.finishRace(result, racer);

    // Let the finish read before the screen changes.
    setTimeout(() => {
      if (outcome.dead) { this.endRun(); return; }
      this.hud.hide();
      this.loop.setMode('menu');
      this.showReward(outcome);
    }, 1400);
  }

  showReward(outcome) {
    this.screens.reward(this.run, outcome, {
      onTake: (offer) => {
        const res = this.run.takeOffer(offer);
        if (!res.ok) { this.screens.toast(res.reason); return; }
        this.screens.toast(res.text);
        this.afterReward();
      },
      onSkip: () => {
        const res = this.run.skipOffer();
        this.screens.toast(res.text);
        this.afterReward();
      },
      onReroll: () => {
        if (this.run.reroll()) this.showReward(outcome);
      },
    });
  }

  afterReward() {
    if (this.run.state === 'victory') this.endRun();
    else this.showMap();
  }

  endRun() {
    this._disposeScene();
    this.hud.hide();
    this.loop.setMode('menu');
    this.lastSummary = this.run.summary();
    this.screens.gameOver(this.lastSummary, { onRestart: () => this.showTitle() });
  }

  // --- frame ---------------------------------------------------------------

  update(dt) {
    const state = this.input.update(dt);
    if (this.scene) {
      this.scene.update(dt, state);
      for (const m of this.activeModifiers || []) m.onTick?.(this.scene, dt);
    }
    this.input.endFrame();
  }

  render(dt, alpha) {
    if (!this.scene) {
      this.audio.silenceEngine();
      this._renderShowroom(dt);
      return;
    }
    const camera = this.scene.render(dt, alpha);
    this.renderer.render(this.scene.scene, camera, this.scene.postFx());
    this.hud.update(this.scene, this.lastStats);

    // Engine audio follows the player's car, not the clock.
    const p = this.scene.player;
    if (this.scene.state === 'racing') {
      this.audio.updateEngine(p.body, { throttle: p.input.throttle, heatPct: p.heat });
    } else {
      this.audio.silenceEngine();
    }

    // Countdown beeps, once per whole second.
    if (this.scene.state === 'countdown') {
      const c = Math.ceil(this.scene.countdown);
      if (c !== this._lastBeep) {
        this._lastBeep = c;
        if (c > 0) this.audio.countdownBeep(false);
      }
    } else if (this._lastBeep !== null && this._lastBeep !== undefined) {
      this._lastBeep = null;
    }
  }

  start() {
    this.loop.start();
    this.showTitle();
  }

  /** Straight into a race, for the capture and playtest harnesses. */
  quickRace(opts = {}) {
    this.quickMode = true;
    this.run = new Run({ seed: opts.seed || randomSeedString(), vehicleId: opts.vehicleId || 'coupe' });
    if (opts.build) this.run.build = opts.build;
    const cfg = {
      seed: opts.seed || 'QUICK',
      biome: opts.biome || BIOMES[0],
      laps: opts.laps ?? 3,
      rivals: opts.rivals ?? 5,
      difficulty: opts.difficulty ?? 1,
      modifiers: [],
    };
    this.startRace(cfg);
    if (opts.autopilot) this.scene.setAutopilot(true, cfg.difficulty);
    return this.scene;
  }
}

const game = new Game();
game.start();

// Exposed for the headless capture and playtest tools.
window.__game = game;
