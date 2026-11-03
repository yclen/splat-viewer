import * as THREE from "three";

// Invisible block world built from the splats, used for walking collision.
// A block is solid when enough reasonably opaque, reasonably small splats sit in it,
// so faint haze, giant blurry blobs and lone floaters don't turn into walls.
export class VoxelGrid {
  constructor(min, size, dims, solid) {
    this.min = min;          // world position of the grid's low corner
    this.size = size;        // edge length of one block
    this.dims = dims;        // [nx, ny, nz]
    this.solid = solid;      // Uint8Array, 1 = solid
    this.solidCount = solid.reduce((n, v) => n + v, 0);
  }

  index(ix, iy, iz) {
    return ix + this.dims[0] * (iy + this.dims[1] * iz);
  }

  // Outside the grid counts as empty air, so you can walk off the edge.
  isSolidCell(ix, iy, iz) {
    const [nx, ny, nz] = this.dims;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
    return this.solid[this.index(ix, iy, iz)] === 1;
  }

  cellOf(v, axis) {
    return Math.floor((v - this.min.getComponent(axis)) / this.size);
  }

  isSolidAt(x, y, z) {
    return this.isSolidCell(this.cellOf(x, 0), this.cellOf(y, 1), this.cellOf(z, 2));
  }

  boxHitsSolid(x0, y0, z0, x1, y1, z1) {
    const ix0 = this.cellOf(x0, 0), ix1 = this.cellOf(x1, 0);
    const iy0 = this.cellOf(y0, 1), iy1 = this.cellOf(y1, 1);
    const iz0 = this.cellOf(z0, 2), iz1 = this.cellOf(z1, 2);
    for (let iz = iz0; iz <= iz1; iz++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let ix = ix0; ix <= ix1; ix++)
          if (this.isSolidCell(ix, iy, iz)) return true;
    return false;
  }

  // How far you can travel from `from` toward `to` before entering a solid block.
  freeDistance(from, to) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = dir.length();
    if (length === 0) return 0;
    dir.divideScalar(length);
    const step = this.size * 0.5;
    const p = new THREE.Vector3();
    for (let t = step; t <= length; t += step) {
      p.copy(from).addScaledVector(dir, t);
      if (this.isSolidAt(p.x, p.y, p.z)) return Math.max(0, t - step);
    }
    return length;
  }

  // Feet position of a good standing spot near (x, z): a solid block with enough
  // empty blocks above it for the player, picked closest to refY (preferring below).
  findSpawn(x, z, refY, height) {
    const [nx, ny, nz] = this.dims;
    const headroom = Math.ceil(height / this.size) + 1;
    const cx = THREE.MathUtils.clamp(this.cellOf(x, 0), 0, nx - 1);
    const cz = THREE.MathUtils.clamp(this.cellOf(z, 2), 0, nz - 1);

    const standingSpots = (ix, iz) => {
      const spots = [];
      for (let iy = 0; iy < ny; iy++) {
        if (!this.isSolidCell(ix, iy, iz) || this.isSolidCell(ix, iy + 1, iz)) continue;
        let free = true;
        for (let k = 1; k <= headroom && free; k++) free = !this.isSolidCell(ix, iy + k, iz);
        if (free) spots.push(this.min.y + (iy + 1) * this.size);
      }
      return spots;
    };

    // Search outward in rings. A spot at or below refY wins as soon as one turns up;
    // spots above it (like the top of a ceiling) are only a fallback.
    let above = null;
    for (let r = 0; r < Math.max(nx, nz); r++) {
      let best = null;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx, iz = cz + dz;
          if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
          for (const y of standingSpots(ix, iz)) {
            const pos = new THREE.Vector3(this.min.x + (ix + 0.5) * this.size, y, this.min.z + (iz + 0.5) * this.size);
            const score = Math.abs(y - refY);
            if (y <= refY + height * 0.25) {
              if (!best || score < best.score) best = { score, pos };
            } else if (!above || score < above.score) {
              above = { score, pos };
            }
          }
        }
      }
      if (best) return best.pos;
    }
    return above?.pos ?? null;
  }

  // Block centers, for the "show collision" debug view.
  solidCenters() {
    const [nx, ny, nz] = this.dims;
    const out = new Float32Array(this.solidCount * 3);
    let o = 0;
    for (let iz = 0; iz < nz; iz++)
      for (let iy = 0; iy < ny; iy++)
        for (let ix = 0; ix < nx; ix++)
          if (this.solid[this.index(ix, iy, iz)]) {
            out[o++] = this.min.x + (ix + 0.5) * this.size;
            out[o++] = this.min.y + (iy + 0.5) * this.size;
            out[o++] = this.min.z + (iz + 0.5) * this.size;
          }
    return out;
  }
}

