import type { SelfIntersectionReport, TriMesh } from '../../src/core/types';
import {
  detectSelfIntersections,
  detectSelfIntersectionsBruteForce,
  detectSelfIntersectionsReference,
} from '../../src/geometry/measure';

/**
 * Synthetic shell cases shared by the parity tests and the shell-query
 * benchmark: thin parallel sheets, a concave-corner channel with a crossing
 * fin, and local in-place dents that simulate local reshaping of a model.
 */

/** Flat triangulated sheet spanning [-w/2, w/2] x [-d/2, d/2] at height z. */
export function buildSheet(width: number, depth: number, nx: number, ny: number, z: number): TriMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      positions.push(-width / 2 + (width * i) / nx, -depth / 2 + (depth * j) / ny, z);
    }
  }
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      indices.push(a, b, c, a, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

export function mergeMeshes(meshes: TriMesh[]): TriMesh {
  let vc = 0;
  let tc = 0;
  for (const m of meshes) {
    vc += m.vertexCount;
    tc += m.triangleCount;
  }
  const positions = new Float32Array(vc * 3);
  const indices = new Uint32Array(tc * 3);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo * 3);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += m.vertexCount;
    io += m.indices.length;
  }
  return { positions, indices, vertexCount: vc, triangleCount: tc };
}

export function translate(mesh: TriMesh, dx: number, dy: number, dz: number): TriMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i] + dx;
    positions[i + 1] = mesh.positions[i + 1] + dy;
    positions[i + 2] = mesh.positions[i + 2] + dz;
  }
  return { ...mesh, positions };
}

export function rotateX(mesh: TriMesh, angle: number): TriMesh {
  const positions = new Float32Array(mesh.positions.length);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i];
    positions[i + 1] = mesh.positions[i + 1] * c - mesh.positions[i + 2] * s;
    positions[i + 2] = mesh.positions[i + 1] * s + mesh.positions[i + 2] * c;
  }
  return { ...mesh, positions };
}

export function rotateZ(mesh: TriMesh, angle: number): TriMesh {
  const positions = new Float32Array(mesh.positions.length);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i] * c - mesh.positions[i + 1] * s;
    positions[i + 1] = mesh.positions[i] * s + mesh.positions[i + 1] * c;
    positions[i + 2] = mesh.positions[i + 2];
  }
  return { ...mesh, positions };
}

/**
 * Two parallel sheets separated by `gap` — much thinner than the triangle
 * size, so their bounding boxes overlap heavily. The accelerated filter must
 * still consider every cross-sheet pair (no misses from box approximation).
 */
export function buildParallelSheets(opts: {
  size: number;
  quads: number;
  gap: number;
  dent?: { center: [number, number]; radius: number; depth: number };
}): TriMesh {
  const lower = buildSheet(opts.size, opts.size, opts.quads, opts.quads, 0);
  const upper = buildSheet(opts.size, opts.size, opts.quads, opts.quads, opts.gap);
  const mesh = mergeMeshes([lower, upper]);
  if (opts.dent) {
    // Push the lower sheet's patch upward through the upper sheet.
    dentMeshInPlace(
      mesh,
      [opts.dent.center[0], opts.dent.center[1], 0],
      opts.dent.radius,
      opts.dent.depth,
      [0, 0, 1],
      { vertex: (v) => v < lower.vertexCount },
    );
  }
  return mesh;
}

/**
 * U-shaped channel (two concave corners where the walls meet the floor) plus
 * a vertical fin that crosses the floor and one wall next to a concave
 * corner. Intersections sit exactly at the concave region.
 */
export function buildConcaveChannelWithFin(): TriMesh {
  const floor = buildSheet(12, 12, 6, 6, 0);
  // Walls stand on the floor's y = ±6 edges and rise to z = 4.
  const wallA = translate(rotateX(buildSheet(12, 4, 6, 2, 0), Math.PI / 2), 0, -6, 2);
  const wallB = translate(rotateX(buildSheet(12, 4, 6, 2, 0), Math.PI / 2), 0, 6, 2);
  // Fin: a vertical plate in the YZ plane crossing the floor and wallA right
  // at the concave corner (y = -6, z = 0).
  const finFlat = buildSheet(8, 5, 4, 3, 0);
  const fin = translate(rotateZ(rotateX(finFlat, Math.PI / 2), Math.PI / 2), 1.5, -5, 0.8);
  return mergeMeshes([floor, wallA, wallB, fin]);
}

