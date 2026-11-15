import type { TriMesh } from '../core/types';

/**
 * Conservative uniform-grid spatial index over triangle AABBs.
 *
 * Each triangle's AABB is inserted into every grid cell it overlaps. Two
 * triangles can only intersect when their AABBs overlap, and overlapping AABBs
 * always share at least one cell, so the emitted candidate set is exactly the
 * box-overlapping pairs — a conservative superset of the truly intersecting
 * pairs. Thin parallel sheets and triangles meeting at concave corners have
 * overlapping boxes and are therefore always reported as candidates; the cell
 * size only changes speed, never correctness.
 *
 * A triangle whose box would span more than MAX_CELLS_PER_TRIANGLE cells (a
 * pathological giant next to fine tessellation) is kept in an overflow list
 * and paired against every triangle instead, which is equally conservative
 * and bounds memory.
 *
 * The index supports incremental maintenance: after a local mesh edit, only
 * the affected triangles are re-hashed (`updateTriangles`), and only pairs
 * involving them need re-testing (`forEachCandidatePairInvolving`).
 */
const MAX_CELLS_PER_TRIANGLE = 512;
const MAX_CELL_COORD = 131071;

export class TriangleIntersectionIndex {
  readonly triangleCount: number;
  readonly cellSize: number;
  /** 6 floats per triangle: min xyz then max xyz. */
  private boxes: Float32Array;
  private cells = new Map<number, number[]>();
  /** Cell keys per triangle, remembered so updates can remove stale entries. */
  private triCells: number[][];
  /** Triangles too large to hash; paired against everything. */
  private overflow = new Set<number>();
  private origin: [number, number, number];
  private invCellSize: number;

  constructor(mesh: TriMesh, opts: { cellSize?: number } = {}) {
    this.triangleCount = mesh.triangleCount;
    this.boxes = new Float32Array(this.triangleCount * 6);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
    // The pad keeps every initial coordinate strictly inside cell >= 0; edits
    // that move vertices past the origin clamp into cell 0 (a conservative
    // merge, never a miss).
    const pad = extent * 1e-6;
    this.origin = [minX - pad, minY - pad, minZ - pad];
    const recommended = TriangleIntersectionIndex.recommendCellSize(mesh);
    const requested = opts.cellSize ?? recommended;
    // Clamp so cell coordinates stay within the 17-bit-per-axis key space.
    this.cellSize = Math.min(Math.max(requested, extent / 4096), extent);
    this.invCellSize = 1 / this.cellSize;
    this.triCells = new Array(this.triangleCount);
    for (let t = 0; t < this.triangleCount; t++) {
      this.computeBox(mesh, t);
      this.triCells[t] = this.insert(t);
    }
  }

