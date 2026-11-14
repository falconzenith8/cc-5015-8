import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { TriMesh } from '../core/types';

export interface FieldDomain {
  min: [number, number, number];
  max: [number, number, number];
  dims: [number, number, number];
  spacing: number;
  band: number;
}

export interface FieldBuildOptions {
  /** Lower signed-distance level of the retained material band. */
  a: number;
  /** Upper signed-distance level of the retained material band. */
  b: number;
  resolution: number;
  /** For open meshes: which oriented side is the outside. */
  openSide: 'positive' | 'negative' | null;
  guardCells?: number;
  maxCells?: number;
}

export interface FieldBuildResult {
  domain: FieldDomain;
  /** F = max(a - d, d - b); negative inside retained material. */
  values: Float32Array;
  closedInput: boolean;
  signSamples: number;
  signMismatches: number;
  clampedResolution: boolean;
  rimCutSamples: number;
  spacingClampedBy: number;
}

export class InputGeometry {
  readonly mesh: TriMesh;
  readonly bvh: MeshBVH;
  readonly faceNormals: Float32Array;
  readonly boundaryEdges: Array<[number, number]>;
  readonly boundaryEdgeSet: Set<string>;
  readonly boundarySegments: number[][];

  constructor(mesh: TriMesh, boundaryEdges: Array<[number, number]>) {
    this.mesh = mesh;
    this.boundaryEdges = boundaryEdges;
    const geo = new THREE.BufferGeometry();
    // Copies so the BVH builder can reorder indices without touching the asset.
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
    // indirect: the geometry index order is preserved and faceIndex refers to
    // the original triangle order, which our face-normal table also uses.
    this.bvh = new MeshBVH(geo, { targetLeafSize: 8, indirect: true });
    this.faceNormals = computeFaceNormals(mesh.positions, mesh.indices);
    this.boundaryEdgeSet = new Set(boundaryEdges.map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)));
    this.boundarySegments = boundaryEdges.map(([a, b]) => {
      const ia = a * 3, ib = b * 3;
      return [
        mesh.positions[ia], mesh.positions[ia + 1], mesh.positions[ia + 2],
        mesh.positions[ib], mesh.positions[ib + 1], mesh.positions[ib + 2],
      ];
    });
  }

  /**
   * The offset band wraps around a trim boundary and seals the opening. A point
   * is "past the boundary" when its nearest surface point lies on a boundary
   * edge rather than in the interior of a face. Callers delete such field
   * samples and such output triangles so the original opening survives.
   */
  footprintPastBoundary(x: number, y: number, z: number, maxDistance: number, tol: number): boolean {
    _target.set(x, y, z);
    const hit = this.bvh.closestPointToPoint(_target, undefined, 0, maxDistance);
    if (!hit || hit.faceIndex === undefined) return false;
    return closestPointOnBoundary(this.mesh, this.boundaryEdgeSet, hit.faceIndex, hit.point, tol);
  }
}

export function computeFaceNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const ux = positions[ib] - positions[ia];
    const uy = positions[ib + 1] - positions[ia + 1];
    const uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia];
    const vy = positions[ic + 1] - positions[ia + 1];
    const vz = positions[ic + 2] - positions[ia + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-15) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    normals[t] = nx;
    normals[t + 1] = ny;
    normals[t + 2] = nz;
  }
  return normals;
}

const _point = new THREE.Vector3();
const _target = new THREE.Vector3();
const _ray = new THREE.Ray();
const _direction = new THREE.Vector3();

export function pointInsideClosed(bvh: MeshBVH, x: number, y: number, z: number): boolean {
  _ray.origin.set(x, y, z);
  const dirs: Array<[number, number, number]> = [
    [1, 0.01731, 0.03127],
    [0.01903, 1, 0.02711],
    [0.02917, 0.02311, 1],
  ];
  for (const d of dirs) {
    _direction.set(d[0], d[1], d[2]).normalize();
    _ray.direction.copy(_direction);
    const hits = bvh.raycast(_ray, THREE.DoubleSide);
    let valid = 0;
    for (const h of hits) if (h.distance > 1e-7) valid++;
    if (valid > 0) return valid % 2 === 1;
  }
  return false;
}

