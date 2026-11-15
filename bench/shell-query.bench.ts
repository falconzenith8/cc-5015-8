import { describe, expect, it } from 'vitest';
import { getFixture } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import { TriangleIntersectionIndex } from '../src/geometry/intersectionIndex';
import {
  detectSelfIntersectionsAfterEdit,
  detectSelfIntersectionsReference,
  detectSelfIntersectionsWithIndex,
} from '../src/geometry/measure';
import type { TriMesh } from '../src/core/types';
import {
  buildConcaveChannelWithFin,
  buildParallelSheets,
  collectRun,
  comparePairSets,
  dentMeshInPlace,
} from '../tests/helpers/syntheticShells';

/**
 * 外壳查询基准 — shell query benchmark for the local intersection acceleration.
 *
 * Computation order (fixed, per case):
 *   1. Build the workload mesh (pipeline output or synthetic shell).
 *   2. Correctness phase: the accelerated path runs to COMPLETION first
 *      (index build -> candidate generation -> exact tests), then the kept
 *      reference (bvhcast, uncapped) and — for small meshes — the O(n^2)
 *      brute force run to completion. Intersecting-pair sets are compared;
 *      miss rate and extra rate must be exactly 0, otherwise the benchmark
 *      fails here and no timing is reported.
 *   3. Only after the accelerated path has fully executed and matched the
 *      reference do we compare speed (median of TIMING_REPEATS).
 *
 * Every parameter is an explicit constant below — no library defaults are
 * allowed to mask a regression. Recorded per case: candidate pairs
 * (相交候选数), exact-tested pairs, intersecting pairs, miss rate (漏检率),
 * extra rate, and the cost breakdown (index build / candidate generation /
 * exact tests / total vs reference total).
 */

const TIMING_REPEATS = 3;
const RESHAPE_ROUNDS = 6;

// Explicit workload parameters (no defaults).
const GROOVED = { thickness: 1.5, resolution: 72, cellSize: 0.6 } as const;
const THIN_NECK = { thickness: 1.2, resolution: 72, cellSize: 0.9 } as const;
const SHEET_STRESS = { size: 36, quads: 36, gap: 0.05, cellSize: 1.0, dent: { center: [3.1, -4.2] as [number, number], radius: 4.5, depth: 0.4 } } as const;
const CHANNEL = { cellSize: 1.5 } as const;

// Six deterministic local edits on the grooved-block shell top (y = 6 plane,
// groove at |x| < 1.2 avoided). Each pushes the outer surface past the inner
// one, creating real self-intersections in a different region.
const RESHAPE_DENTS: Array<{ center: [number, number, number]; radius: number; depth: number }> = [
  { center: [8, 6.2, -12], radius: 4.0, depth: 3.4 },
  { center: [-9, 6.2, 6], radius: 3.6, depth: 3.2 },
  { center: [14, 6.2, 14], radius: 3.2, depth: 3.0 },
  { center: [-14, 6.2, -6], radius: 4.2, depth: 3.5 },
  { center: [5, 6.2, 16], radius: 3.4, depth: 3.1 },
  { center: [-6, 6.2, 12], radius: 3.8, depth: 3.3 },
];

interface FullCaseRecord {
  case: string;
  triangles: number;
  cellSize: number;
  candidatePairs: number;
  testedPairs: number;
  intersections: number;
  missRate: number;
  extraRate: number;
  indexBuildMs: number;
  candidateGenerationMs: number;
  exactTestsMs: number;
  acceleratedTotalMs: number;
  referenceTotalMs: number;
  speedup: number;
}

interface ReshapeRoundRecord {
  round: number;
  affectedTriangles: number;
  incrementalCandidatePairs: number;
  incrementalTestedPairs: number;
  intersectionsAfterMerge: number;
  missRate: number;
  extraRate: number;
  incrementalMs: number;
  fullRebuildMs: number;
  referenceMs: number;
}

const fullRecords: FullCaseRecord[] = [];
const reshapeRecords: ReshapeRoundRecord[] = [];
const reshapeTotals = { incrementalMs: 0, fullRebuildMs: 0, referenceMs: 0 };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

function pipelineOutput(fixtureId: string, thickness: number, resolution: number): TriMesh {
  const fixture = getFixture(fixtureId);
  const result = runOffset(fixture.build(), {
    inputName: fixture.name,
    expectedOpen: fixture.expectedOpen,
    openSide: null,
    params: { ...DEFAULT_PARAMS, mode: 'inward', thickness, resolution },
  });
  if (!result.output) throw new Error(`benchmark workload ${fixtureId} produced no output`);
  return result.output.mesh;
}

function cloneMesh(mesh: TriMesh): TriMesh {
  return {
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
  };
}

/**
 * Correctness first, then timing. Returns false and throws via expect when
 * the accelerated path diverges from the reference; timings are only sampled
 * after the equality proof.
 */
