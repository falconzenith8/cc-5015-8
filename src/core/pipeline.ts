import * as THREE from 'three';
import type {
  ChangeEntry,
  CheckItem,
  OffsetMode,
  OffsetParams,
  ShellResult,
  TriMesh,
} from './types';
import {
  buildField,
  extractSurfaceNets,
  InputGeometry,
  SignedDistanceField,
} from '../geometry/field';
import {
  collectSharpEdges,
  computeStats,
  computeTopology,
  distanceToSegments,
  filterTriangles,
  hashGeometry,
  orientClosedMesh,
} from '../geometry/mesh';
import {
  buildOutputMeshInfo,
  detectSelfIntersections,
  detectSwallowedFeatures,
  measureThickness,
  verifyShell,
} from '../geometry/measure';
import { analyzeFieldTopology } from '../geometry/fieldtopology';
import { describeMode, levelsForMode, validateParams } from './params';

export interface RunOptions {
  inputName: string;
  expectedOpen: boolean;
  openSide: 'positive' | 'negative' | null;
  params: OffsetParams;
  /** Verification tolerance in model units. Defaults to 2% of thickness. */
  tolerance?: number;
  onPhase?: (phase: string, detail?: string) => void;
}

export function runOffset(inputMesh: TriMesh, opts: RunOptions): ShellResult {
  const totalStart = performance.now();
  const phase = opts.onPhase ?? (() => {});
  const params = opts.params;
  const errors: string[] = [];
  const warnings: string[] = [];
  const changes: ChangeEntry[] = [];
  const limitations: string[] = [];
  const tolerance = opts.tolerance ?? Math.max(1e-4, params.thickness * 0.02);
  const inputStatsTopology = computeTopology(inputMesh);
  const inputStats = computeStats(inputMesh, inputStatsTopology);
  const inputHash = hashGeometry(inputMesh.positions, inputMesh.indices);

  const validation = validateParams(params, { expectedOpen: opts.expectedOpen, openSide: opts.openSide });
  for (const issue of validation) {
    if (issue.severity === 'error') errors.push(issue.message);
    else warnings.push(issue.message);
  }
  if (inputStats.isEmpty) errors.push('输入网格为空。');
  if (inputStats.degenerateTriangleCount > 0) {
    warnings.push(`输入含 ${inputStats.degenerateTriangleCount} 个退化三角形；已保留其位置但不参与几何判断。`);
  }

  const emptyResult = (): ShellResult => ({
    ok: false,
    errors,
    warnings,
    params,
    appliedMode: params.mode,
    input: {
      stats: inputStats,
      hash: inputHash,
      name: opts.inputName,
      bboxSize: [
        inputStats.bbox.max[0] - inputStats.bbox.min[0],
        inputStats.bbox.max[1] - inputStats.bbox.min[1],
        inputStats.bbox.max[2] - inputStats.bbox.min[2],
      ],
    },
    domain: { min: [0, 0, 0], max: [0, 0, 0], dims: [0, 0, 0], spacing: 0, band: 0 },
    fieldBuildMs: 0,
    isoMs: 0,
    measureMs: 0,
    totalMs: performance.now() - totalStart,
    output: null,
    thickness: null,
    samples: [],
    sampleMarkers: [],
    checks: [],
    changes,
    featureWarning: null,
    selfIntersection: null,
    verification: null,
    fieldTopology: null,
    limitations,
    disclaimer: '仅用于展示外壳几何。不构成任何实物强度、承压或安全保证。',
    generatedAt: new Date().toISOString(),
  });

  if (errors.length) return emptyResult();

  const open = !inputStats.closed;
  if (open !== opts.expectedOpen) {
    warnings.push(
      open
        ? `网格实际存在 ${inputStats.boundaryEdgeCount} 条边界边，按开放曲面处理；请确认空气侧选择。`
        : '网格封闭且无边界，按闭合实体处理；未使用空气侧选择。',
    );
  }
  if (open && inputStats.oriented === false && inputStats.inconsistentEdgeCount > 0) {
    warnings.push(`开放网格存在 ${inputStats.inconsistentEdgeCount} 条非一致定向边；开放侧符号使用局部面法线，翻转区域会导致测量方向偏转。`);
  }

  // ---- Input orientation handling -----------------------------------------
  let sourceMesh = inputMesh;
  let faceNormalMesh = inputMesh;
  let orientationFixed = false;
  let autoFlippedInput = false;
  if (!open) {
    const oriented = orientClosedMesh(inputMesh);
    orientationFixed = oriented.changed;
    sourceMesh = oriented.mesh;
    faceNormalMesh = oriented.mesh;
    if (oriented.changed) {
      changes.push({
        id: 'input-orientation',
        kind: 'normal',
        severity: 'info',
        title: '输入朝向已校正',
        detail: `闭合输入的环绕方向不一致或体积为负；在内存中修正了 ${oriented.flippedTriangleCount} 个三角形、${oriented.flippedComponentCount} 个整体反向的连通块。原始资产未改动。`,
      });
    }
    if (oriented.ambiguousEdgeCount > 0) {
      warnings.push(`输入有 ${oriented.ambiguousEdgeCount} 条边被超过两个三角形共用；朝向校正无法唯一确定，符号以射线奇偶为准。`);
    }
  } else {
    // Open meshes are never auto-flipped. The explicitly chosen side defines air.
    autoFlippedInput = false;
  }

  const appliedMode = params.mode;
  const levels = levelsForMode(appliedMode, params.thickness);
  if (open && appliedMode === 'inward') {
    // "inward" is ambiguous for an open sheet; require an explicit side and
    // reinterpret the direction as "toward the selected material side".
    limitsNote(limitations, '开放曲面的“向内/向外”均相对你选择的空气侧解释，而非自动推断的体积内部。');
  }

  phase('构建输入索引');
  const inputTopo = computeTopology(sourceMesh);
  const input = new InputGeometry(sourceMesh, inputTopo.boundaryEdges);

  phase('生成距离场', `分辨率目标 ${params.resolution}`);
  const fieldStart = performance.now();
  const fieldBuild = buildField(input, !open, {
    a: levels.a,
    b: levels.b,
    resolution: params.resolution,
    openSide: opts.openSide,
  });
  const fieldBuildMs = performance.now() - fieldStart;
  const sdf = new SignedDistanceField(fieldBuild, input, opts.openSide, levels.a, levels.b);

  if (fieldBuild.clampedResolution) {
    warnings.push(`为控制内存，距离场网格分辨率被自动下调（间距 ×${fieldBuild.spacingClampedBy.toFixed(2)}）。薄壁精度可能下降。`);
    changes.push({
      id: 'resolution-clamped',
      kind: 'resolution',
      severity: 'warn',
      title: '分辨率被自动下调',
      detail: `目标 ${params.resolution}，实际间距 ${fieldBuild.domain.spacing.toFixed(4)} 模型单位。`,
    });
  }
  const cellsPerWall = params.thickness / fieldBuild.domain.spacing;
  if (cellsPerWall < 2.5) {
    warnings.push(`目标厚度仅覆盖约 ${cellsPerWall.toFixed(1)} 个距离场格子，测厚偏差可能超过容差。建议提高分辨率或降低厚度。`);
  }
  if (fieldBuild.signMismatches > 0 && fieldBuild.signSamples > 0) {
    const frac = fieldBuild.signMismatches / fieldBuild.signSamples;
    if (frac > 0.002) {
      warnings.push(`闭合输入在 ${(frac * 100).toFixed(2)}% 的带内采样上，射线奇偶符号与最近面法线方向不一致；常见于极薄特征或自交输入。`);
    }
  }
  if (fieldBuild.rimCutSamples > 0) {
    changes.push({
      id: 'rim-cut',
      kind: 'preserved',
      severity: 'info',
      title: '边界处截断偏置带',
      detail: `开口边界外侧的 ${fieldBuild.rimCutSamples} 个场采样被判定为空气，避免偏置越过原始开口边缘形成虚假翻边。`,
    });
  }

  phase('提取等值面');
  const isoStart = performance.now();
  const rawOutput = extractSurfaceNets(fieldBuild.values, fieldBuild.domain.dims, fieldBuild.domain.min, fieldBuild.domain.spacing);
  // No post-projection: Surface Nets already places each vertex on an edge of
  // the zero crossing, and its residual error measured against the analytic
  // input is a few percent of a cell. A Newton pass on the trilinear field
  // drifted vertices sideways and increased that error, so the raw extraction
  // is kept as-is and its accuracy is reported by the independent measurement.
  const isoMs = performance.now() - isoStart;

  // ---- Output orientation check -------------------------------------------
  let outputMesh = rawOutput;
  let normalCorrectionApplied = false;
  if (outputMesh.triangleCount > 0) {
    const g = sampleGradientAverage(sdf, outputMesh);
    if (g.sign < 0) {
      outputMesh = flipWinding(outputMesh);
      normalCorrectionApplied = true;
      changes.push({
        id: 'output-orientation',
        kind: 'normal',
        severity: 'info',
        title: '输出法线方向已按场梯度校正',
        detail: '提取网格的环绕方向与“材料 → 空气”梯度相反，已整体翻转；这是显式修正，不是静默处理。',
      });
    }
  }

  // Open inputs: the band wraps around the trim boundary and leaves a rounded
  // cap that both seals the opening and folds over itself. Remove the cap band
  // around the input boundary curves so the offset surfaces stay open there.
  let trimmedRimTriangles = 0;
  if (open && outputMesh.triangleCount > 0) {
    const trimRadius = Math.max(
      Math.abs(levels.a), Math.abs(levels.b),
    ) * 1.6 + fieldBuild.domain.spacing;
    const segs = input.boundarySegments;
    const filtered = filterTriangles(outputMesh, (t) => {
      const tri = t * 3;
      const ia = outputMesh.indices[tri] * 3;
      const ib = outputMesh.indices[tri + 1] * 3;
      const ic = outputMesh.indices[tri + 2] * 3;
      const cx = (outputMesh.positions[ia] + outputMesh.positions[ib] + outputMesh.positions[ic]) / 3;
      const cy = (outputMesh.positions[ia + 1] + outputMesh.positions[ib + 1] + outputMesh.positions[ic + 1]) / 3;
      const cz = (outputMesh.positions[ia + 2] + outputMesh.positions[ib + 2] + outputMesh.positions[ic + 2]) / 3;
      return distanceToSegments(cx, cy, cz, segs) > trimRadius;
    });
    outputMesh = filtered.mesh;
    trimmedRimTriangles = filtered.removed;
    if (trimmedRimTriangles > 0) {
      changes.push({
        id: 'open-rim-trim',
        kind: 'preserved',
        severity: 'info',
        title: '裁掉边界处的偏置端盖',
        detail: `开放输入的偏置带会在边界处绕成圆角端盖并封闭开口；已沿输入边界裁掉 ${trimmedRimTriangles} 个端盖三角形（距边界 ${trimRadius.toFixed(3)} 模型单位内），保留开口与两条边界环。原始资产未改动。`,
      });
    }
  }

  const outputTopoForRims = computeTopology(outputMesh);
  const rimSegments = outputTopoForRims.boundaryLoops.flatMap((loop) => {
    const segs: Array<[number, number, number, number, number, number]> = [];
    for (let i = 0; i < loop.vertices.length; i++) {
      const a = loop.vertices[i] * 3;
      const b = loop.vertices[(i + 1) % loop.vertices.length] * 3;
      segs.push([outputMesh.positions[a], outputMesh.positions[a + 1], outputMesh.positions[a + 2],
        outputMesh.positions[b], outputMesh.positions[b + 1], outputMesh.positions[b + 2]]);
    }
    return segs;
  });
  const inputRimSegments = input.boundarySegments.map(
    (s) => [s[0], s[1], s[2], s[3], s[4], s[5]] as [number, number, number, number, number, number],
  );
  const outputInfo = buildOutputMeshInfo(outputMesh, {
    a: levels.a,
    b: levels.b,
    distanceInfo: (x, y, z) => sdf.distanceInfo(x, y, z),
    rimSegments,
    rimThreshold: Math.max(fieldBuild.domain.spacing * 1.1, params.thickness * 0.08),
  });

  const checks: CheckItem[] = [];
  const output = outputInfo;
  const outStats = output.stats;

  // ---- Thickness measurement ---------------------------------------------
  phase('独立测厚');
  const measureStart = performance.now();
  const targetProbes = Math.max(200, Math.min(4000, Math.round(output.mesh.triangleCount * params.samplesPerTriangle * 0.35)));
  // Sharp input edges (dihedral above 30 degrees) plus the input trim boundary:
  // the offset rounds these, so thickness near them is a corner artefact rather
  // than wall error and is excluded from the statistics.
  const sharpSegments = collectSharpEdges(sourceMesh, input.faceNormals, 30);
  const edgeSegments = open ? sharpSegments.concat(input.boundarySegments) : sharpSegments;
  const measurement = measureThickness({
    output: output.mesh,
    triangleClass: output.triangleClass,
    probeCount: targetProbes,
    thickness: params.thickness,
    tolerance,
    seed: params.seed,
    edgeSegments,
    edgeExcludeDistance: params.thickness * 1.5,
  });
  const measureMs = performance.now() - measureStart;
  const thickness = measurement.stats;
  const samples = measurement.samples;

  // ---- Self intersection --------------------------------------------------
  phase('自交检测');
  const selfIntersection = outStats.triangleCount > 0 && outStats.triangleCount <= 220_000
    ? detectSelfIntersections(output.mesh)
    : null;
  if (outStats.triangleCount > 220_000) {
    limitations.push('输出三角形数超过自交检测上限（220k），本次跳过逐对自交检测。');
  }

  // ---- Feature swallowing -------------------------------------------------
  phase('特征吞并检测');
  const inwardReach = appliedMode === 'inward' ? params.thickness : appliedMode === 'symmetric' ? params.thickness / 2 : 0;
  const outwardReach = appliedMode === 'outward' ? params.thickness : appliedMode === 'symmetric' ? params.thickness / 2 : 0;
  const featureWarning = detectSwallowedFeatures(
    input.bvh,
    sourceMesh.positions,
    sourceMesh.indices,
    input.faceNormals,
    {
      inwardReach,
      outwardReach,
      skin: fieldBuild.domain.spacing * 0.35,
      samples: 4000,
      seed: params.seed,
      surfaceArea: inputStats.surfaceArea,
    },
  );
  if (featureWarning) {
    featureWarning.description =
      `输入表面有 ${(featureWarning.affectedFraction * 100).toFixed(1)}% 的检测点，其沿偏置方向的自由空间小于偏置量；` +
      `最小间隙约 ${featureWarning.minFeatureSize.toFixed(3)}，中位 ${featureWarning.medianFeatureSize.toFixed(3)} 模型单位。` +
      '这些位置在结果中可能被合并或吞并，必须在结果区核对。';
    changes.push({
      id: 'swallowed-features',
      kind: 'swallowed',
      severity: 'warn',
      title: '检测到可能被吞并的细部',
      detail: featureWarning.description,
      volume: featureWarning.estimatedArea,
    });
  }

  // ---- Field topology -----------------------------------------------------
  phase('拓扑核验');
  const fieldTopology = analyzeFieldTopology(
    (x, y, z) => sdf.signedDistance(x, y, z),
    output.mesh,
    fieldBuild.domain,
    48,
  );

  // ---- Verification -------------------------------------------------------
  phase('朝向与内外核验');
  const verification = verifyShell(
    output.mesh,
    output.normals,
    output.triangleClass,
    (x, y, z) => sdf.gradient(x, y, z),
    outStats.closed,
    fieldBuild.domain.spacing,
  );
  verification.normalCorrectionApplied = normalCorrectionApplied;
  if (verification.signedSamples > 0 && verification.shellSideMismatches / verification.signedSamples > 0.005) {
    warnings.push(
      `有 ${verification.shellSideMismatches}/${verification.signedSamples} 个采样三角面的法线与会场梯度方向不一致；外/内分类可能不可靠。`,
    );
  }
  if (verification.paritySamples > 0) {
    const frac = verification.parityMismatches / verification.paritySamples;
    if (frac > 0.02) {
      warnings.push(
        `闭合壳体的内外关系核验有 ${(frac * 100).toFixed(1)}% 的采样失败（材料侧/空气侧奇偶期望不符）。可能存在自交或非流形。`,
      );
    }
  }

  // ---- Structural changes -------------------------------------------------
  if (output.smallComponentCount > 0) {
    changes.push({
      id: 'small-components',
      kind: 'topology',
      severity: 'warn',
      title: '输出包含微小连通块',
      detail: `${output.smallComponentCount} 个连通块体积小于表面积阈值，可能是薄壁碎片。未删除，随导出保留。`,
      volume: output.smallComponentVolume,
    });
  }
  const removedComponents = outputInfo.componentVolumes.filter((c) => Math.abs(c.volume) < 1e-9).length;
  if (removedComponents > 0) {
    changes.push({
      id: 'degenerate-components',
      kind: 'topology',
      severity: 'warn',
      title: '输出含零体积连通块',
      detail: `${removedComponents} 个连通块的封闭体积近似为零，可能是开片或退化面；未静默删除。`,
    });
  }
  if (outStats.nonManifoldEdgeCount > 0) {
    warnings.push(`输出有 ${outStats.nonManifoldEdgeCount} 条非流形边，导出文件可能无法被下游 CAD 直接接受。`);
  }
  if (fieldTopology.newlyEnclosedAirVolumes.length > 0) {
    changes.push({
      id: 'enclosed-air',
      kind: 'topology',
      severity: 'warn',
      title: '偏置封闭了原有空气腔',
      detail: `${fieldTopology.newlyEnclosedAirVolumes.length} 个原有空气连通域在输出中不再作为空腔保留；这是偏置合并的直接后果，未做删除或填充。`,
    });
  }
  if (fieldTopology.splitInnerVoidVolumes.length > 0) {
    changes.push({
      id: 'split-voids',
      kind: 'topology',
      severity: 'info',
      title: '内腔被细分为多个连通域',
      detail: `输出内腔连通域数 ${fieldTopology.outputInnerVoidComponents}，输入封闭空气域数 ${fieldTopology.inputEnclosedAirComponents}；细小内腔可能被偏置分开。`,
    });
  }
  if (open) {
    changes.push({
      id: 'open-boundary-preserved',
      kind: 'preserved',
      severity: 'info',
      title: '保留开口边界',
      detail: `输入 ${outStats.boundaryLoopCount ? '' : ''}${inputStats.boundaryLoopCount} 条边界环；输出 ${outStats.boundaryLoopCount} 条边界环、${outStats.boundaryEdgeCount} 条边界边。`,
    });
  }

  // ---- Checks -------------------------------------------------------------
  const check = (
    id: string,
    label: string,
    status: CheckItem['status'],
    detail: string,
    value?: string,
  ) => checks.push({ id, label, status, detail, value });

  check(
    'mesh-closed',
    '网格闭合性',
    outStats.isEmpty ? 'fail' : outStats.closed ? 'pass' : open ? 'na' : 'fail',
    outStats.isEmpty
      ? '未提取到任何表面。'
      : outStats.closed
        ? '无边界边、无非流形边。'
        : `存在 ${outStats.boundaryEdgeCount} 条边界边 / ${outStats.boundaryLoopCount} 条边界环。${open ? '输入为开放曲面，输出保持开口。' : '闭合输入却输出了开口，需检查。'}`,
    outStats.closed ? '闭合' : `${outStats.boundaryLoopCount} 环`,
  );
  check(
    'manifold',
    '流形与定向',
    outStats.nonManifoldEdgeCount === 0 && outStats.inconsistentEdgeCount === 0 ? 'pass' : 'warn',
    `非流形边 ${outStats.nonManifoldEdgeCount}，非一致定向边 ${outStats.inconsistentEdgeCount}，退化三角形 ${outStats.degenerateTriangleCount}。`,
  );
  const thicknessStatus: CheckItem['status'] =
    thickness.measuredCount === 0
      ? 'fail'
      : thickness.withinFraction >= 0.99 && thickness.maxAbsDeviation <= tolerance * 1.5
        ? 'pass'
        : thickness.withinFraction >= 0.9
          ? 'warn'
          : 'fail';
  check(
    'thickness',
    '实测壁厚',
    thicknessStatus,
    `${thickness.measuredCount} 个有效探针，均值 ${thickness.mean.toFixed(4)}，中位 ${thickness.median.toFixed(4)}，` +
      `P05–P95 ${thickness.p05.toFixed(4)}–${thickness.p95.toFixed(4)}，目标 ${params.thickness.toFixed(4)} ± ${tolerance.toFixed(4)}（${(tolerance / params.thickness * 100).toFixed(1)}%）。` +
      ` 小于目标 ${thickness.underCount}，超出 ${thickness.overCount}，未命中对面 ${thickness.failedCount}，开口边排除 ${thickness.rimCount}。`,
    `${(thickness.withinFraction * 100).toFixed(2)}% 在容差内`,
  );
  if (thickness.measuredCount > 0 && thickness.median > 0) {
    const relErr = Math.abs(thickness.median - params.thickness) / params.thickness;
    if (relErr > 0.05) {
      warnings.push(`实测壁厚中位数偏离目标 ${(relErr * 100).toFixed(1)}%，超出 5%。请检查分辨率、特征吞并或尖角处法线方向。`);
    }
  }
  check(
    'orientation',
    '法线方向',
    verification.signedSamples === 0
      ? 'na'
      : verification.shellSideMismatches / verification.signedSamples <= 0.005
        ? 'pass'
        : 'warn',
    verification.note +
      ` 梯度核对 ${verification.signedSamples - verification.shellSideMismatches}/${verification.signedSamples} 一致。` +
      (normalCorrectionApplied ? ' 已按场梯度整体翻转输出。' : ''),
  );
  check(
    'sides',
    '内外关系',
    !outStats.closed
      ? 'na'
      : verification.parityMismatches / Math.max(1, verification.paritySamples) <= 0.005
        ? 'pass'
        : verification.parityMismatches / Math.max(1, verification.paritySamples) < 0.02
          ? 'warn'
          : 'fail',
    outStats.closed
      ? `壳体两侧奇偶校验：${verification.paritySamples - verification.parityMismatches}/${verification.paritySamples} 通过。`
      : '输出不闭合，没有内外体积关系；不适用奇偶校验。',
  );
  const selfStatus: CheckItem['status'] = !selfIntersection
    ? 'na'
    : selfIntersection.pairCount === 0
      ? 'pass'
      : 'fail';
  check(
    'self-intersection',
    '自交',
    selfStatus,
    !selfIntersection
      ? '未执行或超出规模上限。'
      : `空间索引筛出 ${selfIntersection.candidatePairs} 个候选对，逐对精确判定 ${selfIntersection.testedPairs} 个不相邻三角形对，发现 ${selfIntersection.pairCount} 个相交对` +
        (selfIntersection.skippedPairCount ? `；${selfIntersection.skippedPairCount} 对因上限未判定。` : '。'),
    selfIntersection ? `${selfIntersection.pairCount} 对` : '跳过',
  );
  check(
    'features',
    '细部保留 / 吞并',
    featureWarning ? 'warn' : 'pass',
    featureWarning
      ? featureWarning.description
      : '沿偏置方向的自由空间均不小于偏置量；未检测到特征被吞并。',
  );
  check(
    'topology',
    '场级拓扑变化',
    fieldTopology.newlyEnclosedAirVolumes.length > 0 ? 'warn' : 'pass',
    `输入空气域 ${fieldTopology.inputAirComponents}（其中封闭 ${fieldTopology.inputEnclosedAirComponents}），` +
      `输出封闭空腔 ${fieldTopology.outputEnclosedAirComponents}。新封闭 ${fieldTopology.newlyEnclosedAirVolumes.length}，细分内腔 ${fieldTopology.splitInnerVoidVolumes.length}。`,
  );
  const wallCells = params.thickness / fieldBuild.domain.spacing;
  check(
    'resolution-adequacy',
    '分辨率充分性',
    wallCells >= 3 ? 'pass' : wallCells >= 2 ? 'warn' : 'fail',
    `目标厚度约覆盖 ${wallCells.toFixed(1)} 个距离场格子（间距 ${fieldBuild.domain.spacing.toFixed(4)}）。` +
      '小于 3 时尖角与薄壁偏差通常增大。',
  );
  check(
    'input-integrity',
    '原始资产完整性',
    hashGeometry(inputMesh.positions, inputMesh.indices) === inputHash ? 'pass' : 'fail',
    '输入数据在生成前后哈希一致；所有修正均在内存副本上进行，原资产未被覆盖。',
  );

  // ---- Aggregate ----------------------------------------------------------
  const hasFail = checks.some((c) => c.status === 'fail');
  if (hasFail) {
    warnings.push('至少一项核验未通过；结果不能作为合格展示外壳交付，请按结果区提示调整参数或输入。');
  }
  limitations.push(
    '厚度由独立射线在输出网格上实测，不读回生成用的距离场；开口边界附近与尖角处的探针可能被排除或偏短。',
    '等值面顶点不做后置投影：Surface Nets 已在零交叉边上取点，后置牛顿迭代会在三角化场上横向漂移并增大误差，因此保留原始提取结果。',
    '自交检测只判定三角形对相交，不修复；结果保留原始几何，不会为了闭合或导出而删除细节。',
    '距离场偏置在尖锐凸角处天然圆化、凹角处会填补；这是所选算法的固有近似，不是显示误差。',
    '单位一致性由输入资产与厚度参数共同保证，本工具不做任何单位换算。',
  );
  if (fieldBuild.clampedResolution) {
    limitations.push('本次距离场分辨率被自动降低，实际精度以结果区报告的间距为准。');
  }

  const result: ShellResult = {
    ok: outStats.triangleCount > 0 && !hasFail && errors.length === 0,
    errors,
    warnings,
    params,
    appliedMode,
    input: {
      stats: inputStats,
      hash: inputHash,
      name: opts.inputName,
      bboxSize: [
        inputStats.bbox.max[0] - inputStats.bbox.min[0],
        inputStats.bbox.max[1] - inputStats.bbox.min[1],
        inputStats.bbox.max[2] - inputStats.bbox.min[2],
      ],
    },
    domain: {
      min: fieldBuild.domain.min,
      max: fieldBuild.domain.max,
      dims: fieldBuild.domain.dims,
      spacing: fieldBuild.domain.spacing,
      band: fieldBuild.domain.band,
    },
    fieldBuildMs,
    isoMs,
    measureMs,
    totalMs: performance.now() - totalStart,
    output,
    thickness,
    samples,
    sampleMarkers: samples.filter((s) => s.status !== 0).slice(0, 240),
    checks,
    changes,
    featureWarning,
    selfIntersection,
    verification,
    fieldTopology,
    limitations,
    disclaimer: '仅用于展示外壳几何与厚度检查。不构成实物强度、承压、耐温或安全保证；量产前需按材料与工艺另行验证。',
    generatedAt: new Date().toISOString(),
  };
  void orientationFixed;
  void autoFlippedInput;
  void describeMode;
  return result;
}

