import type { BoundaryLoop, MeshStats, MeshTopology, TriMesh } from '../core/types';

export function emptyStats(): MeshStats {
  return {
    vertexCount: 0,
    triangleCount: 0,
    surfaceArea: 0,
    boundaryEdgeCount: 0,
    boundaryLoopCount: 0,
    nonManifoldEdgeCount: 0,
    inconsistentEdgeCount: 0,
    componentCount: 0,
    shellComponentCount: 0,
    degenerateTriangleCount: 0,
    signedVolume: 0,
    closed: false,
    oriented: false,
    isEmpty: true,
    bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function computeTopology(mesh: TriMesh): MeshTopology {
  const { indices, vertexCount } = mesh;
  const directed = new Map<string, number>();
  const edgeUse = new Map<string, number>();
  const nonManifoldEdges: Array<[number, number]> = [];
  const boundaryEdges: Array<[number, number]> = [];
  const inconsistentEdges: Array<[number, number]> = [];

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const triEdges: Array<[number, number]> = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [u, v] of triEdges) {
      if (u === v) continue;
      const dk = `${u}>${v}`;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
      const k = edgeKey(u, v);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  }

  for (const [k, n] of edgeUse) {
    if (n === 1) {
      const [s] = k.split('_');
      const v = Number(s);
      boundaryEdges.push([v, k.includes('_') ? Number(k.split('_')[1]) : v]);
    } else if (n > 2) {
      const parts = k.split('_');
      nonManifoldEdges.push([Number(parts[0]), Number(parts[1])]);
    }
  }

  for (const [k, n] of edgeUse) {
    if (n === 2) {
      const parts = k.split('_');
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      const fwd = directed.get(`${a}>${b}`) ?? 0;
      const back = directed.get(`${b}>${a}`) ?? 0;
      if (fwd !== 1 || back !== 1) inconsistentEdges.push([a, b]);
    }
  }

  const componentOfVertex = new Int32Array(Math.max(vertexCount, 1)).fill(-1);
  const adj: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    adj[a].push(b, c);
    adj[b].push(a, c);
    adj[c].push(a, b);
  }
  let componentCount = 0;
  const stack: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    if (componentOfVertex[v] !== -1) continue;
    componentOfVertex[v] = componentCount;
    stack.push(v);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of adj[cur]) {
        if (componentOfVertex[nb] === -1) {
          componentOfVertex[nb] = componentCount;
          stack.push(nb);
        }
      }
    }
    componentCount++;
  }

  const loops = extractBoundaryLoops(boundaryEdges, mesh);
  return {
    edgeUse,
    boundaryEdges,
    boundaryLoops: loops,
    nonManifoldEdges,
    inconsistentEdges,
    componentOfVertex,
    componentCount,
  };
}

export function extractBoundaryLoops(boundaryEdges: Array<[number, number]>, mesh: TriMesh): BoundaryLoop[] {
  const { indices, positions } = mesh;
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of boundaryEdges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  }
  const visited = new Set<string>();
  const loops: BoundaryLoop[] = [];
  for (const [a, b] of boundaryEdges) {
    const k = edgeKey(a, b);
    if (visited.has(k)) continue;
    const loop: number[] = [a];
    visited.add(k);
    let prev = a;
    let cur = b;
    let guard = 0;
    while (cur !== a && guard++ < indices.length) {
      loop.push(cur);
      const neighbours = adjacency.get(cur) ?? [];
      let next = -1;
      for (const nb of neighbours) {
        const nk = edgeKey(cur, nb);
        if (nk === edgeKey(prev, cur)) continue;
        if (!visited.has(nk)) {
          next = nb;
          visited.add(nk);
          break;
        }
      }
      if (next === -1) break;
      prev = cur;
      cur = next;
    }
    let length = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i] * 3;
      const q = loop[(i + 1) % loop.length] * 3;
      const dx = positions[q] - positions[p];
      const dy = positions[q + 1] - positions[p + 1];
      const dz = positions[q + 2] - positions[p + 2];
      length += Math.hypot(dx, dy, dz);
    }
    loops.push({ vertices: loop, length, closed: cur === a });
  }
  return loops;
}

