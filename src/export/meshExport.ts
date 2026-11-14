import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { TriMesh } from '../core/types';

export type ExportFormat = 'stl' | 'obj' | 'glb';

export function meshToGeometry(mesh: TriMesh): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
  geo.computeVertexNormals();
  return geo;
}

export function exportMesh(mesh: TriMesh, format: ExportFormat, name: string): Promise<{ blob: Blob; filename: string }> {
  const geo = meshToGeometry(mesh);
  const object = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  object.name = name;
  if (format === 'stl') {
    const text = new STLExporter().parse(object, { binary: true }) as unknown as DataView | string;
    const blob = typeof text === 'string' ? new Blob([text], { type: 'model/stl' }) : new Blob([text.buffer as ArrayBuffer], { type: 'model/stl' });
    return Promise.resolve({ blob, filename: `${name}.stl` });
  }
  if (format === 'obj') {
    const text = new OBJExporter().parse(object);
    return Promise.resolve({ blob: new Blob([text], { type: 'model/obj' }), filename: `${name}.obj` });
  }
  const exporter = new GLTFExporter();
  return exporter
    .parseAsync(object, { binary: true, onlyVisible: false })
    .then((result) => {
      const buffer = result as ArrayBuffer;
      return { blob: new Blob([buffer], { type: 'model/gltf-binary' }), filename: `${name}.glb` };
    });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
