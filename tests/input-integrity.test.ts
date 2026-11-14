import { test, expect } from 'vitest';
import { getFixture } from '../src/fixtures';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import { hashGeometry } from '../src/geometry/mesh';

test('generation never mutates the input asset', { timeout: 180000 }, () => {
  for (const id of ['solid-sphere', 'grooved-block', 'thin-neck', 'open-sheet']) {
    const fixture = getFixture(id);
    const input = fixture.build();
    const beforeHash = hashGeometry(input.positions, input.indices);
    const beforePositions = input.positions.slice();
    const beforeIndices = input.indices.slice();
    const result = runOffset(input, {
      inputName: id,
      expectedOpen: fixture.expectedOpen,
      openSide: fixture.expectedOpen ? 'positive' : null,
      params: { ...DEFAULT_PARAMS, thickness: 2, resolution: 64 },
    });
    expect(result.checks.find((c) => c.id === 'input-integrity')!.status).toBe('pass');
    expect(hashGeometry(input.positions, input.indices)).toBe(beforeHash);
    expect(Array.from(input.positions)).toEqual(Array.from(beforePositions));
    expect(Array.from(input.indices)).toEqual(Array.from(beforeIndices));
    // The output must be a distinct buffer, not a view into the input.
    if (result.output) {
      expect(result.output.mesh.positions).not.toBe(input.positions);
      expect(result.output.mesh.indices).not.toBe(input.indices);
    }
  }
});

test('two runs with identical params are deterministic', { timeout: 180000 }, () => {
  const fixture = getFixture('solid-sphere');
  const input = fixture.build();
  const opts = {
    inputName: 'sphere', expectedOpen: false as const, openSide: null,
    params: { ...DEFAULT_PARAMS, thickness: 2, resolution: 64 },
  };
  const a = runOffset(input, opts);
  const b = runOffset(input, opts);
  expect(hashGeometry(a.output!.mesh.positions, a.output!.mesh.indices))
    .toBe(hashGeometry(b.output!.mesh.positions, b.output!.mesh.indices));
  expect(a.thickness!.median).toBe(b.thickness!.median);
  expect(a.samples.length).toBe(b.samples.length);
});
