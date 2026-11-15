export type OffsetMode = 'symmetric' | 'outward' | 'inward';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na';

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  value?: string;
}

export interface ChangeEntry {
  id: string;
  kind: 'topology' | 'swallowed' | 'preserved' | 'normal' | 'mode' | 'resolution' | 'disk';
  severity: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
  location?: [number, number, number];
  volume?: number;
  area?: number;
}

export interface TriMesh {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface MeshStats {
  vertexCount: number;
  triangleCount: number;
  surfaceArea: number;
  boundaryEdgeCount: number;
  boundaryLoopCount: number;
  nonManifoldEdgeCount: number;
  inconsistentEdgeCount: number;
  componentCount: number;
  shellComponentCount: number;
  degenerateTriangleCount: number;
  signedVolume: number;
  closed: boolean;
  oriented: boolean;
  isEmpty: boolean;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface BoundaryLoop {
  vertices: number[];
  length: number;
  closed: boolean;
}

export interface MeshTopology {
  edgeUse: Map<string, number>;
  boundaryEdges: Array<[number, number]>;
  boundaryLoops: BoundaryLoop[];
  nonManifoldEdges: Array<[number, number]>;
  inconsistentEdges: Array<[number, number]>;
  componentOfVertex: Int32Array;
  componentCount: number;
}

export interface OffsetParams {
  mode: OffsetMode;
  /** Target wall thickness in model units. */
  thickness: number;
  /** Max samples along the longest bounding box axis. */
  resolution: number;
  /** Thickness probes per triangle: 1, 2 or 4. */
  samplesPerTriangle: number;
  /** Seed for deterministic sampling and verification rays. */
  seed: number;
}

export interface ShellSample {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  thickness: number;
  target: number;
  deviation: number;
  /** 0 ok, 1 under, 2 over, 3 no opposite hit, 4 excluded (sharp edge / rim) */
  status: 0 | 1 | 2 | 3 | 4;
  rim: boolean;
  triangle: number;
}

export interface ThicknessStats {
  measuredCount: number;
  rimCount: number;
  failedCount: number;
  okCount: number;
  underCount: number;
  overCount: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  p05: number;
  p95: number;
  meanAbsDeviation: number;
  maxAbsDeviation: number;
  tolerance: number;
  target: number;
  /** Measured values used for the histogram. */
  histogram: number[];
  histogramMin: number;
  histogramMax: number;
  /** Fraction of measured wall samples within tolerance. */
  withinFraction: number;
  measuredArea: number;
  failedArea: number;
  rimArea: number;
}

export interface FeatureWarning {
  sampleCount: number;
  totalSamples: number;
  affectedFraction: number;
  estimatedArea: number;
  minFeatureSize: number;
  medianFeatureSize: number;
  points: Array<[number, number, number]>;
  threshold: number;
  description: string;
}

export interface SelfIntersectionReport {
  pairCount: number;
  testedPairs: number;
  /** Candidate pairs produced by the conservative spatial filter before exact tests. */
  candidatePairs: number;
  points: Array<[number, number, number]>;
  skippedPairCount: number;
  degenerateTriangleCount: number;
}

export interface VerificationReport {
  paritySamples: number;
  parityMismatches: number;
  signedSamples: number;
  shellSideMismatches: number;
  normalCorrectionApplied: boolean;
  note: string;
}

export interface FieldTopologyReport {
  inputAirComponents: number;
  inputEnclosedAirComponents: number;
  outputEnclosedAirComponents: number;
  outputInnerVoidComponents: number;
  newlyEnclosedAirVolumes: number[];
  splitInnerVoidVolumes: number[];
  enclosedAirLocations: Array<[number, number, number]>;
  innerVoidLocations: Array<[number, number, number]>;
}

export interface OutputMeshInfo {
  mesh: TriMesh;
  normals: Float32Array;
  /** 0 outer, 1 inner, 2 rim */
  triangleClass: Uint8Array;
  classAreas: [number, number, number];
  stats: MeshStats;
  componentVolumes: Array<{ volume: number; triangleCount: number; centroid: [number, number, number] }>;
  smallComponentCount: number;
  smallComponentVolume: number;
}

export interface ShellResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  params: OffsetParams;
  appliedMode: OffsetMode;
  input: {
    stats: MeshStats;
    hash: string;
    name: string;
    bboxSize: [number, number, number];
  };
  domain: {
    min: [number, number, number];
    max: [number, number, number];
    dims: [number, number, number];
    spacing: number;
    band: number;
  };
  fieldBuildMs: number;
  isoMs: number;
  measureMs: number;
  totalMs: number;
  output: OutputMeshInfo | null;
  thickness: ThicknessStats | null;
  samples: ShellSample[];
  sampleMarkers: ShellSample[];
  checks: CheckItem[];
  changes: ChangeEntry[];
  featureWarning: FeatureWarning | null;
  selfIntersection: SelfIntersectionReport | null;
  verification: VerificationReport | null;
  fieldTopology: FieldTopologyReport | null;
  limitations: string[];
  disclaimer: string;
  generatedAt: string;
}

export interface PresetDocument {
  schema: 'display-shell-params.v1';
  name: string;
  fixtureId: string;
  params: OffsetParams;
  savedAt: string;
}

export interface PipelineHooks {
  onPhase?: (phase: string, detail?: string) => void;
}
