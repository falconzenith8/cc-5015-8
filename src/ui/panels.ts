import type { CheckItem, OffsetMode, ShellResult } from '../core/types';
import { PARAM_CONTROLS, OPEN_SIDE_CONTROL, describeMode } from '../core/params';

export interface UiState {
  params: { mode: OffsetMode; thickness: number; resolution: number; samplesPerTriangle: number; seed: number };
  openSide: 'positive' | 'negative';
  showOriginal: boolean;
  showOutput: boolean;
  showSamples: boolean;
}

export interface UiCallbacks {
  onParamsChange: () => void;
  onRun: () => void;
  onFixtureChange: (id: string) => void;
  onSaveParams: () => void;
  onLoadParams: (file: File) => void;
  onExport: (format: 'stl' | 'obj' | 'glb') => void;
  onVisibility: () => void;
}

const STATUS_TEXT: Record<CheckItem['status'], string> = {
  pass: '通过',
  warn: '注意',
  fail: '未通过',
  na: '不适用',
};

const CHECK_LABELS: Record<CheckItem['status'], string> = STATUS_TEXT;

export function renderControls(
  root: HTMLElement,
  state: UiState,
  fixtures: Array<{ id: string; name: string; description: string; expectedOpen: boolean; knownThickness: number | null }>,
  activeFixture: string,
  running: boolean,
  cb: UiCallbacks,
): void {
  const fixtureHtml = fixtures
    .map(
      (f) =>
        `<button class="fixture ${f.id === activeFixture ? 'active' : ''}" data-fixture="${f.id}">
          <div class="name">${escapeHtml(f.name)}${f.knownThickness !== null ? ` <span class="status-badge pass">已知 t=${f.knownThickness}</span>` : ''}</div>
          <div class="desc">${escapeHtml(f.description)}</div>
        </button>`,
    )
    .join('');

  const controlsHtml = PARAM_CONTROLS.map((spec) => {
    const value = state.params[spec.id as keyof UiState['params']];
    let input = '';
    if (spec.kind === 'segmented') {
      input = `<div class="segmented">${(spec.options ?? [])
        .map(
          (o) =>
            `<button data-param="${spec.id}" data-value="${o.value}" class="${String(value) === String(o.value) ? 'active' : ''}">${escapeHtml(o.label)}</button>`,
        )
        .join('')}</div>`;
    } else if (spec.kind === 'slider') {
      input = `<div class="row"><input type="range" data-param="${spec.id}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}" /><span class="mono" data-readout="${spec.id}">${value}</span></div>`;
    } else if (spec.kind === 'select') {
      input = `<select data-param="${spec.id}">${(spec.options ?? [])
        .map((o) => `<option value="${o.value}" ${String(value) === String(o.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('')}</select>`;
    } else {
      input = `<input type="number" data-param="${spec.id}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}" />`;
    }
    return `<div class="field">
      <label>${escapeHtml(spec.label)}${spec.unit ? ` <span class="subtle">(${escapeHtml(spec.unit)})</span>` : ''}</label>
      ${input}
      <div class="hint">${escapeHtml(spec.hint)}</div>
    </div>`;
  }).join('');

  const fixture = fixtures.find((f) => f.id === activeFixture);
  const openSideHtml = fixture?.expectedOpen
    ? `<div class="field">
        <label>${escapeHtml(OPEN_SIDE_CONTROL.label)} <span class="status-badge warn">必选</span></label>
        <div class="segmented">${OPEN_SIDE_CONTROL.options
          .map(
            (o) =>
              `<button data-openside="${o.value}" class="${state.openSide === o.value ? 'active' : ''}">${escapeHtml(o.label)}</button>`,
          )
          .join('')}</div>
        <div class="hint">${escapeHtml(OPEN_SIDE_CONTROL.hint)}</div>
      </div>`
    : '';

  root.innerHTML = `
    <div class="section">
      <h2>输入夹具</h2>
      <div class="fixture-list">${fixtureHtml}</div>
    </div>
    <div class="section">
      <h2>偏置参数（由内核驱动）</h2>
      ${openSideHtml}
      ${controlsHtml}
      <div class="subtle" style="margin-top:-4px">${escapeHtml(describeMode(state.params.mode))}</div>
    </div>
    <div class="section">
      <h2>显示</h2>
      <label class="toggle"><input type="checkbox" data-vis="showOriginal" ${state.showOriginal ? 'checked' : ''} /> 原始曲面（只读）</label>
      <label class="toggle"><input type="checkbox" data-vis="showOutput" ${state.showOutput ? 'checked' : ''} /> 偏置壳体</label>
      <label class="toggle"><input type="checkbox" data-vis="showSamples" ${state.showSamples ? 'checked' : ''} /> 测厚采样与失败点</label>
    </div>
    <div class="section">
      <h2>运行</h2>
      <div class="btn-row">
        <button class="btn primary" data-action="run" ${running ? 'disabled' : ''}>${running ? '生成中…' : '生成外壳'}</button>
        <button class="btn" data-action="fit">适配视图</button>
      </div>
    </div>
    <div class="section">
      <h2>参数保存 / 载入</h2>
      <div class="btn-row">
        <button class="btn" data-action="save-params">保存参数 JSON</button>
        <label class="btn" style="display:inline-block">载入参数 JSON<input type="file" accept="application/json" style="display:none" data-action="load-params" /></label>
      </div>
      <div class="hint">保存为 display-shell-params.v1；载入后需重新生成。参数文件不包含几何。</div>
    </div>
    <div class="section">
      <h2>导出结果网格</h2>
      <div class="btn-row">
        <button class="btn" data-action="export-stl">STL</button>
        <button class="btn" data-action="export-obj">OBJ</button>
        <button class="btn" data-action="export-glb">GLB</button>
      </div>
      <div class="hint">导出的是当前生成的内存网格；原始输入资产从不被覆盖。</div>
    </div>
  `;

  root.querySelectorAll<HTMLElement>('[data-fixture]').forEach((el) => {
    el.addEventListener('click', () => cb.onFixtureChange(el.dataset.fixture!));
  });
  // Segmented buttons update their active styling in place so the panel keeps
  // focus; number fields commit on 'change' so a half-typed value never reaches
  // the kernel. Sliders and selects update live.
  root.querySelectorAll<HTMLButtonElement>('[data-param]').forEach((el) => {
    if (el.tagName !== 'BUTTON') return;
    el.addEventListener('click', () => {
      const id = el.dataset.param!;
      const raw = el.dataset.value!;
      state.params = { ...state.params, [id]: raw } as UiState['params'];
      el.parentElement?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === el));
      cb.onParamsChange();
    });
  });
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-param]').forEach((el) => {
    if (el.tagName === 'BUTTON') return;
    const commit = (raw: string) => {
      const id = el.dataset.param!;
      const v = Number(raw);
      if (id !== 'mode' && !Number.isFinite(v)) return;
      state.params = { ...state.params, [id]: v } as UiState['params'];
      cb.onParamsChange();
    };
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') {
      el.addEventListener('input', () => {
        const readout = root.querySelector(`[data-readout="${el.dataset.param}"]`);
        if (readout) readout.textContent = el.value;
        commit(el.value);
      });
    } else {
      el.addEventListener('change', () => commit(el.value));
    }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-openside]').forEach((el) => {
    el.addEventListener('click', () => {
      state.openSide = el.dataset.openside as 'positive' | 'negative';
      el.parentElement?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === el));
      cb.onParamsChange();
    });
  });
  root.querySelectorAll<HTMLInputElement>('[data-vis]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.vis as 'showOriginal' | 'showOutput' | 'showSamples';
      state[key] = el.checked;
      cb.onVisibility();
    });
  });
  root.querySelector('[data-action="run"]')?.addEventListener('click', () => cb.onRun());
  root.querySelector('[data-action="fit"]')?.addEventListener('click', () => {
    const evt = new CustomEvent('ui-fit');
    window.dispatchEvent(evt);
  });
  root.querySelector('[data-action="save-params"]')?.addEventListener('click', () => cb.onSaveParams());
  root.querySelector<HTMLInputElement>('[data-action="load-params"]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) cb.onLoadParams(file);
  });
  root.querySelector('[data-action="export-stl"]')?.addEventListener('click', () => cb.onExport('stl'));
  root.querySelector('[data-action="export-obj"]')?.addEventListener('click', () => cb.onExport('obj'));
  root.querySelector('[data-action="export-glb"]')?.addEventListener('click', () => cb.onExport('glb'));
}

export function renderResults(root: HTMLElement, result: ShellResult | null, running: boolean, phase: string, stale = false): void {
  if (!result) {
    root.innerHTML = `<div class="empty">尚未生成。选择夹具、设置厚度后点击“生成外壳”。<br/>结果区将显示实测壁厚分布、核验项、变化记录与失败区域。</div>`;
    return;
  }
  const errors = result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  const warnings = result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  const overall = result.ok ? 'pass' : 'fail';
  const overallText = result.ok ? '结果通过' : '结果未通过 / 需复核';

  const checkRows = result.checks
    .map(
      (c) => `<div class="check">
        <div><span class="status-badge ${c.status}">${CHECK_LABELS[c.status]}</span></div>
        <div>
          <div class="label">${escapeHtml(c.label)} ${c.value ? `<span class="value">${escapeHtml(c.value)}</span>` : ''}</div>
          <div class="detail">${escapeHtml(c.detail)}</div>
        </div>
      </div>`,
    )
    .join('');

  const t = result.thickness;
  const histogram = t ? renderHistogram(t.histogram, t.histogramMin, t.histogramMax, t.target, t.tolerance) : '';
  const thicknessBlock = t
    ? `<div class="kv">
        <div class="k">有效探针 / 尖角与边界排除 / 未命中</div><div class="v">${t.measuredCount} / ${t.rimCount} / ${t.failedCount}</div>
        <div class="k">均值 / 中位</div><div class="v">${fmt(t.mean)} / ${fmt(t.median)}</div>
        <div class="k">最小 / 最大</div><div class="v">${fmt(t.min)} / ${fmt(t.max)}</div>
        <div class="k">P05 / P95</div><div class="v">${fmt(t.p05)} / ${fmt(t.p95)}</div>
        <div class="k">目标 ± 容差</div><div class="v">${fmt(t.target)} ± ${fmt(t.tolerance)}</div>
        <div class="k">目标内</div><div class="v">${(t.withinFraction * 100).toFixed(2)}%</div>
        <div class="k">偏小 / 偏大</div><div class="v">${t.underCount} / ${t.overCount}</div>
        <div class="k">实测面积 / 失败面积</div><div class="v">${fmt(t.measuredArea)} / ${fmt(t.failedArea)}</div>
      </div>
      ${histogram}`
    : `<div class="empty">无测厚结果。</div>`;

  const changes = result.changes.length
    ? result.changes
        .map(
          (c) => `<div class="change ${c.severity}">
            <div class="title">${escapeHtml(c.title)}</div>
            <div class="detail">${escapeHtml(c.detail)}</div>
          </div>`,
        )
        .join('')
    : `<div class="subtle">未记录几何或拓扑变化。</div>`;

  const output = result.output;
  const meshBlock = output
    ? `<div class="kv">
        <div class="k">输出三角形 / 顶点</div><div class="v">${output.stats.triangleCount} / ${output.stats.vertexCount}</div>
        <div class="k">闭合 / 边界边 / 边界环</div><div class="v">${output.stats.closed ? '是' : '否'} / ${output.stats.boundaryEdgeCount} / ${output.stats.boundaryLoopCount}</div>
        <div class="k">非流形 / 非一致定向边</div><div class="v">${output.stats.nonManifoldEdgeCount} / ${output.stats.inconsistentEdgeCount}</div>
        <div class="k">外表面 / 内表面 / 边缘面积</div><div class="v">${fmt(output.classAreas[0])} / ${fmt(output.classAreas[1])} / ${fmt(output.classAreas[2])}</div>
        <div class="k">自交对（候选 / 精确判定）</div><div class="v">${result.selfIntersection ? `${result.selfIntersection.pairCount}（${result.selfIntersection.candidatePairs} / ${result.selfIntersection.testedPairs}）` : '未执行'}</div>
        <div class="k">场分辨率 / 间距</div><div class="v">${result.domain.dims.join('×')} / ${fmt(result.domain.spacing)}</div>
        <div class="k">耗时 场 / 等值面 / 测厚</div><div class="v">${Math.round(result.fieldBuildMs)} / ${Math.round(result.isoMs)} / ${Math.round(result.measureMs)} ms</div>
        <div class="k">输入几何哈希</div><div class="v" title="${escapeHtml(result.input.hash)}">${escapeHtml(result.input.hash.slice(0, 16))}…</div>
      </div>`
    : `<div class="empty">未生成输出网格。</div>`;

  const feature = result.featureWarning;
  const featureBlock = feature
    ? `<div class="change warn">
        <div class="title">可能被吞并的细部</div>
        <div class="detail">${escapeHtml(feature.description)}</div>
        <div class="kv" style="margin-top:6px">
          <div class="k">受影响采样比例</div><div class="v">${(feature.affectedFraction * 100).toFixed(2)}%</div>
          <div class="k">最小 / 中位自由间隙</div><div class="v">${fmt(feature.minFeatureSize)} / ${fmt(feature.medianFeatureSize)}</div>
          <div class="k">合并阈值（2 × 偏置量）</div><div class="v">${fmt(feature.threshold)}</div>
          <div class="k">估计受影响面积</div><div class="v">${fmt(feature.estimatedArea)}</div>
        </div>
      </div>`
    : `<div class="subtle">未检测到沿偏置方向被吞并的细部。</div>`;

  const limitations = result.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join('');

  root.innerHTML = `
    <div class="section">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="status-badge ${overall}">${overallText}</span>
        ${stale ? '<span class="status-badge warn">参数已修改，结果过期</span>' : ''}
        <span class="subtle mono">${result.generatedAt}</span>
      </div>
      ${errors ? `<ul class="error-list">${errors}</ul>` : ''}
      ${warnings ? `<ul class="warn-list">${warnings}</ul>` : ''}
    </div>
    <div class="section">
      <h2>核验项</h2>
      ${checkRows}
    </div>
    <div class="section">
      <h2>实测壁厚（独立于生成场）</h2>
      ${thicknessBlock}
    </div>
    <div class="section">
      <h2>几何变化记录</h2>
      ${changes}
    </div>
    <div class="section">
      <h2>细部吞并 / 失败区域</h2>
      ${featureBlock}
    </div>
    <div class="section">
      <h2>输出网格</h2>
      ${meshBlock}
    </div>
    <div class="section">
      <h2>适用限制</h2>
      <ul class="subtle" style="margin:0;padding-left:16px">${limitations}</ul>
      <div class="subtle" style="margin-top:8px">${escapeHtml(result.disclaimer)}</div>
    </div>
    ${running ? `<div class="progress"><div class="spinner"></div>${escapeHtml(phase || '运行中…')}</div>` : ''}
  `;
}

function renderHistogram(histogram: number[], min: number, max: number, target: number, tolerance: number): string {
  if (!histogram.length || !(max > min)) return '';
  const peak = Math.max(...histogram, 1);
  const bars = histogram
    .map((count, i) => {
      const value = min + ((i + 0.5) / histogram.length) * (max - min);
      const height = Math.max(1, Math.round((count / peak) * 68));
      const cls = Math.abs(value - target) <= tolerance ? 'ok' : value < target ? 'under' : 'over';
      return `<div class="bar ${cls}" style="height:${height}px" title="${value.toFixed(3)}: ${count}"></div>`;
    })
    .join('');
  return `<div class="histogram">${bars}</div>
    <div class="hist-scale"><span>${min.toFixed(3)}</span><span>目标 ${target.toFixed(3)}</span><span>${max.toFixed(3)}</span></div>`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
