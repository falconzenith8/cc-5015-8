import { describe, expect, it } from 'vitest';
import { getFixture } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import {
  detectSelfIntersections,
  detectSelfIntersectionsAfterEdit,
  detectSelfIntersectionsBruteForce,
} from '../src/geometry/measure';
import { TriangleIntersectionIndex } from '../src/geometry/intersectionIndex';
import type { TriMesh } from '../src/core/types';
import {
  buildConcaveChannelWithFin,
  buildParallelSheets,
  collectRun,
  comparePairSets,
  dentMeshInPlace,
} from './helpers/syntheticShells';

function cloneMesh(mesh: TriMesh): TriMesh {
  return {
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
  };
}

describe('conservative spatial index vs complete references', () => {
  it('thin parallel sheets: no intersection is missed and none invented', () => {
    // Gap 0.05 with ~1.0-sized triangles: boxes overlap everywhere, so a
    // non-conservative filter would either explode or drop pairs.
    const flat = buildParallelSheets({ size: 12, quads: 10, gap: 0.05 });
    const grid = collectRun(flat, 'grid');
    const brute = collectRun(flat, 'brute-force');
    const cmp = comparePairSets(grid.pairs, brute.pairs);
    expect(grid.report.pairCount).toBe(0);
    expect(brute.report.pairCount).toBe(0);
    expect(cmp.missRate).toBe(0);
    expect(cmp.extraRate).toBe(0);
    // The conservative filter must still consider cross-sheet candidates.
    expect(grid.report.candidatePairs).toBeGreaterThan(0);
  });

  it('dented thin sheets: crossing pairs at the dent match brute force exactly', () => {
    const dented = buildParallelSheets({
      size: 12,
      quads: 10,
      gap: 0.3,
      dent: { center: [1.3, -2.1], radius: 2.2, depth: 0.9 },
    });
    const grid = collectRun(dented, 'grid');
    const bvh = collectRun(dented, 'bvh-reference');
    const brute = collectRun(dented, 'brute-force');
    expect(brute.report.pairCount).toBeGreaterThan(0);
    for (const run of [grid, bvh]) {
      const cmp = comparePairSets(run.pairs, brute.pairs);
      expect(cmp.missed).toEqual([]);
      expect(cmp.extra).toEqual([]);
      expect(cmp.missRate).toBe(0);
    }
  });

  it('concave channel with a crossing fin: intersections at the concave corner are found', () => {
    const mesh = buildConcaveChannelWithFin();
    const grid = collectRun(mesh, 'grid');
    const bvh = collectRun(mesh, 'bvh-reference');
    const brute = collectRun(mesh, 'brute-force');
    // The fin crosses the floor and one wall next to the concave corner.
    expect(brute.report.pairCount).toBeGreaterThan(0);
    for (const run of [grid, bvh]) {
      const cmp = comparePairSets(run.pairs, brute.pairs);
      expect(cmp.missed).toEqual([]);
      expect(cmp.extra).toEqual([]);
    }
  });

  it('grid candidates are emitted exactly once each', () => {
    const mesh = buildConcaveChannelWithFin();
    const index = new TriangleIntersectionIndex(mesh);
    let count = 0;
    const seen = new Set<string>();
    index.forEachCandidatePair((a, b) => {
      count++;
      const key = `${a}_${b}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    });
    expect(count).toBe(seen.size);
  });

  it('grid candidate set is a superset of every brute-force intersection', () => {
    const mesh = buildParallelSheets({
      size: 10,
      quads: 8,
      gap: 0.2,
      dent: { center: [0.7, 1.9], radius: 1.8, depth: 0.7 },
    });
    const index = new TriangleIntersectionIndex(mesh);
    const candidates = new Set<string>();
    index.forEachCandidatePair((a, b) => candidates.add(`${a}_${b}`));
    const brute = collectRun(mesh, 'brute-force');
    for (const p of brute.pairs) {
      expect(candidates.has(p)).toBe(true);
    }
  });

  it('empty and degenerate inputs stay consistent across paths', () => {
    const empty: TriMesh = { positions: new Float32Array(0), indices: new Uint32Array(0), vertexCount: 0, triangleCount: 0 };
    for (const method of ['grid', 'bvh-reference', 'brute-force'] as const) {
      const run = collectRun(empty, method);
      expect(run.report.pairCount).toBe(0);
      expect(run.report.candidatePairs).toBe(0);
    }
  });

  it('the diagnostic cap still reports skipped pairs instead of hiding them', () => {
    const mesh = buildConcaveChannelWithFin();
    const capped = detectSelfIntersections(mesh, 5);
    const full = detectSelfIntersections(mesh);
    expect(capped.skippedPairCount).toBe(capped.testedPairs - 5);
    expect(capped.testedPairs).toBe(full.testedPairs);
  });
});

describe('incremental index maintenance after local reshaping', () => {
  it('merged incremental results equal a full re-query on the modified mesh', () => {
    const mesh = buildParallelSheets({ size: 14, quads: 12, gap: 0.4 });
    const index = new TriangleIntersectionIndex(mesh);
    const basePairs: Array<[number, number]> = [];
    detectSelfIntersections(mesh, Number.POSITIVE_INFINITY, (lo, hi) => basePairs.push([lo, hi]));

    // Local edit: push a patch of the lower sheet through the upper one.
    const affected = dentMeshInPlace(mesh, [2.1, -1.4, 0], 2.6, 1.2, [0, 0, 1], {
      vertex: (v) => mesh.positions[v * 3 + 2] < 0.2,
    });
    expect(affected.length).toBeGreaterThan(0);

    const incremental = detectSelfIntersectionsAfterEdit(index, mesh, affected, basePairs);
    const merged = new Set(incremental.intersectingPairs.map(([lo, hi]) => `${lo}_${hi}`));

    const fullGrid = collectRun(mesh, 'grid');
    const fullRef = collectRun(mesh, 'bvh-reference');
    expect(fullRef.report.pairCount).toBeGreaterThan(0);
    for (const reference of [fullGrid.pairs, fullRef.pairs]) {
      const cmp = comparePairSets(merged, reference);
      expect(cmp.missed).toEqual([]);
      expect(cmp.extra).toEqual([]);
      expect(cmp.missRate).toBe(0);
    }
    // The incremental pass must only re-test pairs near the edit.
    expect(incremental.report.testedPairs).toBeLessThan(fullGrid.report.testedPairs);
    expect(incremental.report.pairCount).toBe(fullGrid.report.pairCount);
  });

  it('updated index reproduces the freshly built candidate set exactly', () => {
    const mesh = buildParallelSheets({ size: 12, quads: 10, gap: 0.3 });
    const index = new TriangleIntersectionIndex(mesh);
    const affected = dentMeshInPlace(mesh, [-1.2, 0.8, 0], 2.4, 1.0, [0, 0, 1], {
      vertex: (v) => mesh.positions[v * 3 + 2] < 0.15,
    });
    index.updateTriangles(mesh, affected);
    const affectedSet = new Set(affected);

    const updatedAll = new Set<string>();
    index.forEachCandidatePair((a, b) => updatedAll.add(`${a}_${b}`));
    const fresh = new TriangleIntersectionIndex(mesh);
    const freshAll = new Set<string>();
    fresh.forEachCandidatePair((a, b) => freshAll.add(`${a}_${b}`));
    expect(updatedAll).toEqual(freshAll);

    const involving = new Set<string>();
    index.forEachCandidatePairInvolving(affectedSet, (a, b) => involving.add(`${a}_${b}`));
    const freshInvolving = new Set<string>();
    for (const key of freshAll) {
      const [a, b] = key.split('_').map(Number);
      if (affectedSet.has(a) || affectedSet.has(b)) freshInvolving.add(key);
    }
    expect(involving).toEqual(freshInvolving);
  });
});

describe('pipeline outputs: accelerated path vs kept reference', () => {
  const cases: Array<[string, number, number]> = [
    ['grooved-block', 1.5, 72],
    ['solid-sphere', 2.5, 64],
    ['thin-neck', 1.2, 72],
  ];
  for (const [id, thickness, resolution] of cases) {
    it(`${id}: identical failure regions, zero miss rate`, { timeout: 300000 }, () => {
      const fixture = getFixture(id);
      const r = runOffset(fixture.build(), {
        inputName: fixture.name,
        expectedOpen: fixture.expectedOpen,
        openSide: null,
        params: { ...DEFAULT_PARAMS, mode: 'inward', thickness, resolution },
      });
      const mesh = r.output!.mesh;
      const grid = collectRun(mesh, 'grid');
      const ref = collectRun(mesh, 'bvh-reference');
      const cmp = comparePairSets(grid.pairs, ref.pairs);
      expect(cmp.missed).toEqual([]);
      expect(cmp.extra).toEqual([]);
      expect(cmp.missRate).toBe(0);
      expect(grid.report.pairCount).toBe(ref.report.pairCount);
      // The conservative filter must not inflate the exact-test workload.
      expect(grid.report.candidatePairs).toBeLessThanOrEqual(ref.report.candidatePairs);
    });
  }

  it('dented shell output: intersections created by local reshaping are all found', { timeout: 300000 }, () => {
    const fixture = getFixture('grooved-block');
    const r = runOffset(fixture.build(), {
      inputName: fixture.name,
      expectedOpen: fixture.expectedOpen,
      openSide: null,
      params: { ...DEFAULT_PARAMS, mode: 'inward', thickness: 1.5, resolution: 72 },
    });
    const mesh = cloneMesh(r.output!.mesh);
    // The grooved block is extruded along Z; its flat top is the y = 6 plane
    // (the groove sits at |x| < 1.2). Dent only the outer top surface
    // (y > 5) inward past the inner surface at y ≈ 4.5 — the patch crosses it.
    const affected = dentMeshInPlace(mesh, [8, 6.2, 0], 4.0, 3.4, [0, -1, 0], {
      vertex: (v) => mesh.positions[v * 3 + 1] > 5,
    });
    expect(affected.length).toBeGreaterThan(0);
    const grid = collectRun(mesh, 'grid');
    const ref = collectRun(mesh, 'bvh-reference');
    expect(ref.report.pairCount).toBeGreaterThan(0);
    const cmp = comparePairSets(grid.pairs, ref.pairs);
    expect(cmp.missed).toEqual([]);
    expect(cmp.extra).toEqual([]);
  });
});
