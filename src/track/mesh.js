import * as THREE from 'three';
import { buildBlockTerrain, buildBlockVerge, terrainRoll } from './terrain.js';
import { buildHouse } from '../world/rooms.js';
import { RNG } from '../core/rng.js';
import { paintMarkings } from './markings.js';
import { asphaltTexture, groundTexture, roadNormal } from '../materials/noise.js';
import { BARRIER_RAIL_OFFSET, ROAD_LIFT, BRANCH_LIFT } from './track.js';
import { clamp, clamp01, lerp, wrap } from '../core/math.js';

// Turns a Track into geometry.
//
// The whole circuit is a handful of merged meshes — road, kerbs, barriers,
// ground — rather than per-segment objects. A 2 km lap sampled every 3 m is
// ~660 rings; as individual meshes that is 660 draw calls and 660 matrix
// updates per frame for geometry that never moves. Merged, it is four.
//
// Lane markings are baked into vertex colours rather than a second texture or
// a decal pass. The road is sampled 9 vertices across specifically so there is
// somewhere to put an edge line and a dashed centre without any extra cost.

const RING_SPACING = 3.0;   // metres between cross-sections
const ROAD_COLS = 9;        // vertices across the road
const BARRIER_HEIGHT = 1.35;

/**
 * How far the road surface floats above the path it is built from.
 *
 * Exported because anything laid *on* the road — light pools, decals — has to
 * clear this, and `Track.groundAt` reports the path height rather than the
 * surface height. A decal placed against `groundAt` alone is a centimetre under
 * the tarmac and disappears wherever the depth buffer is precise enough to say
 * so, which is exactly where the player is looking.
 */
/** Where lane paint sits, as a fraction of half-width from the centre. */
// Road markings are drawn by the road's own shader, from where a fragment is
// across the road and how far along it — see `paintMarkings`.
//
// They used to be a brightness multiplier on the vertex colours. There are nine
// vertices across a road twenty-four metres wide, so a "line" was a three-metre
// gradient that read as a vague pale band, could only ever be brighter-than-
// asphalt rather than yellow, and could not be a dash, an arrow or a stop line
// at all. Computing them per fragment costs no geometry, no draw call, and is
// crisp at any distance because the width is set in metres rather than in
// vertices.

