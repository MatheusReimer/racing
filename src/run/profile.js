import { DEFAULT_OWNED, COSMETIC_BY_ID } from '../data/cosmetics.js';

// What the player keeps.
//
// Everything else in this game is per-run by design: a build is found, fitted
// and lost, and the next run starts level with the first. This is the one thing
// that survives, and it survives precisely because it changes nothing — a
// cosmetic cannot make run twenty easier than run one.
//
// Stored in `localStorage`, which is allowed to be missing, full, or refused:
// a private window, a browser set to block site data, or a quota that a
// screenshot filled. Every access is guarded, and a profile that cannot be
// saved still works for the session it is in — losing a paint job is not worth
// an error the player has to read.

const KEY = 'rogue-racer:profile:v1';

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(data) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * The player's kit, across runs.
 *
 * Held as one object rather than read from storage on every question: the
 * showroom asks what is equipped every frame it draws, and that is not a
 * question to answer by parsing JSON.
 */
export class Profile {
  constructor() {
    const saved = read();
    // Unknown ids are dropped rather than kept. A profile written by a later
    // version, or by a catalogue that has since lost an entry, otherwise leaves
    // the player owning something the game cannot draw.
    const owned = (saved?.owned ?? []).filter((id) => COSMETIC_BY_ID[id]);
    this.owned = new Set([...DEFAULT_OWNED, ...owned]);
    this.equipped = {
      paint: this.valid(saved?.equipped?.paint, 'paint:factory'),
      rim: this.valid(saved?.equipped?.rim, 'rim:stock'),
    };
    this.crates = Math.max(0, saved?.crates ?? 0);
    this.runsWon = Math.max(0, saved?.runsWon ?? 0);
    // Runs taken to the grid, won or not. The title screen counts with it, so
    // it is the number of the run about to be attempted rather than a score —
    // a profile saved before this field existed simply starts from zero.
    this.runsStarted = Math.max(0, saved?.runsStarted ?? 0);
    this.persisted = saved !== null;
  }

  valid(id, fallback) {
    return id && this.owned.has(id) && COSMETIC_BY_ID[id] ? id : fallback;
  }

  has(id) { return this.owned.has(id); }

  /** @returns true if this was not already owned. */
  grant(id) {
    if (!COSMETIC_BY_ID[id] || this.owned.has(id)) return false;
    this.owned.add(id);
    this.save();
    return true;
  }

  equip(id) {
    const item = COSMETIC_BY_ID[id];
    if (!item || !this.owned.has(id)) return false;
    this.equipped[item.slot] = id;
    this.save();
    return true;
  }

  /** A crate owed, to be opened on the screen that shows it. */
  award(n = 1) {
    this.crates += n;
    this.save();
  }

  take() {
    if (this.crates <= 0) return false;
    this.crates -= 1;
    this.save();
    return true;
  }

  startedRun() {
    this.runsStarted += 1;
    this.save();
  }

  wonRun() {
    this.runsWon += 1;
    this.save();
  }

  /**
   * What the equipped cosmetics do to a car, as overrides the chassis takes.
   *
   * Null where the player has chosen the factory look, so "no cosmetic" and
   * "this cosmetic happens to match" stay different things.
   */
  look() {
    const paint = COSMETIC_BY_ID[this.equipped.paint];
    const rim = COSMETIC_BY_ID[this.equipped.rim];
    return {
      baseColor: paint?.base ?? null,
      accentColor: paint?.accent ?? null,
      rimTint: rim?.tint ?? null,
    };
  }

  save() {
    this.persisted = write({
      owned: [...this.owned],
      equipped: this.equipped,
      crates: this.crates,
      runsWon: this.runsWon,
      runsStarted: this.runsStarted,
    });
    return this.persisted;
  }
}
