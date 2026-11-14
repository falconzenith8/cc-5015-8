import { describe, expect, it } from 'vitest';
import { getFixture } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import type { OffsetParams } from '../src/core/types';

function run(id: string, patch: Partial<OffsetParams> = {}, openSide: 'positive' | 'negative' | null = 'positive') {
  const fixture = getFixture(id);
  return runOffset(fixture.build(), {
    inputName: fixture.name,
    expectedOpen: fixture.expectedOpen,
    openSide: fixture.expectedOpen ? openSide : null,
    params: { ...DEFAULT_PARAMS, ...patch },
  });
}

function brief(r: ReturnType<typeof run>) {
  return {
    ok: r.ok,
    errors: r.errors,
    warnings: r.warnings,
    tris: r.output?.stats.triangleCount,
    closed: r.output?.stats.closed,
    loops: r.output?.stats.boundaryLoopCount,
    nonManifold: r.output?.stats.nonManifoldEdgeCount,
    classAreas: r.output?.classAreas,
    self: r.selfIntersection?.pairCount,
    thick: r.thickness && {
      n: r.thickness.measuredCount, med: +r.thickness.median.toFixed(4),
      mean: +r.thickness.mean.toFixed(4), min: +r.thickness.min.toFixed(4), max: +r.thickness.max.toFixed(4),
      within: +r.thickness.withinFraction.toFixed(4), rim: r.thickness.rimCount, fail: r.thickness.failedCount,
      under: r.thickness.underCount, over: r.thickness.overCount,
    },
    feature: r.featureWarning && { frac: +r.featureWarning.affectedFraction.toFixed(3), min: +r.featureWarning.minFeatureSize.toFixed(3) },
    topo: r.fieldTopology && {
      inAir: r.fieldTopology.inputAirComponents, inEnc: r.fieldTopology.inputEnclosedAirComponents,
      outVoids: r.fieldTopology.outputInnerVoidComponents, newly: r.fieldTopology.newlyEnclosedAirVolumes.length,
    },
    checks: r.checks.map(c => `${c.id}:${c.status}`),
    ms: Math.round(r.totalMs),
  };
}

describe('acceptance fixtures', () => {
  it('球壳：已知厚度 2.5，闭合，无自交', { timeout: 180000 }, () => {
    const r = run('solid-sphere', { mode: 'inward', thickness: 2.5, resolution: 64 });
    console.log('SPHERE', JSON.stringify(brief(r)));
    expect(r.output!.stats.closed).toBe(true);
    expect(Math.abs(r.thickness!.median - 2.5)).toBeLessThan(0.05);
    expect(r.thickness!.withinFraction).toBeGreaterThan(0.98);
    expect(r.selfIntersection!.pairCount).toBe(0);
    expect(r.checks.find(c => c.id === 'sides')!.status).toBe('pass');
  });

  it('凹槽块：闭合，壁厚偏差在 5% 内', { timeout: 180000 }, () => {
    const r = run('grooved-block', { mode: 'inward', thickness: 1.5, resolution: 72 });
    console.log('GROOVE', JSON.stringify(brief(r)));
    expect(r.output!.stats.closed).toBe(true);
    expect(r.thickness!.measuredCount).toBeGreaterThan(100);
    expect(Math.abs(r.thickness!.median - 1.5)).toBeLessThan(0.08);
  });

  it('薄颈：正常厚度通过，偏置接近颈半径时报告吞并风险', { timeout: 240000 }, () => {
    const safe = run('thin-neck', { mode: 'inward', thickness: 1.2, resolution: 72 });
    console.log('NECK-SAFE', JSON.stringify(brief(safe)));
    expect(safe.thickness!.measuredCount).toBeGreaterThan(50);
    const aggressive = run('thin-neck', { mode: 'inward', thickness: 3.0, resolution: 72 });
    console.log('NECK-AGGRESSIVE', JSON.stringify(brief(aggressive)));
    expect(aggressive.featureWarning).not.toBeNull();
    // Feature size is the measured free gap; it is swallowed when that gap is
    // smaller than the summed offset reach from both sides (2 x thickness).
    expect(aggressive.featureWarning!.minFeatureSize).toBeLessThan(aggressive.featureWarning!.threshold);
  });

  it('开口片：保留开口，不假定内部，显式侧选择生效', { timeout: 180000 }, () => {
    const r = run('open-sheet', { mode: 'symmetric', thickness: 1.0, resolution: 72 }, 'positive');
    console.log('OPEN', JSON.stringify(brief(r)));
    expect(r.output!.stats.closed).toBe(false);
    expect(r.output!.stats.boundaryLoopCount).toBeGreaterThan(0);
    expect(r.checks.find(c => c.id === 'sides')!.status).toBe('na');
    expect(r.thickness!.measuredCount).toBeGreaterThan(50);
  });
});
