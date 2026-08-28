import { RNG } from '../core/rng.js';
import { clamp, clamp01 } from '../core/math.js';

// The route map for a region.
//
// A Slay the Spire-style layered graph: rows of nodes with edges only ever
// going forward, so the player picks a path through a region and cannot
// backtrack. What makes it a decision rather than a corridor is that the node
// types are placed against each other — a row with an Elite is also given a
// Shop somewhere alongside it, so taking the risk and taking the safety are
// alternatives rather than a sequence.
//
// Generation guarantees, all of which are checked by tools/map-probe.mjs:
//   - every node is reachable from the start
//   - every node can reach the boss
//   - no row is a single mandatory node except the first and the boss
//   - Shops and Rests are never adjacent to each other on the same path

export const NODE_TYPES = {
  race: {
    id: 'race', name: 'Race', icon: '🏁', color: '#8fa3b8',
    desc: 'A standard field. Finish high for a better reward.',
  },
  elite: {
    id: 'elite', name: 'Elite Race', icon: '☠️', color: '#e5484d',
    desc: 'A harder field with modified rivals. Significantly better rewards.',
  },
  shop: {
    id: 'shop', name: 'Shop', icon: '🔧', color: '#f2c53d',
    desc: 'Spend scrap on parts, skills, repairs and rerolls.',
  },
  event: {
    id: 'event', name: 'Event', icon: '❓', color: '#b06be0',
    desc: 'Something happens. It might be good.',
  },
  challenge: {
    id: 'challenge', name: 'Challenge', icon: '🎯', color: '#4fd1ff',
    desc: 'A race with a special rule. Meet it for a rare reward.',
  },
  rest: {
    id: 'rest', name: 'Garage', icon: '🛠️', color: '#7ddc8f',
    desc: 'Repair, or upgrade one skill.',
  },
  boss: {
    id: 'boss', name: 'Boss Race', icon: '👑', color: '#ffa726',
    desc: 'The region champion. It changes the rules.',
  },
};

/** Rows per region, excluding the fixed opening race and the boss. */
const MIDDLE_ROWS = 6;
const MIN_WIDTH = 2;
const MAX_WIDTH = 4;

export class MapNode {
  constructor(id, row, col, type) {
    this.id = id;
    this.row = row;
    this.col = col;
    this.type = type;
    this.next = [];
    this.prev = [];
    this.visited = false;
    this.available = false;
    /** Filled in when the node is entered, so the UI can show what happened. */
    this.outcome = null;
    this.payload = null;
  }

  get def() {
    return NODE_TYPES[this.type];
  }
}

export class RunMap {
  constructor(nodes, rows, regionIndex) {
    this.nodes = nodes;
    this.rows = rows;
    this.regionIndex = regionIndex;
    this.current = null;
    this.start = rows[0][0];
    this.boss = rows[rows.length - 1][0];
    this.start.available = true;
  }

  nodeById(id) {
    return this.nodes.find((n) => n.id === id);
  }

  /** Nodes the player may legally move to right now. */
  options() {
    if (!this.current) return [this.start];
    return this.current.next;
  }

  enter(node) {
    if (!this.options().includes(node)) return false;
    this.current = node;
    node.visited = true;
    for (const n of this.nodes) n.available = false;
    for (const n of node.next) n.available = true;
    return true;
  }

  get complete() {
    return this.current === this.boss && this.current.visited;
  }

  /** Depth reached, for scoring and difficulty scaling. */
  get depth() {
    return this.current ? this.current.row : 0;
  }
}

/**
 * @param seed        run seed plus region index
 * @param regionIndex 0-based; later regions are denser and more hostile
 */
export function generateMap(seed, regionIndex = 0) {
  const rng = new RNG(`${seed}:region${regionIndex}`);
  const rows = [];
  let nextId = 0;
  const mk = (row, col, type) => {
    const n = new MapNode(`n${nextId++}`, row, col, type);
    return n;
  };

  // Row 0: a single opening race, so every run starts from the same place.
  rows.push([mk(0, 0, 'race')]);

  // Middle rows.
  for (let r = 1; r <= MIDDLE_ROWS; r++) {
    const width = rng.int(MIN_WIDTH, MAX_WIDTH);
    const row = [];
    for (let c = 0; c < width; c++) row.push(mk(r, c, 'race'));
    rows.push(row);
  }

  // Penultimate row is always a Garage: the boss should be a decision you
  // prepare for, not one you arrive at by accident with a broken car.
  rows.push([mk(MIDDLE_ROWS + 1, 0, 'rest')]);
  rows.push([mk(MIDDLE_ROWS + 2, 0, 'boss')]);

  connect(rows, rng);
  assignTypes(rows, rng, regionIndex);

  const nodes = rows.flat();
  return new RunMap(nodes, rows, regionIndex);
}

