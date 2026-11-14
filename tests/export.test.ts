import { test, expect } from 'vitest';
import * as THREE from 'three';
import { exportMesh, meshToGeometry } from '../src/export/meshExport';
import { getFixture } from '../src/fixtures';

test('STL export round-trips triangle count', async () => {
  const mesh = getFixture('grooved-block').build();
  const { blob, filename } = await exportMesh(mesh, 'stl', 'grooved');
  expect(filename).toBe('grooved.stl');
  const buf = await blob.arrayBuffer();
  // Binary STL: 84-byte header + 50 bytes per triangle.
  const dv = new DataView(buf);
  expect(dv.getUint32(80, true)).toBe(mesh.triangleCount);
  expect(buf.byteLength).toBe(84 + 50 * mesh.triangleCount);
});

test('OBJ export lists all vertices and faces', async () => {
  const mesh = getFixture('solid-sphere').build();
  const { blob, filename } = await exportMesh(mesh, 'obj', 'sphere');
  expect(filename).toBe('sphere.obj');
  const text = await blob.text();
  const v = text.split('\n').filter((l) => l.startsWith('v ')).length;
  const f = text.split('\n').filter((l) => l.startsWith('f ')).length;
  expect(v).toBe(mesh.vertexCount);
  expect(f).toBe(mesh.triangleCount);
});

// GLTFExporter reads blobs through FileReader; Node has no DOM implementation.
if (!(globalThis as { FileReader?: unknown }).FileReader) {
  class BlobReader {
    onloadend: (() => void) | null = null;
    result: ArrayBuffer | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = BlobReader;
}

test('GLB export produces a parseable glTF binary', async () => {
  const mesh = getFixture('open-sheet').build();
  const { blob, filename } = await exportMesh(mesh, 'glb', 'sheet');
  expect(filename).toBe('sheet.glb');
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(buf.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)) as string);
  expect(json.meshes.length).toBe(1);
  expect(json.meshes[0].primitives.length).toBe(1);
});

test('exported geometry keeps positions unchanged', () => {
  const mesh = getFixture('thin-neck').build();
  const geo = meshToGeometry(mesh);
  const pos = geo.getAttribute('position').array as Float32Array;
  expect(pos.length).toBe(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 97) expect(pos[i]).toBe(mesh.positions[i]);
  const idx = geo.getIndex()!.array as Uint32Array;
  expect(idx.length).toBe(mesh.indices.length);
});
