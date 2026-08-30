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
const CELL = 0.9;

/**
 * How many cubes in a run share a shade.
 *
 * The room did not read as cubes and the cube *size* was not why — a box is a
 * box at any cell size, and rendering the kitchen at 1.4 m cubes only made it a
 * cruder box. The car reads as voxel because it is a curved thing approximated
 * by cubes, so its surface steps and you can count the steps. A wall is
 * genuinely flat, so nothing steps and the grid is invisible.
 *
 * So the lattice is shown rather than implied: every cube of a large flat
 * surface takes one of a few shades, chosen from its own coordinates. Two
 * things stop that costing everything. The shades are close enough together to
 * read as one material rather than as noise, and the pattern is coherent over
 * `SPECKLE` cubes, so the mesher still merges runs instead of emitting six
 * faces per cube.
 */
const SPECKLE = 2;
// Far enough apart to read from a car at speed, close enough together to be
// one material rather than a chequerboard. At +-4.5% it was invisible from the
// driving camera and only showed in a still.
const SHADES = [1.0, 0.925, 1.075, 0.962];

/** A stable shade index for a cube, from where the cube is. */
function speckleOf(x, y, z) {
  const i = Math.floor(x / SPECKLE);
  const j = Math.floor(y / SPECKLE);
  const k = Math.floor(z / SPECKLE);
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) % SHADES.length;
}

/**
 * Fill a range with the same colour in a few shades, cube by cube.
 *
 * The expensive way to write a box, used only on the surfaces big enough that
 * a flat fill is what gives the room away as not-cubes: floors, and walls.
 */
