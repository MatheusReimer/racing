import * as THREE from 'three';
import { buildPropLibrary, disposePropLibrary, PROP_TYPES } from './props.js';
import { triCount } from './shapes.js';

// Draws the scattered props.
//
// One InstancedMesh per (type, variant), so three hundred props are about
// fifteen draw calls rather than three hundred. Instancing is the only reason
// the map can be this dense at all — a Mesh per prop would cost a draw call and
// a matrix upload each, and the whole CPU budget would go to submitting them.
//
// Destroyed props are hidden by collapsing their instance matrix to zero scale
// rather than by rebuilding the buffer: an InstancedMesh cannot cheaply remove
// an element, and a zero-scaled instance is culled by the rasteriser for free.

export class PropsMesh {
  constructor(props, biome, quality, seed = 1) {
    this.group = new THREE.Group();
    this.props = props;
    this.library = buildPropLibrary(biome, seed);

    // Bucket by type, detail level and variant: one instanced draw per bucket.
    //
    // The detail level is part of the key because instancing shares a single
    // geometry — two props of the same type at different distances cannot be
    // drawn together, which is the price of LOD here and is why the far levels
    // deliberately carry fewer variants.
    const buckets = new Map();
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      const entry = this.library[p.type];
      if (!entry) continue;
      const levels = entry.levels ?? [entry.variants];
      const lod = Math.min(p.lod ?? 0, levels.length - 1);
      const pool = levels[lod]?.length ? levels[lod] : levels[0];
      const variant = (p.variant ?? 0) % pool.length;
      const key = `${p.type}:${lod}:${variant}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { type: p.type, variant, lod, entry, geo: pool[variant], indices: [] };
        buckets.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    this.instances = [];
    this.byProp = new Map();
    // One shared unlit material for every glowing prop: they differ by geometry
    // and vertex colour, not by material.
    this._glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    let tris = 0;

    for (const bucket of buckets.values()) {
      const geo = bucket.geo;
      const mesh = new THREE.InstancedMesh(geo, bucket.entry.material, bucket.indices.length);
      mesh.castShadow = !!quality?.shadows;
      mesh.receiveShadow = false;
      // Props never move, so Three should not recompute their world matrices.
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;

      bucket.indices.forEach((propIndex, slot) => {
        const p = this.props[propIndex];
        pos.set(p.x, p.y, p.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
        // A gantry is built to span the road it stands on, so its lateral scale
        // comes from the track width rather than from the usual jitter.
        const sx = p.spanScale ? p.spanScale / 11 : p.scale;
        scl.set(sx, p.scale, p.scale);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(slot, m);
        this.byProp.set(propIndex, {
          mesh, slot, scale: p.scale, spanScale: p.spanScale, bucket,
        });
      });

      mesh.instanceMatrix.needsUpdate = true;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.instances.push(mesh);
      tris += triCount(geo) * bucket.indices.length;

      // The unlit pass, sharing this bucket's transforms exactly so a lamp head
      // can never drift from the lamp it belongs to.
      const glowPool = bucket.entry.glowLevels?.[bucket.lod];
      if (glowPool?.length) {
        const gGeo = glowPool[bucket.variant % glowPool.length];
        const gMesh = new THREE.InstancedMesh(gGeo, this._glowMat, bucket.indices.length);
        gMesh.matrixAutoUpdate = false;
        gMesh.frustumCulled = true;
        gMesh.instanceMatrix.copy(mesh.instanceMatrix);
        gMesh.instanceMatrix.needsUpdate = true;
        gMesh.updateMatrix();
        this.group.add(gMesh);
        this.instances.push(gMesh);
        bucket.glowMesh = gMesh;
        tris += triCount(gGeo) * bucket.indices.length;
      }
    }

    // Emissive props (braziers) get a second, unlit pass so they actually glow.
    this._buildEmissive(quality);

    const byLod = [0, 0, 0];
    for (const p of props) byLod[Math.min(p.lod ?? 0, 2)]++;
    this.stats = {
      props: props.length,
      draws: this.instances.length,
      tris,
      types: buckets.size,
      byLod,
    };
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._dirty = new Set();
  }

  _buildEmissive(quality) {
    const glowing = this.props
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.emissive != null);
    if (glowing.length === 0) return;

    const geo = new THREE.IcosahedronGeometry(0.55, 0);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    const mesh = new THREE.InstancedMesh(geo, mat, glowing.length);
    mesh.matrixAutoUpdate = false;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);

    glowing.forEach(({ p, i }, slot) => {
      pos.set(p.x, p.y + (PROP_TYPES[p.type]?.height ?? 2) * 0.92 * p.scale, p.z);
      scl.setScalar(p.scale);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(slot, m);
      mesh.setColorAt(slot, new THREE.Color(p.emissive));
      // Share the destruction bookkeeping so a smashed brazier goes dark.
      const existing = this.byProp.get(i);
      if (existing) existing.glow = { mesh, slot };
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.updateMatrix();

    this.group.add(mesh);
    this.emissiveMesh = mesh;
    this.emissiveGeo = geo;
    this.emissiveMat = mat;
  }

  /**
   * Hide anything the simulation has destroyed. Called each frame; costs one
   * pass over the prop list and only touches the GPU when something changed.
   */
  syncDestroyed() {
    let changed = false;
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.alive || p._hidden) continue;
      const ref = this.byProp.get(i);
      if (!ref) { p._hidden = true; continue; }
      ref.mesh.setMatrixAt(ref.slot, this._zero);
      this._dirty.add(ref.mesh);
      if (ref.bucket?.glowMesh) {
        ref.bucket.glowMesh.setMatrixAt(ref.slot, this._zero);
        this._dirty.add(ref.bucket.glowMesh);
      }
      if (ref.glow) {
        ref.glow.mesh.setMatrixAt(ref.glow.slot, this._zero);
        this._dirty.add(ref.glow.mesh);
      }
      p._hidden = true;
      changed = true;
    }
    if (changed) {
      for (const mesh of this._dirty) mesh.instanceMatrix.needsUpdate = true;
      this._dirty.clear();
    }
  }

  addTo(scene) {
    scene.add(this.group);
    return this;
  }

  dispose() {
    for (const mesh of this.instances) mesh.dispose();
    this.instances.length = 0;
    this.emissiveMesh?.dispose();
    this.emissiveGeo?.dispose();
    this.emissiveMat?.dispose();
    this._glowMat.dispose();
    disposePropLibrary(this.library);
    this.group.parent?.remove(this.group);
  }
}
