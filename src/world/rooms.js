import * as THREE from 'three';
import { VoxCanvas } from './canvas.js';
import { facetedMaterial, shade, mix } from './shapes.js';
import { ROOM_W, ROOM_D, WALL_H, WALL_T, DOOR_W } from '../track/house.js';

// The house itself: floors, walls, doorways.
//
// Not props. A wall is not something scattered beside the route, it is the
// route's container — it decides where the car can go and it is generated from
// the same room ring the centreline was threaded through, so the two cannot
// drift apart. Props are placed *in* this.
//
// Everything is cells, like the rest of the world. The cell here is 45 cm at
// game scale, which is 4.5 cm of real house at 1:10 — the same rung of the
// ladder the buildings used, and about eight times the car's own cell, which
// is the ratio the outdoor world already reads as coherent.

/** Metres per cell for the shell. */
const CELL = 0.45;

/**
 * What each floor is made of.
 *
 * A pattern, not a texture: the grid is the material. A tile is a square of
 * cells with a grout line of one cell between, boards are long runs, carpet is
 * a fine two-tone noise, and concrete is flat. Each one costs a different
 * number of triangles for exactly the reason it looks different — a tiled
 * floor cannot merge across its grout and a concrete one merges to two quads.
 */
const FLOORS = {
  tile: { unit: 7, grout: 1, a: 0xd8d2c4, b: 0xbfb8a8, line: 0x8f887b },
  boards: { unit: 26, grout: 1, a: 0x9a6f43, b: 0x8a6038, line: 0x6b4a2c },
  carpet: { unit: 3, grout: 0, a: 0x6a5f52, b: 0x63594d, line: 0x63594d },
  rug: { unit: 5, grout: 0, a: 0x7a3f3a, b: 0x6d3833, line: 0x6d3833 },
  concrete: { unit: 40, grout: 0, a: 0x8a8880, b: 0x848279, line: 0x848279 },
};

/**
 * Lay a floor.
 *
 * Boards run the long way and tiles are square, which is the whole difference
 * between the two at this distance — a board floor read as a tiled one until
 * the runs were made twenty-six cells long.
 */
function floor(C, spec, x0, x1, z0, z1, FLOOR_D) {
  const a = C.colour(spec.a);
  const b = C.colour(spec.b);
  const line = C.colour(spec.line);
  const step = spec.unit + spec.grout;
  const long = spec.unit >= 20;

  for (let z = z0; z < z1; z += long ? 4 : step) {
    const zd = Math.min(z1, z + (long ? 4 : spec.unit));
    for (let x = x0; x < x1; x += step) {
      const xd = Math.min(x1, x + spec.unit);
      // Alternate on a checker for tiles, on the row for boards, and on a
      // scatter for carpet — which is the one that has to not read as a grid.
      const alt = long
        ? (Math.floor(z / 4) + Math.floor(x / step)) % 3 === 0
        : (Math.floor(x / step) + Math.floor(z / step)) % 2 === 0;
      C.box(x, 0, z, xd, FLOOR_D, zd, alt ? a : b);
      if (spec.grout) {
        C.box(xd, 0, z, Math.min(x1, xd + spec.grout), FLOOR_D, zd, line);
        if (!long) C.box(x, 0, zd, xd, FLOOR_D, Math.min(z1, zd + spec.grout), line);
      }
    }
  }
}

/**
 * One room: its floor, its four walls, and the openings in them.
 *
 * Walls go on every side. A room with a wall missing is a room the route can
 * leave sideways, and the whole point of a house is that it cannot — the only
 * ways out are the doors.
 *
 * @param doors  which sides have an opening and where along the wall, as
 *               `{ side, at }` with side one of -x, +x, -z, +z
 */