function speckle(C, x0, y0, z0, x1, y1, z1, hex) {
  const v = SHADES.map((k) => C.colour(shade(hex, k)));
  for (let z = z0; z < z1; z += SPECKLE) {
    for (let y = y0; y < y1; y += SPECKLE) {
      for (let x = x0; x < x1; x += SPECKLE) {
        C.box(x, y, z, Math.min(x1, x + SPECKLE), Math.min(y1, y + SPECKLE),
          Math.min(z1, z + SPECKLE), v[speckleOf(x, y, z)]);
      }
    }
  }
}

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
      speckle(C, x, 0, z, xd, FLOOR_D, zd, alt ? spec.a : spec.b);
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
function buildRoom(theme, doors, palette, rng, place, clear) {
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
      speckle(C, ax0, y, az0, ax1, Math.min(ay1, y + 6), az1,
        (y / 6) % 2 ? wallHue : shade(wallHue, 0.94));
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

  common(C, FLOOR_D, doors, place, rng, palette);
  fixtures(C, theme, FLOOR_D, rng, palette);
  clear?.(C, FLOOR_D);

  // How many cubes this room is actually made of, carried on the geometry.
  //
  // The triangle count is what the GPU is billed for and the cube count is
  // what the room *is*; the ratio between them is the only measure of whether
  // the greedy mesher is doing its job, and it was not being recorded anywhere.
  const geo = C.geometry();
  geo.userData.cubes = C.count;
  return geo;
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

    // Which of its walls face outside, so it knows where windows go.
    const place = {
      westOut: room.cell[0] === 0,
      eastOut: room.cell[0] === layout.cols - 1,
      northOut: room.cell[1] === 0,
      southOut: room.cell[1] === layout.rows - 1,
    };
    // And then the route is carved back out of it.
    //
    // Fixtures are placed against walls, and the racing line swings *toward*
    // the outside wall to make the room worth driving through — so the two
    // meet, and a bath ended up on the start line. It had no collision either,
    // because the room is one mesh and the simulation knows nothing about it:
    // the car drove through the bath.
    //
    // Rather than teach every fixture where the track is, the track is
    // subtracted afterwards. Anything standing in the corridor is simply not
    // there, which is both the correct result and the only one that cannot be
    // got wrong by adding another piece of furniture later.
    const geo = buildRoom(room.theme, doors, palette, rng, place,
      (C, F) => carveRoute(C, F, track, room));
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
/** The one colour the utility's airer needs that its room does not define. */
const metalC = (C) => C.colour(0xc4c8cc);

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
    // The run of units, and they are units rather than a plinth: a kickboard
    // set back at the floor, doors with a gap between them, and a handle on
    // each. Three fills apiece and it is the difference between a kitchen and
    // a long grey box against a wall.
    const cabinet = C.colour(0xe4e0d6);
    const handle = C.colour(0xa8adb2);
    C.box(x0, F + m(1), z0, x0 + m(6), F + m(8.5), z1 - m(4), cabinet);
    C.box(x0, F, z0, x0 + m(4.6), F + m(1), z1 - m(4), C.colour(0x8f8b82));
    for (let z = z0 + 1; z < z1 - m(5); z += m(5)) {
      C.box(x0 - 1, F + m(1.4), z, x0, F + m(8.2), z + m(4.4), cabinet);
      C.box(x0 - 1, F + m(7.2), z + m(1.6), x0, F + m(7.6), z + m(2.8), handle);
    }
    // The worktop, oversailing the doors, in something that is not white.
    C.box(x0, F + m(8.5), z0, x0 + m(6.6), F + m(9.2), z1 - m(4), C.colour(0x4a4740));

    // The cooker: a hob with four rings on it, a door with a window, and a
    // hood over it with a light underneath.
    const cz = Math.round((z0 + z1) / 2);
    C.box(x0, F, cz - m(3), x0 + m(6), F + m(9), cz + m(3), steel);
    C.box(x0 - 1, F + m(2), cz - m(2.6), x0, F + m(7), cz + m(2.6), C.colour(0x2a2f36));
    C.box(x0 - 1, F + m(7.4), cz - m(2.6), x0, F + m(8), cz + m(2.6), handle);
    for (const rx of [x0 + m(1.4), x0 + m(3.8)]) {
      for (const rz of [cz - m(1.8), cz + m(0.6)]) {
        C.box(rx, F + m(9.2), rz, rx + m(1.6), F + m(9.4), rz + m(1.6), C.colour(0x24282e));
      }
    }
    // The pot, with a lid and a handle, which is the room's hazard.
    C.box(x0 + m(1.6), F + m(9.4), cz - m(1.6), x0 + m(4.2), F + m(11.6), cz + m(1), dark);
    C.box(x0 + m(1.2), F + m(11.6), cz - m(2), x0 + m(4.6), F + m(12.2), cz + m(1.4), steel);
    C.box(x0 + m(2.6), F + m(12.2), cz - m(0.6), x0 + m(3.2), F + m(12.8), cz, steel);
    C.box(x0 + m(4.6), F + m(10.2), cz - m(0.8), x0 + m(5.6), F + m(10.8), cz + m(0.2), dark);
    C.box(x0, F + m(17), cz - m(3.4), x0 + m(5), F + m(21), cz + m(3.4), steel);
    C.box(x0 + m(1.4), F + m(16.4), cz - m(2.6), x0 + m(4), F + m(17), cz + m(2.6), white);

    // The fridge, with a handle down its edge and magnets on the door.
    C.box(x0, F, z1 - m(6), x0 + m(6.5), F + m(18), z1, white);
    C.box(x0 - 1, F + m(4), z1 - m(5.6), x0, F + m(13), z1 - m(5), handle);
    C.box(x0 - 1, F + m(9), z1 - m(6), x0, F + m(9.4), z1, C.colour(0xd8d4cc));
    for (let i = 0; i < 4; i++) {
      const mz = z1 - m(5) + rng.int(0, m(4));
      const my = F + m(10) + rng.int(0, m(6));
      C.box(x0 - 1, my, mz, x0, my + m(0.8), mz + m(0.8),
        C.colour([0xd8503a, 0x3a7ad8, 0xe8c22a, 0x4aa858][i]));
    }

    // Wall cupboards over the run, and the splashback tiled rather than plain.
    C.box(x0, F + m(14), z0, x0 + m(4), F + m(21), z1 - m(8), cabinet);
    for (let z = z0 + 1; z < z1 - m(9); z += m(5)) {
      C.box(x0 - 1, F + m(14.4), z, x0, F + m(20.6), z + m(4.4), cabinet);
      C.box(x0 - 1, F + m(15), z + m(1.6), x0, F + m(15.4), z + m(2.8), handle);
    }
    const tileA = C.colour(0xdfe6e8);
    const tileB = C.colour(0xcdd6d8);
    for (let z = z0; z < z1 - m(4); z += 3) {
      for (let y = F + m(9); y < F + m(14); y += 3) {
        C.box(x0, y, z, x0 + 1, y + 3, z + 3,
          ((z / 3 | 0) + (y / 3 | 0)) % 2 ? tileA : tileB);
      }
    }

    // The sink: a bowl sunk into the worktop, a mixer tap, a draining board.
    C.box(x0 + m(0.8), F + m(7.4), z0 + m(3), x0 + m(5.2), F + m(9.2), z0 + m(8), steel);
    C.box(x0 + m(1.2), F + m(7.8), z0 + m(3.4), x0 + m(4.8), F + m(9.2), z0 + m(7.6), dark);
    C.box(x0 + m(0.6), F + m(9.2), z0 + m(3.2), x0 + m(1.4), F + m(12), z0 + m(4), steel);
    C.box(x0 + m(0.6), F + m(11.6), z0 + m(3.2), x0 + m(3), F + m(12), z0 + m(4), steel);
    for (let i = 0; i < 5; i++) {
      C.box(x0 + m(1), F + m(9.2), z0 + m(8.4) + i * m(0.8),
        x0 + m(5), F + m(9.4), z0 + m(8.8) + i * m(0.8), steel);
    }

    // Worktop things: a kettle with a spout, a toaster with slots, a knife
    // block with knives in it, a chopping board leaning up, mugs.
    C.box(x0 + m(1), F + m(9.2), z0 + m(15), x0 + m(3.2), F + m(12.6), z0 + m(17.2), steel);
    C.box(x0 + m(3.2), F + m(11), z0 + m(15.8), x0 + m(4), F + m(12), z0 + m(16.4), steel);
    C.box(x0 + m(1), F + m(9.2), z0 + m(18), x0 + m(4), F + m(11.2), z0 + m(20), C.colour(0xb8bcc0));
    for (const oz of [z0 + m(18.6), z0 + m(19.2)]) {
      C.box(x0 + m(1.6), F + m(11.2), oz, x0 + m(3.4), F + m(11.4), oz + m(0.3), dark);
    }
    C.box(x0 + m(1), F + m(9.2), z0 + m(21.4), x0 + m(2.6), F + m(12), z0 + m(23), wood);
    for (let i = 0; i < 3; i++) {
      C.box(x0 + m(1.4) + i * m(0.5), F + m(12), z0 + m(21.8),
        x0 + m(1.7) + i * m(0.5), F + m(14) + i, z0 + m(22.2), dark);
    }
    C.box(x0 + m(0.6), F + m(9.2), z0 + m(11), x0 + m(1), F + m(13), z0 + m(15), wood);
    for (let i = 0; i < 3; i++) {
      C.box(x0 + m(4) + i * m(1.2), F + m(9.2), z0 + m(11),
        x0 + m(4.8) + i * m(1.2), F + m(10.2), z0 + m(11.8),
        C.colour([0xd8d4cc, 0x4a8ad8, 0xd8724a][i]));
    }

    // A bin with a pedal, a clock on the wall, and a mat in front of the sink.
    C.box(x1 - m(4), F, z1 - m(5), x1 - m(1), F + m(7), z1 - m(2), C.colour(0x4a5058));
    C.box(x1 - m(4.2), F + m(7), z1 - m(5.2), x1 - m(0.8), F + m(7.6), z1 - m(1.8), steel);
    C.box(x1 - m(4.4), F + m(0.4), z1 - m(4.4), x1 - m(3.6), F + m(0.8), z1 - m(3.4), steel);
    const clockZ = Math.round((z0 + z1) / 2) + m(9);
    C.box(x1 - 1, F + m(17), clockZ, x1, F + m(21), clockZ + m(4), white);
    C.box(x1 - 2, F + m(18.6), clockZ + m(1.6), x1 - 1, F + m(19.4), clockZ + m(2.4), dark);
    C.box(x0 + m(6.6), F, z0 + m(3), x0 + m(12), F + 1, z0 + m(9), C.colour(0x8a5a4a));

    // A table with chairs, out in the room, which the route goes round.
    const tx = Math.round((x0 + x1) / 2) + m(4);
    const tz = Math.round((z0 + z1) / 2);
    C.box(tx - m(5), F + m(7), tz - m(4), tx + m(5), F + m(8), tz + m(4), wood);
    // The table's own legs, at its corners.
    for (const ox of [-m(4.4), m(3.4)]) {
      for (const oz of [-m(3.4), m(2.4)]) {
        C.box(tx + ox, F, tz + oz, tx + ox + m(1), F + m(7), tz + oz + m(1), wood);
      }
    }
    // And four chairs, each a seat with legs under it and a back behind it.
    //
    // They were a leg and a back at the same four points, with nothing joining
    // them: four slabs standing round a table. A chair is the seat — it is the
    // part you can see from above, which is the only angle anybody sees this
    // room from.
    const chair = (cx2, cz2, facing) => {
      C.box(cx2 - m(2), F + m(4.4), cz2 - m(2), cx2 + m(2), F + m(5.2), cz2 + m(2), wood);
      for (const lx of [cx2 - m(1.8), cx2 + m(1.2)]) {
        for (const lz of [cz2 - m(1.8), cz2 + m(1.2)]) {
          C.box(lx, F, lz, lx + m(0.6), F + m(4.4), lz + m(0.6), wood);
        }
      }
      // The back goes on the side away from the table, which is what `facing`
      // is for — all four of them had it on the same side to begin with, and
      // one of the four was then sitting with its back to the food.
      if (facing === -1) C.box(cx2 - m(2), F + m(5.2), cz2 - m(2), cx2 - m(1.3), F + m(10), cz2 + m(2), wood);
      else if (facing === 1) C.box(cx2 + m(1.3), F + m(5.2), cz2 - m(2), cx2 + m(2), F + m(10), cz2 + m(2), wood);
      else if (facing === -2) C.box(cx2 - m(2), F + m(5.2), cz2 - m(2), cx2 + m(2), F + m(10), cz2 - m(1.3), wood);
      else C.box(cx2 - m(2), F + m(5.2), cz2 + m(1.3), cx2 + m(2), F + m(10), cz2 + m(2), wood);
    };
    chair(tx - m(7.5), tz - m(1), -1);
    chair(tx + m(7.5), tz - m(1), 1);
    chair(tx - m(1), tz - m(6.5), -2);
    chair(tx - m(1), tz + m(6.5), 2);
    // A fruit bowl on it, and a folded newspaper.
    C.box(tx - m(1.2), F + m(8), tz - m(1.2), tx + m(1.2), F + m(9.2), tz + m(1.2),
      C.colour(0xd8cdb8));
    for (const f2 of [[0, 0, 0xd84a3a], [m(0.8), m(0.6), 0xe8b02a], [-m(0.7), m(0.5), 0x4a9a3a]]) {
      C.box(tx + f2[0], F + m(9.2), tz + f2[1], tx + f2[0] + m(0.8), F + m(10), tz + f2[1] + m(0.8),
        C.colour(f2[2]));
    }
    C.box(tx + m(1.6), F + m(8), tz - m(3), tx + m(4.4), F + m(8.3), tz - m(1), white);

    // Boxes on top of the wall cupboards, which is where they live.
    for (let i = 0; i < 3; i++) {
      const bz = z0 + m(2) + i * m(4.5);
      C.box(x0 + m(0.5), F + m(21), bz, x0 + m(3), F + m(24), bz + m(3.4),
        C.colour(mix(0xc89a4a, 0xd8b880, rng.next())));
    }
  } else if (theme.id === 'bathroom') {
    // The bath along the far wall, and the water in it that overflows.
    C.box(x1 - m(7), F, z0, x1, F + m(6), z0 + m(17), white);
    C.box(x1 - m(6), F + m(4.5), z0 + 1, x1 - 1, F + m(5), z0 + m(16), C.colour(0x4f9fd0));
    // A toilet and a basin on the opposite wall.
    C.box(x0, F, z1 - m(8), x0 + m(6), F + m(4), z1 - m(4), white);
    C.box(x0, F + m(4), z1 - m(7), x0 + m(3), F + m(8), z1 - m(5), white);
    C.box(x0, F + m(7), z0 + m(4), x0 + m(5), F + m(8.5), z0 + m(10), white);
    // A mirror over the basin, a towel rail, a bath mat, and the water that
    // has come over the side — which is the room's whole hazard.
    C.box(x0, F + m(12), z0 + m(5), x0 + 1, F + m(18), z0 + m(9), C.colour(0xcfe4ee));
    C.box(x0 + m(1), F + m(11), z1 - m(14), x0 + m(1.6), F + m(11.6), z1 - m(10), steel);
    C.box(x0 + m(1), F + m(8), z1 - m(14), x0 + m(2), F + m(11), z1 - m(10), C.colour(0xd8c8b8));
    const wet = C.colour(0x6fb0d8);
    for (let i = 0; i < 7; i++) {
      const px = x1 - m(9) - rng.int(0, m(9));
      const pz = z0 + rng.int(0, Math.max(1, z1 - z0 - m(4)));
      C.box(px, F, pz, px + m(2) + rng.int(0, 4), F + 1, pz + m(2) + rng.int(0, 4), wet);
    }
    // A shower over the bath, on a rail, with the curtain pushed to one end —
    // and it is the curtain that makes the corner read as a shower rather than
    // as a pipe on a wall.
    C.box(x1 - m(1.4), F + m(20), z0, x1 - m(0.8), F + m(20.6), z0 + m(17), steel);
    C.box(x1 - m(2), F + m(19), z0 + m(2), x1 - m(1.2), F + m(20), z0 + m(3), steel);
    C.box(x1 - m(4), F + m(19), z0 + m(1.6), x1 - m(2), F + m(19.6), z0 + m(3.4), steel);
    C.box(x1 - m(2), F + m(6), z0 + m(11), x1 - m(1), F + m(20), z0 + m(17),
      C.colour(0xdfe8ee));
    // Bottles on the edge of the bath, and a laundry basket by the door.
    for (let i = 0; i < 4; i++) {
      const bz = z0 + m(3) + i * m(2.4);
      C.box(x1 - m(6.6), F + m(6), bz, x1 - m(5.8), F + m(8) + rng.int(0, 3), bz + m(0.8),
        C.colour([0x4a9ad8, 0xd8724a, 0x8ad84a, 0xd84a9a][i]));
    }
    C.box(x0 + m(8), F, z1 - m(6), x0 + m(12), F + m(6), z1 - m(2), C.colour(0xc8b894));
    C.box(x0 + m(8.5), F + m(4), z1 - m(5.5), x0 + m(11.5), F + m(7), z1 - m(2.5),
      C.colour(0xe4e0d4));
    // A toilet roll, on a holder, because it is the detail nobody models.
    C.box(x0 + m(0.6), F + m(6), z1 - m(9.6), x0 + m(1.8), F + m(7.2), z1 - m(8.4), white);
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
    // A bedside table with a lamp on it, a chest of drawers, and a rug.
    C.box(x1 - m(4), F, z0 + m(21), x1, F + m(5), z0 + m(25), wood);
    C.box(x1 - m(3), F + m(5), z0 + m(22), x1 - m(1), F + m(7), z0 + m(24), white);
    C.box(x1 - m(3.5), F + m(7), z0 + m(21.5), x1 - m(0.5), F + m(9.5), z0 + m(24.5),
      C.colour(0xe8d8a8));
    // A duvet heaped rather than flat, a second pillow, slippers by the bed,
    // and a pile of clothes on the floor that nobody has dealt with.
    for (let i = 0; i < 5; i++) {
      const dz = z0 + m(6) + i * m(2.8);
      C.box(x1 - m(13) - rng.int(0, 2), F + m(5.5), dz,
        x1 - m(0.5), F + m(6.5) + rng.int(0, 2), dz + m(2.6), C.colour(0x4a6a8a));
    }
    C.box(x1 - m(13.6), F + m(7), z0 + m(11), x1 - m(10.6), F + m(8.6), z0 + m(16), white);
    for (const sz2 of [z0 + m(21), z0 + m(23)]) {
      C.box(x1 - m(9), F, sz2, x1 - m(6), F + m(1.4), sz2 + m(1.4), C.colour(0x8a5a6a));
    }
    for (let i = 0; i < 4; i++) {
      const lx = x0 + m(16) + rng.int(0, m(6));
      const lz = z1 - m(10) - rng.int(0, m(8));
      C.box(lx, F, lz, lx + m(3), F + m(1.2) + rng.int(0, 2), lz + m(3),
        C.colour(mix(0x8a7a9a, 0xc8b8a8, rng.next())));
    }
    C.box(x0 + m(8), F, z0 + m(2), x0 + m(14), F + m(9), z0 + m(6), wood);
    for (let d2 = 0; d2 < 3; d2++) {
      C.box(x0 + m(8) - 1, F + m(1) + d2 * m(2.6), z0 + m(2.5),
        x0 + m(8), F + m(2.6) + d2 * m(2.6), z0 + m(5.5), white);
    }
  } else if (theme.id === 'living') {
    // Sofa, and the television it is pointed at.
    C.box(x0, F, z0 + m(4), x0 + m(9), F + m(4), z0 + m(22), accent);
    C.box(x0, F + m(4), z0 + m(4), x0 + m(3), F + m(8), z0 + m(22), accent);
    C.box(x1 - m(4), F, z1 - m(16), x1, F + m(4.5), z1 - m(2), wood);
    C.box(x1 - m(3), F + m(4.5), z1 - m(15), x1 - m(1), F + m(13), z1 - m(3), dark);
    C.box(x1 - m(2.6), F + m(5.2), z1 - m(14.4), x1 - m(1.4), F + m(12.3), z1 - m(3.6),
      C.colour(0x2a3a4a));
    // A coffee table with a mug on it, a standard lamp in the corner, a
    // bookcase, and the cables the theme promises across the floor.
    const gx = Math.round((x0 + x1) / 2);
    const gz = Math.round((z0 + z1) / 2);
    C.box(gx - m(4), F + m(3.5), gz - m(2.5), gx + m(4), F + m(4.2), gz + m(2.5), wood);
    // With legs. It was a tabletop hovering at knee height, which nobody
    // notices in a chase camera and is the first thing seen from a room shot.
    for (const ox of [-m(3.4), m(2.6)]) {
      for (const oz of [-m(2), m(1.2)]) {
        C.box(gx + ox, F, gz + oz, gx + ox + m(0.8), F + m(3.5), gz + oz + m(0.8), wood);
      }
    }
    C.box(gx - m(0.6), F + m(4.2), gz - m(0.6), gx + m(0.6), F + m(5.4), gz + m(0.6), white);
    C.box(x0 + m(1), F, z1 - m(4), x0 + m(2), F + m(15), z1 - m(3), dark);
    C.box(x0, F + m(15), z1 - m(5), x0 + m(3), F + m(19), z1 - m(2), C.colour(0xf0e2b8));
    C.box(x1 - m(3), F, z0 + m(2), x1, F + m(14), z0 + m(12), wood);
    for (let sh = 0; sh < 4; sh++) {
      C.box(x1 - m(3), F + m(3) * sh + 1, z0 + m(2.5), x1, F + m(3) * sh + 2, z0 + m(11.5), dark);
    }
    for (let i = 0; i < 3; i++) {
      const cz2 = z1 - m(6) - i * m(2);
      C.box(x1 - m(14), F, cz2, x1 - m(3), F + 1, cz2 + 1, dark);
    }
    // Cushions on the sofa, a shelf of photographs, a games console under the
    // television with its own little light, and a remote left on the table.
    for (let i = 0; i < 3; i++) {
      const sz2 = z0 + m(6) + i * m(5.5);
      C.box(x0 + m(2), F + m(4), sz2, x0 + m(3.6), F + m(7.4), sz2 + m(4),
        C.colour(mix(palette.accent ?? 0xe0563a, 0xf0e2c8, 0.55 + rng.next() * 0.3)));
    }
    C.box(x1 - m(3.4), F, z1 - m(14), x1 - m(0.6), F + m(1.6), z1 - m(11), dark);
    C.box(x1 - m(3), F + m(0.4), z1 - m(13.4), x1 - m(2.6), F + m(1.2), z1 - m(13),
      C.colour(0x4fd0a0));
    C.box(gx - m(2.4), F + m(4.2), gz + m(0.8), gx - m(1.2), F + m(4.6), gz + m(1.6), dark);
    C.box(x0, F + m(11), z0 + m(8), x0 + m(2), F + m(11.6), z0 + m(18), wood);
    for (let i = 0; i < 3; i++) {
      const fz = z0 + m(9) + i * m(3);
      C.box(x0 + m(0.4), F + m(11.6), fz, x0 + m(1.2), F + m(14), fz + m(2), white);
      C.box(x0 + m(0.6), F + m(12), fz + m(0.3), x0 + m(1), F + m(13.6), fz + m(1.7),
        C.colour(mix(0x6a8aa8, 0xc8a888, rng.next())));
    }
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
    // Loose blocks on the floor, a ramp off the toy box lid, and a ball.
    for (let i = 0; i < 10; i++) {
      const bx = x0 + m(6) + rng.int(0, Math.max(1, x1 - x0 - m(12)));
      const bz = z0 + m(3) + rng.int(0, Math.max(1, z1 - z0 - m(6)));
      C.box(bx, F, bz, bx + m(2.2), F + m(1.2), bz + m(2.2), hues[i % 4]);
    }
    for (let s2 = 0; s2 < m(7); s2++) {
      C.box(x1 - m(8) - s2, F, z1 - m(8), x1 - m(8) - s2 + 1, F + m(7) - s2, z1 - m(2), wood);
    }
    // A play mat, a loop of train track on it, a rocking horse and a bear.
    C.box(x0 + m(12), F, z0 + m(6), x0 + m(26), F + 1, z0 + m(20), C.colour(0x4a8ac8));
    const rx0 = x0 + m(14), rz0 = z0 + m(8), rx1 = x0 + m(24), rz1 = z0 + m(18);
    const rail = C.colour(0x8a6a48);
    C.box(rx0, F + 1, rz0, rx1, F + 2, rz0 + 2, rail);
    C.box(rx0, F + 1, rz1 - 2, rx1, F + 2, rz1, rail);
    C.box(rx0, F + 1, rz0, rx0 + 2, F + 2, rz1, rail);
    C.box(rx1 - 2, F + 1, rz0, rx1, F + 2, rz1, rail);
    C.box(rx0 + m(2), F + 2, rz0 - 1, rx0 + m(5), F + m(2.4), rz0 + 3, C.colour(0xd83a3a));
    C.box(x1 - m(6), F, z0 + m(3), x1 - m(2), F + m(1.2), z0 + m(9), wood);
    C.box(x1 - m(5.4), F + m(1.2), z0 + m(4.5), x1 - m(2.6), F + m(5), z0 + m(7.5), white);
    C.box(x1 - m(5.4), F + m(5), z0 + m(6.6), x1 - m(3.4), F + m(7), z0 + m(8.4), white);
    const fur = C.colour(0xb08a5a);
    C.box(x0 + m(4), F, z1 - m(8), x0 + m(7), F + m(4), z1 - m(5), fur);
    C.box(x0 + m(4.4), F + m(4), z1 - m(7.6), x0 + m(6.6), F + m(6.4), z1 - m(5.4), fur);
    for (const ez of [z1 - m(7.6), z1 - m(6)]) {
      C.box(x0 + m(4.2), F + m(6), ez, x0 + m(5), F + m(7), ez + m(0.8), fur);
    }

    const ballR = m(2.4);
    for (let dy = 0; dy < ballR * 2; dy++) {
      const rr = Math.round(Math.sqrt(Math.max(0, ballR * ballR - (dy - ballR) ** 2)));
      C.box(x0 + m(10) - rr, F + dy, z1 - m(6) - rr, x0 + m(10) + rr, F + dy + 1,
        z1 - m(6) + rr, hues[(dy >> 1) % 4]);
    }
  } else if (theme.id === 'study') {
    // A bookshelf, and the books stacked into a ramp at the foot of it.
    C.box(x0, F, z0 + m(3), x0 + m(3), F + m(20), z0 + m(21), wood);
    for (let s = 0; s < 5; s++) {
      C.box(x0, F + m(3.6) * s, z0 + m(3), x0 + m(3), F + m(3.6) * s + 1, z0 + m(21), dark);
    }
    for (let s = 0; s < 5; s++) {
      C.box(x0 + m(3) + s, F, z0 + m(8), x0 + m(3) + s + 1, F + m(4) - s, z0 + m(14), accent);
    }
    // A desk under the window with a monitor on it, and a chair nobody moved.
    C.box(x1 - m(7), F + m(7), z0 + m(6), x1, F + m(8), z0 + m(18), wood);
    for (const ox of [m(0.5), m(6)]) {
      C.box(x1 - ox, F, z0 + m(6.5), x1 - ox + m(1), F + m(7), z0 + m(7.5), dark);
      C.box(x1 - ox, F, z0 + m(16.5), x1 - ox + m(1), F + m(7), z0 + m(17.5), dark);
    }
    C.box(x1 - m(4), F + m(8), z0 + m(9), x1 - m(3), F + m(14), z0 + m(15), dark);
    C.box(x1 - m(9), F, z0 + m(10), x1 - m(5), F + m(4), z0 + m(14), dark);
    C.box(x1 - m(9), F + m(4), z0 + m(10), x1 - m(8), F + m(10), z0 + m(14), dark);
    // Papers on the desk and a few that missed the bin, a filing cabinet, and
    // a lamp bent over the keyboard.
    for (let i = 0; i < 4; i++) {
      const px = x1 - m(6) + rng.int(0, 4);
      const pz = z0 + m(7) + rng.int(0, m(9));
      C.box(px, F + m(8), pz, px + m(2.4), F + m(8) + 1, pz + m(3), white);
    }
    C.box(x1 - m(3), F + m(8), z0 + m(16), x1 - m(0.6), F + m(8.6), z0 + m(17.6), white);
    C.box(x1 - m(2.2), F + m(8.6), z0 + m(16.4), x1 - m(1.4), F + m(13), z0 + m(17.2), dark);
    C.box(x1 - m(4), F + m(12.4), z0 + m(16.4), x1 - m(1.4), F + m(13), z0 + m(17.2), dark);
    C.box(x1 - m(4.4), F + m(11.6), z0 + m(16.2), x1 - m(3.2), F + m(12.6), z0 + m(17.4), white);
    C.box(x1 - m(4), F, z0 + m(19), x1, F + m(7), z0 + m(23), steel);
    for (let d3 = 0; d3 < 2; d3++) {
      C.box(x1 - m(4) - 1, F + m(1) + d3 * m(3), z0 + m(19.5),
        x1 - m(4), F + m(3.6) + d3 * m(3), z0 + m(22.5), dark);
    }
    C.box(x0 + m(6), F, z1 - m(6), x0 + m(8.4), F + m(4), z1 - m(3.6), steel);
    for (let i = 0; i < 3; i++) {
      const bx = x0 + m(9) + rng.int(0, m(4));
      const bz = z1 - m(7) + rng.int(0, m(4));
      C.box(bx, F, bz, bx + m(1.4), F + m(1.4), bz + m(1.4), white);
    }
  } else if (theme.id === 'hall') {
    // A hall is the room with nothing in it, and it still has a hall's things:
    // coat hooks, a console table, a runner, and shoes by the wall.
    C.box(x0, F + m(15), z0 + m(4), x0 + m(1), F + m(16), z1 - m(4), wood);
    for (let i = 0; i < 5; i++) {
      const hz = z0 + m(6) + i * m(4);
      C.box(x0 + m(1), F + m(14), hz, x0 + m(2), F + m(15.5), hz + m(0.8), steel);
      if (rng.bool(0.6)) {
        C.box(x0 + m(1), F + m(7), hz - m(1.5), x0 + m(3), F + m(14.5), hz + m(2.5),
          C.colour(mix(palette.accent ?? 0xe0563a, 0x4a5058, rng.next())));
      }
    }
    C.box(x1 - m(3), F + m(6.5), z0 + m(6), x1, F + m(7.5), z0 + m(16), wood);
    for (const oz of [z0 + m(6.5), z0 + m(14.5)]) {
      C.box(x1 - m(2.5), F, oz, x1 - m(1.5), F + m(6.5), oz + m(1), wood);
    }
    for (let i = 0; i < 4; i++) {
      const sz = z1 - m(6) - i * m(2.4);
      C.box(x0 + m(1), F, sz, x0 + m(3.5), F + m(1.6), sz + m(1.6), dark);
    }
    // An umbrella stand with umbrellas in it, a mirror over the console, and
    // the post nobody has picked up.
    C.box(x1 - m(4), F, z1 - m(6), x1 - m(1.6), F + m(5), z1 - m(3.6), steel);
    for (let i = 0; i < 3; i++) {
      const ux = x1 - m(3.6) + i;
      C.box(ux, F + m(5), z1 - m(5.4) + i, ux + 1, F + m(11), z1 - m(4.4) + i,
        C.colour([0x2a3a6a, 0x6a2a3a, 0x2a5a3a][i]));
    }
    C.box(x1 - m(1), F + m(12), z0 + m(8), x1, F + m(19), z0 + m(14), C.colour(0xcfe4ee));
    C.box(x1 - m(1.4), F + m(11.4), z0 + m(7.4), x1 - m(1), F + m(19.6), z0 + m(14.6), wood);
    for (let i = 0; i < 3; i++) {
      const lx = x0 + m(6) + rng.int(0, m(5));
      const lz = z0 + m(4) + rng.int(0, m(4));
      C.box(lx, F, lz, lx + m(2.4), F + 1, lz + m(1.6), white);
    }
  } else if (theme.id === 'utility') {
    C.box(x0, F, z0 + m(3), x0 + m(6), F + m(8.5), z0 + m(9), white);
    C.box(x0 - 1, F + m(3), z0 + m(4.5), x0, F + m(6), z0 + m(7.5), dark);
    C.box(x0, F, z0 + m(10), x0 + m(6), F + m(8.5), z0 + m(16), white);
    // Shelves of boxes above them, and a mop in the corner.
    C.box(x0, F + m(13), z0 + m(2), x0 + m(4), F + m(14), z0 + m(18), wood);
    for (let i = 0; i < 4; i++) {
      const bz = z0 + m(3) + i * m(3.6);
      C.box(x0 + m(0.5), F + m(14), bz, x0 + m(3.5), F + m(17), bz + m(3),
        C.colour(mix(0x9a7a4a, 0xb8a888, rng.next())));
    }
    C.box(x1 - m(2), F, z1 - m(4), x1 - m(1.4), F + m(14), z1 - m(3.4), wood);
    // A clothes airer with washing on it, an ironing board, and the bottles
    // that live on top of the machines.
    const airX = x1 - m(12);
    for (const oz of [z0 + m(4), z0 + m(12)]) {
      C.box(airX, F, oz, airX + m(0.8), F + m(10), oz + m(0.8), metalC(C));
      C.box(airX + m(6), F, oz, airX + m(6.8), F + m(10), oz + m(0.8), metalC(C));
    }
    for (let i = 0; i < 4; i++) {
      const ay = F + m(6) + i * m(1.4);
      C.box(airX, ay, z0 + m(4), airX + m(7), ay + 1, z0 + m(12.8), metalC(C));
    }
    for (let i = 0; i < 3; i++) {
      const wx = airX + m(1) + i * m(2);
      C.box(wx, F + m(4), z0 + m(5), wx + m(1.4), F + m(9.4), z0 + m(11),
        C.colour(mix(0xd8dce4, 0xc8b8d8, rng.next())));
    }
    C.box(x1 - m(4), F, z1 - m(14), x1 - m(1), F + m(8), z1 - m(6), C.colour(0xd8d4c8));
    for (let i = 0; i < 3; i++) {
      C.box(x0 + m(1) + i * m(1.8), F + m(8.5), z0 + m(4), x0 + m(2.2) + i * m(1.8),
        F + m(11), z0 + m(5.2), C.colour([0x4a9ad8, 0xe8a83a, 0x8ad84a][i]));
    }
  }
}

