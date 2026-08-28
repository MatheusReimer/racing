import { clamp } from './math.js';

// Keyboard + gamepad, folded into the four analogue axes the vehicle actually
// consumes. Nothing downstream reads raw key codes — it all reads
// `Input.state` — so rebinding, gamepad support, and the scripted playtest
// harness are the same code path.

const DEFAULT_BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'ShiftRight'],
  nos: ['Space'],
  skill1: ['Digit1'],
  skill2: ['Digit2'],
  skill3: ['Digit3'],
  skill4: ['Digit4'],
  lookBack: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter'],
};

export class Input {
  constructor(target = window) {
    this.target = target;
    this.bindings = DEFAULT_BINDINGS;
    this.down = new Set();
    /** Keys that went down this frame; cleared by `endFrame()`. */
    this.pressed = new Set();
    this.enabled = true;
    /** When true, `state` is written externally (playtest harness, AI demo). */
    this.scripted = false;

    this.state = {
      throttle: 0,
      brake: 0,
      steer: 0,
      drift: false,
      nos: false,
      lookBack: false,
      skills: [false, false, false, false],
    };

    this._steerSmooth = 0;
    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onBlur = () => this.releaseAll();
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
  }

  _keyDown(e) {
    // Arrows and space scroll the page; the game owns them while it has focus.
    if (this._isBound(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.down.add(e.code);
    this.pressed.add(e.code);
  }

  _keyUp(e) {
    this.down.delete(e.code);
  }

  _isBound(code) {
    for (const codes of Object.values(this.bindings)) {
      if (codes.includes(code)) return true;
    }
    return false;
  }

  releaseAll() {
    this.down.clear();
  }

  /** Is any key bound to `action` currently held? */
  held(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  /** Did any key bound to `action` go down this frame? */
  justPressed(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  /**
   * Fold devices into `state`. Steering is smoothed here so the vehicle model
   * never needs to know whether it came from a digital key or a stick.
   */
  update(dt) {
    if (this.scripted) return this.state;

    const s = this.state;
    if (!this.enabled) {
      s.throttle = 0;
      s.brake = 0;
      s.steer = 0;
      s.drift = false;
      s.nos = false;
      s.skills.fill(false);
      this._steerSmooth = 0;
      return s;
    }

    s.throttle = this.held('throttle') ? 1 : 0;
    s.brake = this.held('brake') ? 1 : 0;
    s.drift = this.held('drift');
    s.nos = this.held('nos');
    s.lookBack = this.held('lookBack');
    s.skills[0] = this.justPressed('skill1');
    s.skills[1] = this.justPressed('skill2');
    s.skills[2] = this.justPressed('skill3');
    s.skills[3] = this.justPressed('skill4');

    let rawSteer = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);

    const pad = this._gamepad();
    if (pad) {
      const ax = this._deadzone(pad.axes[0] ?? 0, 0.15);
      if (Math.abs(ax) > Math.abs(rawSteer)) rawSteer = ax;
      // Standard mapping: triggers are analogue buttons 6 and 7.
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > s.throttle) s.throttle = rt;
      if (lt > s.brake) s.brake = lt;
      if (pad.buttons[0]?.pressed) s.throttle = 1;
      if (pad.buttons[1]?.pressed || pad.buttons[5]?.pressed) s.drift = true;
      if (pad.buttons[2]?.pressed || pad.buttons[4]?.pressed) s.nos = true;
    }

    // Return to centre faster than we push away from it. Without the asymmetry
    // the car feels like it is swimming when you release mid-corner.
    const rate = Math.abs(rawSteer) > Math.abs(this._steerSmooth) ? 9 : 16;
    this._steerSmooth += (rawSteer - this._steerSmooth) * Math.min(1, rate * dt);
    if (Math.abs(this._steerSmooth) < 0.002) this._steerSmooth = 0;
    s.steer = clamp(this._steerSmooth, -1, 1);

    return s;
  }

  _deadzone(v, dz) {
    const a = Math.abs(v);
    if (a < dz) return 0;
    return Math.sign(v) * ((a - dz) / (1 - dz));
  }

  _gamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Must be called after every consumer has read `state` this frame. */
  endFrame() {
    this.pressed.clear();
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._onBlur);
  }
}