function buildRoom(theme, doors, palette, rng) {
  // The floor's *top* is y = 0, not its bottom.
  //
  // Built up from zero it stood 90 cm proud of the surface the car drives on,
  // and the cars were buried in it to the windows. The ground plane is where
  // the car is; the floor is the two courses underneath it.
  const FLOOR_D = 2;
  const w = ROOM_W + WALL_T * 2;
  const d = ROOM_D + WALL_T * 2;
  const C = new VoxCanvas(w, WALL_H + 2, d, CELL, {
    origin: [-w / 2, -FLOOR_D * CELL, -d / 2],
  });
  const spec = FLOORS[theme.floor] ?? FLOORS.boards;

  const t = Math.max(2, C.c(WALL_T));
  const x0 = t, x1 = C.nx - t;
  const z0 = t, z1 = C.nz - t;
  const top = FLOOR_D + C.c(WALL_H);
  const doorH = FLOOR_D + C.c(21);
  const doorHalf = Math.max(2, C.c(DOOR_W / 2));

  floor(C, spec, x0, x1, z0, z1, FLOOR_D);

  // Walls. Papered above, skirted below — the skirting is one course proud and
  // it is the single detail that says "room" rather than "box", because it is
  // the line the car's headlights run along.
  const wallHue = mix(palette.prop ?? 0x9a8f7e, 0xd8cdb8, 0.35 + rng.next() * 0.4);
  const cWall = C.colour(wallHue);
  const cWallAlt = C.colour(shade(wallHue, 0.94));
  const cSkirt = C.colour(0xe8e2d6);
  const cFrame = C.colour(0xf0ebe0);

  const wall = (ax0, ay0, az0, ax1, ay1, az1) => {
    // Banded in two near-identical shades, a course apart. Thirty metres of one
    // flat colour is what a wall looks like when it has been painted in a
    // renderer; two shades at cell scale is what it looks like in a photograph.
    for (let y = ay0; y < ay1; y += 6) {
      C.box(ax0, y, az0, ax1, Math.min(ay1, y + 6), az1,
        (y / 6) % 2 ? cWall : cWallAlt);
    }
    C.box(ax0, FLOOR_D, az0, ax1, FLOOR_D + 3, az1, cSkirt);
  };

  wall(0, FLOOR_D, 0, x0, top, C.nz);
  wall(x1, FLOOR_D, 0, C.nx, top, C.nz);
  wall(x0, FLOOR_D, 0, x1, top, z0);
  wall(x0, FLOOR_D, z1, x1, top, C.nz);

  for (const d of doors) {
    // The opening, and a frame round it a course proud of the wall.
    const cx = Math.round(C.nx / 2 + d.at / CELL);
    const cz = Math.round(C.nz / 2 + d.at / CELL);
    if (d.side === -1 || d.side === 1) {
      const wx0 = d.side < 0 ? 0 : x1;
      const wx1 = d.side < 0 ? x0 : C.nx;
      C.box(wx0, FLOOR_D, cz - doorHalf, wx1, doorH, cz + doorHalf, 0);
      C.box(wx0, doorH, cz - doorHalf - 1, wx1, doorH + 2, cz + doorHalf + 1, cFrame);
      for (const z of [cz - doorHalf - 1, cz + doorHalf]) {
        C.box(wx0, FLOOR_D, z, wx1, doorH + 2, z + 1, cFrame);
      }
    } else {
      const wz0 = d.side < 0 ? 0 : z1;
      const wz1 = d.side < 0 ? z0 : C.nz;
      C.box(cx - doorHalf, FLOOR_D, wz0, cx + doorHalf, doorH, wz1, 0);
      C.box(cx - doorHalf - 1, doorH, wz0, cx + doorHalf + 1, doorH + 2, wz1, cFrame);
      for (const x of [cx - doorHalf - 1, cx + doorHalf]) {
        C.box(x, FLOOR_D, wz0, x + 1, doorH + 2, wz1, cFrame);
      }
    }
  }

  fixtures(C, theme, FLOOR_D, rng, palette);

  return C.geometry();
}

/**
 * The whole house, as one group of room meshes.
 *
 * One mesh per room rather than one for the house: a house at this cell would
 * be a grid of six hundred by sixty by six hundred cells, which is twenty-two
 * million of them and forty megabytes of occupancy before a triangle is
 * emitted. Per room it is half a million, allocated and freed one at a time.
 */
