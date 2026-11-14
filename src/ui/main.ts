import './styles.css';
import { FIXTURES, getFixture } from '../fixtures';
import { DEFAULT_PARAMS, validateParams } from '../core/params';
import { runOffset } from '../core/pipeline';
import type { OffsetMode, OffsetParams, PresetDocument, ShellResult, TriMesh } from '../core/types';
import { NullViewport, Viewport } from './viewport';
import { renderControls, renderResults, type UiCallbacks, type UiState } from './panels';
import { downloadBlob, exportMesh, type ExportFormat } from '../export/meshExport';

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div>
        <h1>展示外壳曲面偏置工作台</h1>
        <div class="sub">距离场偏置 + 独立测厚核验 · 原始资产只读</div>
      </div>
      <div class="spacer"></div>
      <span class="pill" id="status-pill">空闲</span>
    </header>
    <div class="layout">
      <aside class="panel left" id="controls"></aside>
      <main class="viewport" id="viewport">
        <div class="viewport-overlay" id="overlay"></div>
        <div class="viewport-hint">拖拽旋转 · 滚轮缩放 · 右键平移</div>
        <div class="legend">
          <div class="item"><span class="swatch" style="background:#63b3ed"></span>外表面</div>
          <div class="item"><span class="swatch" style="background:#f6ad55"></span>内表面</div>
          <div class="item"><span class="swatch" style="background:#68d391"></span>边缘</div>
          <div class="item"><span class="swatch" style="background:#e53e3e"></span>失败 / 吞并点</div>
          <div class="item"><span class="swatch" style="background:#805ad5"></span>尖角/边界排除探针</div>
        </div>
      </main>
      <aside class="panel right" id="results"></aside>
    </div>
  </div>
`;

const controlsRoot = document.getElementById('controls')!;
const resultsRoot = document.getElementById('results')!;
const viewportRoot = document.getElementById('viewport')!;
const statusPill = document.getElementById('status-pill')!;
const overlay = document.getElementById('overlay')!;

const state: UiState = {
  params: { ...DEFAULT_PARAMS },
  openSide: 'positive',
  showOriginal: true,
  showOutput: true,
  showSamples: true,
};

let activeFixture = 'solid-sphere';
let result: ShellResult | null = null;
let running = false;
let phase = '';
let runToken = 0;
let stale = false;
const sourceCache = new Map<string, TriMesh>();

// The kernel, exports and parameter storage do not depend on WebGL, so a
// missing GL context downgrades to a 2D-less session instead of failing the app.
let viewport: {
  setOriginal(mesh: TriMesh | null): void;
  setOutput(res: ShellResult | null): void;
  setShowOriginal(visible: boolean): void;
  setShowOutput(visible: boolean): void;
  setShowSamples(visible: boolean): void;
  fitAll(): void;
  dispose(): void;
};
try {
  viewport = new Viewport(viewportRoot);
} catch {
  viewport = new NullViewport();
  viewportRoot.querySelector('.viewport-hint')?.remove();
}
window.addEventListener('ui-fit', () => viewport.fitAll());

const callbacks: UiCallbacks = {
  onParamsChange: () => {
    stale = result !== null;
    drawResults();
    drawOverlay();
    statusPill.textContent = stale ? '参数已修改，结果过期' : '参数已修改';
  },
  onRun: () => void generate(),
  onFixtureChange: (id: string) => {
    activeFixture = id;
    runToken++; // Any in-flight run belongs to the previous fixture.
    running = false;
    stale = false;
    const fixture = getFixture(id);
    const mesh = fixture.build();
    sourceCache.set(id, mesh);
    result = null;
    viewport.setOriginal(mesh);
    viewport.setOutput(null);
    drawControls();
    drawResults();
    drawOverlay();
    statusPill.textContent = fixture.expectedOpen ? '开放曲面：请选择空气侧' : '已载入夹具';
    viewport.fitAll();
  },
  onSaveParams: () => {
    const doc: PresetDocument = {
      schema: 'display-shell-params.v1',
      name: getFixture(activeFixture).name,
      fixtureId: activeFixture,
      params: { ...state.params },
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${activeFixture}-params.json`);
  },
  onLoadParams: (file: File) => void loadParams(file),
  onExport: (format: ExportFormat) => void exportCurrent(format),
  onVisibility: () => {
    viewport.setShowOriginal(state.showOriginal);
    viewport.setShowOutput(state.showOutput);
    viewport.setShowSamples(state.showSamples);
  },
};

function drawControls() {
  renderControls(controlsRoot, state, FIXTURES.map(f => ({
    id: f.id, name: f.name, description: f.description, expectedOpen: f.expectedOpen, knownThickness: f.knownThickness,
  })), activeFixture, running, callbacks);
}

function drawResults() {
  renderResults(resultsRoot, result, running, phase, stale);
}

