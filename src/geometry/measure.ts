import * as THREE from 'three';
import { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';
import type {
  FeatureWarning,
  MeshTopology,
  OutputMeshInfo,
  SelfIntersectionReport,
  ShellSample,
  ThicknessStats,
  TriMesh,
  VerificationReport,
} from '../core/types';
import { computeStats, computeTopology, computeVertexNormals, distanceToSegments, triangleArea } from './mesh';
import { TriangleIntersectionIndex } from './intersectionIndex';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toGeometry(mesh: TriMesh): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
  return geo;
}

export function computeTriangleNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
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

export interface ClassifyOptions {
  /** Lower signed-distance level (inner surface). */
  a: number;
  /** Upper signed-distance level (outer surface). */
  b: number;
  /**
   * Unsigned distance to the input surface and an oriented (+1 air / -1 material)
   * sign estimate. Distance magnitude tells which offset level a triangle sits
   * on, which avoids parity ambiguity exactly at the produced surface.
   */
  distanceInfo: (x: number, y: number, z: number) => { unsigned: number; oriented: number };
  /** Boundary loop vertex positions; rim triangles lie near these curves. */
  rimSegments?: Array<[number, number, number, number, number, number]>;
  rimThreshold: number;
}

export function buildOutputMeshInfo(mesh: TriMesh, opts: ClassifyOptions): OutputMeshInfo {
  const topology = computeTopology(mesh);
  const stats = computeStats(mesh, topology);
  const normals = computeTriangleNormals(mesh.positions, mesh.indices);
  const triangleClass = new Uint8Array(mesh.triangleCount);
  const classAreas: [number, number, number] = [0, 0, 0];
  const absA = Math.abs(opts.a);
  const absB = Math.abs(opts.b);
  const symmetric = Math.abs(absA - absB) < Math.max(1e-9, Math.abs(opts.b - opts.a) * 1e-3);
  for (let t = 0; t < mesh.triangleCount; t++) {
    const ia = mesh.indices[t * 3] * 3;
    const ib = mesh.indices[t * 3 + 1] * 3;
    const ic = mesh.indices[t * 3 + 2] * 3;
    const cx = (mesh.positions[ia] + mesh.positions[ib] + mesh.positions[ic]) / 3;
    const cy = (mesh.positions[ia + 1] + mesh.positions[ib + 1] + mesh.positions[ic + 1]) / 3;
    const cz = (mesh.positions[ia + 2] + mesh.positions[ib + 2] + mesh.positions[ic + 2]) / 3;
    let cls: 0 | 1 | 2;
    if (nearRim(cx, cy, cz, opts.rimSegments, opts.rimThreshold)) {
      cls = 2;
    } else {
      const info = opts.distanceInfo(cx, cy, cz);
      if (symmetric) {
        cls = info.oriented > 0 ? 0 : 1;
      } else {
        const distA = Math.abs(info.unsigned - absA);
        const distB = Math.abs(info.unsigned - absB);
        if (Math.abs(distA - distB) < Math.max(1e-6, Math.abs(absB - absA) * 0.05)) {
          cls = info.oriented > 0 ? 0 : 1;
        } else {
          cls = distB <= distA ? 0 : 1;
        }
      }
    }
    triangleClass[t] = cls;
    classAreas[cls] += triangleArea(mesh.positions, mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  const componentVolumes = computeComponentVolumes(mesh, topology);
  const smallThreshold = Math.max(stats.surfaceArea * 1e-5, 1e-12);
  let smallComponentCount = 0;
  let smallComponentVolume = 0;
  for (const c of componentVolumes) {
    if (Math.abs(c.volume) < smallThreshold) {
      smallComponentCount++;
      smallComponentVolume += Math.abs(c.volume);
    }
  }
  return {
    mesh,
    normals,
    triangleClass,
    classAreas,
    stats,
    componentVolumes,
    smallComponentCount,
    smallComponentVolume,
  };
}

function nearRim(
  x: number,
  y: number,
  z: number,
  segments: Array<[number, number, number, number, number, number]> | undefined,
  threshold: number,
): boolean {
  if (!segments || segments.length === 0) return false;
  const t2 = threshold * threshold;
  for (const s of segments) {
    if (pointSegmentDistanceSq(x, y, z, s) <= t2) return true;
  }
  return false;
}

function pointSegmentDistanceSq(
  x: number, y: number, z: number,
  s: [number, number, number, number, number, number],
): number {
  const [ax, ay, az, bx, by, bz] = s;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + dx * t, py = ay + dy * t, pz = az + dz * t;
  const ex = x - px, ey = y - py, ez = z - pz;
  return ex * ex + ey * ey + ez * ez;
}

function computeComponentVolumes(
  mesh: TriMesh,
  topology: MeshTopology,
): Array<{ volume: number; triangleCount: number; centroid: [number, number, number] }> {
  const acc = new Map<number, { volume: number; tri: number; cx: number; cy: number; cz: number; w: number }>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const ia = mesh.indices[t * 3] * 3;
    const ib = mesh.indices[t * 3 + 1] * 3;
    const ic = mesh.indices[t * 3 + 2] * 3;
    const ax = mesh.positions[ia], ay = mesh.positions[ia + 1], az = mesh.positions[ia + 2];
    const bx = mesh.positions[ib], by = mesh.positions[ib + 1], bz = mesh.positions[ib + 2];
    const cx = mesh.positions[ic], cy = mesh.positions[ic + 1], cz = mesh.positions[ic + 2];
    const vol = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const area = triangleArea(mesh.positions, mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
    const comp = topology.componentOfVertex[mesh.indices[t * 3]];
    const e = acc.get(comp) ?? { volume: 0, tri: 0, cx: 0, cy: 0, cz: 0, w: 0 };
    e.volume += vol;
    e.tri++;
    e.cx += ((ax + bx + cx) / 3) * area;
    e.cy += ((ay + by + cy) / 3) * area;
    e.cz += ((az + bz + cz) / 3) * area;
    e.w += area;
    acc.set(comp, e);
  }
  return [...acc.values()].map((e) => ({
    volume: e.volume,
    triangleCount: e.tri,
    centroid: e.w > 0 ? [e.cx / e.w, e.cy / e.w, e.cz / e.w] : [0, 0, 0],
  }));
}

export interface MeasureInput {
  output: TriMesh;
  triangleClass: Uint8Array;
  probeCount: number;
  thickness: number;
  tolerance: number;
  seed: number;
  /** Upper bound for a valid opposite surface, as a multiple of the target. */
  maxReachMultiplier?: number;
  /**
   * Probes whose opposite point lies further than this angle from the inward
   * normal are classified as edge-affected and excluded from the tolerance
   * statistics. They are still returned as samples for inspection.
   */
  maxAngleDeg?: number;
  /**
   * Sharp input edges and trim boundaries. The offset rounds these, so a probe
   * within `edgeExcludeDistance` of one is excluded from the tolerance
   * statistics rather than reported as a wall-thickness error.
   */
  edgeSegments?: number[][];
  edgeExcludeDistance?: number;
}

interface ClassGeometry {
  bvh: MeshBVH;
  triMap: Uint32Array;
  vertMap: Uint32Array;
  triangleCount: number;
}

function buildClassGeometry(mesh: TriMesh, triangleClass: Uint8Array, cls: number): ClassGeometry | null {
  const tris: number[] = [];
  const vertexSet = new Map<number, number>();
  const vertMap: number[] = [];
  const compactIndices: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (triangleClass[t] !== cls) continue;
    tris.push(t);
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      let cv = vertexSet.get(v);
      if (cv === undefined) {
        cv = vertMap.length;
        vertexSet.set(v, cv);
        vertMap.push(v);
      }
      compactIndices.push(cv);
    }
  }
  if (tris.length === 0) return null;
  const positions = new Float32Array(vertMap.length * 3);
  for (let i = 0; i < vertMap.length; i++) {
    const v = vertMap[i];
    positions[i * 3] = mesh.positions[v * 3];
    positions[i * 3 + 1] = mesh.positions[v * 3 + 1];
    positions[i * 3 + 2] = mesh.positions[v * 3 + 2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(compactIndices), 1));
  const bvh = new MeshBVH(geo, { targetLeafSize: 12, indirect: true });
  return {
    bvh,
    triMap: new Uint32Array(tris),
    vertMap: new Uint32Array(vertMap),
    triangleCount: tris.length,
  };
}

