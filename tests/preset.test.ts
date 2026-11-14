import { test, expect } from 'vitest';
import { DEFAULT_PARAMS, validateParams } from '../src/core/params';
import type { PresetDocument } from '../src/core/types';
import { FIXTURES } from '../src/fixtures';

function roundTrip(doc: PresetDocument): PresetDocument {
  return JSON.parse(JSON.stringify(doc)) as PresetDocument;
}

test('parameter document round-trips with schema intact', () => {
  const doc: PresetDocument = {
    schema: 'display-shell-params.v1',
    name: '球壳 (Solid sphere)',
    fixtureId: 'solid-sphere',
    params: { ...DEFAULT_PARAMS, mode: 'symmetric', thickness: 3.25, resolution: 96, samplesPerTriangle: 4 },
    savedAt: new Date().toISOString(),
  };
  const restored = roundTrip(doc);
  expect(restored.schema).toBe('display-shell-params.v1');
  expect(restored.params).toEqual(doc.params);
  expect(FIXTURES.some((f) => f.id === restored.fixtureId)).toBe(true);
  expect(validateParams(restored.params, { expectedOpen: false, openSide: null })).toHaveLength(0);
});

test('loaded params are still validated against the kernel rules', () => {
  const bad = { ...DEFAULT_PARAMS, thickness: -1, resolution: 10 };
  const issues = validateParams(bad, { expectedOpen: false, openSide: null });
  expect(issues.some((i) => i.field === 'thickness' && i.severity === 'error')).toBe(true);
  expect(issues.some((i) => i.field === 'resolution' && i.severity === 'error')).toBe(true);
});

test('open fixture requires an explicit air side before running', () => {
  const issues = validateParams(DEFAULT_PARAMS, { expectedOpen: true, openSide: null });
  expect(issues.some((i) => i.field === 'openSide' && i.severity === 'error')).toBe(true);
  expect(validateParams(DEFAULT_PARAMS, { expectedOpen: true, openSide: 'negative' })).toHaveLength(0);
});