const MAX_CELLS = 32_000_000;

export function buildVoxelGrid(mesh, {
  blockSize = 0.05,
  minOpacity = 0.15,
  minSplats = 1,
  maxSplatSize = 1,
  fillHoles = true,
  addFloor = true,
  headroom = 2,
} = {}) {
  // Refresh parents too: the orientation lives on the parent group and may have
  // changed since the last rendered frame.
  mesh.updateWorldMatrix(true, false);
  const toWorld = mesh.matrixWorld;

  // Pass 1: world positions of splats that look like real surface.
  const positions = [];
  const p = new THREE.Vector3();
  mesh.forEachSplat((index, center, scales, quaternion, opacity) => {
    if (opacity < minOpacity) return;
    if (Math.max(scales.x, scales.y, scales.z) > maxSplatSize) return;
    p.copy(center).applyMatrix4(toWorld);
    positions.push(p.x, p.y, p.z);
  });
  const count = positions.length / 3;
  if (count === 0) throw new Error("No splats passed the solidity filters");

  // Bounds from the 0.5–99.5 percentile so distant floaters don't bloat the grid.
  const lo = new THREE.Vector3(), hi = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    const vals = new Float32Array(Math.ceil(count / 4));
    for (let i = 0, j = 0; i < count; i += 4, j++) vals[j] = positions[i * 3 + axis];
    vals.sort();
    lo.setComponent(axis, vals[Math.floor(vals.length * 0.005)]);
    hi.setComponent(axis, vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))]);
  }
  // Room above the highest surface so you can stand on top of things.
  hi.y += headroom;

  let size = blockSize;
  const extent = new THREE.Vector3().subVectors(hi, lo);
  const cellsFor = (s) => Math.ceil(extent.x / s + 1) * Math.ceil(extent.y / s + 1) * Math.ceil(extent.z / s + 1);
  while (cellsFor(size) > MAX_CELLS) size *= 1.25;

  const min = lo.clone().subScalar(size);
  const dims = [
    Math.ceil(extent.x / size) + 3,
    Math.ceil(extent.y / size) + 3,
    Math.ceil(extent.z / size) + 3,
  ];
  const [nx, ny, nz] = dims;

  // Pass 2: count splats per block.
  const counts = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < count; i++) {
    const ix = Math.floor((positions[i * 3] - min.x) / size);
    const iy = Math.floor((positions[i * 3 + 1] - min.y) / size);
    const iz = Math.floor((positions[i * 3 + 2] - min.z) / size);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
    const k = ix + nx * (iy + ny * iz);
    if (counts[k] < 255) counts[k]++;
  }

  const solid = new Uint8Array(counts.length);
  for (let k = 0; k < counts.length; k++) solid[k] = counts[k] >= minSplats ? 1 : 0;

  // Plug one-block pinholes in floors and walls (solid on both sides along an axis)
  // without thickening the surfaces.
  let result = solid;
  if (fillHoles) {
    result = solid.slice();
    const strideY = nx, strideZ = nx * ny;
    for (let iz = 1; iz < nz - 1; iz++)
      for (let iy = 1; iy < ny - 1; iy++)
        for (let ix = 1; ix < nx - 1; ix++) {
          const k = ix + strideY * iy + strideZ * iz;
          if (solid[k]) continue;
          if ((solid[k - 1] && solid[k + 1]) ||
              (solid[k - strideY] && solid[k + strideY]) ||
              (solid[k - strideZ] && solid[k + strideZ])) result[k] = 1;
        }
  }

  // Scanned floors are often patchy. Find the floor (the lowest height layer with
  // at least half as many blocks as the busiest layer) and make it fully solid.
  let floorY = null;
  if (addFloor) {
    const perLayer = new Array(ny).fill(0);
    for (let iz = 0; iz < nz; iz++)
      for (let iy = 0; iy < ny; iy++)
        for (let ix = 0; ix < nx; ix++)
          if (result[ix + nx * (iy + ny * iz)]) perLayer[iy]++;
    const busiest = Math.max(...perLayer);
    const floorLayer = perLayer.findIndex((n) => n >= busiest * 0.5);
    if (floorLayer >= 0) {
      for (let iz = 0; iz < nz; iz++)
        for (let ix = 0; ix < nx; ix++) result[ix + nx * (floorLayer + ny * iz)] = 1;
      floorY = min.y + (floorLayer + 1) * size;
    }
  }

  const grid = new VoxelGrid(min, size, dims, result);
  grid.floorY = floorY;
  return grid;
}