/**
 * Minimum wall thickness sampling.
 *
 * Each probe starts on the upper shell face and records the closest point on the
 * opposite shell face. This is the minimum local wall thickness and is stable
 * near round-over regions where the extracted surface chamfers a sharp crease;
 * an along-normal ray would measure a longer chord there. Probes whose opposite
 * point lies off the inward normal by a large angle are tagged edge-affected and
 * excluded from the tolerance statistics, but still reported.
 *
 * The measurement reads only the produced triangles, never the generating field.
 */
export function measureThickness(input: MeasureInput): { samples: ShellSample[]; stats: ThicknessStats } {
  const { output, triangleClass, thickness, tolerance } = input;
  const outer = buildClassGeometry(output, triangleClass, 0);
  const inner = buildClassGeometry(output, triangleClass, 1);
  if (!outer || !inner) {
    return { samples: [], stats: emptyThickness(thickness, tolerance) };
  }
  const vertexNormals = computeVertexNormals(output);
  const maxReach = Math.max(thickness * (input.maxReachMultiplier ?? 2.5), thickness * 1.5);
  const maxAngle = ((input.maxAngleDeg ?? 12) * Math.PI) / 180;
  const upperTris: number[] = [];
  const upperWeights: number[] = [];
  let upperArea = 0;
  for (let i = 0; i < outer.triangleCount; i++) {
    const t = outer.triMap[i];
    const area = triangleArea(output.positions, output.indices[t * 3], output.indices[t * 3 + 1], output.indices[t * 3 + 2]);
    if (area <= 1e-12) continue;
    upperTris.push(i);
    upperWeights.push(area);
    upperArea += area;
  }
  if (upperTris.length === 0) {
    return { samples: [], stats: emptyThickness(thickness, tolerance) };
  }
  const cum: number[] = [];
  let acc = 0;
  for (const w of upperWeights) { acc += w; cum.push(acc); }
  const rng = mulberry32(input.seed);
  const pick = (): number => {
    const r = rng() * upperArea;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return upperTris[lo];
  };
  const point = new THREE.Vector3();
  const inward = new THREE.Vector3();
  const toOpposite = new THREE.Vector3();
  const counts = [0, 0, 0, 0, 0];
  const values: number[] = [];
  const samples: ShellSample[] = [];
  const seen = new Set<string>();
  const hitInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let attempts = 0;
  while (samples.length < input.probeCount && attempts < input.probeCount * 6) {
    attempts++;
    const compact = pick();
    const tri = outer.triMap[compact];
    let u = rng(), v = rng();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    const va = output.indices[tri * 3];
    const vb = output.indices[tri * 3 + 1];
    const vc = output.indices[tri * 3 + 2];
    const ia = va * 3, ib = vb * 3, ic = vc * 3;
    point.set(
      output.positions[ia] * w + output.positions[ib] * u + output.positions[ic] * v,
      output.positions[ia + 1] * w + output.positions[ib + 1] * u + output.positions[ic + 1] * v,
      output.positions[ia + 2] * w + output.positions[ib + 2] * u + output.positions[ic + 2] * v,
    );
    inward.set(
      vertexNormals[ia] * w + vertexNormals[ib] * u + vertexNormals[ic] * v,
      vertexNormals[ia + 1] * w + vertexNormals[ib + 1] * u + vertexNormals[ic + 1] * v,
      vertexNormals[ia + 2] * w + vertexNormals[ib + 2] * u + vertexNormals[ic + 2] * v,
    );
    const nlen = inward.length();
    if (nlen < 1e-9) { counts[3]++; continue; }
    inward.multiplyScalar(-1 / nlen);
    const opposite = inner.bvh.closestPointToPoint(point, hitInfo, 0, maxReach);
    if (!opposite) { counts[3]++; continue; }
    const measured = opposite.distance;
    if (input.edgeSegments && input.edgeSegments.length > 0) {
      const edgeDist = distanceToSegments(point.x, point.y, point.z, input.edgeSegments);
      if (edgeDist < (input.edgeExcludeDistance ?? 0)) {
        counts[4]++;
        continue;
      }
    }
    toOpposite.copy(opposite.point).sub(point).normalize();
    const cos = Math.max(-1, Math.min(1, toOpposite.dot(inward)));
    const angle = Math.acos(cos);
    if (angle > maxAngle) {
      counts[4]++;
      continue;
    }
    const dev = measured - thickness;
    let status: ShellSample['status'] = 0;
    if (Math.abs(dev) > tolerance) status = dev < 0 ? 1 : 2;
    counts[status]++;
    values.push(measured);
    const key = `${Math.round(point.x * 48)}_${Math.round(point.y * 48)}_${Math.round(point.z * 48)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({
      x: point.x, y: point.y, z: point.z,
      hx: opposite.point.x, hy: opposite.point.y, hz: opposite.point.z,
      thickness: measured,
      target: thickness,
      deviation: dev,
      status,
      rim: false,
      triangle: tri,
    });
  }
  return { samples, stats: summarize(values, counts, thickness, tolerance, upperArea) };
}

function emptyThickness(target: number, tolerance: number): ThicknessStats {
  return {
    measuredCount: 0, rimCount: 0, failedCount: 0, okCount: 0, underCount: 0, overCount: 0,
    mean: 0, median: 0, min: 0, max: 0, p05: 0, p95: 0,
    meanAbsDeviation: 0, maxAbsDeviation: 0, tolerance, target,
    histogram: new Array(32).fill(0), histogramMin: target, histogramMax: target,
    withinFraction: 0, measuredArea: 0, failedArea: 0, rimArea: 0,
  };
}

function summarize(
  values: number[],
  counts: number[],
  target: number,
  tolerance: number,
  upperArea: number,
): ThicknessStats {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : 0);
  const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  const meanAbsDeviation = sorted.length ? sorted.reduce((s, v) => s + Math.abs(v - target), 0) / sorted.length : 0;
  const maxAbsDeviation = sorted.reduce((m, v) => Math.max(m, Math.abs(v - target)), 0);
  const bins = 32;
  const histMin = sorted.length ? sorted[0] : target;
  const histMax = sorted.length ? sorted[sorted.length - 1] : target;
  const histogram = new Array(bins).fill(0);
  if (sorted.length) {
    if (histMax > histMin) {
      for (const v of sorted) {
        const b = Math.min(bins - 1, Math.floor(((v - histMin) / (histMax - histMin)) * bins));
        histogram[b]++;
      }
    } else {
      histogram[Math.floor(bins / 2)] = sorted.length;
    }
  }
  const within = sorted.filter((v) => Math.abs(v - target) <= tolerance).length;
  const valid = counts[0] + counts[1] + counts[2];
  const denom = Math.max(1, valid + counts[4] + counts[3]);
  return {
    measuredCount: values.length,
    rimCount: counts[4],
    failedCount: counts[3],
    okCount: counts[0],
    underCount: counts[1],
    overCount: counts[2],
    mean,
    median: percentile(0.5),
    min: sorted.length ? sorted[0] : 0,
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    p05: percentile(0.05),
    p95: percentile(0.95),
    meanAbsDeviation,
    maxAbsDeviation,
    tolerance,
    target,
    histogram,
    histogramMin: histMin,
    histogramMax: histMax,
    withinFraction: sorted.length ? within / sorted.length : 0,
    measuredArea: (upperArea * valid) / denom,
    failedArea: (upperArea * counts[3]) / denom,
    rimArea: (upperArea * counts[4]) / denom,
  };
}

/**
 * Input-side swallowed-feature detection. For each sampled surface point a
 * probe travels along the offset direction; if the first opposite-facing
 * surface is closer than the reach, the offset would pass through it.
 */
export function detectSwallowedFeatures(
  bvh: MeshBVH,
  positions: Float32Array,
  indices: Uint32Array,
  faceNormals: Float32Array,
  opts: { inwardReach: number; outwardReach: number; skin: number; samples: number; seed: number; surfaceArea: number },
): FeatureWarning | null {
  const candidateReaches: number[] = [];
  if (opts.inwardReach > 0) candidateReaches.push(opts.inwardReach);
  if (opts.outwardReach > 0) candidateReaches.push(opts.outwardReach);
  if (candidateReaches.length === 0) return null;
  const triCount = indices.length / 3;
  const cumulative = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    total += triangleArea(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
    cumulative[t] = total;
  }
  if (total <= 0) return null;
  const rng = mulberry32(opts.seed ^ 0x9e3779b9);
  const ray = new THREE.Ray();
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const hits: Array<{ distance: number; point: [number, number, number] }> = [];
  const sampleTarget = Math.min(opts.samples, Math.max(64, triCount * 2));
  let sampleCount = 0;
  for (let s = 0; s < sampleTarget; s++) {
    const r = rng() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const tri = lo;
    let u = rng(), v = rng();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    const ia = indices[tri * 3] * 3;
    const ib = indices[tri * 3 + 1] * 3;
    const ic = indices[tri * 3 + 2] * 3;
    p.set(
      positions[ia] * w + positions[ib] * u + positions[ic] * v,
      positions[ia + 1] * w + positions[ib + 1] * u + positions[ic + 1] * v,
      positions[ia + 2] * w + positions[ib + 2] * u + positions[ic + 2] * v,
    );
    const nx = faceNormals[tri * 3], ny = faceNormals[tri * 3 + 1], nz = faceNormals[tri * 3 + 2];
    sampleCount++;
    for (const inward of [true, false]) {
      const reach = inward ? opts.inwardReach : opts.outwardReach;
      if (!(reach > 0)) continue;
      const sign = inward ? -1 : 1;
      dir.set(nx * sign, ny * sign, nz * sign).normalize();
      ray.origin.set(p.x, p.y, p.z);
      ray.origin.addScaledVector(dir, opts.skin);
      ray.direction.copy(dir);
      const found = bvh.raycast(ray, THREE.DoubleSide).sort((a, b) => a.distance - b.distance);
      let dist = -1;
      for (const hit of found) {
        if (hit.distance <= opts.skin * 1.25) continue;
        if (hit.distance > reach * 2 + opts.skin * 2) break;
        const f = Math.floor(hit.faceIndex ?? -1);
        if (f < 0) continue;
        const dot = faceNormals[f * 3] * nx + faceNormals[f * 3 + 1] * ny + faceNormals[f * 3 + 2] * nz;
        if (dot > -0.15) continue;
        dist = hit.distance + opts.skin;
        // Offset fronts from both sides meet when the facing gap is shorter than
        // twice the reached depth: the feature is filled / ablated.
        if (dist < reach * 2) {
          const hp = ray.origin.clone().addScaledVector(dir, hit.distance);
          hits.push({ distance: dist, point: [hp.x, hp.y, hp.z] });
        }
        break;
      }
      void dist;
    }
  }
  if (hits.length === 0) return null;
  const distances = hits.map((h) => h.distance).sort((a, b) => a - b);
  const points = hits.slice(0, 200).map((h) => h.point);
  return {
    sampleCount: hits.length,
    totalSamples: sampleCount,
    affectedFraction: hits.length / Math.max(1, sampleCount),
    estimatedArea: total * (hits.length / Math.max(1, sampleCount)),
    minFeatureSize: distances[0],
    medianFeatureSize: distances[Math.floor(distances.length / 2)],
    points,
    // The two offset fronts facing each other meet when the free gap is shorter
    // than the summed reach from both sides, so the comparison threshold is
    // twice the reaches actually applied.
    threshold: 2 * Math.max(...candidateReaches),
    description: '',
  };
}

/**
 * Shared exact triangle-pair predicate used by every self-intersection path.
 * The accelerated grid path, the kept BVH reference and the brute-force anchor
 * all run this identical test, so their verdicts can be compared pair by pair.
 */
interface PairTester {
  /** Triangles sharing a vertex are topology neighbours, not self-intersections. */
  sharesVertex(a: number, b: number): boolean;
  /** Exact predicate: coplanar overlap area, otherwise a real crossing segment. */
  intersects(a: number, b: number): boolean;
  midpoint(a: number, b: number): [number, number, number];
}

function createPairTester(mesh: TriMesh): PairTester {
  const positions = mesh.positions;
  const indices = mesh.indices;
  let extent = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    extent = Math.max(extent,
      Math.abs(positions[v * 3]), Math.abs(positions[v * 3 + 1]), Math.abs(positions[v * 3 + 2]));
  }
  const selfIntersectionMinLength = Math.max(1e-6, extent * 2e-5);
  const coplanarEps = Math.max(1e-6, extent * 1e-5);
  const triA = new ExtendedTriangle();
  const triB = new ExtendedTriangle();
  const nA = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const intersectLine = new THREE.Line3();
  const cA = new THREE.Vector3();
  const cB = new THREE.Vector3();
  const load = (t: number, target: ExtendedTriangle) => {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    target.a.set(positions[ia], positions[ia + 1], positions[ia + 2]);
    target.b.set(positions[ib], positions[ib + 1], positions[ib + 2]);
    target.c.set(positions[ic], positions[ic + 1], positions[ic + 2]);
    target.needsUpdate = true;
    return target;
  };
  return {
    sharesVertex(a: number, b: number): boolean {
      const a0 = indices[a * 3], a1 = indices[a * 3 + 1], a2 = indices[a * 3 + 2];
      const b0 = indices[b * 3], b1 = indices[b * 3 + 1], b2 = indices[b * 3 + 2];
      return a0 === b0 || a0 === b1 || a0 === b2 || a1 === b0 || a1 === b1 || a1 === b2 || a2 === b0 || a2 === b1 || a2 === b2;
    },
    intersects(a: number, b: number): boolean {
      load(a, triA);
      load(b, triB);
      triA.getNormal(nA);
      // three.js reports a bogus edge for coplanar pairs, so decide those with
      // a projected 2D overlap-area test instead of the reported segment.
      const d0 = nA.dot(tmp.subVectors(triB.a, triA.a));
      const d1 = nA.dot(tmp.subVectors(triB.b, triA.a));
      const d2 = nA.dot(tmp.subVectors(triB.c, triA.a));
      if (Math.abs(d0) <= coplanarEps && Math.abs(d1) <= coplanarEps && Math.abs(d2) <= coplanarEps) {
        const overlap = coplanarOverlapArea(triA, triB, nA);
        return overlap > 1e-10 * extent * extent && overlap > triA.getArea() * 1e-3 && overlap > triB.getArea() * 1e-3;
      }
      // Non-coplanar: a real crossing leaves a segment. Touching at a single
      // point (coincident cell vertices, folds) is not counted.
      const seg = triA.intersectsTriangle(triB, intersectLine) ? intersectLine : null;
      return seg !== null && seg.start.distanceTo(seg.end) > selfIntersectionMinLength;
    },
    midpoint(a: number, b: number): [number, number, number] {
      load(a, triA);
      load(b, triB);
      triA.getMidpoint(cA);
      triB.getMidpoint(cB);
      cA.add(cB).multiplyScalar(0.5);
      return [cA.x, cA.y, cA.z];
    },
  };
}

function emptySelfIntersection(degenerateTriangleCount: number): SelfIntersectionReport {
  return { pairCount: 0, testedPairs: 0, candidatePairs: 0, points: [], skippedPairCount: 0, degenerateTriangleCount };
}

function runCandidateLoop(
  mesh: TriMesh,
  maxPairs: number,
  forEachPair: (visit: (lo: number, hi: number) => void) => void,
  onIntersection?: (lo: number, hi: number) => void,
): SelfIntersectionReport {
  const degenerateTriangleCount = countDegenerate(mesh);
  if (mesh.triangleCount === 0) return emptySelfIntersection(degenerateTriangleCount);
  const tester = createPairTester(mesh);
  let pairCount = 0;
  let testedPairs = 0;
  let candidatePairs = 0;
  let skipped = 0;
  const points: Array<[number, number, number]> = [];
  forEachPair((lo, hi) => {
    candidatePairs++;
    if (tester.sharesVertex(lo, hi)) return;
    testedPairs++;
    if (testedPairs > maxPairs) {
      skipped++;
      return;
    }
    if (tester.intersects(lo, hi)) {
      pairCount++;
      onIntersection?.(lo, hi);
      if (points.length < 160) points.push(tester.midpoint(lo, hi));
    }
  });
  return { pairCount, testedPairs, candidatePairs, points, skippedPairCount: skipped, degenerateTriangleCount };
}

/**
 * Self-intersection detection accelerated by a conservative uniform-grid
 * spatial index. The index emits exactly the AABB-overlapping triangle pairs —
 * a superset of all truly intersecting pairs — so no intersection can be lost
 * to the bounding-box approximation, including thin parallel sheets and
 * triangles meeting at concave corners. Every candidate then runs the shared
 * exact predicate, and the full candidate set is evaluated (no diagnostic
 * cap unless the caller passes one).
 */
export function detectSelfIntersections(
  mesh: TriMesh,
  maxPairs = Number.POSITIVE_INFINITY,
  onIntersection?: (lo: number, hi: number) => void,
): SelfIntersectionReport {
  if (mesh.triangleCount === 0) return emptySelfIntersection(countDegenerate(mesh));
  return detectSelfIntersectionsWithIndex(mesh, new TriangleIntersectionIndex(mesh), maxPairs, onIntersection);
}

/**
 * Same accelerated detection with a caller-supplied index (explicit cell size,
 * or a reused index). The shell-query benchmark uses this to decompose the
 * cost into index build, candidate generation and exact tests.
 */
export function detectSelfIntersectionsWithIndex(
  mesh: TriMesh,
  index: TriangleIntersectionIndex,
  maxPairs = Number.POSITIVE_INFINITY,
  onIntersection?: (lo: number, hi: number) => void,
): SelfIntersectionReport {
  if (mesh.triangleCount === 0) return emptySelfIntersection(countDegenerate(mesh));
  return runCandidateLoop(mesh, maxPairs, (visit) => index.forEachCandidatePair(visit), onIntersection);
}

/**
 * Kept as the display shell's running reference: the original BVH-vs-BVH
 * (bvhcast) traversal with the identical exact predicate. The benchmark and
 * the parity tests compare the accelerated path against this implementation.
 */
export function detectSelfIntersectionsReference(
  mesh: TriMesh,
  maxPairs = 400_000,
  onIntersection?: (lo: number, hi: number) => void,
): SelfIntersectionReport {
  const degenerateTriangleCount = countDegenerate(mesh);
  if (mesh.triangleCount === 0) return emptySelfIntersection(degenerateTriangleCount);
  const geo = toGeometry(mesh);
  const bvh = new MeshBVH(geo, { targetLeafSize: 16, indirect: true });
  const idx = geo.getIndex()!;
  // Triangles that share an edge (or a cell vertex) are neighbours in the
  // extracted quad grid; only non-adjacent pairs can be real self-intersections.
  const edgeOwner = new Map<string, number[]>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = idx.getX(t * 3);
    const b = idx.getX(t * 3 + 1);
    const c = idx.getX(t * 3 + 2);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      let list = edgeOwner.get(k);
      if (!list) { list = []; edgeOwner.set(k, list); }
      list.push(t);
    }
  }
  void edgeOwner;
  const tester = createPairTester(mesh);
  let pairCount = 0;
  let testedPairs = 0;
  let skipped = 0;
  const points: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  let candidatePairs = 0;
  bvh.bvhcast(bvh, new THREE.Matrix4(), {
    intersectsTriangles: (_ta, _tb, raw1, raw2) => {
      // BVH callbacks report primitive-buffer positions; with an indirect BVH
      // these must be resolved to the original triangle indices.
      const i1 = bvh.resolveTriangleIndex(raw1);
      const i2 = bvh.resolveTriangleIndex(raw2);
      if (i1 === i2) return false;
      const lo = i1 < i2 ? i1 : i2;
      const hi = i1 < i2 ? i2 : i1;
      const key = `${lo}_${hi}`;
      if (seen.has(key)) return false;
      seen.add(key);
      candidatePairs++;
      if (tester.sharesVertex(lo, hi)) return false;
      testedPairs++;
      if (testedPairs > maxPairs) {
        skipped++;
        return false;
      }
      if (tester.intersects(lo, hi)) {
        pairCount++;
        onIntersection?.(lo, hi);
        if (points.length < 160) points.push(tester.midpoint(lo, hi));
      }
      return false;
    },
  });
  return { pairCount, testedPairs, candidatePairs, points, skippedPairCount: skipped, degenerateTriangleCount };
}

/**
 * O(n^2) all-pairs anchor for small meshes: every non-adjacent pair is tested
 * with the shared predicate. This is the complete reference solution used to
 * prove that the spatial index never drops a candidate (miss rate must be 0).
 */
export function detectSelfIntersectionsBruteForce(
  mesh: TriMesh,
  maxPairs = Number.POSITIVE_INFINITY,
  onIntersection?: (lo: number, hi: number) => void,
): SelfIntersectionReport {
  return runCandidateLoop(mesh, maxPairs, (visit) => {
    for (let lo = 0; lo < mesh.triangleCount; lo++) {
      for (let hi = lo + 1; hi < mesh.triangleCount; hi++) {
        visit(lo, hi);
      }
    }
  }, onIntersection);
}

export interface IncrementalSelfIntersection {
  report: SelfIntersectionReport;
  /** All intersecting pairs after the edit, as (lo, hi) triangle id pairs. */
  intersectingPairs: Array<[number, number]>;
}

/**
 * Local intersection acceleration after a model edit. The caller keeps one
 * TriangleIntersectionIndex alive across edits; after vertices move, the index
 * is re-hashed only for the affected triangles (`updateTriangles`) and only
 * candidate pairs touching them are re-tested. Pairs untouched by the edit
 * keep their previous verdicts, so the merged result equals a full re-query
 * at a cost proportional to the edited region.
 *
 * Computation order: (1) re-hash affected triangles, (2) stream candidate
 * pairs involving them, (3) run the shared exact predicate on those,
 * (4) merge with the untouched prior intersections.
 */
export function detectSelfIntersectionsAfterEdit(
  index: TriangleIntersectionIndex,
  mesh: TriMesh,
  affectedTriangles: Iterable<number>,
  priorIntersectingPairs: Iterable<[number, number]>,
  maxPairs = Number.POSITIVE_INFINITY,
): IncrementalSelfIntersection {
  const affectedSet = new Set<number>();
  for (const t of affectedTriangles) affectedSet.add(t);
  index.updateTriangles(mesh, affectedSet);
  const kept: Array<[number, number]> = [];
  for (const [lo, hi] of priorIntersectingPairs) {
    if (!affectedSet.has(lo) && !affectedSet.has(hi)) kept.push([lo, hi]);
  }
  const fresh: Array<[number, number]> = [];
  const report = runCandidateLoop(
    mesh,
    maxPairs,
    (visit) => index.forEachCandidatePairInvolving(affectedSet, visit),
    (lo, hi) => fresh.push([lo, hi]),
  );
  const intersectingPairs = kept.concat(fresh);
  const tester = createPairTester(mesh);
  const points: Array<[number, number, number]> = [];
  for (const [lo, hi] of intersectingPairs) {
    if (points.length >= 160) break;
    points.push(tester.midpoint(lo, hi));
  }
  return {
    report: { ...report, pairCount: intersectingPairs.length, points },
    intersectingPairs,
  };
}

/**
 * Area of the intersection of two coplanar triangles, projected onto the plane
 * with normal n. Both triangles are convex, so clipping one against the other
 * (Sutherland-Hodgman) is exact.
 */
function coplanarOverlapArea(a: THREE.Triangle, b: THREE.Triangle, n: THREE.Vector3): number {
  const basisU = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.x) > 0.9) basisU.set(0, 1, 0);
  basisU.crossVectors(n, basisU).normalize();
  const basisV = new THREE.Vector3().crossVectors(n, basisU).normalize();
  const project = (pts: THREE.Vector3[]): Array<[number, number]> => pts.map((p) => [p.dot(basisU), p.dot(basisV)]);
  let poly = project([a.a, a.b, a.c]);
  const clip = project([b.a, b.b, b.c]);
  const sign = (p1: [number, number], p2: [number, number], q: [number, number]) =>
    (p2[0] - p1[0]) * (q[1] - p1[1]) - (p2[1] - p1[1]) * (q[0] - p1[0]);
  // Consistent winding of the clip triangle (positive area).
  if (polyArea(clip) < 0) clip.reverse();
  for (let i = 0; i < 3; i++) {
    const p1 = clip[i];
    const p2 = clip[(i + 1) % 3];
    const input = poly;
    poly = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const next = input[(j + 1) % input.length];
      const sCur = sign(p1, p2, cur);
      const sNext = sign(p1, p2, next);
      if (sCur >= 0) poly.push(cur);
      if ((sCur >= 0) !== (sNext >= 0)) {
        const t = sCur / (sCur - sNext);
        poly.push([cur[0] + t * (next[0] - cur[0]), cur[1] + t * (next[1] - cur[1])]);
      }
    }
    if (poly.length === 0) return 0;
  }
  return Math.abs(polyArea(poly));
}

function polyArea(poly: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return sum / 2;
}

function countDegenerate(mesh: TriMesh): number {
  let n = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (triangleArea(mesh.positions, mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]) < 1e-12) n++;
  }
  return n;
}

/**
 * Orientation and side verification. Triangle normals must point along +phi
 * (from remaining material toward air). For a closed output, parity probes on
 * both sides of each sampled face confirm material/air classification.
 */
export function verifyShell(
  output: TriMesh,
  normals: Float32Array,
  triangleClass: Uint8Array,
  gradient: (x: number, y: number, z: number) => [number, number, number],
  isClosed: boolean,
  spacing: number,
  sampleCount = 400,
  seed = 4242,
): VerificationReport {
  const rng = mulberry32(seed);
  const triCount = output.triangleCount;
  if (triCount === 0) {
    return { paritySamples: 0, parityMismatches: 0, signedSamples: 0, shellSideMismatches: 0, normalCorrectionApplied: false, note: '无可校验输出。' };
  }
  const bvh = new MeshBVH(toGeometry(output), { targetLeafSize: 12 });
  const probeDist = Math.max(1e-4, spacing * 0.35);
  let signedSamples = 0, signedMismatch = 0;
  let paritySamples = 0, parityMismatches = 0;
  const tri = new THREE.Triangle();
  const mid = new THREE.Vector3();
  const n = new THREE.Vector3();
  const probe = new THREE.Vector3();
  for (let s = 0; s < sampleCount; s++) {
    const t = Math.floor(rng() * triCount);
    if (triangleClass[t] === 2) continue;
    const ia = output.indices[t * 3];
    const ib = output.indices[t * 3 + 1];
    const ic = output.indices[t * 3 + 2];
    tri.set(
      new THREE.Vector3().fromArray(output.positions, ia * 3),
      new THREE.Vector3().fromArray(output.positions, ib * 3),
      new THREE.Vector3().fromArray(output.positions, ic * 3),
    );
    tri.getMidpoint(mid);
    n.set(normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]);
    const g = gradient(mid.x, mid.y, mid.z);
    const glen = Math.hypot(g[0], g[1], g[2]);
    if (glen > 1e-9) {
      signedSamples++;
      if ((n.x * g[0] + n.y * g[1] + n.z * g[2]) / glen < 0) signedMismatch++;
    }
    if (!isClosed) continue;
    const materialProbe = mid.clone().addScaledVector(n, -probeDist);
    const airProbe = mid.clone().addScaledVector(n, probeDist);
    const materialInside = parityInside(bvh, materialProbe);
    const airInside = parityInside(bvh, airProbe);
    paritySamples++;
    if (!materialInside || airInside) parityMismatches++;
  }
  return {
    paritySamples,
    parityMismatches,
    signedSamples,
    shellSideMismatches: signedMismatch,
    normalCorrectionApplied: false,
    note: isClosed
      ? '闭合输出：两侧射线奇偶校验，并以场梯度核对三角面法线方向。'
      : '输出不闭合：不做内部奇偶判断，仅核对法线与场梯度方向。',
  };
}

export function parityInside(bvh: MeshBVH, point: THREE.Vector3): boolean {
  const ray = new THREE.Ray();
  const dirs: Array<[number, number, number]> = [
    [1, 0.0131, 0.0271],
    [0.0177, 1, 0.0219],
    [0.0233, 0.0191, 1],
  ];
  for (const d of dirs) {
    ray.origin.copy(point);
    ray.direction.set(d[0], d[1], d[2]).normalize();
    const hits = bvh.raycast(ray, THREE.DoubleSide);
    let valid = 0;
    for (const h of hits) if (h.distance > 1e-5) valid++;
    if (valid > 0) return valid % 2 === 1;
  }
  return false;
}