/**
 * Signed distance to the input surface, positive on the outside.
 *
 * Closed consistently oriented inputs use one parity scan per X row. Open inputs
 * use the explicitly selected oriented side and additionally cut the band at
 * the boundary rim so the offset does not balloon past the original opening.
 */
export class SignedDistanceField {
  readonly input: InputGeometry;
  readonly closed: boolean;
  readonly openSide: 'positive' | 'negative' | null;
  readonly domain: FieldDomain;
  readonly values: Float32Array;
  readonly a: number;
  readonly b: number;

  private readonly dims: [number, number, number];
  private readonly spacing: number;
  private readonly origin: [number, number, number];

  constructor(result: FieldBuildResult, input: InputGeometry, openSide: 'positive' | 'negative' | null, a: number, b: number) {
    this.input = input;
    this.closed = result.closedInput;
    this.openSide = openSide;
    this.domain = result.domain;
    this.values = result.values;
    this.a = a;
    this.b = b;
    this.dims = result.domain.dims;
    this.spacing = result.domain.spacing;
    this.origin = result.domain.min;
  }

  /** Trilinear phi lookup. Positive values are air. */
  samplePhi(x: number, y: number, z: number): number {
    const [nx, ny, nz] = this.dims;
    const h = this.spacing;
    const fx = (x - this.origin[0]) / h;
    const fy = (y - this.origin[1]) / h;
    const fz = (z - this.origin[2]) / h;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return 1;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const v = this.values;
    const nxy = nx * ny;
    const idx = i + nx * (j + ny * k);
    const c00 = v[idx] + (v[idx + 1] - v[idx]) * tx;
    const c10 = v[idx + nx] + (v[idx + nx + 1] - v[idx + nx]) * tx;
    const c01 = v[idx + nxy] + (v[idx + nxy + 1] - v[idx + nxy]) * tx;
    const c11 = v[idx + nxy + nx] + (v[idx + nxy + nx + 1] - v[idx + nxy + nx]) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  gradient(x: number, y: number, z: number): [number, number, number] {
    const h = this.spacing * 0.5;
    return [
      this.samplePhi(x + h, y, z) - this.samplePhi(x - h, y, z),
      this.samplePhi(x, y + h, z) - this.samplePhi(x, y - h, z),
      this.samplePhi(x, y, z + h) - this.samplePhi(x, y, z - h),
    ];
  }

  /** Signed distance from the input surface (positive outside) at an arbitrary point. */
  signedDistance(x: number, y: number, z: number): number {
    _point.set(x, y, z);
    const hit = this.input.bvh.closestPointToPoint(_point);
    if (!hit) return Infinity;
    const cp = hit.point;
    let sign: number;
    if (this.closed) {
      sign = pointInsideClosed(this.input.bvh, x, y, z) ? -1 : 1;
    } else {
      const tri = hit.faceIndex ?? -1;
      const n = this.faceNormal(tri);
      const local = (x - cp.x) * n[0] + (y - cp.y) * n[1] + (z - cp.z) * n[2];
      const oriented = local >= 0 ? 1 : -1;
      sign = this.openSide === 'negative' ? -oriented : oriented;
    }
    return sign * hit.distance;
  }

  /**
   * Unsigned distance to the input surface plus an oriented sign estimate from
   * the closest face normal. Stable at the offset surface where a full
   * inside/outside parity test is ambiguous.
   */
  distanceInfo(x: number, y: number, z: number): { unsigned: number; oriented: number } {
    _point.set(x, y, z);
    const hit = this.input.bvh.closestPointToPoint(_point);
    if (!hit) return { unsigned: Infinity, oriented: 1 };
    const tri = hit.faceIndex ?? -1;
    const n = this.faceNormal(tri);
    const cp = hit.point;
    const local = (x - cp.x) * n[0] + (y - cp.y) * n[1] + (z - cp.z) * n[2];
    const oriented = local >= 0 ? 1 : -1;
    const side = this.closed ? 1 : (this.openSide === 'negative' ? -1 : 1);
    return { unsigned: hit.distance, oriented: oriented * side };
  }

  faceNormal(faceIndex: number | null): [number, number, number] {
    if (faceIndex === null || faceIndex < 0) return [0, 1, 0];
    const off = faceIndex * 3;
    return [this.input.faceNormals[off], this.input.faceNormals[off + 1], this.input.faceNormals[off + 2]];
  }
}

/** One parity scan per (y,z) row; returns the inside mask along X. */
function parityRowInside(bvh: MeshBVH, nx: number, minX: number, spacing: number, y: number, z: number): Int8Array {
  const row = new Int8Array(nx);
  _ray.origin.set(minX - spacing, y + 1.7e-5, z + 1.3e-5);
  _ray.direction.set(1, 0, 0);
  const hits = bvh.raycast(_ray, THREE.DoubleSide);
  const xs: number[] = [];
  for (const h of hits) {
    if (h.distance <= 1e-7) continue;
    xs.push(_ray.origin.x + h.distance);
  }
  xs.sort((p, q) => p - q);
  const unique: number[] = [];
  for (const v of xs) {
    if (unique.length === 0 || Math.abs(v - unique[unique.length - 1]) > spacing * 1e-3) unique.push(v);
  }
  let cursor = 0;
  let inside = false;
  for (let i = 0; i < nx; i++) {
    const x = minX + i * spacing;
    while (cursor < unique.length && unique[cursor] <= x) {
      inside = !inside;
      cursor++;
    }
    row[i] = inside ? -1 : 1;
  }
  return row;
}

/**
 * True when the closest point on `tri` lies on a boundary edge of that
 * triangle, i.e. the query point is outside the surface footprint (past the
 * trim boundary or inside a hole). The offset band would otherwise wrap
 * around the boundary and seal the opening.
 */
function closestPointOnBoundary(
  mesh: TriMesh,
  boundaryEdgeSet: Set<string>,
  tri: number,
  cp: { x: number; y: number; z: number },
  tol: number,
): boolean {
  const ia = mesh.indices[tri * 3] * 3;
  const ib = mesh.indices[tri * 3 + 1] * 3;
  const ic = mesh.indices[tri * 3 + 2] * 3;
  const verts = [ia, ib, ic];
  const dirs: Array<[number, number]> = [[0, 1], [1, 2], [2, 0]];
  for (const [u, v] of dirs) {
    const a = verts[u] / 3;
    const b = verts[v] / 3;
    if (!boundaryEdgeSet.has(a < b ? `${a}_${b}` : `${b}_${a}`)) continue;
    const ax = mesh.positions[ia + 0], ay = mesh.positions[ia + 1], az = mesh.positions[ia + 2];
    const bx = mesh.positions[ib + 0], by = mesh.positions[ib + 1], bz = mesh.positions[ib + 2];
    const cx = mesh.positions[ic + 0], cy = mesh.positions[ic + 1], cz = mesh.positions[ic + 2];
    const p0 = u === 0 ? [ax, ay, az] : u === 1 ? [bx, by, bz] : [cx, cy, cz];
    const p1 = v === 1 ? [bx, by, bz] : v === 2 ? [cx, cy, cz] : [ax, ay, az];
    const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2];
    const len2 = ex * ex + ey * ey + ez * ez;
    if (len2 < 1e-20) continue;
    let t = ((cp.x - p0[0]) * ex + (cp.y - p0[1]) * ey + (cp.z - p0[2]) * ez) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = p0[0] + t * ex, qy = p0[1] + t * ey, qz = p0[2] + t * ez;
    if (Math.hypot(cp.x - qx, cp.y - qy, cp.z - qz) <= tol) return true;
  }
  return false;
}

