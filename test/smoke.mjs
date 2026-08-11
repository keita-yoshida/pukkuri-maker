// Node smoke test for the DOM-free parts: distance transform, height field,
// mesh topology and STL layout. Run with: node test/smoke.mjs
import assert from 'node:assert/strict';
import { insideDistance, dilate } from '../src/edt.js';
import { buildHeightField } from '../src/puff.js';
import { solveCapillary } from '../src/capillary.js';
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

// --- capillary solver -----------------------------------------------------
// Two strokes on one canvas: a thin one and a fat one. A liquid pinned at the
// outline must dome the fat stroke higher than the thin one; the classic arc
// profile cannot tell them apart, which is the whole reason this solver exists.
{
  const m = new Uint8Array(n * n);
  for (let y = 20; y < 108; y++) {
    for (let x = 20; x < 26; x++) m[y * n + x] = 1;      // thin, 6px
    for (let x = 60; x < 100; x++) m[y * n + x] = 1;     // fat, 40px
  }
  const mmPerPx = 90 / n;
  const h = solveCapillary(m, n, { mmPerPx, capillary: 2.5, peak: 4 });
  const thin = h[64 * n + 23];
  const fat = h[64 * n + 80];
  assert.ok(Math.abs(fat - 4) < 0.25, `peak lands on the requested height, got ${fat.toFixed(2)}`);
  assert.ok(thin < fat * 0.6, `thin stroke stays lower than the fat one (${thin.toFixed(2)} vs ${fat.toFixed(2)})`);
  assert.ok(thin > 0, 'thin stroke still rises');
  assert.equal(h[64 * n + 10], 0, 'nothing outside the mask');
  assert.ok(h.every((v) => v >= 0 && v <= 4.01), 'height stays within bounds');

  // Small capillary length = runny: the fat stroke flattens into a plateau, so
  // its centre and a point well inside its edge end up at nearly one height.
  const runny = solveCapillary(m, n, { mmPerPx, capillary: 0.8, peak: 4 });
  const springy = solveCapillary(m, n, { mmPerPx, capillary: 12, peak: 4 });
  const flatness = (f) => f[64 * n + 68] / f[64 * n + 80];
  assert.ok(flatness(runny) > flatness(springy),
    `low capillary length flattens wide areas (${flatness(runny).toFixed(2)} vs ${flatness(springy).toFixed(2)})`);
}

// --- height field ---------------------------------------------------------
const opts = {
  mode: 'surface', sizeMM: 90, letterHeight: 4, letterRadius: 4,
  capillary: 2.5, meniscus: 0.3, floorBoost: 0.35, minThickness: 0.8,
  outlineWidth: 2.5, outlineHeight: 2, baseShape: 'circle', baseThickness: 1.6,
  quilt: 0.35, quiltPitch: 11,
};
const field = buildHeightField(square, n, opts);
const maxH = field.height.reduce((a, b) => Math.max(a, b), 0);
assert.ok(maxH > 4 && maxH < 12, `plausible max height, got ${maxH}`);
assert.ok(field.height.every((h) => h >= 0), 'no negative heights');
assert.ok(field.height[64 * n + 64] > field.height[64 * n + 34], 'letters dome upward');
assert.ok(field.height.every((h, i) => !field.solid[i] || h >= 0.8 - 1e-6), 'solid pixels keep the minimum thickness');
assert.equal(field.solid[0], 0, 'grid corner is outside the round plate');

// --- mesh topology --------------------------------------------------------
// Every directed edge must appear exactly once for a closed, consistently
// wound surface.
function countBadEdges(buffer, triangles) {
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
  return bad;
}

const { buffer, triangles } = buildMesh(field);
assert.equal(buffer.byteLength, 84 + triangles * 50, 'binary STL size matches header');
assert.equal(new DataView(buffer).getUint32(80, true), triangles, 'header triangle count');
assert.equal(countBadEdges(buffer, triangles), 0, 'mesh is closed and consistently wound');

// The default setup — letters only, no plate, no outline — is several separate
// shells, so check it stays closed too.
const bare = buildHeightField(square, n, { ...opts, baseShape: 'none', outlineWidth: 0 });
assert.equal(bare.solid[0], 0, 'nothing outside the letters');
const bareMesh = buildMesh(bare);
assert.equal(countBadEdges(bareMesh.buffer, bareMesh.triangles), 0, 'letters-only mesh is closed');

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
