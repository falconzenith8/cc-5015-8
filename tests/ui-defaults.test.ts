import { test } from 'vitest';
import { FIXTURES } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';

test('every fixture at UI default params', { timeout: 600000 }, () => {
  for (const f of FIXTURES) {
    const r = runOffset(f.build(), {
      inputName: f.name,
      expectedOpen: f.expectedOpen,
      openSide: f.expectedOpen ? 'positive' : null,
      params: { ...DEFAULT_PARAMS },
    });
    console.log(f.id, JSON.stringify({
      ok: r.ok,
      tris: r.output?.stats.triangleCount,
      closed: r.output?.stats.closed,
      loops: r.output?.stats.boundaryLoopCount,
      self: r.selfIntersection?.pairCount,
      med: r.thickness?.median,
      within: r.thickness?.withinFraction,
      rim: r.thickness?.rimCount,
      fail: r.thickness?.failedCount,
      checks: r.checks.filter(c => c.status !== 'pass').map(c => `${c.id}:${c.status}`),
      ms: Math.round(r.totalMs),
    }));
  }
});
