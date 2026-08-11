// Node smoke test for the DOM-free parts: distance transform, height field,
// mesh topology and STL layout. Run with: node test/smoke.mjs
import assert from 'node:assert/strict';
import { insideDistance, dilate } from '../src/edt.js';
import { buildHeightField } from '../src/puff.js';
import { buildMesh } from '../src/mesh.js';
import { parseDXF, pathsBounds } from '../src/dxf.js';

const n = 128;

// --- distance transform ---------------------------------------------------
const square = new Uint8Array(n * n);
for (let y = 32; y < 96; y++) for (let x = 32; x < 96; x++) square[y * n + x] = 1;
const d = insideDistance(square, n, n);
assert.equal(d[10 * n + 10], 0, 'outside pixels have zero inside-distance');
assert.equal(d[64 * n + 64], 32, 'centre of a 64px square is 32px from the edge');
assert.equal(d[32 * n + 64], 1, 'edge pixels sit one step in');

const grown = dilate(square, n, n, 4);
assert.equal(grown[28 * n + 64], 1, 'dilation reaches 4px out');
assert.equal(grown[26 * n + 64], 0, 'dilation stops past its radius');

// --- height field ---------------------------------------------------------
const opts = {
  sizeMM: 90, letterHeight: 4, letterRadius: 4, outlineWidth: 2.5,
  outlineHeight: 2, baseShape: 'circle', baseThickness: 1.6,
  quilt: 0.35, quiltPitch: 11,
};
const field = buildHeightField(square, n, opts);
const maxH = field.height.reduce((a, b) => Math.max(a, b), 0);
assert.ok(maxH > 4 && maxH < 12, `plausible max height, got ${maxH}`);
assert.ok(field.height.every((h) => h >= 0), 'no negative heights');
assert.ok(field.height[64 * n + 64] > field.height[64 * n + 34], 'letters dome upward');
assert.equal(field.solid[0], 0, 'grid corner is outside the round plate');

// --- mesh topology --------------------------------------------------------
const { buffer, triangles } = buildMesh(field);
assert.equal(buffer.byteLength, 84 + triangles * 50, 'binary STL size matches header');
assert.equal(new DataView(buffer).getUint32(80, true), triangles, 'header triangle count');

// Every directed edge must appear exactly once for a closed, consistently
// wound surface.
const view = new DataView(buffer);
const edges = new Map();
const key = (a, b) => `${a}|${b}`;
const vid = (o) => [0, 4, 8].map((k) => view.getFloat32(o + k, true).toFixed(4)).join(',');
for (let t = 0; t < triangles; t++) {
  const o = 84 + t * 50 + 12;
  const v = [vid(o), vid(o + 12), vid(o + 24)];
  for (let k = 0; k < 3; k++) {
    const e = key(v[k], v[(k + 1) % 3]);
    edges.set(e, (edges.get(e) || 0) + 1);
  }
}
let bad = 0;
for (const [e, count] of edges) {
  const [a, b] = e.split('|');
  if (count !== 1 || (edges.get(key(b, a)) || 0) !== 1) bad++;
}
assert.equal(bad, 0, `mesh is closed and consistently wound (${bad} bad edges)`);

// --- DXF ------------------------------------------------------------------
const dxf = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '10', '0', '20', '0', '11', '10', '21', '0',
  '0', 'CIRCLE', '10', '5', '20', '5', '40', '3',
  '0', 'LWPOLYLINE', '70', '1',
  '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');
const paths = parseDXF(dxf);
assert.equal(paths.length, 3, 'three entities parsed');
assert.equal(paths[2].closed, true, 'closed polyline flagged');
const bounds = pathsBounds(paths);
assert.equal(bounds.minX, 0);
assert.equal(bounds.maxX, 10);

console.log(`ok — ${triangles.toLocaleString()} triangles, ${(buffer.byteLength / 1e6).toFixed(1)} MB STL`);