/**
 * What every room has, whatever it is for.
 *
 * This is most of what makes a box read as a house, and none of it is
 * furniture: a window with a sill and curtains, a radiator under it, a light on
 * the ceiling, a picture on the wall, a socket by the skirting, and a door leaf
 * standing open beside each opening. A kitchen without a fridge is a room. A
 * room without a window, a light and a plug is a corridor in a warehouse.
 *
 * Windows go on the walls that face outside — which the ring knows, because a
 * room on the edge of the rectangle has an edge — and never on a wall that
 * already has a door in it.
 */
function common(C, F, doors, place, rng, palette) {
  const m = (v) => C.c(v);
  const t = Math.max(2, C.c(WALL_T));
  const x0 = t, x1 = C.nx - t;
  const z0 = t, z1 = C.nz - t;
  const top = F + C.c(WALL_H);

  const glass = C.colour(0x9fc4d8);
  const frame = C.colour(0xf2ede2);
  const curtain = C.colour(mix(palette.accent ?? 0xe0563a, 0xc8bda8, 0.55));
  const white = C.colour(0xeceae4);
  const metal = C.colour(0xc4c8cc);
  const dark = C.colour(0x3a3f46);

  const hasDoor = (side) => doors.some((d) => d.side === side);

  /** A window in a wall: opening, glass, frame, sill, curtains, radiator. */
  const window_ = (side) => {
    const sill = F + m(9);
    const head = F + m(20);
    const half = m(7);
    if (Math.abs(side) === 1) {
      const wx0 = side < 0 ? 0 : x1;
      const wx1 = side < 0 ? x0 : C.nx;
      const c = Math.round((z0 + z1) / 2);
      C.box(wx0, sill, c - half, wx1, head, c + half, glass);
      C.box(wx0, sill - 2, c - half - 1, wx1, sill, c + half + 1, frame);
      C.box(wx0, head, c - half - 1, wx1, head + 2, c + half + 1, frame);
      for (const z of [c - half - 1, c + half]) C.box(wx0, sill, z, wx1, head, z + 1, frame);
      // The sill, proud of the wall, and curtains either side of it.
      const inX = side < 0 ? x0 : x1 - 1;
      C.box(inX, sill - 2, c - half - 2, inX + 1, sill, c + half + 2, frame);
      for (const z of [c - half - 4, c + half]) {
        C.box(inX, sill - 1, z, inX + 1, head + 3, z + 4, curtain);
      }
      // A radiator under it: ribbed, which on a grid is a rib every other cell.
      const rx = side < 0 ? x0 : x1 - 2;
      for (let z = c - half; z < c + half; z += 2) {
        C.box(rx, F + m(1.5), z, rx + 2, F + m(7), z + 1, white);
      }
    } else {
      const wz0 = side < 0 ? 0 : z1;
      const wz1 = side < 0 ? z0 : C.nz;
      const c = Math.round((x0 + x1) / 2);
      C.box(c - half, sill, wz0, c + half, head, wz1, glass);
      C.box(c - half - 1, sill - 2, wz0, c + half + 1, sill, wz1, frame);
      C.box(c - half - 1, head, wz0, c + half + 1, head + 2, wz1, frame);
      for (const x of [c - half - 1, c + half]) C.box(x, sill, wz0, x + 1, head, wz1, frame);
      const inZ = side < 0 ? z0 : z1 - 1;
      C.box(c - half - 2, sill - 2, inZ, c + half + 2, sill, inZ + 1, frame);
      for (const x of [c - half - 4, c + half]) {
        C.box(x, sill - 1, inZ, x + 4, head + 3, inZ + 1, curtain);
      }
      const rz = side < 0 ? z0 : z1 - 2;
      for (let x = c - half; x < c + half; x += 2) {
        C.box(x, F + m(1.5), rz, x + 1, F + m(7), rz + 2, white);
      }
    }
  };

  if (place.westOut && !hasDoor(-1)) window_(-1);
  if (place.eastOut && !hasDoor(1)) window_(1);
  if (place.northOut && !hasDoor(-2)) window_(-2);
  if (place.southOut && !hasDoor(2)) window_(2);

  // A door leaf, standing open against the wall beside its opening. A doorway
  // with no door in it is a hole; the leaf is what says somebody lives here.
  for (const d of doors) {
    const doorHalf = Math.max(2, C.c(DOOR_W / 2));
    const doorH = F + C.c(21);
    if (Math.abs(d.side) === 1) {
      const wx = d.side < 0 ? x0 : x1 - m(1);
      const c = Math.round(C.nz / 2 + d.at / CELL);
      C.box(wx, F, c + doorHalf, wx + m(1), doorH, c + doorHalf + m(8), frame);
    } else {
      const wz = d.side < 0 ? z0 : z1 - m(1);
      const c = Math.round(C.nx / 2 + d.at / CELL);
      C.box(c + doorHalf, F, wz, c + doorHalf + m(8), doorH, wz + m(1), frame);
    }
  }

  // A ceiling.
  //
  // The rooms were open-topped, which is invisible from the chase camera and
  // is exactly why it went unnoticed: a room with no lid is a courtyard, and
  // the light hanging in one has nothing to hang from.
  const ceiling = C.colour(0xf4f0e8);
  C.box(0, top, 0, C.nx, top + 2, C.nz, ceiling);

  // A light on it, a rose round the flex, and a smoke alarm off to one side.
  const cx = Math.round(C.nx / 2);
  const cz = Math.round(C.nz / 2);
  C.box(cx - 1, top - m(2), cz - 1, cx + 1, top, cz + 1, metal);
  C.box(cx - m(2), top - m(3.5), cz - m(2), cx + m(2), top - m(2), cz + m(2), white);
  C.box(cx - m(3), top - 1, cz - m(3), cx + m(3), top, cz + m(3), white);
  C.box(cx + m(9), top - 1, cz - m(7), cx + m(11), top, cz - m(5), white);

  // A light switch beside each door, at the height a switch is.
  for (const d of doors) {
    const doorHalf = Math.max(2, C.c(DOOR_W / 2));
    if (Math.abs(d.side) === 1) {
      const wx = d.side < 0 ? x0 : x1 - 1;
      const c = Math.round(C.nz / 2 + d.at / CELL);
      C.box(wx, F + m(13), c - doorHalf - m(2.5), wx + 1, F + m(15), c - doorHalf - m(1), white);
    } else {
      const wz = d.side < 0 ? z0 : z1 - 1;
      const c = Math.round(C.nx / 2 + d.at / CELL);
      C.box(c - doorHalf - m(2.5), F + m(13), wz, c - doorHalf - m(1), F + m(15), wz + 1, white);
    }
  }

  // A houseplant in a corner, in a pot, because every room in every house has
  // one and it is the cheapest object here per unit of "somebody lives here".
  if (rng.bool(0.75)) {
    const px = rng.bool(0.5) ? x0 + m(2) : x1 - m(5);
    const pz = rng.bool(0.5) ? z0 + m(2) : z1 - m(5);
    const pot = C.colour(0xa8663f);
    const leaf = C.colour(mix(0x3f7a3a, 0x2c5c30, rng.next()));
    C.box(px, F, pz, px + m(3), F + m(3), pz + m(3), pot);
    C.box(px + m(1.2), F + m(3), pz + m(1.2), px + m(1.8), F + m(9), pz + m(1.8), leaf);
    for (let i = 0; i < 5; i++) {
      const a2 = rng.next() * 6.283;
      const rr = m(2) + rng.int(0, 3);
      const lx = Math.round(px + m(1.5) + Math.cos(a2) * rr);
      const lz = Math.round(pz + m(1.5) + Math.sin(a2) * rr);
      const ly = F + m(5) + rng.int(0, m(4));
      C.box(Math.min(lx, px + m(1)), ly, Math.min(lz, pz + m(1)),
        Math.max(lx, px + m(2)) + 1, ly + 1, Math.max(lz, pz + m(2)) + 1, leaf);
    }
  }

  for (let i = 0; i < 2; i++) {
    const on = rng.int(0, 3);
    const py = F + m(13) + rng.int(0, 4);
    const pw = m(4) + rng.int(0, 6);
    const ph = m(3) + rng.int(0, 4);
    const hue = C.colour(mix(palette.accent ?? 0xe0563a, 0x6a5f52, rng.next()));
    if (on < 2) {
      const px = on === 0 ? x0 : x1 - 1;
      const pz = z0 + m(6) + rng.int(0, Math.max(1, z1 - z0 - m(14)));
      C.box(px, py, pz, px + 1, py + ph, pz + pw, dark);
      C.box(px + 1, py + 1, pz + 1, px + 2, py + ph - 1, pz + pw - 1, hue);
    } else {
      const pz = on === 2 ? z0 : z1 - 1;
      const px = x0 + m(6) + rng.int(0, Math.max(1, x1 - x0 - m(14)));
      C.box(px, py, pz, px + pw, py + ph, pz + 1, dark);
      C.box(px + 1, py + 1, pz + 1, px + pw - 1, py + ph - 1, pz + 2, hue);
    }
  }

  for (let i = 0; i < 2; i++) {
    const pz = z0 + m(4) + rng.int(0, Math.max(1, z1 - z0 - m(8)));
    C.box(x0, F + m(3), pz, x0 + 1, F + m(4.6), pz + m(1.6), white);
  }
}

