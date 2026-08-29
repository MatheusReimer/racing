import { Loop } from './core/loop.js';
import { QualityGovernor } from './core/perf.js';
import { Input } from './core/input.js';
import { EventBus } from './core/events.js';
import { Renderer } from './render/renderer.js';
import { Race } from './race/race.js';
import { HUD } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { VEHICLES } from './data/vehicles.js';
import { Profile } from './run/profile.js';
import { rollCrate } from './data/cosmetics.js';
import { RNG } from './core/rng.js';
import { Run } from './run/run.js';
import { Build } from './build/build.js';
import { BIOMES } from './data/biomes.js';
import { randomSeedString } from './core/rng.js';
import { Audio } from './audio/audio.js';
import { Showroom } from './vehicle/showroom.js';
import { loadHulls, HULLS } from './data/bodies/index.js';
import { warmHulls } from './vehicle/chassis.js';

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
    // What the player keeps between runs. Cosmetics only — see cosmetics.js
    // for why that boundary is the point rather than a limitation.
    this.profile = new Profile();
    this.hud.setQualityName(this.quality.name);
    this.hud.hide();
    this.audio = new Audio(this.events);

    this.run = null;
    this.scene = null;
    this.showroom = null;
    this.lastSummary = null;
    // The seed of the run that has not started yet. Held here rather than
    // rolled inside `startRun` so the title screen can show it and the player
    // can reject it — a seed you only learn after committing is a number, not
    // a choice.
    this.titleSeed = null;
    this.garageOpen = false;

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
    // A pit stop happens at speed with no screen in front of it, so the only
    // report the player gets is this line.
    this.events.on('pit:served', (stop) => {
      this.hud?.flash(stop.paid > 0 ? `${stop.text}  −${stop.paid}` : stop.text);
    });
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
      this._showroomShadow(false);
      return;
    }
    this._showroomDrawn = true;
    this._showroomShadow(true);
    this.showroom.update(dt);
    const camera = this.showroom.render(rect.width / Math.max(1, rect.height));
    this.renderer.renderInset(this.showroom.scene, camera, rect);
  }

  /**
   * Shadow maps, on for the turntable whatever the tier says.
   *
   * `shadows` is a quality decision about a race: a shadow camera spanning the
   * visible track, re-rendered every frame while forty cars and the scenery
   * move through it. The showroom is one car on a fourteen-metre frustum in a
   * menu paced at thirty, which the lowest tier this game targets can afford —
   * and the contact shadow under the car is most of what stops it looking
   * pasted onto the road.
   *
   * Toggled on the transition in and out, never per frame: `enabled` is part
   * of every material's compiled defines, so setting it inside the loop would
   * rebuild every program in the scene once a frame.
   */
  _showroomShadow(on) {
    const gl = this.renderer.gl;
    const want = on || !!this.quality.settings?.shadows;
    // Compared against the renderer's actual state, not against what this
    // asked for last time. The governor changes tier while the menu is up and
    // `applyQuality` writes this same flag from the tier — so a version that
    // remembered its own intent set it once, was overruled by the next
    // downgrade, and never noticed. Nothing is written while the two agree, so
    // this is still a transition and not a per-frame recompile.
    if (gl.shadowMap.enabled === want) return;
    gl.shadowMap.enabled = want;
    gl.shadowMap.needsUpdate = true;
  }

  // --- routing -------------------------------------------------------------

  showTitle() {
    this._disposeScene();
    this.hud.hide();
    this.loop.setMode('menu');
    this.input.enabled = false;
    // The finished run is done with. It used to stay live on the title screen
    // — nothing read it, but a stale run holding a build, a map and a durability
    // count is the sort of thing the next feature reads by accident.
    this.run = null;
    this.showroom = this.showroom || new Showroom(this.renderer.gl);
    this.showMachine(this.titleVehicleId || VEHICLES[0].id);
  }

  /**
   * The title screen, and the only view of a machine there is.
   *
   * The roster of cards it used to open on was six of these at thumbnail size:
   * the same information, too small to read and too small to see the car. The
   * arrows walk the same list, and there is nothing behind this screen.
   */
  showMachine(vehicleId) {
    this.titleVehicleId = vehicleId;
    this.hud.hide();
    this.loop.setMode('menu');
    this.input.enabled = false;
    this.showroom = this.showroom || new Showroom(this.renderer.gl);
    this.showroom.setVehicle(vehicleId, this.profile.look());
    // A crate owed is opened before anything else. It is the reward for the run
    // that just ended, and burying it behind a menu is the surest way to make
    // finishing a run feel like nothing happened.
    if (this.profile.crates > 0) { this.openCrate(vehicleId); return; }

    this.titleSeed = this.titleSeed || randomSeedString();

    this.screens.title({
      vehicleId,
      lastSummary: this.lastSummary,
      profile: this.profile,
      seed: this.titleSeed,
      runNumber: this.profile.runsStarted + 1,
      garageOpen: this.garageOpen,
      onStart: (id) => this.startRun(id),
      onSwitch: (id) => this.showMachine(id),
      onReseed: () => {
        this.titleSeed = randomSeedString();
        this.showMachine(vehicleId);
      },
      onGarage: (open) => {
        this.garageOpen = open;
        this.showMachine(vehicleId);
      },
      onEquip: (key) => {
        this.profile.equip(key);
        // Straight back to the same screen, so the car on the turntable is
        // wearing the thing that was just clicked.
        this.showMachine(vehicleId);
      },
    });
  }

  /** Open one owed crate, then come back for the next. */
  openCrate(vehicleId) {
    if (!this.profile.take()) { this.showMachine(vehicleId); return; }
    const seed = `crate:${this.profile.runsWon}:${this.profile.owned.size}`;
    const item = rollCrate(new RNG(seed), [...this.profile.owned]);
    if (!item) { this.showMachine(vehicleId); return; }
    this.profile.grant(item.key);
    // Worn immediately. A cosmetic you have to go and find in a locker to see
    // is a line in a list, not a reward.
    this.profile.equip(item.key);
    this.screens.crate(item, {
      remaining: this.profile.crates,
      onClose: () => this.showMachine(vehicleId),
    });
  }

  startRun(vehicleId) {
    this.quickMode = false;
    // `forcedSeed` lets the UI-flow harness pin the map so the set of screens it
    // visits — and therefore the set of checks it runs — is the same every time.
    const seed = this.forcedSeed || this.titleSeed || randomSeedString();
    // Spent. The next visit to the title screen rolls a fresh one, so coming
    // back after a wreck does not silently offer the run that just killed you.
    this.titleSeed = null;
    this.garageOpen = false;
    this.profile.startedRun();
    this.run = new Run({ seed, vehicleId });
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
        if (res.needsSlot) { this.showShopSwap(item); return; }
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
      // A refusal is not a decision. Both jobs can turn the player down now —
      // an upgrade they cannot afford — and leaving the garage anyway would
      // spend the node on nothing.
      onRepair: () => {
        const r = this.run.restRepair();
        this.screens.toast(r.ok ? r.text : r.reason);
        if (r.ok) this.showMap(); else this.showRest();
      },
      onUpgrade: (id, branchId) => {
        const r = this.run.restUpgrade(id, branchId);
        this.screens.toast(r.ok ? r.text : r.reason);
        if (r.ok) this.showMap(); else this.showRest();
      },
      onLeave: () => { this.run.leaveRest(); this.showMap(); },
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
      // The sky bakes itself into an environment map, which needs a GL context.
      renderer: this.renderer,
      look: this.profile.look(),
      config: {
        laps: cfg.laps,
        rivals: cfg.rivals,
        difficulty: cfg.difficulty,
        rivalArchetypes: cfg.rivalArchetypes,
        lengthScale: cfg.lengthScale,
        nodeType: cfg.nodeType,
        // The run's money, lent to the race so the pit lane can spend it.
        // Read back in `_onRaceOver`, whatever the finish.
        scrap: this.run.scrap,
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

    // Build every shader the scene will need, here, before the first frame.
    //
    // WebGL compiles a program the first time something is drawn with it, and
    // "the first time" for most of this scene is the moment the lights go out:
    // seventeen programs in one frame, which the profiler catches as a single
    // frame four hundred and forty-five milliseconds long, right when the
    // player has just been told to go. Doing it now moves that cost into the
    // load rather than into the start, and the load is already a pause.
    this.renderer.precompile(this.scene.scene, this.scene.camera?.camera ?? null);

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

    // Whatever the pits took. Before `finishRace`, which pays the purse — the
    // stop was made with the money the player had going in.
    this.run.spendInRace(this.scene.scrapSpent ?? 0);

    const outcome = this.run.finishRace(result, racer);

    // Let the finish read before the screen changes.
    setTimeout(() => {
      if (outcome.dead) { this.endRun(); return; }
      this.hud.hide();
      this.loop.setMode('menu');
      this.showReward(outcome);
    }, 1400);
  }

  /** The same question, asked by the shop. */
  showShopSwap(item) {
    this.screens.swapSkill(this.run, item, {
      onSwap: (dropId) => {
        const res = this.run.buy(item, { drop: dropId });
        this.screens.toast(res.ok ? res.text : res.reason);
        this.showShop();
      },
      onCancel: () => this.showShop(),
    });
  }

  /** Which skill to give up for the one just chosen. */
  showSwap(outcome, offer) {
    this.screens.swapSkill(this.run, offer, {
      onSwap: (dropId) => {
        const res = this.run.takeOffer(offer, { drop: dropId });
        if (!res.ok) { this.screens.toast(res.reason); return; }
        this.screens.toast(res.text);
        this.afterReward();
      },
      // Backing out returns to the same offer, unspent. Nothing was taken and
      // nothing was rerolled, so the choice is still open.
      onCancel: () => this.showReward(outcome),
    });
  }

  showReward(outcome) {
    this.screens.reward(this.run, outcome, {
      onTake: (offer) => {
        const res = this.run.takeOffer(offer);
        // A full skill loadout is a question, not a refusal.
        if (res.needsSlot) { this.showSwap(outcome, offer); return; }
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
    // Finishing the tournament is the only thing that pays a crate. Losing pays
    // nothing, which is what stops a crate being an attendance prize.
    if (this.lastSummary.outcome === 'victory') {
      this.profile.wonRun();
      this.profile.award(1);
    }
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

// Bodies before the first car. `VehicleMesh` is built mid-race when a rival
// spawns, so it has to stay synchronous; fetching here means it always is.
await loadHulls();
// And cut them, so the first race does not pay for it on the grid.
warmHulls(HULLS);

const game = new Game();
game.start();

// Exposed for the headless capture and playtest tools.
window.__game = game;
