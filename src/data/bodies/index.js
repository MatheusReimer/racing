// Car bodies, decimated off reference cars by tools/decimate.mjs.
//
// Binary rather than source. Fifty thousand triangles is a megabyte of
// coordinates; printed as decimal it would cost half again in size and a parse
// of the whole thing at boot, for numbers no one will ever read in a diff.
//
// These are derivative geometry — the reference's own surface with fewer
// vertices in it, not a measurement of a car — so the reference's licence
// reaches the game. The 205 GTI, MX-5 (NA), Impreza GC8 and Beetle are CC-BY
// and want crediting; the S15 is CC BY-NC-SA, which is non-commercial and
// share-alike. refs/README.txt carries the provenance.

export const HULL_NAMES = ['hatch', 'coupe', 'roadster', 'rally', 'beetle'];
const MAGIC = 0x524c4852;

/** @type {Record<string, {positions: Float32Array, indices: Uint32Array,
 *   classes: Uint8Array, length: number, width: number, height: number,
 *   ground: number, wheel: {radius, width, front, rear} | null }>} */
export const HULLS = {};

/**
 * Read one body file. Exported so the headless tools can feed `HULLS` from disk
 * — they run in Node, where there is no relative URL to fetch, and a probe that
 * quietly fell back to the generated route would be testing the wrong car.
 */
export function parseHull(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a body file');
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`body file version ${version} is not readable here`);
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
  return HULLS;
}
