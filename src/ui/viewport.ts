import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { OffsetMode, ShellResult } from '../core/types';
import { meshToGeometry } from '../export/meshExport';

export interface ViewportOptions {
  original: { mesh: { positions: Float32Array; indices: Uint32Array; vertexCount: number; triangleCount: number } | null };
}

const CLASS_COLORS = [0x63b3ed, 0xf6ad55, 0x68d391];
const SAMPLE_COLORS = [0x38a169, 0xe53e3e, 0xdd6b20, 0x805ad5];

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private originalGroup = new THREE.Group();
  private outputGroup = new THREE.Group();
  private sampleGroup = new THREE.Group();
  private rimGroup = new THREE.Group();
  private frame = 0;
  private needsRender = true;
  private container: HTMLElement;
  private originalMaterial = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.1,
    roughness: 0.75,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
  });
  private lastBounds: THREE.Box3 | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (err) {
      container.innerHTML = `<div class="gl-error">此浏览器无法创建 WebGL 上下文，3D 视图不可用。生成、保存参数与导出网格仍然可用。<br/><span class="subtle">${String(err)}</span></div>`;
      throw err;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x0d1117);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, container.clientWidth / Math.max(1, container.clientHeight), 0.05, 20000);
    this.camera.position.set(60, 45, 70);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;

    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1b2430, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(1, 1.6, 1.2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb3ff, 0.5);
    fill.position.set(-1, -0.8, -1.1);
    this.scene.add(fill);
    this.scene.add(new THREE.GridHelper(120, 24, 0x2b3648, 0x1a2230));
    this.scene.add(this.originalGroup, this.outputGroup, this.sampleGroup, this.rimGroup);

    this.controls.addEventListener('change', () => { this.needsRender = true; });
    window.addEventListener('resize', () => this.resize());
    this.renderLoop();
  }

  private renderLoop = () => {
    this.frame = requestAnimationFrame(this.renderLoop);
    this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  setOriginal(mesh: { positions: Float32Array; indices: Uint32Array; vertexCount: number; triangleCount: number } | null) {
    disposeGroup(this.originalGroup);
    if (!mesh) {
      this.needsRender = true;
      return;
    }
    (this.originalMaterial as THREE.Material).depthWrite = false;
    const object = new THREE.Mesh(meshToGeometry(mesh), this.originalMaterial);
    object.name = 'original';
    this.originalGroup.add(object);
    this.originalGroup.visible = this.showOriginal;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(meshToGeometry(mesh), 24),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.35 }),
    );
    this.originalGroup.add(edges);
    this.fitTo(this.originalGroup);
    this.needsRender = true;
  }

  private showOriginal = true;
  private showOutput = true;

  setShowOriginal(visible: boolean) {
    this.showOriginal = visible;
    this.originalGroup.visible = visible;
    this.needsRender = true;
  }

  setShowOutput(visible: boolean) {
    this.showOutput = visible;
    this.outputGroup.visible = visible;
    this.sampleGroup.visible = visible && this.showSamples;
    this.rimGroup.visible = visible && this.showSamples;
    this.needsRender = true;
  }

  private showSamples = true;
  setShowSamples(visible: boolean) {
    this.showSamples = visible;
    this.sampleGroup.visible = visible;
    this.rimGroup.visible = visible;
    this.needsRender = true;
  }

  setOutput(result: ShellResult | null) {
    disposeGroup(this.outputGroup);
    disposeGroup(this.sampleGroup);
    disposeGroup(this.rimGroup);
    if (!result || !result.output || result.output.mesh.triangleCount === 0) {
      this.needsRender = true;
      return;
    }
    const info = result.output;
    const geo = meshToGeometry(info.mesh);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.62, side: THREE.DoubleSide }),
    );
    mesh.name = 'offset-shell';
    applyClassColors(geo, info.triangleClass);
    this.outputGroup.add(mesh);

    // Thickness probes: a short line from the shell surface to the opposite
    // surface plus a small marker, coloured by measured status. Thousands of
    // lines would bury the shell, so failures are drawn first and the total is
    // capped; the result panel carries the full statistical record.
    const drawn = [...result.samples.filter((s) => s.status !== 0).slice(0, 240), ...result.samples.filter((s) => s.status === 0).slice(0, 260)];
    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const color = new THREE.Color();
    for (const s of drawn) {
      color.setHex(SAMPLE_COLORS[s.status] ?? 0xffffff);
      linePositions.push(s.x, s.y, s.z, s.hx, s.hy, s.hz);
      lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    if (linePositions.length > 0) {
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
      this.sampleGroup.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })));
    }
    const markers = result.sampleMarkers.length > 0 ? result.sampleMarkers : drawn;
    if (markers.length > 0) {
      const points = markers.map((s) => new THREE.Vector3(s.x, s.y, s.z));
      const pointGeo = new THREE.BufferGeometry().setFromPoints(points);
      const colors = new Float32Array(points.length * 3);
      markers.forEach((s, i) => {
        color.setHex(SAMPLE_COLORS[s.status] ?? 0xffffff);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      });
      pointGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      this.sampleGroup.add(new THREE.Points(
        pointGeo,
        new THREE.PointsMaterial({ size: Math.max(0.3, this.domainSize(result) * 0.004), vertexColors: true, sizeAttenuation: true }),
      ));
    }
    this.outputGroup.visible = this.showOutput;
    this.sampleGroup.visible = this.showOutput && this.showSamples;

    // Failure markers: self-intersections, swallowed features, enclosed air.
    const failurePoints: Array<[number, number, number]> = [];
    for (const p of result.selfIntersection?.points ?? []) failurePoints.push(p);
    for (const p of result.featureWarning?.points ?? []) failurePoints.push(p);
    for (const p of result.fieldTopology?.enclosedAirLocations ?? []) failurePoints.push(p);
    if (failurePoints.length > 0) {
      const geoFail = new THREE.BufferGeometry().setFromPoints(failurePoints.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
      this.rimGroup.add(new THREE.Points(
        geoFail,
        new THREE.PointsMaterial({ color: 0xf56565, size: Math.max(0.45, this.domainSize(result) * 0.008), sizeAttenuation: true }),
      ));
    }
    const rimPoints: number[] = [];
    for (const sample of drawn) {
      if (sample.status === 4) rimPoints.push(sample.x, sample.y, sample.z);
    }
    if (rimPoints.length > 0) {
      const geoRim = new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: rimPoints.length / 3 }, (_, i) => new THREE.Vector3(rimPoints[i * 3], rimPoints[i * 3 + 1], rimPoints[i * 3 + 2])),
      );
      this.rimGroup.add(new THREE.Points(geoRim, new THREE.PointsMaterial({ color: 0x805ad5, size: Math.max(0.3, this.domainSize(result) * 0.005), sizeAttenuation: true })));
    }
    this.rimGroup.visible = this.showOutput && this.showSamples;
    // Fit only when the output bounds are not already comfortably in view, so
    // tweaking thickness does not jerk the camera on every run.
    const bounds = new THREE.Box3().setFromObject(this.outputGroup);
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-3);
    if (!this.lastBounds || !this.lastBounds.clone().expandByScalar(radius * 0.15).containsBox(bounds)) {
      this.fitTo(this.outputGroup);
      this.lastBounds = bounds;
    }
    this.needsRender = true;
  }

  private domainSize(result: ShellResult): number {
    return Math.max(...result.input.bboxSize, 1);
  }

  fitTo(group: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-3);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.75, 0.55, 0.95).normalize().multiplyScalar(distance * 1.25));
    this.camera.near = Math.max(0.01, radius * 0.01);
    this.camera.far = Math.max(100, radius * 40);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.needsRender = true;
  }

  fitAll() {
    const group = new THREE.Group();
    group.add(this.originalGroup, this.outputGroup);
    this.fitTo(group);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    disposeGroup(this.originalGroup);
    disposeGroup(this.outputGroup);
    disposeGroup(this.sampleGroup);
    disposeGroup(this.rimGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function applyClassColors(geo: THREE.BufferGeometry, triangleClass: Uint8Array) {
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const index = geo.getIndex()!;
  const c = new THREE.Color();
  for (let t = 0; t < triangleClass.length; t++) {
    c.setHex(CLASS_COLORS[triangleClass[t]] ?? 0xffffff);
    for (let k = 0; k < 3; k++) {
      const v = index.getX(t * 3 + k);
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function disposeGroup(group: THREE.Object3D) {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as THREE.Mesh).material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) (material as THREE.Material).dispose();
  });
  group.clear();
}

/** No-op stand-in used when the browser cannot create a WebGL context. */
export class NullViewport {
  setOriginal(_mesh: unknown) {}
  setOutput(_result: unknown) {}
  setShowOriginal(_visible: boolean) {}
  setShowOutput(_visible: boolean) {}
  setShowSamples(_visible: boolean) {}
  fitAll() {}
  dispose() {}
}

export const MODE_LABELS: Record<OffsetMode, string> = {
  inward: '向内',
  outward: '向外',
  symmetric: '对称',
};
