import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

/**
 * Drives the real display-shell UI (src/ui/main.ts) in jsdom: adjust the
 * offset thickness through the model-operation panel, run the kernel, and
 * read the actually computed shell surface and thickness distribution from
 * the results panel — before and after the parameter change. Anomalies must
 * surface in the interface (warnings, check badges), not just in the kernel.
 */

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);

async function waitForStatus(not: string[], timeoutMs = 240000): Promise<string> {
  const pill = document.getElementById('status-pill')!;
  const start = Date.now();
  for (;;) {
    const text = pill.textContent ?? '';
    if (!not.includes(text)) return text;
    if (Date.now() - start > timeoutMs) throw new Error(`status stuck at ${text}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

function kvValue(label: string): string | null {
  const results = document.getElementById('results')!;
  const keys = [...results.querySelectorAll<HTMLElement>('.kv .k')];
  for (const k of keys) {
    if (k.textContent === label) {
      const v = k.nextElementSibling as HTMLElement | null;
      return v?.textContent ?? null;
    }
  }
  return null;
}

function setThickness(value: string) {
  const input = document.querySelector<HTMLInputElement>('[data-param="thickness"]')!;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function clickFixture(id: string) {
  document.querySelector<HTMLElement>(`[data-fixture="${id}"]`)!.click();
}

function clickRun() {
  document.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
}

function medianFromPanel(): number {
  const raw = kvValue('均值 / 中位');
  expect(raw).toBeTruthy();
  return Number(raw!.split('/')[1].trim());
}

describe('模型操作视窗：调整偏置量并实测壳体表面与厚度分布', () => {
  it('thickness edits through the panel drive real runs; distributions shift accordingly', { timeout: 300000 }, async () => {
    await import('../src/ui/main');
    // Initial fixture is the solid sphere; the panel must offer the kernel controls.
    expect(document.querySelector('[data-param="thickness"]')).toBeTruthy();
    expect(document.querySelector('[data-action="run"]')).toBeTruthy();

    // --- Before: t = 2.0 ---------------------------------------------------
    setThickness('2.0');
    expect(document.getElementById('status-pill')!.textContent).toContain('参数已修改');
    clickRun();
    await waitForStatus(['运行中']);
    const beforeMedian = medianFromPanel();
    const beforeSurface = kvValue('外表面 / 内表面 / 边缘面积');
    expect(Math.abs(beforeMedian - 2.0)).toBeLessThan(0.1);
    expect(beforeSurface).toBeTruthy();
    // The thickness block is a real histogram computed from probes.
    expect(document.querySelector('#results .histogram')).toBeTruthy();
    const beforeHistText = document.querySelector('#results')!.textContent!;

    // --- After: t = 3.5 ------------------------------------------------------
    setThickness('3.5');
    clickRun();
    await waitForStatus(['运行中']);
    const afterMedian = medianFromPanel();
    const afterSurface = kvValue('外表面 / 内表面 / 边缘面积');
    const afterHistText = document.querySelector('#results')!.textContent!;
    // The measured distribution tracks the requested offset — actual
    // computation, not a replayed default.
    expect(Math.abs(afterMedian - 3.5)).toBeLessThan(0.15);
    expect(afterMedian).toBeGreaterThan(beforeMedian + 1.0);
    expect(afterSurface).not.toBe(beforeSurface);
    expect(afterHistText).not.toBe(beforeHistText);
    // Checks and mesh info reflect the new run.
    expect(kvValue('输出三角形 / 顶点')).toBeTruthy();
  });

  it('surfaces the swallowed-feature anomaly in the interface for an aggressive offset', { timeout: 300000 }, async () => {
    await import('../src/ui/main');
    clickFixture('thin-neck');
    setThickness('3.0');
    clickRun();
    const status = await waitForStatus(['运行中']);
    const text = document.querySelector('#results')!.textContent!;
    expect(text).toContain('可能被吞并的细部');
    expect(text).toContain('合并阈值');
    // The anomaly is also an aggregate warning, and the run is flagged for review.
    expect(['需复核', '通过']).toContain(status);
    expect(document.querySelector('#results .warn-list, #results .change.warn')).toBeTruthy();
  });
});
