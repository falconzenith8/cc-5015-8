import type { OffsetMode } from './types';

export interface ControlSpec {
  id: 'mode' | 'thickness' | 'resolution' | 'samplesPerTriangle';
  kind: 'segmented' | 'slider' | 'select' | 'number';
  label: string;
  hint: string;
  options?: Array<{ value: string | number; label: string; hint?: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export const DEFAULT_PARAMS = {
  mode: 'inward' as OffsetMode,
  thickness: 2.5,
  resolution: 72,
  samplesPerTriangle: 2,
  seed: 20261114,
};

export const PARAM_CONTROLS: ControlSpec[] = [
  {
    id: 'mode',
    kind: 'segmented',
    label: '偏置模式',
    hint: '向内：原面成为外表面；向外：原面成为内表面；对称：目标厚度在两侧均分。',
    options: [
      { value: 'inward', label: '向内', hint: '原面保留为外壳外表面，厚度向材料内部发展。' },
      { value: 'outward', label: '向外', hint: '原面保留为内表面，厚度向空气侧发展。' },
      { value: 'symmetric', label: '对称', hint: '目标厚度在两侧各半，原面位于壳体中面。' },
    ],
  },
  {
    id: 'thickness',
    kind: 'number',
    label: '目标厚度 t',
    hint: '与模型单位一致，不做单位换算。生成后会由独立射线测量核验实际壁厚。',
    min: 0.01,
    max: 200,
    step: 0.01,
    unit: '模型单位',
  },
  {
    id: 'resolution',
    kind: 'slider',
    label: '距离场分辨率',
    hint: '最长轴采样数。越低越快，但薄壁与尖角更易失真；每侧壁至少约 3 个格子时结果较可靠。',
    min: 32,
    max: 144,
    step: 8,
  },
  {
    id: 'samplesPerTriangle',
    kind: 'select',
    label: '测厚采样密度',
    hint: '每个输出上表面三角形的目标探针数；总探针有上限，结果区显示实际数量。',
    options: [
      { value: 1, label: '低 (1/面)' },
      { value: 2, label: '中 (2/面)' },
      { value: 4, label: '高 (4/面)' },
    ],
  },
];

/** Driven by the kernel as well: open inputs must declare which oriented side is air. */
export const OPEN_SIDE_CONTROL = {
  id: 'openSide' as const,
  kind: 'segmented' as const,
  label: '开放曲面的空气侧',
  hint: '开放曲面没有体积内部，内核不会自动推断。请选择面法线正向或反向作为外部空气。',
  options: [
    { value: 'positive', label: '法线正向', hint: '所选面法线指向的一侧视为空气。' },
    { value: 'negative', label: '法线反向', hint: '面法线的相反方向视为空气。' },
  ],
};

export interface ValidationIssue {
  field: 'mode' | 'thickness' | 'resolution' | 'samplesPerTriangle' | 'openSide';
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidateContext {
  expectedOpen: boolean;
  openSide: 'positive' | 'negative' | null;
}

export function validateParams(
  params: { mode: OffsetMode; thickness: number; resolution: number; samplesPerTriangle: number },
  ctx: ValidateContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!['inward', 'outward', 'symmetric'].includes(params.mode)) {
    issues.push({ field: 'mode', severity: 'error', message: '偏置模式无效。' });
  }
  if (!Number.isFinite(params.thickness) || params.thickness <= 0) {
    issues.push({ field: 'thickness', severity: 'error', message: '目标厚度必须为正数。' });
  } else if (params.thickness > 200) {
    issues.push({ field: 'thickness', severity: 'warning', message: '厚度相对常见展示模型偏大，可能导致细节被吞并。' });
  }
  if (!Number.isFinite(params.resolution) || params.resolution < 32 || params.resolution > 144) {
    issues.push({ field: 'resolution', severity: 'error', message: '分辨率须在 32 到 144 之间。' });
  }
  if (![1, 2, 4].includes(params.samplesPerTriangle)) {
    issues.push({ field: 'samplesPerTriangle', severity: 'error', message: '采样密度须为 1、2 或 4。' });
  }
  if (ctx.expectedOpen && !ctx.openSide) {
    issues.push({
      field: 'openSide',
      severity: 'error',
      message: '开放曲面未选择空气侧。请显式指定哪一侧是外部，内核不会自动假定内部方向。',
    });
  }
  return issues;
}

export function describeMode(mode: OffsetMode): string {
  switch (mode) {
    case 'inward':
      return '向内偏置：原面为外表面，厚度向材料内部发展';
    case 'outward':
      return '向外偏置：原面为内表面，厚度向空气侧发展';
    case 'symmetric':
      return '对称偏置：目标厚度在两侧均分，原面位于壳体中面';
  }
}

export function levelsForMode(mode: OffsetMode, thickness: number): { a: number; b: number } {
  switch (mode) {
    case 'inward':
      return { a: -thickness, b: 0 };
    case 'outward':
      return { a: 0, b: thickness };
    case 'symmetric':
      return { a: -thickness / 2, b: thickness / 2 };
  }
}

export function buildParamsForScenario(mode: OffsetMode, thickness: number, resolution = 72, samplesPerTriangle = 2) {
  return { mode, thickness, resolution, samplesPerTriangle, seed: 20261114 };
}
