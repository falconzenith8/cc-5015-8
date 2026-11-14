import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures';
import { computeStats } from '../src/geometry/mesh';

describe('fixtures', () => {
  for (const f of FIXTURES) {
    it(`${f.name} 拓扑符合声明`, () => {
      const mesh = f.build();
      const stats = computeStats(mesh);
      expect(stats.triangleCount).toBeGreaterThan(20);
      expect(stats.closed).toBe(!f.expectedOpen);
      expect(stats.oriented).toBe(true);
      expect(stats.nonManifoldEdgeCount).toBe(0);
      expect(stats.degenerateTriangleCount).toBe(0);
      if (!f.expectedOpen) expect(stats.signedVolume).toBeGreaterThan(0);
    });
  }
});