/**
 * Take the racing line back out of a room.
 *
 * Every cell above the floor whose world position is inside the track's own
 * width is cleared. The margin is a car's half-width again on top, because a
 * wing mirror that clips a fridge nobody can see the edge of is worse than a
 * fridge that is slightly further back than it looks.
 *
 * Costs one path projection per column of the room — about ten thousand for a
 * room, a couple of hundred thousand for a house, and `Path.project` is
 * bucketed, so it is tens of milliseconds once at load.
 */
function carveRoute(C, FLOOR_D, track, room) {
  if (!track?.path) return;
  // Half a car of clearance on top of the road's own width, and the road is
  // wider than it was. A wing mirror clipping a fridge nobody can see the edge
  // of is worse than a fridge that sits slightly further back than it looks.
  const MARGIN = 2.6;
  const proj = { s: 0, dist: 0, side: 0 };
  for (let ix = 0; ix < C.nx; ix++) {
    const wx = room.x + C.ox + (ix + 0.5) * C.step;
    for (let iz = 0; iz < C.nz; iz++) {
      const wz = room.z + C.oz + (iz + 0.5) * C.step;
      track.path.project(wx, wz, proj);
      if (proj.dist > track.halfWidthAt(proj.s) + MARGIN) continue;
      // Clear the column above the floor. The floor itself stays: the car has
      // to drive on something, and the tiles are what it drives on.
      C.box(ix, FLOOR_D, iz, ix + 1, C.ny, iz + 1, 0);
    }
  }
}