function buildRibbon(path, lengthOf, halfWidthAt, opts = {}) {
  // 0 main line, 1 a branch off it, 2 the pit lane. Three values rather than a
  // flag because the three are painted differently, and the shader is the only
  // thing that knows how to paint anything.
  const { isBranch = false, closed = true, lift = ROAD_LIFT } = opts;
  const laneKind = isBranch === true ? 1 : (isBranch || 0);
  const L = lengthOf;
  const rings = Math.max(4, Math.floor(L / RING_SPACING));
  const cols = ROAD_COLS;

  const vertCount = (rings + (closed ? 0 : 1)) * cols;
  const pos = new Float32Array(vertCount * 3);
  const nor = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const col = new Float32Array(vertCount * 3);
  const lane = new Float32Array(vertCount * 4);

  const p = { x: 0, y: 0, z: 0 };
  const t = { x: 0, z: 0 };
  const ringCount = rings + (closed ? 0 : 1);

  for (let i = 0; i < ringCount; i++) {
    const s = (i / rings) * L;
    path.pointAt(s, p);
    path.tangentAt(s, t);
    const nx = t.z, nz = -t.x;      // right-hand normal
    const hw = halfWidthAt(s);

    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;   // -1..1
      const k = (i * cols + j);
      pos[k * 3] = p.x + nx * u * hw;
      pos[k * 3 + 1] = p.y + lift;
      pos[k * 3 + 2] = p.z + nz * u * hw;
      nor[k * 3] = 0; nor[k * 3 + 1] = 1; nor[k * 3 + 2] = 0;
      // Tile in metres so the aggregate keeps a constant real-world scale
      // regardless of how wide this stretch of road is. 0.45 puts one texture
      // repeat every ~2.2 m, which is the scale asphalt actually has.
      uv[k * 2] = u * hw * 0.45;
      uv[k * 2 + 1] = s * 0.45;
      // Where this vertex is on the road, in metres, for the marking shader.
      lane[k * 4] = u;
      lane[k * 4 + 1] = s;
      lane[k * 4 + 2] = hw;
      lane[k * 4 + 3] = laneKind;
      col[k * 3] = 1; col[k * 3 + 1] = 1; col[k * 3 + 2] = 1;
    }
  }

  const quads = (closed ? rings : rings) * (cols - 1);
  const idx = new Uint32Array(quads * 6);
  let w = 0;
  for (let i = 0; i < rings; i++) {
    const i0 = i * cols;
    const i1 = (closed ? ((i + 1) % rings) : (i + 1)) * cols;
    for (let j = 0; j < cols - 1; j++) {
      const a = i0 + j, b = i0 + j + 1, c = i1 + j, d = i1 + j + 1;
      idx[w++] = a; idx[w++] = c; idx[w++] = b;
      idx[w++] = b; idx[w++] = c; idx[w++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aLane', new THREE.BufferAttribute(lane, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Guard rail: two horizontal rails on posts, swept along the road.
 *
 * The first version was a single extruded wall two vertices tall, with the
 * bright accent on the upper row. Interpolating between a dark base and a
 * bright top over the whole height produced one continuous saturated band —
 * more of a painted stripe than a barrier, and it dominated every frame.
 *
 * Splitting it into a thin bright top rail, a dark lower rail and visible posts
 * gives the eye something to measure speed against, and reads as built rather
 * than painted.
 */
function buildBarrier(track, lengthOf, offsetAt, accent, closed = true) {
  /**
   * Whether a point on the rail line is standing in a road.
   *
   * Only the main line is railed, and its outer rail on a corner runs straight
   * through any shortcut that cuts that corner — fifty-two samples of it, up to
   * five metres inside another road. From the driver's seat that is a
   * red-and-white barrier in the middle of the tarmac, and it was: the mesh
   * follows the racing line and has never been asked what else is out there.
   *
   * Suppressing those segments also opens the rail where a shortcut leaves the
   * main line, which it has to be: the simulation lets a car onto a branch and
   * the rail was drawn straight across the entrance.
   */
  const otherRoads = (track.branches ?? []).map((b) => ({
    path: b.path,
    halfWidth: b.halfWidth,
  }));
  const railScratch = { s: 0, dist: 0, side: 0 };
  const inAnotherRoad = (x, z) => {
    for (const road of otherRoads) {
      const q = road.path.project(x, z, railScratch);
      if (q.s <= 0.01 || q.s >= road.path.length - 0.01) continue;
      if (Math.abs(q.side) < road.halfWidth + 1.0) return true;
    }
    return false;
  };

  const L = lengthOf;
  const rings = Math.max(8, Math.floor(L / 2.2));
  const path = track.path;

  // Two rails, each a thin band; posts every few rings.
  const RAILS = [
    { y0: 0.62, y1: 0.86, bright: false },
    { y0: 0.98, y1: 1.26, bright: true },
  ];
  const POST_EVERY = 3;

  const verts = [];
  const cols = [];
  const dark = new THREE.Color(0x2a2f35);
  const post = new THREE.Color(0x43494f);
  const bright = new THREE.Color(accent);
  const pale = new THREE.Color(0xe8e6e0);

  const p0 = { x: 0, y: 0, z: 0 };
  const p1 = { x: 0, y: 0, z: 0 };
  const t0 = { x: 0, z: 0 };
  const t1 = { x: 0, z: 0 };

  const quad = (a, b, c, d, colour) => {
    // Two triangles, non-indexed so every face keeps its own normal.
    for (const v of [a, b, c, a, c, d]) verts.push(v[0], v[1], v[2]);
    for (let i = 0; i < 6; i++) cols.push(colour.r, colour.g, colour.b);
  };

  for (let i = 0; i < rings; i++) {
    const sA = (i / rings) * L;
    const sB = ((i + 1) / rings) * L;
    if (!closed && sB > L) break;

    path.pointAt(sA, p0); path.tangentAt(sA, t0);
    path.pointAt(sB, p1); path.tangentAt(sB, t1);
    const nA = { x: t0.z, z: -t0.x };
    const nB = { x: t1.z, z: -t1.x };
    const oA = offsetAt(sA);
    const oB = offsetAt(sB);

    const ax = p0.x + nA.x * oA, az = p0.z + nA.z * oA;
    const bx = p1.x + nB.x * oB, bz = p1.z + nB.z * oB;

    // A rail standing in another road is not a rail, it is an obstacle.
    if (inAnotherRoad(ax, az) || inAnotherRoad(bx, bz)) continue;

    for (const rail of RAILS) {
      // Alternate the bright rail so it flickers past as speed cues.
      const on = Math.floor(sA / 4.5) % 2 === 0;
      const colour = rail.bright ? (on ? bright : pale) : dark;
      quad(
        [ax, p0.y + rail.y0, az],
        [bx, p1.y + rail.y0, bz],
        [bx, p1.y + rail.y1, bz],
        [ax, p0.y + rail.y1, az],
        colour,
      );
    }

    // Posts.
    if (i % POST_EVERY === 0) {
      const w = 0.14;
      const px = nA.x * w, pz = nA.z * w;
      // A slab facing the road is enough at this scale, and costs 2 triangles.
      quad(
        [ax - px, p0.y, az - pz],
        [ax + px, p0.y, az + pz],
        [ax + px, p0.y + 1.3, az + pz],
        [ax - px, p0.y + 1.3, az - pz],
        post,
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Ground verge: a wide ribbon that follows the road outward on both sides.
 *
 * The obvious implementation — a displaced grid, projecting every vertex onto
 * the path to find its elevation — costs one `Path.project()` per vertex. At a
 * usable density that is ~9000 projections, which blocks the main thread for
 * seconds at track load and delays the race start.
 *
 * Sweeping the path instead gives elevation for free: the ring already knows
 * its `s`, so the road height is just `pointAt(s).y`. It is O(rings x columns)
 * with no searching at all, and the terrain is guaranteed to meet the road
 * exactly rather than approximately.
 *
 * Vertex colours here are *modulation only*, never the base colour — the
 * texture already carries that, and applying it twice multiplies two linear
 * values below 0.3 together and turns the desert black.
 */
/**
 * Ground relief away from the road, as a function of world position.
 *
 * Two sine terms gave smooth swells the eye reads as a bedsheet. Four octaves
 * at roughly halving wavelengths give the same overall shape with edges in it,
 * which is what makes the faceted style work on terrain as well as on props.
 * Shared with the distant ground so the two cannot disagree at the seam.
 */

// Dense where the eye can resolve it, sparse where fog is already taking over.
// Going denser than this all the way out cost roughly a quarter of the low
// tier's real-time headroom for detail that sits behind fog: vertex count, not
// extent, is what the ground charges for.


/**
 * Far-field fill. The verge covers what the player can resolve; this plane
 * sits under everything else so the interior of the circuit and the deep
 * distance are never empty sky. It is two triangles and is almost entirely
 * consumed by fog.
 */
function buildBackdrop(track, biome) {
  let minY = Infinity, cx = 0, cz = 0, n = 0;
  const p = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < track.length; s += 25) {
    track.path.pointAt(s, p);
    if (p.y < minY) minY = p.y;
    cx += p.x; cz += p.z; n++;
  }
  cx /= n; cz /= n;

  // Far enough below that the verge's deepest trough cannot expose it. A fixed
  // 14 m did not clear it: the trough is `roll * elevation * 0.42`, and roll
  // reaches about -2.9, so a high-elevation biome dips well past 14 m and the
  // flat sheet punched through the terrain.
  const elev = biome?.elevation ?? 8;
  const geo = new THREE.PlaneGeometry(3200, 3200, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(cx, minY - (elev * 1.3 + 16), cz);
  const c = new Float32Array(geo.attributes.position.count * 3).fill(0.92);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Start/finish gantry line across the road. */
function buildStartLine(track) {
  const s = track.startS;
  const hw = track.halfWidthAt(s);
  const geo = new THREE.PlaneGeometry(hw * 2, 3.2, 16, 1);
  geo.rotateX(-Math.PI / 2);

  const col = new Float32Array(geo.attributes.position.count * 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / hw;   // -1..1
    const check = Math.floor((u + 1) * 8) % 2 === 0;
    const c = check ? 1.0 : 0.06;
    col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const p = track.path.pointAt(s, { x: 0, y: 0, z: 0 });
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, toneMapped: false,
  }));
  mesh.position.set(p.x, p.y + 0.09, p.z);
  mesh.rotation.y = track.path.yawAt(s);
  return mesh;
}

export class TrackMesh {
  constructor(track, biome, quality) {
    this.track = track;
    this.group = new THREE.Group();
    this.materials = [];

    const pal = biome.palette;
    const aniso = quality?.anisotropy ?? 4;

    // --- road ---
    const roadTex = asphaltTexture(pal.road, 7 + (biome.order || 0) * 13);
    roadTex.anisotropy = aniso;
    const roadNor = roadNormal(3 + (biome.order || 0));
    roadNor.anisotropy = aniso;

    this.roadMat = new THREE.MeshStandardMaterial({
      map: roadTex,
      normalMap: roadNor,
      // A wet road is smooth, so its bumps have to be turned down with it.
      // Leaving the normal map at full strength while dropping roughness to
      // 0.16 put a specular highlight on every bump in the texture, which at a
      // grazing angle reads as a field of orange glitter rather than as tarmac.
      normalScale: pal.wet ? new THREE.Vector2(0.12, 0.12) : new THREE.Vector2(0.4, 0.4),
      vertexColors: true,
      // Wet districts reflect. This is the single largest reason Underground
      // looks the way it does: the road is the brightest surface in frame
      // because it is a mirror for every light above it, not because it is lit.
      roughness: pal.wet ? 0.30 : 0.9,
      metalness: pal.wet ? 0.45 : 0.02,
    });
    paintMarkings(this.roadMat, pal, track);
    this.materials.push(this.roadMat);

    // A stripped biome draws no track at all — not the ribbon, not the pit
    // lane, not the barriers, not the start line. The materials above are
    // still built because `dispose` and the marking painter expect them, and
    // an empty group is cheaper than a special case in five other places.
    //
    // Only the drawing goes. `track` itself is untouched: the path, the widths,
    // the branches and `groundAt` are all still there, so the car still drives
    // a circuit and the simulation cannot tell the difference. What is gone is
    // every triangle of it.
    // Indoors there is no road. The floor is the surface the car drives on and
    // the route across it is marked by what is standing beside it, not by a
    // strip of tarmac laid over the tiles — which is what this looked like
    // when it drew both: a kitchen with a B-road through it.
    const roadGeo = (biome.stripped || biome.indoor)
      ? null : buildRibbon(track.path, track.length, (s) => track.halfWidthAt(s), {});
    if (roadGeo) {
      const road = new THREE.Mesh(roadGeo, this.roadMat);
      road.receiveShadow = !!quality?.shadows;
      road.matrixAutoUpdate = false;
      this.group.add(road);
    }

    // --- branches ---
    for (const br of ((biome.stripped || biome.indoor) ? [] : track.branches)) {
      const g = buildRibbon(br.path, br.path.length, () => br.halfWidth, {
        isBranch: br.isPit ? 2 : true, closed: false, lift: BRANCH_LIFT,
      });
      const m = new THREE.Mesh(g, this.roadMat);
      m.receiveShadow = !!quality?.shadows;
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }

    // --- barriers ---
    this.barrierMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.25, flatShading: true,
      // Rails are thin slabs, so the far side has to draw too.
      side: THREE.DoubleSide,
    });
    this.materials.push(this.barrierMat);

    for (const side of (biome.stripped ? [] : [-1, 1])) {
      const g = buildBarrier(
        track, track.length,
        (s) => side * (track.halfWidthAt(s) + BARRIER_RAIL_OFFSET),
        pal.accent,
      );
      const m = new THREE.Mesh(g, this.barrierMat);
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }

    // --- ground ---
    const groundTex = groundTexture(pal.ground, pal.groundAlt, 21 + (biome.order || 0) * 5, 256,
      biome.id === 'desert' ? 5 : 3, biome.city ? 0.07 : 0.28);
    groundTex.anisotropy = aniso;
    // Flat-shaded terrain: the verge is a coarse sweep, and averaging its
    // normals turns deliberate facets into a soft blur, which is the opposite
    // of the look.
    this.groundMat = new THREE.MeshStandardMaterial({
      map: groundTex, vertexColors: true, roughness: 0.96, metalness: 0.0,
      flatShading: true,
    });
    this.materials.push(this.groundMat);

    // A stripped biome gets no ground at all: no near band, no blocks, no
    // backdrop plane. The road is left hanging over nothing, which is the
    // point — it is the only way to see what the road and the barriers
    // actually contribute before anything is built back around them.
    if (!biome.stripped && !biome.indoor) {
      const verge = new THREE.Mesh(buildBlockVerge(track, biome, quality), this.groundMat);
      verge.receiveShadow = !!quality?.shadows;
      verge.matrixAutoUpdate = false;
      verge.renderOrder = -10;
      this.group.add(verge);

      // And the blocks, from where the ribbon stops out to the fog.
      const blocks = new THREE.Mesh(buildBlockTerrain(track, biome, quality), this.groundMat);
      blocks.receiveShadow = !!quality?.shadows;
      blocks.matrixAutoUpdate = false;
      blocks.renderOrder = -15;
      this.group.add(blocks);

      const backdrop = new THREE.Mesh(buildBackdrop(track, biome), this.groundMat);
      backdrop.matrixAutoUpdate = false;
      backdrop.renderOrder = -20;
      this.group.add(backdrop);
    }

    // --- the house itself ---
    //
    // Floors and walls, built from the same room ring the centreline was
    // threaded through so the two cannot drift apart. Indoors this is what the
    // verge and the barriers are outdoors: it is the container, not scenery.
    if (biome.indoor && track.layout?.rooms) {
      this.house = buildHouse(track, biome, new RNG(`house:${biome.id}`));
      if (this.house) {
        this.group.add(this.house);
        this.materials.push(this.house.userData.material);
      }
    }

    // --- start line ---
    if (!biome.stripped) this.group.add(buildStartLine(track));

    this.group.updateMatrixWorld(true);
  }

  addTo(scene) {
    scene.add(this.group);
    return this;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.group.parent?.remove(this.group);
  }
}
