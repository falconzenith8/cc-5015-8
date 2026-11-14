import { describe, expect, it } from 'vitest';
import { getFixture } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import type { OffsetParams } from '../src/core/types';

function run(id: string, patch: Partial<OffsetParams> = {}) {
  const fixture = getFixture(id);
  const params: OffsetParams = { ...DEFAULT_PARAMS, ...patch };
  return runOffset(fixture.build(), {
    inputName: fixture.name,
    expectedOpen: fixture.expectedOpen,
    openSide: fixture.expectedOpen ? 'positive' : null,
    params,
  });
}

describe('offset pipeline', () => {
  it('球壳向内 2.5 得到接近 2.5 的实测壁厚', { timeout: 120000 }, () => {
    const r = run('solid-sphere', { mode: 'inward', thickness: 2.5, resolution: 64 });
    console.log(JSON.stringify({
      ok: r.ok, errors: r.errors, warnings: r.warnings,
      tri: r.output?.stats.triangleCount, closed: r.output?.stats.closed,
      thick: r.thickness && {
        n: r.thickness.measuredCount, med: r.thickness.median, mean: r.thickness.mean,
        min: r.thickness.min, max: r.thickness.max, within: r.thickness.withinFraction,
        rim: r.thickness.rimCount, fail: r.thickness.failedCount,
      },
      self: r.selfIntersection, topo: r.fieldTopology, ms: r.totalMs,
      checks: r.checks.map(c => `${c.id}:${c.status}`),
    }, null, 1));
    expect(r.errors.length).toBe(0);
    expect(r.output?.stats.closed).toBe(true);
    expect(r.thickness!.measuredCount).toBeGreaterThan(100);
    expect(r.thickness!.median).toBeGreaterThan(2.3);
    expect(r.thickness!.median).toBeLessThan(2.7);
  });
});