export function computeStats(mesh: TriMesh, topology?: MeshTopology): MeshStats {
  const { positions, indices, vertexCount, triangleCount } = mesh;
  if (vertexCount === 0 || triangleCount === 0) return emptyStats();
  const topo = topology ?? computeTopology(mesh);
  let area = 0;
  let signedVolume = 0;
  let degenerate = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const triArea = Math.hypot(nx, ny, nz) * 0.5;
    area += triArea;
    if (triArea <= 1e-14) degenerate++;
    signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  const shellComponentCount = topo.componentCount;
  return {
    vertexCount,
    triangleCount,
    surfaceArea: area,
    boundaryEdgeCount: topo.boundaryEdges.length,
    boundaryLoopCount: topo.boundaryLoops.length,
    nonManifoldEdgeCount: topo.nonManifoldEdges.length,
    inconsistentEdgeCount: topo.inconsistentEdges.length,
    componentCount: topo.componentCount,
    shellComponentCount,
    degenerateTriangleCount: degenerate,
    signedVolume,
    closed: topo.boundaryEdges.length === 0 && topo.nonManifoldEdges.length === 0,
    oriented: topo.inconsistentEdges.length === 0,
    isEmpty: false,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

/**
 * Edges whose incident face normals differ by more than `angleDeg`. These are
 * the sharp creases that the distance-field offset rounds, so thickness probes
 * near them are corner artefacts. Returns flat XYZ segment pairs.
 */
export function collectSharpEdges(
  mesh: TriMesh,
  faceNormals: Float32Array,
  angleDeg: number,
): number[][] {
  const edgeFaces = new Map<string, number[]>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      let list = edgeFaces.get(k);
      if (!list) { list = []; edgeFaces.set(k, list); }
      list.push(t);
    }
  }
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const out: number[][] = [];
  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 2) continue;
    const n1 = faces[0] * 3, n2 = faces[1] * 3;
    const dot = faceNormals[n1] * faceNormals[n2] + faceNormals[n1 + 1] * faceNormals[n2 + 1] + faceNormals[n1 + 2] * faceNormals[n2 + 2];
    if (dot >= cosLimit) continue;
    const [a, b] = key.split('_').map(Number);
    out.push([
      mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2],
      mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2],
    ]);
  }
  return out;
}

/** Distance from a point to the nearest segment in a flat XYZ segment list. */
export function distanceToSegments(
  x: number, y: number, z: number,
  segments: number[][],
): number {
  let best = Infinity;
  for (const seg of segments) {
    const ax = seg[0], ay = seg[1], az = seg[2];
    const bx = seg[3], by = seg[4], bz = seg[5];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const len2 = ex * ex + ey * ey + ez * ez;
    let t = len2 > 0 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * ex, qy = ay + t * ey, qz = az + t * ez;
    const d = Math.hypot(x - qx, y - qy, z - qz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Drop whole triangles and compact away the vertices that no remaining triangle
 * references. Used to remove offset caps that sealed an opening; the original
 * surface is untouched, and the removed count is reported by the caller.
 */
export function filterTriangles(mesh: TriMesh, keep: (triangle: number) => boolean): { mesh: TriMesh; removed: number } {
  const kept: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (!keep(t)) continue;
    kept.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  const removed = mesh.triangleCount - kept.length / 3;
  if (removed === 0) return { mesh, removed };
  const remap = new Int32Array(mesh.vertexCount).fill(-1);
  const positions: number[] = [];
  const indices = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    const v = kept[i];
    if (remap[v] === -1) {
      remap[v] = positions.length / 3;
      positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    }
    indices[i] = remap[v];
  }
  return {
    mesh: {
      positions: new Float32Array(positions),
      indices,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    },
    removed,
  };
}

export function mergeMeshes(meshes: TriMesh[]): TriMesh {
  let vCount = 0;
  let tCount = 0;
  for (const m of meshes) {
    vCount += m.vertexCount;
    tCount += m.triangleCount;
  }
  const positions = new Float32Array(vCount * 3);
  const indices = new Uint32Array(tCount * 3);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo * 3);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += m.vertexCount;
    io += m.indices.length;
  }
  return { positions, indices, vertexCount: vCount, triangleCount: tCount };
}

export function flipMeshWinding(mesh: TriMesh): TriMesh {
  const indices = new Uint32Array(mesh.indices);
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
  return { ...mesh, indices };
}

export function computeVertexNormals(mesh: TriMesh): Float32Array {
  const { positions, indices, vertexCount } = mesh;
  const normals = new Float32Array(vertexCount * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < vertexCount; i++) {
    const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
    const len = Math.hypot(x, y, z);
    if (len > 1e-12) {
      normals[i * 3] = x / len;
      normals[i * 3 + 1] = y / len;
      normals[i * 3 + 2] = z / len;
    }
  }
  return normals;
}