function runFullCase(name: string, mesh: TriMesh, cellSize: number, opts: { bruteForce: boolean }): FullCaseRecord {
  // ---- Correctness phase: accelerated path executes to completion. --------
  const indexBuild = timed(() => new TriangleIntersectionIndex(mesh, { cellSize }));
  let candidatePairs = 0;
  const candidateGen = timed(() => indexBuild.value.forEachCandidatePair(() => candidatePairs++));
  const acceleratedPairs = new Set<string>();
  const accelerated = timed(() =>
    detectSelfIntersectionsWithIndex(mesh, new TriangleIntersectionIndex(mesh, { cellSize }), Number.POSITIVE_INFINITY, (lo, hi) =>
      acceleratedPairs.add(`${lo}_${hi}`),
    ),
  );
  const referencePairs = new Set<string>();
  const reference = timed(() =>
    detectSelfIntersectionsReference(mesh, Number.POSITIVE_INFINITY, (lo, hi) => referencePairs.add(`${lo}_${hi}`)),
  );
  const cmp = comparePairSets(acceleratedPairs, referencePairs);
  let brutePairs: Set<string> | null = null;
  let bruteMs = 0;
  if (opts.bruteForce) {
    const brute = collectRun(mesh, 'brute-force');
    brutePairs = brute.pairs;
    bruteMs = brute.ms;
    const cmpBrute = comparePairSets(acceleratedPairs, brutePairs);
    expect(cmpBrute.missed, `${name}: accelerated missed pairs vs brute force: ${cmpBrute.missed.slice(0, 5).join(' ')}`).toEqual([]);
    expect(cmpBrute.extra, `${name}: accelerated invented pairs vs brute force`).toEqual([]);
  }
  expect(cmp.missed, `${name}: accelerated missed pairs vs reference: ${cmp.missed.slice(0, 5).join(' ')}`).toEqual([]);
  expect(cmp.extra, `${name}: accelerated invented pairs vs reference`).toEqual([]);
  expect(cmp.missRate).toBe(0);
  expect(cmp.extraRate).toBe(0);

  // ---- Timing phase: only now are the two paths compared for speed. -------
  const acceleratedRuns: number[] = [];
  const referenceRuns: number[] = [];
  for (let r = 0; r < TIMING_REPEATS; r++) {
    acceleratedRuns.push(timed(() => detectSelfIntersectionsWithIndex(mesh, new TriangleIntersectionIndex(mesh, { cellSize }))).ms);
    referenceRuns.push(timed(() => detectSelfIntersectionsReference(mesh, Number.POSITIVE_INFINITY)).ms);
  }
  const acceleratedTotalMs = median(acceleratedRuns);
  const referenceTotalMs = median(referenceRuns);
  const record: FullCaseRecord = {
    case: name,
    triangles: mesh.triangleCount,
    cellSize,
    candidatePairs,
    testedPairs: accelerated.value.testedPairs,
    intersections: accelerated.value.pairCount,
    missRate: cmp.missRate,
    extraRate: cmp.extraRate,
    indexBuildMs: +indexBuild.ms.toFixed(1),
    candidateGenerationMs: +candidateGen.ms.toFixed(1),
    exactTestsMs: +(accelerated.ms - indexBuild.ms - candidateGen.ms).toFixed(1),
    acceleratedTotalMs: +acceleratedTotalMs.toFixed(1),
    referenceTotalMs: +referenceTotalMs.toFixed(1),
    speedup: +(referenceTotalMs / acceleratedTotalMs).toFixed(2),
  };
  if (brutePairs) {
    console.log(`BENCH ${name}: bruteForceMs=${bruteMs.toFixed(0)} brutePairs=${brutePairs.size}`);
  }
  fullRecords.push(record);
  return record;
}

describe('外壳查询基准：薄壳凹角全量查询', () => {
  it('grooved-block shell (concave groove, 61k tris)', { timeout: 900000 }, () => {
    const mesh = pipelineOutput('grooved-block', GROOVED.thickness, GROOVED.resolution);
    runFullCase('thin-shell-concave:grooved-block', mesh, GROOVED.cellSize, { bruteForce: false });
  });

  it('thin-neck shell (concave neck fillet, 84k tris)', { timeout: 900000 }, () => {
    const mesh = pipelineOutput('thin-neck', THIN_NECK.thickness, THIN_NECK.resolution);
    runFullCase('thin-shell-concave:thin-neck', mesh, THIN_NECK.cellSize, { bruteForce: false });
  });

  it('parallel thin sheets under load (gap << triangle size)', { timeout: 900000 }, () => {
    const mesh = buildParallelSheets({
      size: SHEET_STRESS.size,
      quads: SHEET_STRESS.quads,
      gap: SHEET_STRESS.gap,
      dent: SHEET_STRESS.dent,
    });
    const record = runFullCase('thin-sheets-load', mesh, SHEET_STRESS.cellSize, { bruteForce: true });
    expect(record.intersections).toBeGreaterThan(0);
  });

  it('concave channel with crossing fin (brute-force anchored)', { timeout: 900000 }, () => {
    const mesh = buildConcaveChannelWithFin();
    const record = runFullCase('concave-corner-fin', mesh, CHANNEL.cellSize, { bruteForce: true });
    expect(record.intersections).toBeGreaterThan(0);
  });
});