/**
 * Local reshaping: move every vertex within `radius` of `center` by
 * `depth` along `dir` (unit), in place. Returns the ids of the affected
 * triangles (those referencing a moved vertex) — the set an incremental
 * index must re-hash.
 */
export function dentMeshInPlace(
  mesh: TriMesh,
  center: [number, number, number],
  radius: number,
  depth: number,
  dir: [number, number, number],
  filter?: { vertex?: (v: number) => boolean; triangle?: (t: number) => boolean },
): number[] {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const dx = dir[0] / len;
  const dy = dir[1] / len;
  const dz = dir[2] / len;
  const r2 = radius * radius;
  const moved = new Uint8Array(mesh.vertexCount);
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (filter?.vertex && !filter.vertex(v)) continue;
    const px = mesh.positions[v * 3] - center[0];
    const py = mesh.positions[v * 3 + 1] - center[1];
    const pz = mesh.positions[v * 3 + 2] - center[2];
    if (px * px + py * py + pz * pz > r2) continue;
    // Smooth falloff keeps the patch connected to the untouched surface.
    const fall = 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.sqrt(px * px + py * py + pz * pz) / radius));
    mesh.positions[v * 3] += dx * depth * fall;
    mesh.positions[v * 3 + 1] += dy * depth * fall;
    mesh.positions[v * 3 + 2] += dz * depth * fall;
    moved[v] = 1;
  }
  const affected: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (filter?.triangle && !filter.triangle(t)) continue;
    if (moved[mesh.indices[t * 3]] || moved[mesh.indices[t * 3 + 1]] || moved[mesh.indices[t * 3 + 2]]) {
      affected.push(t);
    }
  }
  return affected;
}

export type DetectMethod = 'grid' | 'bvh-reference' | 'brute-force';

export interface CollectedRun {
  report: SelfIntersectionReport;
  pairs: Set<string>;
  ms: number;
}

const DETECTORS: Record<DetectMethod, (mesh: TriMesh, maxPairs: number, onPair?: (lo: number, hi: number) => void) => SelfIntersectionReport> = {
  grid: (m, cap, onPair) => detectSelfIntersections(m, cap, onPair),
  'bvh-reference': (m, cap, onPair) => detectSelfIntersectionsReference(m, cap, onPair),
  'brute-force': (m, cap, onPair) => detectSelfIntersectionsBruteForce(m, cap, onPair),
};

/** Run one detector to completion and collect the exact intersecting pair set. */
export function collectRun(mesh: TriMesh, method: DetectMethod, maxPairs = Number.POSITIVE_INFINITY): CollectedRun {
  const pairs = new Set<string>();
  const t0 = performance.now();
  const report = DETECTORS[method](mesh, maxPairs, (lo, hi) => pairs.add(`${lo}_${hi}`));
  const ms = performance.now() - t0;
  return { report, pairs, ms };
}

export interface SetComparison {
  missed: string[];
  extra: string[];
  missRate: number;
  extraRate: number;
}

/** Failure-region comparison: accelerated pair set against the reference set. */
export function comparePairSets(accelerated: Set<string>, reference: Set<string>): SetComparison {
  const missed: string[] = [];
  for (const p of reference) if (!accelerated.has(p)) missed.push(p);
  const extra: string[] = [];
  for (const p of accelerated) if (!reference.has(p)) extra.push(p);
  return {
    missed,
    extra,
    missRate: reference.size === 0 ? 0 : missed.length / reference.size,
    extraRate: reference.size === 0 ? (extra.length === 0 ? 0 : 1) : extra.length / reference.size,
  };
}
