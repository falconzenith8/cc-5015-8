import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderControls, renderResults, type UiCallbacks, type UiState } from '../src/ui/panels';
import { runOffset } from '../src/core/pipeline';
import { DEFAULT_PARAMS } from '../src/core/params';
import { getFixture, FIXTURES } from '../src/fixtures';
import { PARAM_CONTROLS, OPEN_SIDE_CONTROL } from '../src/core/params';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as unknown as { document: Document }).document = dom.window.document;

function callbacks(): UiCallbacks & { fired: string[] } {
  const fired: string[] = [];
  return {
    fired,
    onParamsChange: () => fired.push('params'),
    onRun: () => fired.push('run'),
    onFixtureChange: (id) => fired.push(`fixture:${id}`),
    onSaveParams: () => fired.push('save'),
    onLoadParams: () => fired.push('load'),
    onExport: (f) => fired.push(`export:${f}`),
    onVisibility: () => fired.push('visibility'),
    };
}

function baseState(over: Partial<UiState> = {}): UiState {
  return {
    params: { ...DEFAULT_PARAMS },
    openSide: 'positive',
    showOriginal: true,
    showOutput: true,
    showSamples: true,
    ...over,
  };
}

const fixtureList = FIXTURES.map((f) => ({
  id: f.id, name: f.name, description: f.description,
  expectedOpen: f.expectedOpen, knownThickness: f.knownThickness,
}));

describe('control panel is driven by the kernel schema', () => {
  it('renders one control per PARAM_CONTROLS entry', () => {
    const root = document.createElement('div');
    renderControls(root, baseState(), fixtureList, 'solid-sphere', false, callbacks());
    for (const spec of PARAM_CONTROLS) {
      expect(root.querySelectorAll(`[data-param="${spec.id}"]`).length).toBeGreaterThan(0);
    }
  });

  it('shows the open-side selector only for open fixtures', () => {
    const root = document.createElement('div');
    renderControls(root, baseState(), fixtureList, 'solid-sphere', false, callbacks());
    expect(root.querySelectorAll('[data-openside]').length).toBe(0);
    renderControls(root, baseState(), fixtureList, 'open-sheet', false, callbacks());
    expect(root.querySelectorAll('[data-openside]').length).toBe(OPEN_SIDE_CONTROL.options.length);
  });

  it('does not fire generation after a fixture click alone', () => {
    const root = document.createElement('div');
    const cb = callbacks();
    renderControls(root, baseState(), fixtureList, 'solid-sphere', false, cb);
    const button = root.querySelector<HTMLElement>('[data-fixture="thin-neck"]')!;
    button.click();
    expect(cb.fired).toContain('fixture:thin-neck');
    expect(cb.fired).not.toContain('run');
  });

  it('changes mode through the segmented control', () => {
    const root = document.createElement('div');
    const state = baseState();
    const cb = callbacks();
    renderControls(root, state, fixtureList, 'solid-sphere', false, cb);
    root.querySelector<HTMLElement>('[data-param="mode"][data-value="symmetric"]')!.click();
    expect(state.params.mode).toBe('symmetric');
    expect(cb.fired).toContain('params');
  });

  it('disables the run button while running', () => {
    const root = document.createElement('div');
    renderControls(root, baseState(), fixtureList, 'solid-sphere', true, callbacks());
    const run = root.querySelector<HTMLButtonElement>('[data-action="run"]')!;
    expect(run.disabled).toBe(true);
  });
});

describe('result panel surfaces kernel feedback', () => {
  it('renders checks, thickness and changes for a real run', { timeout: 180000 }, () => {
    const fixture = getFixture('solid-sphere');
    const result = runOffset(fixture.build(), {
      inputName: fixture.name, expectedOpen: false, openSide: null,
      params: { ...DEFAULT_PARAMS, mode: 'inward', thickness: 2.5, resolution: 64 },
    });
    const root = document.createElement('div');
    renderResults(root, result, false, '');
    expect(root.textContent).toContain('实测壁厚');
    expect(root.textContent).toContain('核验项');
    expect(root.querySelector('.histogram')).not.toBeNull();
    expect(root.querySelectorAll('.check').length).toBe(result.checks.length);
    expect(root.querySelector('.status-badge.pass')).not.toBeNull();
    expect(root.textContent).toContain('仅用于展示外壳几何');
  });

  it('shows the empty prompt before any run', () => {
    const root = document.createElement('div');
    renderResults(root, null, false, '');
    expect(root.textContent).toContain('尚未生成');
  });

  it('renders failure region details for a swallowed feature', { timeout: 240000 }, () => {
    const fixture = getFixture('thin-neck');
    const result = runOffset(fixture.build(), {
      inputName: fixture.name, expectedOpen: false, openSide: null,
      params: { ...DEFAULT_PARAMS, mode: 'inward', thickness: 3.0, resolution: 72 },
    });
    expect(result.featureWarning).not.toBeNull();
    const root = document.createElement('div');
    renderResults(root, result, false, '');
    expect(root.textContent).toContain('可能被吞并的细部');
    expect(root.textContent).toContain('合并阈值');
  });
});

describe('parameter edits stay local and reach the kernel state', () => {
  it('commits a number field only on change, not on every keystroke', () => {
    const root = document.createElement('div');
    const state = baseState();
    const cb = callbacks();
    renderControls(root, state, fixtureList, 'solid-sphere', false, cb);
    const input = root.querySelector<HTMLInputElement>('[data-param="thickness"]')!;
    input.value = '3.75';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(state.params.thickness).toBe(DEFAULT_PARAMS.thickness);
    expect(cb.fired).not.toContain('params');
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(state.params.thickness).toBe(3.75);
    expect(cb.fired).toContain('params');
  });

  it('ignores a non-numeric thickness instead of writing NaN into the kernel params', () => {
    const root = document.createElement('div');
    const state = baseState();
    renderControls(root, state, fixtureList, 'solid-sphere', false, callbacks());
    const input = root.querySelector<HTMLInputElement>('[data-param="thickness"]')!;
    input.value = '';
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(Number.isFinite(state.params.thickness)).toBe(true);
  });

  it('updates the active segment in place without re-rendering the panel', () => {
    const root = document.createElement('div');
    const state = baseState();
    renderControls(root, state, fixtureList, 'solid-sphere', false, callbacks());
    const target = root.querySelector<HTMLElement>('[data-param="mode"][data-value="outward"]')!;
    const other = root.querySelector<HTMLElement>('[data-param="mode"][data-value="inward"]')!;
    target.click();
    expect(state.params.mode).toBe('outward');
    expect(target.classList.contains('active')).toBe(true);
    expect(other.classList.contains('active')).toBe(false);
    // Same DOM node: the render pass did not replace the panel.
    expect(root.querySelector('[data-param="mode"][data-value="outward"]')).toBe(target);
  });
});