export function buildField(
  input: InputGeometry,
  closedInput: boolean,
  opts: FieldBuildOptions,
): FieldBuildResult {
  const mesh = input.mesh;
  const a = Math.min(opts.a, opts.b);
  const b = Math.max(opts.a, opts.b);
  const guardCells = opts.guardCells ?? 2;
  const maxCells = opts.maxCells ?? 8_000_000;
  const levelReach = Math.max(Math.abs(a), Math.abs(b));
  if (!(levelReach > 0)) throw new Error('厚度必须大于 0');

  const bbox = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(mesh.positions, 3));
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxExtent = Math.max(size.x, size.y, size.z) || 1;
  let spacing = maxExtent / Math.max(2, opts.resolution - 1);
  const initialSpacing = spacing;
  let clampedResolution = false;

  let dims: [number, number, number] = [3, 3, 3];
  const computeDims = () => {
    const band = levelReach + guardCells * spacing;
    const pad = band + 1.5 * spacing;
    const nx = Math.max(3, Math.ceil((size.x + 2 * pad) / spacing) + 1);
    const ny = Math.max(3, Math.ceil((size.y + 2 * pad) / spacing) + 1);
    const nz = Math.max(3, Math.ceil((size.z + 2 * pad) / spacing) + 1);
    dims = [nx, ny, nz];
    return band;
  };
  let band = computeDims();
  for (let attempt = 0; attempt < 10 && dims[0] * dims[1] * dims[2] > maxCells; attempt++) {
    spacing *= 1.15;
    clampedResolution = true;
    band = computeDims();
  }

  const bandPad = levelReach + guardCells * spacing;
  const pad = bandPad + 1.5 * spacing;
  const min: [number, number, number] = [bbox.min.x - pad, bbox.min.y - pad, bbox.min.z - pad];
  const max: [number, number, number] = [bbox.max.x + pad, bbox.max.y + pad, bbox.max.z + pad];
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const values = new Float32Array(total).fill(1);
  const nxy = nx * ny;
  const queryReach = bandPad + spacing * 1.5;

  let signSamples = 0;
  let signMismatches = 0;
  let rimCutSamples = 0;
  const target = new THREE.Vector3();
  const sideSign = opts.openSide === 'negative' ? -1 : 1;
  const boundaryTol = Math.max(1e-4, spacing * 1e-3);

  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * spacing;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * spacing;
      const parityRow = closedInput ? parityRowInside(input.bvh, nx, min[0], spacing, y, z) : null;
      for (let i = 0; i < nx; i++) {
        const x = min[0] + i * spacing;
        target.set(x, y, z);
        const hit = input.bvh.closestPointToPoint(target, undefined, 0, queryReach);
        if (!hit) continue;
        const dist = hit.distance;
        if (dist > bandPad) continue;
        const tri = hit.faceIndex ?? -1;
        if (!closedInput && tri >= 0 && closestPointOnBoundary(mesh, input.boundaryEdgeSet, tri, hit.point, boundaryTol)) {
          rimCutSamples++;
          continue;
        }
        const n = tri >= 0 ? [input.faceNormals[tri * 3], input.faceNormals[tri * 3 + 1], input.faceNormals[tri * 3 + 2]] : [0, 1, 0];
        const cp = hit.point;
        const local = (x - cp.x) * n[0] + (y - cp.y) * n[1] + (z - cp.z) * n[2];
        let sign: number;
        if (closedInput) {
          sign = parityRow ? parityRow[i] : 1;
          if (Math.abs(local) > spacing * 0.03) {
            signSamples++;
            if ((local > 0 ? 1 : -1) !== sign) signMismatches++;
          }
        } else {
          let oriented = local >= 0 ? 1 : -1;
          sign = sideSign * oriented;
        }
        const d = sign * dist;
        const phi = Math.max(a - d, d - b);
        values[i + nx * j + nxy * k] = Math.max(-queryReach, Math.min(queryReach, phi));
      }
    }
  }

  return {
    domain: { min, max, dims, spacing, band: bandPad },
    values,
    closedInput,
    signSamples,
    signMismatches,
    clampedResolution,
    rimCutSamples,
    spacingClampedBy: spacing / initialSpacing,
  };
}