export function triangleArea(positions: ArrayLike<number>, a: number, b: number, c: number): number {
  const ia = a * 3, ib = b * 3, ic = c * 3;
  const ux = positions[ib] - positions[ia];
  const uy = positions[ib + 1] - positions[ia + 1];
  const uz = positions[ib + 2] - positions[ia + 2];
  const vx = positions[ic] - positions[ia];
  const vy = positions[ic + 1] - positions[ia + 1];
  const vz = positions[ic + 2] - positions[ia + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.hypot(nx, ny, nz) * 0.5;
}

export function hashGeometry(positions: Float32Array, indices: Uint32Array): string {
  // FNV-1a over quantized coordinates and index buffer; used only to prove the
  // original asset is not rewritten in place by the pipeline.
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const ib = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  for (let i = 0; i < ib.length; i++) {
    h ^= ib[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface OrientationResult {
  mesh: TriMesh;
  flippedTriangleCount: number;
  flippedComponentCount: number;
  ambiguousEdgeCount: number;
  components: number;
  changed: boolean;
}

/**
 * Make a closed mesh consistently wound, then orient each component outward
 * using its signed volume. Returns a converted copy; the input is not touched.
 */
export function orientClosedMesh(mesh: TriMesh): OrientationResult {
  const triCount = mesh.triangleCount;
  const indices = new Uint32Array(mesh.indices);
  if (triCount === 0) {
    return { mesh: { ...mesh, indices }, flippedTriangleCount: 0, flippedComponentCount: 0, ambiguousEdgeCount: 0, components: 0, changed: false };
  }
  // Undirected edge -> list of using triangles with their directed edge.
  const edgeUsers = new Map<string, Array<{ tri: number; from: number; to: number }>>();
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const k = edgeKey(u, v);
      let list = edgeUsers.get(k);
      if (!list) {
        list = [];
        edgeUsers.set(k, list);
      }
      list.push({ tri: t, from: u, to: v });
    }
  }
  const adj: Array<Array<{ tri: number; sameDirection: boolean }>> = Array.from({ length: triCount }, () => []);
  let ambiguousEdgeCount = 0;
  for (const [, users] of edgeUsers) {
    if (users.length === 2) {
      const same = users[0].from === users[1].from;
      adj[users[0].tri].push({ tri: users[1].tri, sameDirection: same });
      adj[users[1].tri].push({ tri: users[0].tri, sameDirection: same });
    } else if (users.length > 2) {
      ambiguousEdgeCount++;
    }
  }
  const flip = new Int8Array(triCount).fill(-1);
  const componentOf = new Int32Array(triCount).fill(-1);
  const compVertices = new Map<number, number[]>();
  let components = 0;
  const queue: number[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (flip[seed] !== -1) continue;
    flip[seed] = 0;
    componentOf[seed] = components;
    queue.push(seed);
    compVertices.set(components, []);
    while (queue.length) {
      const cur = queue.pop()!;
      compVertices.get(components)!.push(indices[cur * 3], indices[cur * 3 + 1], indices[cur * 3 + 2]);
      for (const nb of adj[cur]) {
        if (flip[nb.tri] !== -1) continue;
        flip[nb.tri] = nb.sameDirection ? 1 - flip[cur] : flip[cur];
        componentOf[nb.tri] = components;
        queue.push(nb.tri);
      }
    }
    components++;
  }
  let flippedTriangleCount = 0;
  for (let t = 0; t < triCount; t++) {
    if (flip[t] === 1) {
      const tmp = indices[t * 3 + 1];
      indices[t * 3 + 1] = indices[t * 3 + 2];
      indices[t * 3 + 2] = tmp;
      flippedTriangleCount++;
    }
  }
  let flippedComponentCount = 0;
  for (let comp = 0; comp < components; comp++) {
    const verts = compVertices.get(comp)!;
    let volume = 0;
    for (let i = 0; i < verts.length; i += 3) {
      const ia = verts[i] * 3;
      const ib = verts[i + 1] * 3;
      const ic = verts[i + 2] * 3;
      const ax = mesh.positions[ia], ay = mesh.positions[ia + 1], az = mesh.positions[ia + 2];
      const bx = mesh.positions[ib], by = mesh.positions[ib + 1], bz = mesh.positions[ib + 2];
      const cx = mesh.positions[ic], cy = mesh.positions[ic + 1], cz = mesh.positions[ic + 2];
      volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    }
    if (volume < 0) {
      flippedComponentCount++;
      for (let t = 0; t < triCount; t++) {
        if (componentOf[t] !== comp) continue;
        const tmp = indices[t * 3 + 1];
        indices[t * 3 + 1] = indices[t * 3 + 2];
        indices[t * 3 + 2] = tmp;
      }
    }
  }
  return {
    mesh: { ...mesh, indices },
    flippedTriangleCount,
    flippedComponentCount,
    ambiguousEdgeCount,
    components,
    changed: flippedTriangleCount > 0 || flippedComponentCount > 0,
  };
}

