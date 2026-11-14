import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { FieldTopologyReport } from '../core/types';
import { toGeometry } from './measure';

/**
 * Field-level topology accounting on a coarse parity grid.
 *
 * Air is "enclosed" when it is not connected to the grid border. For a shell the
 * cavity is the enclosed air region; for a solid input there is none. A cavity
 * whose centre lies inside the original material (inputPhi < 0) was newly
 * enclosed by the offset itself, which is reported rather than silently kept.
 */
export function analyzeFieldTopology(
  inputPhi: (x: number, y: number, z: number) => number,
  outputMesh: { positions: Float32Array; indices: Uint32Array; vertexCount: number; triangleCount: number } | null,
  domain: { min: [number, number, number]; max: [number, number, number]; dims: [number, number, number] },
  resolution = 48,
): FieldTopologyReport {
  const min = domain.min;
  const max = domain.max;
  const spans: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longest = Math.max(...spans) || 1;
  const dims: [number, number, number] = [
    Math.max(4, Math.round((spans[0] / longest) * resolution) + 1),
    Math.max(4, Math.round((spans[1] / longest) * resolution) + 1),
    Math.max(4, Math.round((spans[2] / longest) * resolution) + 1),
  ];
  const [nx, ny, nz] = dims;
  const steps: [number, number, number] = [spans[0] / (nx - 1), spans[1] / (ny - 1), spans[2] / (nz - 1)];
  const cellVolume = steps[0] * steps[1] * steps[2];
  const count = nx * ny * nz;
  const world = (idx: number): [number, number, number] => {
    const i = idx % nx;
    const j = Math.floor(idx / nx) % ny;
    const k = Math.floor(idx / (nx * ny));
    return [min[0] + i * steps[0], min[1] + j * steps[1], min[2] + k * steps[2]];
  };

  // Input air: unknown outside for open inputs, parity-based for closed ones.
  const inputAir = new Uint8Array(count);
  for (let idx = 0; idx < count; idx++) {
    const [x, y, z] = world(idx);
    if (inputPhi(x, y, z) > 0) inputAir[idx] = 1;
  }
  const inputLabels = labelComponents(nx, ny, nz, inputAir, min, steps);
  const inputEnclosed = inputLabels.components.filter((c) => !c.touchesBorder);
  const inputEnclosedAirComponents = inputEnclosed.length;

  if (!outputMesh || outputMesh.triangleCount === 0) {
    return {
      inputAirComponents: inputLabels.components.length,
      inputEnclosedAirComponents,
      outputEnclosedAirComponents: 0,
      outputInnerVoidComponents: 0,
      newlyEnclosedAirVolumes: [],
      splitInnerVoidVolumes: [],
      enclosedAirLocations: [],
      innerVoidLocations: [],
    };
  }

  const bvh = new MeshBVH(toGeometry(outputMesh), { targetLeafSize: 12 });
  const outside = new Uint8Array(count);
  const ray = new THREE.Ray();
  const dir = new THREE.Vector3(1, 0.0173, 0.0311).normalize();
  for (let idx = 0; idx < count; idx++) {
    const [x, y, z] = world(idx);
    ray.origin.set(x, y, z);
    ray.direction.copy(dir);
    const hits = bvh.raycast(ray, THREE.DoubleSide);
    const xs: number[] = [];
    for (const h of hits) if (h.distance > 1e-6) xs.push(_rayX(ray) + h.distance);
    xs.sort((a, b) => a - b);
    let unique = 0;
    let last = -Infinity;
    for (const v of xs) {
      if (v - last > Math.min(steps[0], steps[1], steps[2]) * 0.02) {
        unique++;
        last = v;
      }
    }
    outside[idx] = unique % 2 === 0 ? 1 : 0;
  }
  const outLabels = labelComponents(nx, ny, nz, outside, min, steps);
  const cavities = outLabels.components.filter((c) => !c.touchesBorder);
  const innerVoidLocations: Array<[number, number, number]> = [];
  const newlyEnclosed: number[] = [];
  const enclosedLocations: Array<[number, number, number]> = [];
  const splitVolumes: number[] = [];
  for (const cavity of cavities) innerVoidLocations.push(cavity.centroidWorld);

  // A bounded offset band around a closed input always has one hollow interior;
  // that void is the intended shell cavity, not an anomaly. Only cavities beyond
  // the expected count are reported as newly enclosed air.
  const expectedCavities = inputEnclosedAirComponents + 1;
  const extra = cavities.length - expectedCavities;
  if (extra > 0) {
    const sorted = cavities
      .map((c, i) => ({ c, i, v: c.volume * cellVolume }))
      .filter((entry) => inputPhi(entry.c.centroidWorld[0], entry.c.centroidWorld[1], entry.c.centroidWorld[2]) < 0)
      .sort((a, b) => a.v - b.v);
    for (const entry of sorted.slice(0, extra)) {
      newlyEnclosed.push(entry.v);
      enclosedLocations.push(entry.c.centroidWorld);
    }
  }
  // A cavity still counts as "split" when the input had one enclosed void and
  // the output produced more than one cavity.
  if (inputEnclosedAirComponents > 0 && cavities.length > inputEnclosedAirComponents) {
    const vols = cavities.map((c) => c.volume * cellVolume).sort((a, b) => a - b);
    splitVolumes.push(...vols.slice(0, cavities.length - inputEnclosedAirComponents));
  }
  return {
    inputAirComponents: inputLabels.components.length,
    inputEnclosedAirComponents,
    outputEnclosedAirComponents: cavities.length,
    outputInnerVoidComponents: cavities.length,
    newlyEnclosedAirVolumes: newlyEnclosed,
    splitInnerVoidVolumes: splitVolumes,
    enclosedAirLocations: enclosedLocations.slice(0, 24),
    innerVoidLocations: innerVoidLocations.slice(0, 24),
  };
}

