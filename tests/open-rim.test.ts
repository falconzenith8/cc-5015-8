import { test, expect } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { getFixture } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import { toGeometry } from '../src/geometry/measure';

function firstHitDist(mesh: { positions: Float32Array; indices: Uint32Array; vertexCount: number; triangleCount: number }, ray: THREE.Ray): number {
  const bvh = new MeshBVH(toGeometry(mesh), { indirect: true });
  const hits = bvh.raycast(ray, THREE.DoubleSide).sort((a, b) => a.distance - b.distance);
  return hits.length ? hits[0].distance : -1;
}

test('open sheet keeps its hole and stays open', { timeout: 180000 }, () => {
  const fixture = getFixture('open-sheet');
  const input = fixture.build();
  const result = runOffset(input, {
    inputName: fixture.name, expectedOpen: true, openSide: 'positive',
    params: { ...DEFAULT_PARAMS, mode: 'symmetric', thickness: 2, resolution: 96 },
  });
  const out = result.output!.mesh;
  // Vertical ray through the axis: the hole must pass through with no hits.
  const ray = new THREE.Ray(new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, -1, 0));
  expect(firstHitDist(out, ray)).toBe(-1);
  // Off-axis: two surfaces separated by the target thickness. The sheet is
  // bowed (y = 0.012 x^2), so a vertical ray crosses a slanted wall and the
  // chord is 2 / cos(theta) for the local slope.
  const probeX = 8;
  const slope = 2 * 0.012 * probeX;
  const expectedChord = 2 * Math.sqrt(1 + slope * slope);
  const off = new THREE.Ray(new THREE.Vector3(probeX, 40, 0.012 * probeX * probeX), new THREE.Vector3(0, -1, 0));
  const hits = new MeshBVH(toGeometry(out), { indirect: true })
    .raycast(off, THREE.DoubleSide)
    .map((h) => 40 - h.distance)
    .sort((a, b) => a - b);
  expect(hits.length).toBe(2);
  expect(Math.abs(hits[1] - hits[0] - expectedChord)).toBeLessThan(0.12);
  // The output is still an open surface and reports the opening as such.
  expect(result.output!.stats.closed).toBe(false);
  expect(result.output!.stats.boundaryLoopCount).toBeGreaterThan(0);
  expect(result.checks.find((c) => c.id === 'sides')!.status).toBe('na');
  // The rim trim is a reported change, not a silent deletion.
  expect(result.changes.some((c) => c.id === 'open-rim-trim')).toBe(true);
  expect(result.ok).toBe(true);
});

test('open sheet needs an explicit air side and does not guess one', () => {
  const fixture = getFixture('open-sheet');
  const result = runOffset(fixture.build(), {
    inputName: fixture.name, expectedOpen: true, openSide: null,
    params: { ...DEFAULT_PARAMS },
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join(' ')).toContain('空气侧');
});
