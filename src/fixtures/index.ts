import * as THREE from 'three';
import type { TriMesh } from '../core/types';

export interface FixtureDefinition {
  id: string;
  name: string;
  description: string;
  /** Expected wall thickness when the preset is at its default. null = not a known-thickness fixture. */
  knownThickness: number | null;
  expectedOpen: boolean;
  tags: string[];
  build: () => TriMesh;
}

function fromGeometry(geo: THREE.BufferGeometry): TriMesh {
  const indexed = geo.index ? geo.toNonIndexed() : geo;
  const pos = indexed.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);
  }
  const indices = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) indices[i] = i;
  return weld({ positions, indices, vertexCount: pos.count, triangleCount: pos.count / 3 });
}

export function weld(mesh: TriMesh, eps = 1e-5): TriMesh {
  const map = new Map<string, number>();
  const outPositions: number[] = [];
  const outIndices = new Uint32Array(mesh.indices.length);
  const remap = new Int32Array(mesh.vertexCount);
  const q = 1 / eps;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      remap[i] = existing;
    } else {
      const id = outPositions.length / 3;
      map.set(key, id);
      outPositions.push(x, y, z);
      remap[i] = id;
    }
  }
  let kept = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]];
    const b = remap[mesh.indices[t + 1]];
    const c = remap[mesh.indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    outIndices[kept++] = a;
    outIndices[kept++] = b;
    outIndices[kept++] = c;
  }
  const positions = new Float32Array(outPositions);
  const indices = outIndices.slice(0, kept);
  return { positions, indices, vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

function merge(meshes: TriMesh[]): TriMesh {
  let vc = 0, tc = 0;
  for (const m of meshes) { vc += m.vertexCount; tc += m.triangleCount; }
  const positions = new Float32Array(vc * 3);
  const indices = new Uint32Array(tc * 3);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo * 3);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += m.vertexCount;
    io += m.indices.length;
  }
  return { positions, indices, vertexCount: vc, triangleCount: tc };
}

function transformMesh(mesh: TriMesh, fn: (x: number, y: number, z: number) => [number, number, number]): TriMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const [x, y, z] = fn(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  return { ...mesh, positions };
}

/** Extrude a 2D polygon (XY plane, CCW) along Z into a closed, consistently wound prism. */
function extrudePolygon(points: Array<[number, number]>, z0: number, z1: number): TriMesh {
  const triangles = THREE.ShapeUtils.triangulateShape(
    points.map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );
  const vertices: number[] = [];
  const indices: number[] = [];
  const n = points.length;
  for (const [x, y] of points) {
    vertices.push(x, y, z1);
    vertices.push(x, y, z0);
  }
  // back cap z1: CCW gives +Z normal
  for (const [a, b, c] of triangles) indices.push(a * 2, b * 2, c * 2);
  // front cap z0: reverse winding -> -Z normal
  for (const [a, b, c] of triangles) indices.push(c * 2 + 1, b * 2 + 1, a * 2 + 1);
  // side walls: for edge p->q of a CCW outline, (p_front, q_front, q_back, p_back) faces outward
  for (let i = 0; i < n; i++) {
    const p = i;
    const q = (i + 1) % n;
    const pf = p * 2 + 1, qf = q * 2 + 1;
    const pb = p * 2, qb = q * 2;
    indices.push(pf, qf, qb, pf, qb, pb);
  }
  return {
    positions: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    vertexCount: vertices.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** Closed solid sphere of radius 20; offsetting inward by t leaves a shell of thickness t. */
function buildSolidSphere(): TriMesh {
  return fromGeometry(new THREE.SphereGeometry(20, 80, 56));
}

/**
 * 40 x 40 x 12 block with a 4-wide, 4-deep central groove, as an extruded
 * U-profile prism (closed, consistently oriented).
 */
function buildGroovedBlock(): TriMesh {
  const profile: Array<[number, number]> = [
    [-20, -6],
    [20, -6],
    [20, 6],
    [1.2, 6],
    [1.2, 2],
    [-1.2, 2],
    [-1.2, 6],
    [-20, 6],
  ];
  return weld(extrudePolygon(profile, -20, 20));
}

/** Dumbbell: two 18-radius lobes joined by a 2.2-radius neck, via a closed lathe profile. */
function buildThinNeck(): TriMesh {
  const profile: Array<[number, number]> = [
    [0, -22],
    [18, -21.5],
    [18, -7],
    [2.2, -4.5],
    [2.2, 4.5],
    [18, 7],
    [18, 21.5],
    [0, 22],
  ];
  const geo = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    64,
  );
  const mesh = fromGeometry(geo);
  // Lathe revolves around Y with outward normals; keep as-is.
  return mesh;
}

/**
 * Curved open sheet: a true annulus (hole radius 5, outer radius 24) bowed along
 * one axis. Two boundary loops, no interior; the hole must survive offsetting.
 */
function buildOpenSheet(): TriMesh {
  const holeR = 5;
  const outerR = 24;
  const ringCount = 10;
  const radialSegments = 96;
  const bow = 0.012;
  const positions: number[] = [];
  const indices: number[] = [];
  const index = (i: number, j: number) => (i * radialSegments) + (j % radialSegments);
  for (let i = 0; i <= ringCount; i++) {
    const r = holeR + ((outerR - holeR) * i) / ringCount;
    for (let j = 0; j < radialSegments; j++) {
      const a = (j / radialSegments) * Math.PI * 2;
      const x = r * Math.cos(a);
      const z = r * Math.sin(a);
      positions.push(x, bow * x * x, z);
    }
  }
  for (let i = 0; i < ringCount; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = index(i, j);
      const b = index(i + 1, j);
      const c = index(i + 1, j + 1);
      const d = index(i, j + 1);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  return weld({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  });
}

export const FIXTURES: FixtureDefinition[] = [
  {
    id: 'solid-sphere',
    name: '球壳 (Solid sphere)',
    description: '半径 20 的闭合实心球；向内偏置 2.5 得到已知壁厚 2.5 的球壳。',
    knownThickness: 2.5,
    expectedOpen: false,
    tags: ['closed', 'known-thickness'],
    build: buildSolidSphere,
  },
  {
    id: 'grooved-block',
    name: '凹槽块 (Grooved block)',
    description: '40×40×12 实心块，顶部有 2.4 宽、4 深中央凹槽，用于检查凹槽侧壁与角部。',
    knownThickness: null,
    expectedOpen: false,
    tags: ['closed', 'groove'],
    build: buildGroovedBlock,
  },
  {
    id: 'thin-neck',
    name: '薄颈 (Thin neck)',
    description: '两个半径 18 的瓣由半径 2.2 的颈部相连；偏置量接近颈部半径时观察特征吞并。',
    knownThickness: null,
    expectedOpen: false,
    tags: ['closed', 'thin-feature'],
    build: buildThinNeck,
  },
  {
    id: 'open-sheet',
    name: '开口片 (Open sheet)',
    description: '半径 5–24 的弯曲环状开口曲面（内外两条边界环）；必须显式选择偏置侧，不推断内部。',
    knownThickness: null,
    expectedOpen: true,
    tags: ['open', 'boundary'],
    build: buildOpenSheet,
  },
];

export function getFixture(id: string): FixtureDefinition {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`未知夹具: ${id}`);
  return f;
}

export { merge };