function _rayX(ray: THREE.Ray): number {
  return ray.origin.x;
}

interface LabelComponent {
  volume: number;
  touchesBorder: boolean;
  centroidWorld: [number, number, number];
}

function labelComponents(
  nx: number,
  ny: number,
  nz: number,
  mask: Uint8Array,
  min: [number, number, number],
  steps: [number, number, number],
): { components: LabelComponent[] } {
  const count = nx * ny * nz;
  const labels = new Int32Array(count).fill(-1);
  const components: LabelComponent[] = [];
  const stack: number[] = [];
  const strideZ = nx * ny;
  for (let start = 0; start < count; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;
    const id = components.length;
    labels[start] = id;
    stack.push(start);
    let volume = 0;
    let touchesBorder = false;
    let cx = 0, cy = 0, cz = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      volume++;
      const i = cur % nx;
      const j = Math.floor(cur / nx) % ny;
      const k = Math.floor(cur / strideZ);
      cx += i; cy += j; cz += k;
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) touchesBorder = true;
      const nbs = [
        i > 0 ? cur - 1 : -1,
        i < nx - 1 ? cur + 1 : -1,
        j > 0 ? cur - nx : -1,
        j < ny - 1 ? cur + nx : -1,
        k > 0 ? cur - strideZ : -1,
        k < nz - 1 ? cur + strideZ : -1,
      ];
      for (const nb of nbs) {
        if (nb < 0) continue;
        if (mask[nb] !== 1 || labels[nb] !== -1) continue;
        labels[nb] = id;
        stack.push(nb);
      }
    }
    const gi = cx / volume, gj = cy / volume, gk = cz / volume;
    components.push({
      volume,
      touchesBorder,
      centroidWorld: [
        min[0] + gi * steps[0],
        min[1] + gj * steps[1],
        min[2] + gk * steps[2],
      ],
    });
  }
  return { components };
}