function drawOverlay() {
  const fixture = getFixture(activeFixture);
  const chips: string[] = [];
  chips.push(`<span class="overlay-chip">${fixture.expectedOpen ? '开放曲面' : '闭合实体'}</span>`);
chips.push(`<span class="overlay-chip">t = ${state.params.thickness}</span>`);
  if (stale) chips.push(`<span class="overlay-chip" style="color:#ecc94b">结果过期</span>`);
  const p = result;
  if (p?.output) {
    chips.push(`<span class="overlay-chip">${p.output.stats.triangleCount} 三角形</span>`);
    if (p.thickness) chips.push(`<span class="overlay-chip">中位 ${p.thickness.median.toFixed(3)}</span>`);
    if (p.selfIntersection) chips.push(`<span class="overlay-chip">自交 ${p.selfIntersection.pairCount}</span>`);
  }
  overlay.innerHTML = chips.join('');
}

async function generate() {
  const fixture = getFixture(activeFixture);
  const params = state.params as OffsetParams;
  const validation = validateParams(params, { expectedOpen: fixture.expectedOpen, openSide: fixture.expectedOpen ? state.openSide : null });
  const errors = validation.filter((v) => v.severity === 'error');
  if (errors.length) {
    result = null;
    resultsRoot.innerHTML = `<div class="section"><h2>参数未通过内核校验</h2><ul class="error-list">${errors
      .map((e) => `<li>${escapeHtml(e.message)}</li>`)
      .join('')}</ul></div>`;
    drawOverlay();
    statusPill.textContent = '参数错误';
    return;
  }
  const token = ++runToken;
  running = true;
  phase = '准备输入';
  drawControls();
  drawResults();
  statusPill.textContent = '运行中';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const source = sourceCache.get(activeFixture) ?? fixture.build();
    sourceCache.set(activeFixture, source);
    const res = runOffset(source, {
      inputName: fixture.name,
      expectedOpen: fixture.expectedOpen,
      openSide: fixture.expectedOpen ? state.openSide : null,
      params,
      onPhase: (p, detail) => {
        if (token !== runToken) return;
        phase = detail ? `${p} · ${detail}` : p;
        const prog = resultsRoot.querySelector('.progress');
        if (prog) prog.lastChild!.textContent = phase;
      },
    });
    if (token !== runToken) return;
    result = res;
    stale = false;
    viewport.setOutput(res);
    drawResults();
    drawOverlay();
    statusPill.textContent = res.ok ? '通过' : '需复核';
  } catch (err) {
    if (token !== runToken) return;
    statusPill.textContent = '运行失败';
    resultsRoot.innerHTML = `<div class="empty">生成过程抛出错误：${String(err)}</div>`;
  } finally {
    running = false;
    phase = '';
    if (token === runToken) {
      drawControls();
      drawResults();
    }
  }
}

async function exportCurrent(format: ExportFormat) {
  if (!result?.output || result.output.mesh.triangleCount === 0) {
    statusPill.textContent = '无可导出的网格';
    return;
  }
  const fixture = getFixture(activeFixture);
  const name = `${activeFixture}-${result.appliedMode}-t${result.params.thickness}`;
  try {
    const { blob, filename } = await exportMesh(result.output.mesh, format, name);
    downloadBlob(blob, filename);
    statusPill.textContent = `已导出 ${filename}`;
  } catch (err) {
    statusPill.textContent = `导出失败：${String(err)}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadParams(file: File) {
  try {
    const text = await file.text();
    const doc = JSON.parse(text) as PresetDocument;
    if (doc.schema !== 'display-shell-params.v1') throw new Error('参数文件 schema 不匹配');
    if (!doc.params) throw new Error('缺少 params');
    const fixtureExists = FIXTURES.some((f) => f.id === doc.fixtureId);
    if (fixtureExists && doc.fixtureId !== activeFixture) {
      callbacks.onFixtureChange(doc.fixtureId);
    }
    const merged: OffsetParams = { ...DEFAULT_PARAMS, ...doc.params };
    state.params = {
      mode: merged.mode as OffsetMode,
      thickness: merged.thickness,
      resolution: merged.resolution,
      samplesPerTriangle: merged.samplesPerTriangle,
      seed: merged.seed,
    };
    stale = result !== null;
    drawControls();
    drawResults();
    drawOverlay();
    statusPill.textContent = '参数已载入，请重新生成';
  } catch (err) {
    statusPill.textContent = `载入失败：${String(err)}`;
  }
}

// Initial fixture.
callbacks.onFixtureChange(activeFixture);
handleHashPreset();

function handleHashPreset() {
  const raw = window.location.hash.replace(/^#preset=/, '');
  if (!raw) return;
  try {
    const doc = JSON.parse(decodeURIComponent(raw)) as PresetDocument;
    if (doc.schema === 'display-shell-params.v1' && FIXTURES.some((f) => f.id === doc.fixtureId)) {
      callbacks.onFixtureChange(doc.fixtureId);
      const merged = { ...DEFAULT_PARAMS, ...doc.params };
      state.params = {
        mode: merged.mode, thickness: merged.thickness, resolution: merged.resolution,
        samplesPerTriangle: merged.samplesPerTriangle, seed: merged.seed,
      };
      drawControls();
    }
  } catch {
    // Ignore malformed hash; the UI stays on defaults.
  }
}
