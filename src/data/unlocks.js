import { STARTER_VEHICLE_IDS } from './vehicles.js';

// Which machines the roster offers, and which it only shows.
//
// The gate is built and switched off. That is deliberate rather than
// unfinished: the locked card is a real state the roster has to draw — a
// silhouette, a requirement, and a card that does not respond to a click — and
// a state that only exists in somebody's plan is a state that breaks the first
// time it is needed. This way it is drawn, styled and walked by the harness
// now, and turning it on is one line rather than a feature.
//
// It is off because locking is a decision about the game, not about the
// screen: three of six machines behind a win count changes what a new player
// is allowed to try, and the screen was the thing being built here.

/** Flip to true to gate the roster on runs won. */
export const GATING = false;

/**
 * Runs that must be *won* before a machine is offered. The starters are the
 * ones the roster has always named; the rest are ordered by how much they ask
 * of the player rather than by power — the rotary runs hot, the roadster is
 * made of paper, and the rally car's nine part slots are only worth having
 * once you know what to put in them.
 */
export const UNLOCK_AFTER = {
  rotary: 3,
  roadster: 5,
  rally: 8,
};

for (const id of STARTER_VEHICLE_IDS) UNLOCK_AFTER[id] = 0;

/** Runs won before `id` is available. 0 for anything with no entry. */
export function unlockAt(id) {
  return UNLOCK_AFTER[id] ?? 0;
}

/**
 * @param profile  the player's Profile, or null before one exists
 * @returns true if the roster should show this machine but refuse it
 */
export function isLocked(id, profile) {
  if (!GATING) return false;
  return (profile?.runsWon ?? 0) < unlockAt(id);
}

/** What the locked card says instead of a name. */
export function unlockLabel(id) {
  const n = unlockAt(id);
  return n === 1 ? 'Unlocks after 1 win' : `Unlocks after ${n} wins`;
}
