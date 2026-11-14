import { test, expect } from 'vitest';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import type { PresetDocument } from '../src/core/types';
import { getFixture } from '../src/fixtures';

/**
 * Mirrors the UI's save/load plumbing without the DOM: the document the UI
 * writes must be exactly what the UI reads back and what the kernel accepts.
 */
function saveDocument(fixtureId: string, params: typeof DEFAULT_PARAMS): string {
  const doc: PresetDocument = {
    schema: 'display-shell-params.v1',
    name: getFixture(fixtureId).name,
    fixtureId,
    params: { ...params },
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(doc);
}

function loadDocument(json: string): PresetDocument {
  const doc = JSON.parse(json) as PresetDocument;
  if (doc.schema !== 'display-shell-params.v1') throw new Error('schema');
  return doc;
}

test('a saved UI document drives an identical kernel run', { timeout: 180000 }, () => {
  const fixtureId = 'grooved-block';
  const params = { ...DEFAULT_PARAMS, mode: 'outward' as const, thickness: 1.75, resolution: 72 };
  const restored = loadDocument(saveDocument(fixtureId, params));
  const fixture = getFixture(restored.fixtureId);
  const result = runOffset(fixture.build(), {
    inputName: fixture.name,
    expectedOpen: fixture.expectedOpen,
    openSide: null,
    params: restored.params,
  });
  expect(result.params.mode).toBe('outward');
  expect(result.params.thickness).toBe(1.75);
  expect(result.output!.stats.closed).toBe(true);
  expect(result.thickness!.median).toBeGreaterThan(1.6);
  expect(result.thickness!.median).toBeLessThan(1.9);
});

test('the saved document contains parameters only, no geometry', () => {
  const json = saveDocument('open-sheet', DEFAULT_PARAMS);
  expect(json).not.toContain('positions');
  expect(json).not.toContain('indices');
  const doc = JSON.parse(json);
  expect(Object.keys(doc).sort()).toEqual(['fixtureId', 'name', 'params', 'savedAt', 'schema']);
});