export function extractSurfaceNets(
  values: Float32Array,
  dims: [number, number, number],
  min: [number, number, number],
  spacing: number,
): TriMesh {
  const [nx, ny, nz] = dims;
  const vertices: number[] = [];
  const indices: number[] = [];
  const R0 = 1;
  const R1 = nx + 1;
  let R2 = (nx + 1) * (ny + 1);
  const buffer = new Int32Array(R2 * 2);
  let bufNo = 1;
  let n = 0;
  const grid = new Float32Array(8);
  const x = [0, 0, 0];
  const R = [R0, R1, R2];

  for (x[2] = 0; x[2] < nz - 1; x[2]++, n += nx, bufNo ^= 1, R2 = -R2, R[2] = R2) {
    let m = 1 + (nx + 1) * (1 + bufNo * (ny + 1));
    for (x[1] = 0; x[1] < ny - 1; x[1]++, n++, m += 2) {
      for (x[0] = 0; x[0] < nx - 1; x[0]++, n++, m++) {
        let mask = 0;
        let g = 0;
        for (let ck = 0; ck < 2; ck++)
          for (let cj = 0; cj < 2; cj++)
            for (let ci = 0; ci < 2; ci++, g++) {
              const v = values[n + ci + nx * cj + nx * ny * ck];
              grid[g] = v;
              if (v < 0) mask |= 1 << g;
            }
        if (mask === 0 || mask === 255) continue;
        const edgeMask = EDGE_TABLE[mask];
        let vx = 0, vy = 0, vz = 0;
        let count = 0;
        for (let e = 0; e < 12; e++) {
          if (!(edgeMask & (1 << e))) continue;
          const e0 = CUBE_EDGES[e * 2];
          const e1 = CUBE_EDGES[e * 2 + 1];
          const g0 = grid[e0];
          const g1 = grid[e1];
          let t = g0 - g1;
          if (Math.abs(t) < 1e-12) continue;
          t = g0 / t;
          count++;
          for (let d = 0, bit = 1; d < 3; d++, bit <<= 1) {
            const a0 = e0 & bit;
            const a1 = e1 & bit;
            if (a0 !== a1) {
              const term = a0 ? 1 - t : t;
              if (d === 0) vx += term;
              else if (d === 1) vy += term;
              else vz += term;
            } else {
              const term = a0 ? 1 : 0;
              if (d === 0) vx += term;
              else if (d === 1) vy += term;
              else vz += term;
            }
          }
        }
        if (count === 0) continue;
        const inv = 1 / count;
        vertices.push(
          min[0] + (x[0] + vx * inv) * spacing,
          min[1] + (x[1] + vy * inv) * spacing,
          min[2] + (x[2] + vz * inv) * spacing,
        );
        buffer[m] = vertices.length / 3 - 1;
        for (let axis = 0; axis < 3; axis++) {
          if (!(edgeMask & (1 << axis))) continue;
          const iu = (axis + 1) % 3;
          const iv = (axis + 2) % 3;
          if (x[iu] === 0 || x[iv] === 0) continue;
          const du = R[iu];
          const dv = R[iv];
          if (mask & 1) {
            indices.push(buffer[m], buffer[m - du], buffer[m - dv]);
            indices.push(buffer[m - dv], buffer[m - du], buffer[m - du - dv]);
          } else {
            indices.push(buffer[m], buffer[m - dv], buffer[m - du]);
            indices.push(buffer[m - du], buffer[m - dv], buffer[m - du - dv]);
          }
        }
      }
    }
  }
  return {
    positions: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    vertexCount: vertices.length / 3,
    triangleCount: indices.length / 3,
  };
}

const CUBE_EDGES = (() => {
  const out = new Int32Array(24);
  let k = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) {
        out[k++] = i;
        out[k++] = p;
      }
    }
  }
  return out;
})();

const EDGE_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) {
      const a = !!(i & (1 << CUBE_EDGES[j]));
      const b = !!(i & (1 << CUBE_EDGES[j + 1]));
      if (a !== b) em |= 1 << (j >> 1);
    }
    table[i] = em;
  }
  return table;
})();