export function buildHouse(track, biome, rng) {
  const layout = track.layout;
  if (!layout?.rooms) return null;

  const group = new THREE.Group();
  const material = facetedMaterial({ roughness: 0.9, metalness: 0.02 });
  const palette = biome.palette;

  for (const room of layout.rooms) {
    // Which of this room's walls have an opening, and where along them.
    const doors = [];
    for (const d of layout.doorways) {
      const mine = (d.a[0] === room.cell[0] && d.a[1] === room.cell[1])
        || (d.b[0] === room.cell[0] && d.b[1] === room.cell[1]);
      if (!mine) continue;
      const dx = d.x - room.x;
      const dz = d.z - room.z;
      // +-1 is a door in an x wall, +-2 in a z wall, and `at` is how far along
      // that wall it sits from the middle.
      if (Math.abs(dx) > Math.abs(dz)) doors.push({ side: dx < 0 ? -1 : 1, at: dz });
      else doors.push({ side: dz < 0 ? -2 : 2, at: dx });
    }

    const geo = buildRoom(room.theme, doors, palette, rng);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(room.x, 0, room.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  group.userData.material = material;
  return group;
}

/**
 * The fixtures: what makes a room that room.
 *
 * Drawn into the room's own canvas rather than scattered as props, and that is
 * a decision about what these *are*. A fridge is not a barrel that happened to
 * land in a kitchen — it is against the wall, it is always against the wall,
 * and it costs nothing extra to put it there because the room is already a
 * canvas being meshed. It also cannot land on the racing line, which the
 * scatter would have to be told about.
 *
 * Movable things — a ball, a can, a scatter of building blocks — are props and
 * will come from the prop system when there is one for them.
 *
 * @param free  the two-cell band along each wall that fixtures may use; the
 *              middle of the room belongs to the route
 */
function fixtures(C, theme, FLOOR_D, rng, palette) {
  const t = Math.max(2, C.c(WALL_T));
  const x0 = t, x1 = C.nx - t;
  const z0 = t, z1 = C.nz - t;
  const F = FLOOR_D;
  const m = (v) => C.c(v);

  // Everything here is measured in real centimetres times ten, like the rest
  // of the house: a worktop is 90 cm high, so it is 9 units, so it is 20 cells.
  const white = C.colour(0xeceae4);
  const steel = C.colour(0xb6bcc2);
  const dark = C.colour(0x3a3f46);
  const wood = C.colour(mix(0x8a6038, palette.prop ?? 0x9a8f7e, 0.3));
  const accent = C.colour(palette.accent ?? 0xe0563a);

  if (theme.id === 'kitchen') {
    // A run of units along one wall, with a worktop over them.
    C.box(x0, F, z0, x0 + m(6), F + m(8.5), z1 - m(4), white);
    C.box(x0, F + m(8.5), z0, x0 + m(6.4), F + m(9), z1 - m(4), dark);
    // The cooker, and the pot on it that is the room's hazard.
    const cz = Math.round((z0 + z1) / 2);
    C.box(x0, F, cz - m(3), x0 + m(6), F + m(9), cz + m(3), steel);
    C.box(x0 + m(1), F + m(9), cz - m(2), x0 + m(5), F + m(11.5), cz + m(2), dark);
    // The fridge, at the end of the run: the tallest thing in the room.
    C.box(x0, F, z1 - m(6), x0 + m(6.5), F + m(18), z1, white);
    C.box(x0 - 1, F + m(6), z1 - m(6), x0, F + m(6.6), z1, steel);
  } else if (theme.id === 'bathroom') {
    // The bath along the far wall, and the water in it that overflows.
    C.box(x1 - m(7), F, z0, x1, F + m(6), z0 + m(17), white);
    C.box(x1 - m(6), F + m(4.5), z0 + 1, x1 - 1, F + m(5), z0 + m(16), C.colour(0x4f9fd0));
    // A toilet and a basin on the opposite wall.
    C.box(x0, F, z1 - m(8), x0 + m(6), F + m(4), z1 - m(4), white);
    C.box(x0, F + m(4), z1 - m(7), x0 + m(3), F + m(8), z1 - m(5), white);
    C.box(x0, F + m(7), z0 + m(4), x0 + m(5), F + m(8.5), z0 + m(10), white);
  } else if (theme.id === 'bedroom') {
    // The bed, and the gap under it — which is the shortcut the theme promises
    // and is left clear on purpose.
    C.box(x1 - m(14), F + m(3), z0 + m(2), x1, F + m(5.5), z0 + m(20), C.colour(0x4a6a8a));
    for (const cx of [x1 - m(13), x1 - m(1.5)]) {
      for (const cz of [z0 + m(3), z0 + m(18)]) C.box(cx, F, cz, cx + m(1.5), F + m(3), cz + m(1.5), wood);
    }
    C.box(x1 - m(14), F + m(5.5), z0 + m(2), x1 - m(11), F + m(7), z0 + m(20), white);
    // A wardrobe against the other wall.
    C.box(x0, F, z1 - m(12), x0 + m(6), F + m(20), z1 - m(2), wood);
  } else if (theme.id === 'living') {
    // Sofa, and the television it is pointed at.
    C.box(x0, F, z0 + m(4), x0 + m(9), F + m(4), z0 + m(22), accent);
    C.box(x0, F + m(4), z0 + m(4), x0 + m(3), F + m(8), z0 + m(22), accent);
    C.box(x1 - m(4), F, z1 - m(16), x1, F + m(4.5), z1 - m(2), wood);
    C.box(x1 - m(3), F + m(4.5), z1 - m(15), x1 - m(1), F + m(13), z1 - m(3), dark);
    C.box(x1 - m(2.6), F + m(5.2), z1 - m(14.4), x1 - m(1.4), F + m(12.3), z1 - m(3.6),
      C.colour(0x2a3a4a));
  } else if (theme.id === 'toyroom') {
    // A run of building blocks along the wall, in four colours, stacked
    // unevenly because nobody stacks them evenly.
    const hues = [C.colour(0xd83a3a), C.colour(0x2f7ad8), C.colour(0xe8c22a), C.colour(0x3fa04a)];
    for (let i = 0, z = z0 + 2; z < z1 - m(3); z += m(2.4), i++) {
      const h = m(2) + rng.int(0, 3) * m(1.2);
      C.box(x0, F, z, x0 + m(4.8), F + h, z + m(2.2), hues[i % 4]);
      // The stud on top, which is the one detail that says building block.
      C.box(x0 + m(1.2), F + h, z + m(0.6), x0 + m(2), F + h + 1, z + m(1.4), hues[i % 4]);
    }
    C.box(x1 - m(8), F, z1 - m(10), x1, F + m(7), z1, wood);
  } else if (theme.id === 'study') {
    // A bookshelf, and the books stacked into a ramp at the foot of it.
    C.box(x0, F, z0 + m(3), x0 + m(3), F + m(20), z0 + m(21), wood);
    for (let s = 0; s < 5; s++) {
      C.box(x0, F + m(3.6) * s, z0 + m(3), x0 + m(3), F + m(3.6) * s + 1, z0 + m(21), dark);
    }
    for (let s = 0; s < 5; s++) {
      C.box(x0 + m(3) + s, F, z0 + m(8), x0 + m(3) + s + 1, F + m(4) - s, z0 + m(14), accent);
    }
  } else if (theme.id === 'utility') {
    C.box(x0, F, z0 + m(3), x0 + m(6), F + m(8.5), z0 + m(9), white);
    C.box(x0 - 1, F + m(3), z0 + m(4.5), x0, F + m(6), z0 + m(7.5), dark);
    C.box(x0, F, z0 + m(10), x0 + m(6), F + m(8.5), z0 + m(16), white);
  }
}