  /**
   * Median longest-axis extent of the triangle boxes. Balances insert cost
   * against pairs per cell; any value keeps the candidate set conservative.
   */
  static recommendCellSize(mesh: TriMesh): number {
    const n = mesh.triangleCount;
    if (n === 0) return 1;
    const extents = new Float64Array(n);
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < n; t++) {
      let loX = Infinity, loY = Infinity, loZ = Infinity;
      let hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        const x = p[v], y = p[v + 1], z = p[v + 2];
        if (x < loX) loX = x;
        if (y < loY) loY = y;
        if (z < loZ) loZ = z;
        if (x > hiX) hiX = x;
        if (y > hiY) hiY = y;
        if (z > hiZ) hiZ = z;
      }
      extents[t] = Math.max(hiX - loX, hiY - loY, hiZ - loZ);
    }
    extents.sort();
    const median = extents[n >> 1];
    return median > 0 ? median : 1;
  }

  /** Re-hash the given triangles after their vertices moved. */
  updateTriangles(mesh: TriMesh, triangles: Iterable<number>): void {
    for (const t of triangles) {
      if (t < 0 || t >= this.triangleCount) continue;
      const oldKeys = this.triCells[t];
      if (oldKeys) {
        for (const key of oldKeys) {
          const list = this.cells.get(key);
          if (!list) continue;
          const at = list.indexOf(t);
          if (at !== -1) {
            list[at] = list[list.length - 1];
            list.pop();
          }
          if (list.length === 0) this.cells.delete(key);
        }
      }
      this.overflow.delete(t);
      this.computeBox(mesh, t);
      this.triCells[t] = this.insert(t);
    }
  }

  /**
   * Visit every AABB-overlapping pair (a, b) with a < b exactly once.
   * A pair is emitted only from the cell holding the minimum corner of the
   * two boxes' overlap region, which both triangles always occupy; that makes
   * the emission unique without any dedup set. Overflow triangles are paired
   * against everything, which needs no cell at all.
   */
  forEachCandidatePair(visit: (a: number, b: number) => void): void {
    for (const [key, list] of this.cells) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i] < list[j] ? list[i] : list[j];
          const b = list[i] < list[j] ? list[j] : list[i];
          if (this.overlaps(a, b) && this.canonicalCellKey(a, b) === key) {
            visit(a, b);
          }
        }
      }
    }
    for (const t of this.overflow) {
      for (let u = 0; u < this.triangleCount; u++) {
        if (u === t || this.overflow.has(u)) continue;
        const a = t < u ? t : u;
        const b = t < u ? u : t;
        if (this.overlaps(a, b)) visit(a, b);
      }
    }
    const overflowList = [...this.overflow];
    for (let i = 0; i < overflowList.length; i++) {
      for (let j = i + 1; j < overflowList.length; j++) {
        const a = overflowList[i] < overflowList[j] ? overflowList[i] : overflowList[j];
        const b = overflowList[i] < overflowList[j] ? overflowList[j] : overflowList[i];
        if (this.overlaps(a, b)) visit(a, b);
      }
    }
  }

  /**
   * Visit every AABB-overlapping pair that involves at least one triangle from
   * `subset`. Used after `updateTriangles`: pairs untouched by the edit keep
   * their previous exact-test results, so only these need re-evaluation.
   */
  forEachCandidatePairInvolving(subset: Iterable<number>, visit: (a: number, b: number) => void): void {
    const inSubset = new Set<number>();
    const touchedCells = new Set<number>();
    for (const t of subset) {
      if (t < 0 || t >= this.triangleCount) continue;
      inSubset.add(t);
      const keys = this.triCells[t];
      if (keys) for (const k of keys) touchedCells.add(k);
    }
    for (const key of touchedCells) {
      const list = this.cells.get(key);
      if (!list) continue;
      for (const t of list) {
        if (!inSubset.has(t)) continue;
        for (const m of list) {
          if (m === t) continue;
          // A pair of two subset members is reachable from both sides; emit it
          // only from the lower id so every pair is produced exactly once.
          if (m < t && inSubset.has(m)) continue;
          const a = t < m ? t : m;
          const b = t < m ? m : t;
          if (this.overlaps(a, b) && this.canonicalCellKey(a, b) === key) {
            visit(a, b);
          }
        }
      }
    }
    // Overflow triangles pair with everything: emit those pairs that involve
    // the subset. Pairs of two overflow triangles are emitted once (lower id).
    for (const t of this.overflow) {
      if (inSubset.has(t)) {
        for (let u = 0; u < this.triangleCount; u++) {
          if (u === t) continue;
          if (this.overflow.has(u) && u < t) continue;
          const a = t < u ? t : u;
          const b = t < u ? u : t;
          if (this.overlaps(a, b)) visit(a, b);
        }
      } else {
        for (const u of inSubset) {
          if (this.overflow.has(u)) continue;
          const a = t < u ? t : u;
          const b = t < u ? u : t;
          if (this.overlaps(a, b)) visit(a, b);
        }
      }
    }
  }

  private computeBox(mesh: TriMesh, t: number): void {
    const p = mesh.positions;
    const idx = mesh.indices;
    const o = t * 6;
    let loX = Infinity, loY = Infinity, loZ = Infinity;
    let hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const x = p[v], y = p[v + 1], z = p[v + 2];
      if (x < loX) loX = x;
      if (y < loY) loY = y;
      if (z < loZ) loZ = z;
      if (x > hiX) hiX = x;
      if (y > hiY) hiY = y;
      if (z > hiZ) hiZ = z;
    }
    this.boxes[o] = loX;
    this.boxes[o + 1] = loY;
    this.boxes[o + 2] = loZ;
    this.boxes[o + 3] = hiX;
    this.boxes[o + 4] = hiY;
    this.boxes[o + 5] = hiZ;
  }

  private cellCoord(value: number, axis: number): number {
    const c = Math.floor((value - this.origin[axis]) * this.invCellSize);
    // Clamping merges out-of-range cells into the boundary cell. That only ever
    // adds candidates to the same cell, so the filter stays conservative.
    return c < 0 ? 0 : c > MAX_CELL_COORD ? MAX_CELL_COORD : c;
  }

  private cellKey(cx: number, cy: number, cz: number): number {
    return (cz * (MAX_CELL_COORD + 1) + cy) * (MAX_CELL_COORD + 1) + cx;
  }

  /** Insert one triangle; returns its cell keys (empty when overflowed). */
  private insert(t: number): number[] {
    const o = t * 6;
    const x0 = this.cellCoord(this.boxes[o], 0);
    const y0 = this.cellCoord(this.boxes[o + 1], 1);
    const z0 = this.cellCoord(this.boxes[o + 2], 2);
    const x1 = this.cellCoord(this.boxes[o + 3], 0);
    const y1 = this.cellCoord(this.boxes[o + 4], 1);
    const z1 = this.cellCoord(this.boxes[o + 5], 2);
    const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (span > MAX_CELLS_PER_TRIANGLE) {
      this.overflow.add(t);
      return [];
    }
    const keys: number[] = [];
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = this.cellKey(cx, cy, cz);
          keys.push(key);
          let list = this.cells.get(key);
          if (!list) {
            list = [];
            this.cells.set(key, list);
          }
          list.push(t);
        }
      }
    }
    return keys;
  }

  private overlaps(a: number, b: number): boolean {
    const oa = a * 6;
    const ob = b * 6;
    const boxes = this.boxes;
    return boxes[oa] <= boxes[ob + 3] && boxes[ob] <= boxes[oa + 3]
      && boxes[oa + 1] <= boxes[ob + 4] && boxes[ob + 1] <= boxes[oa + 4]
      && boxes[oa + 2] <= boxes[ob + 5] && boxes[ob + 2] <= boxes[oa + 5];
  }

  /** Key of the cell holding the minimum corner of the two boxes' overlap. */
  private canonicalCellKey(a: number, b: number): number {
    const oa = a * 6;
    const ob = b * 6;
    const boxes = this.boxes;
    const cx = this.cellCoord(Math.max(boxes[oa], boxes[ob]), 0);
    const cy = this.cellCoord(Math.max(boxes[oa + 1], boxes[ob + 1]), 1);
    const cz = this.cellCoord(Math.max(boxes[oa + 2], boxes[ob + 2]), 2);
    return this.cellKey(cx, cy, cz);
  }
}