function limitsNote(list: string[], text: string) {
  if (!list.includes(text)) list.push(text);
}

function sampleGradientAverage(sdf: SignedDistanceField, mesh: TriMesh): { sign: number } {
  const stride = Math.max(1, Math.floor(mesh.triangleCount / 400));
  let sum = 0;
  for (let t = 0; t < mesh.triangleCount; t += stride) {
    const ia = mesh.indices[t * 3] * 3;
    const ib = mesh.indices[t * 3 + 1] * 3;
    const ic = mesh.indices[t * 3 + 2] * 3;
    const x = (mesh.positions[ia] + mesh.positions[ib] + mesh.positions[ic]) / 3;
    const y = (mesh.positions[ia + 1] + mesh.positions[ib + 1] + mesh.positions[ic + 1]) / 3;
    const z = (mesh.positions[ia + 2] + mesh.positions[ib + 2] + mesh.positions[ic + 2]) / 3;
    const g = sdf.gradient(x, y, z);
    const ux = mesh.positions[ib] - mesh.positions[ia];
    const uy = mesh.positions[ib + 1] - mesh.positions[ia + 1];
    const uz = mesh.positions[ib + 2] - mesh.positions[ia + 2];
    const vx = mesh.positions[ic] - mesh.positions[ia];
    const vy = mesh.positions[ic + 1] - mesh.positions[ia + 1];
    const vz = mesh.positions[ic + 2] - mesh.positions[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    sum += nx * g[0] + ny * g[1] + nz * g[2];
  }
  return { sign: sum >= 0 ? 1 : -1 };
}

export function flipWinding(mesh: TriMesh): TriMesh {
  const indices = new Uint32Array(mesh.indices);
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
  return { ...mesh, indices };
}

export { THREE };
