// Car bodies, decimated off reference cars by tools/decimate.mjs.
//
// Binary rather than source. Fifty thousand triangles is a megabyte of
// coordinates; printed as decimal it would cost half again in size and a parse
// of the whole thing at boot, for numbers no one will ever read in a diff.
//
// These are derivative geometry — the reference's own surface with fewer
// vertices in it, not a measurement of a car — so the reference's licence
// reaches the game:
//
//   hatch     1997 Peugeot 205 GTI            CC-BY
//   coupe     1999 Nissan Silvia S15 Spec-S   CC BY-NC-SA
//   rotary    1999 Mazda RX-7 FD              CC BY-NC-SA
//   gt        1982 Audi Quattro B2            CC BY-NC-SA
//   roadster  1989 Mazda MX-5 (NA)            CC-BY
//   rally     Subaru Impreza WRX STi (GC8)    CC-BY
//   beetle    early-fifties VW Beetle         CC-BY
//
// Four want crediting. Three are non-commercial and share-alike, which is a
// constraint on the whole game now that their surfaces are in it.
// refs/README.txt carries the provenance.

import { loadMarks } from './marks.js';

export const HULL_NAMES = ['hatch', 'coupe', 'rotary', 'gt', 'roadster', 'rally', 'beetle'];
const MAGIC = 0x524c4852;

/** @type {Record<string, {positions: Float32Array, indices: Uint32Array,
 *   classes: Uint8Array, length: number, width: number, height: number,
 *   ground: number, wheel: {radius, width, front, rear} | null }>} */
export const HULLS = {};

/**
 * Voxel bodies, when they have been asked for.
 *
 * Empty unless `loadVox` runs, and that is the switch: `chassis.js` takes the
 * voxel route for a body type that has one and the decimated route for one that
 * does not, so turning the look on and off is a matter of whether the data was
 * fetched rather than a flag threaded through the mesh builder.
 */
export const VOX = {};

/** Read the voxel bodies. A body without one simply keeps its decimated hull. */
export async function loadVox(names = HULL_NAMES, base = 'bodies/') {
  const { parseVox } = await import('../../vehicle/voxmesh.js');
  await Promise.all(names.map(async (n) => {
    try {
      const res = await fetch(`${base}${n}.vox`);
      if (!res.ok) return;
      VOX[n] = parseVox(await res.arrayBuffer());
    } catch {
      // No voxel body for this one.
    }
  }));
  return VOX;
}

/**
 * Read one body file. Exported so the headless tools can feed `HULLS` from disk
 * — they run in Node, where there is no relative URL to fetch, and a probe that
 * quietly fell back to the generated route would be testing the wrong car.
 */
export function parseHull(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a body file');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`body file version ${version} is not readable here`);
  const nv = dv.getUint32(8, true);
  const nt = dv.getUint32(12, true);
  const radius = dv.getFloat32(32, true);
  let off = 64;
  const positions = new Float32Array(buf, off, nv * 3); off += nv * 12;
  const indices = new Uint32Array(buf, off, nt * 3); off += nt * 12;
  const classes = new Uint8Array(buf, off, nt);
  return {
    positions,
    indices,
    classes,
    length: dv.getFloat32(16, true),
    width: dv.getFloat32(20, true),
    height: dv.getFloat32(24, true),
    ground: dv.getFloat32(28, true),
    wheel: radius > 0 ? {
      radius,
      width: dv.getFloat32(36, true),
      front: dv.getFloat32(40, true),
      rear: dv.getFloat32(44, true),
      // Centre to centre. Not derivable from the hull's width, which includes
      // the mirrors — take it from there and the wheels sit outside the arches.
      track: dv.getFloat32(48, true),
    } : null,
  };
}

/**
 * Fetch every body before the first car is built.
 *
 * Called once at boot with top-level await, so `VehicleMesh` stays synchronous
 * — it is constructed mid-race when a rival spawns, and threading a promise
 * through that would put a frame of empty road where a car should be.
 */
export async function loadHulls(base = 'bodies/') {
  const got = await Promise.all(HULL_NAMES.map(async (n) => {
    const res = await fetch(`${base}${n}.bin`);
    if (!res.ok) throw new Error(`${base}${n}.bin: HTTP ${res.status}`);
    return [n, parseHull(await res.arrayBuffer())];
  }));
  for (const [n, hull] of got) HULLS[n] = hull;
  // The hand marks that go with them. A body with none is the normal case.
  await loadMarks(HULL_NAMES);
  return HULLS;
}