/**
 * Wire consecutive rows. Every node gets at least one outgoing edge and every
 * node in the next row gets at least one incoming edge, which is what makes
 * the graph fully connected in both directions without a repair pass.
 */
function connect(rows, rng) {
  for (let r = 0; r < rows.length - 1; r++) {
    const from = rows[r];
    const to = rows[r + 1];

    // Forward pass: every source node connects to a target near its own
    // column, so edges stay short and the map reads as a map rather than a
    // mesh.
    for (let i = 0; i < from.length; i++) {
      const centre = Math.round((i / Math.max(1, from.length - 1)) * (to.length - 1));
      const span = rng.bool(0.45) ? 1 : 0;
      const lo = clamp(centre - span, 0, to.length - 1);
      const hi = clamp(centre + span, 0, to.length - 1);
      const count = rng.bool(0.35) && hi > lo ? 2 : 1;
      const picks = new Set();
      for (let k = 0; k < count; k++) picks.add(rng.int(lo, hi));
      for (const p of picks) link(from[i], to[p]);
    }

    // Backward pass: adopt any orphan in the next row.
    for (let j = 0; j < to.length; j++) {
      if (to[j].prev.length > 0) continue;
      const centre = Math.round((j / Math.max(1, to.length - 1)) * (from.length - 1));
      link(from[clamp(centre, 0, from.length - 1)], to[j]);
    }
  }
}

function link(a, b) {
  if (a.next.includes(b)) return;
  a.next.push(b);
  b.prev.push(a);
}

/**
 * Decide what each node is.
 *
 * The rule that matters: a row containing an Elite must also offer something
 * safer, so the player is choosing between risk and caution rather than being
 * handed one. A row with no alternative is not a decision.
 */
function assignTypes(rows, rng, regionIndex) {
  const eliteChance = 0.16 + regionIndex * 0.06;
  const shopChance = 0.16;
  const eventChance = 0.22;
  const challengeChance = 0.13;
  const restChance = 0.10;

  for (let r = 1; r < rows.length - 2; r++) {
    const row = rows[r];
    let placedElite = false;

    for (const node of row) {
      const roll = rng.next();
      let type = 'race';
      if (roll < eliteChance && r >= 2) type = 'elite';
      else if (roll < eliteChance + shopChance) type = 'shop';
      else if (roll < eliteChance + shopChance + eventChance) type = 'event';
      else if (roll < eliteChance + shopChance + eventChance + challengeChance) type = 'challenge';
      else if (roll < eliteChance + shopChance + eventChance + challengeChance + restChance) type = 'rest';

      // Only one Elite per row: two makes the row a wall rather than a choice.
      if (type === 'elite') {
        if (placedElite) type = 'race';
        else placedElite = true;
      }
      node.type = type;
    }

    // If this row is all one thing, break it up — a row with no variety is
    // a corridor with extra steps.
    if (row.length > 1 && row.every((n) => n.type === row[0].type)) {
      row[rng.int(0, row.length - 1)].type = rng.pick(['event', 'shop', 'challenge']);
    }

    // A row containing an Elite must contain a non-Elite alternative.
    if (placedElite && row.length > 1 && row.every((n) => n.type === 'elite')) {
      row.find((n) => n.type === 'elite').type = 'shop';
    }

    // Never let the *only* path through a row be an Elite.
    if (row.length === 1 && row[0].type === 'elite') row[0].type = 'race';

    // Two Garages back to back wastes a row.
    if (r > 1) {
      for (const node of row) {
        if (node.type !== 'rest') continue;
        if (node.prev.some((p) => p.type === 'rest')) node.type = 'race';
      }
    }
  }

  // Guarantee at least one shop before the boss: arriving broke and broken
  // with no chance to prepare is not a difficulty spike, it is a dead run.
  const middle = rows.slice(1, rows.length - 2).flat();
  if (!middle.some((n) => n.type === 'shop')) {
    const candidates = middle.filter((n) => n.type === 'race' && n.row >= rows.length - 5);
    (candidates.length ? rng.pick(candidates) : rng.pick(middle)).type = 'shop';
  }
}