describe('外壳查询基准：局部改形增量维护', () => {
  it('six successive local dents: incremental vs full rebuild vs reference', { timeout: 900000 }, () => {
    const mesh = cloneMesh(pipelineOutput('grooved-block', GROOVED.thickness, GROOVED.resolution));
    const index = new TriangleIntersectionIndex(mesh, { cellSize: GROOVED.cellSize });
    // Round 0 baseline: full accelerated pass supplies the prior pair set.
    let priorPairs: Array<[number, number]> = [];
    detectSelfIntersectionsWithIndex(mesh, index, Number.POSITIVE_INFINITY, (lo, hi) => priorPairs.push([lo, hi]));

    for (let round = 0; round < RESHAPE_ROUNDS; round++) {
      const dent = RESHAPE_DENTS[round];
      const affected = dentMeshInPlace(mesh, dent.center, dent.radius, dent.depth, [0, -1, 0], {
        vertex: (v) => mesh.positions[v * 3 + 1] > 5,
      });
      if (affected.length === 0) throw new Error(`round ${round}: dent touched no triangles`);

      // Accelerated incremental path runs to completion first.
      const incremental = timed(() => detectSelfIntersectionsAfterEdit(index, mesh, affected, priorPairs));
      const merged = new Set(incremental.value.intersectingPairs.map(([lo, hi]) => `${lo}_${hi}`));

      // Full rebuild (grid) and kept reference as the complete references.
      const fullRebuild = collectRun(mesh, 'grid');
      const reference = collectRun(mesh, 'bvh-reference');
      const cmpFull = comparePairSets(merged, fullRebuild.pairs);
      const cmpRef = comparePairSets(merged, reference.pairs);
      expect(cmpFull.missed, `round ${round}: incremental missed vs full rebuild`).toEqual([]);
      expect(cmpFull.extra, `round ${round}: incremental invented vs full rebuild`).toEqual([]);
      expect(cmpRef.missed, `round ${round}: incremental missed vs reference`).toEqual([]);
      expect(cmpRef.extra, `round ${round}: incremental invented vs reference`).toEqual([]);

      reshapeRecords.push({
        round,
        affectedTriangles: affected.length,
        incrementalCandidatePairs: incremental.value.report.candidatePairs,
        incrementalTestedPairs: incremental.value.report.testedPairs,
        intersectionsAfterMerge: incremental.value.report.pairCount,
        missRate: cmpRef.missRate,
        extraRate: cmpRef.extraRate,
        incrementalMs: +incremental.ms.toFixed(1),
        fullRebuildMs: +fullRebuild.ms.toFixed(1),
        referenceMs: +reference.ms.toFixed(1),
      });
      reshapeTotals.incrementalMs += incremental.ms;
      reshapeTotals.fullRebuildMs += fullRebuild.ms;
      reshapeTotals.referenceMs += reference.ms;
      priorPairs = incremental.value.intersectingPairs;
    }
    expect(reshapeRecords).toHaveLength(RESHAPE_ROUNDS);
    expect(reshapeRecords.some((r) => r.intersectionsAfterMerge > 0)).toBe(true);
  });
});

describe('外壳查询基准：汇总', () => {
  it('prints the cost breakdown and miss rates', () => {
    const summary = {
      fullCases: fullRecords,
      reshapeRounds: reshapeRecords,
      reshapeTotals: {
        incrementalMs: +reshapeTotals.incrementalMs.toFixed(1),
        fullRebuildMs: +reshapeTotals.fullRebuildMs.toFixed(1),
        referenceMs: +reshapeTotals.referenceMs.toFixed(1),
        incrementalSpeedupVsFullRebuild: +(reshapeTotals.fullRebuildMs / reshapeTotals.incrementalMs).toFixed(2),
        incrementalSpeedupVsReference: +(reshapeTotals.referenceMs / reshapeTotals.incrementalMs).toFixed(2),
      },
    };
    console.log('SHELL-QUERY-BENCH ' + JSON.stringify(summary, null, 1));
    for (const r of fullRecords) {
      expect(r.missRate, `${r.case}: miss rate must be 0`).toBe(0);
      expect(r.extraRate, `${r.case}: extra rate must be 0`).toBe(0);
    }
    for (const r of reshapeRecords) {
      expect(r.missRate, `reshape round ${r.round}: miss rate must be 0`).toBe(0);
      expect(r.extraRate, `reshape round ${r.round}: extra rate must be 0`).toBe(0);
    }
  });
});
