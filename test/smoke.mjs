// Node smoke test for the DOM-free parts: distance transform, height field,
// mesh topology and STL layout. Run with: node test/smoke.mjs
import assert from 'node:assert/strict';
import { insideDistance, dilate } from '../src/edt.js';
import { buildHeightField } from '../src/puff.js';
import { solveCapillary } from '../src/capillary.js';
import { buildMesh } from '../src/mesh.js';
import { parseDXF, pathsBounds } from '../src/dxf.js';
import { signedFromCoverage } from '../src/sdf.js';
import { emitTriangles, WALL } from '../src/mesh.js';

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
  const phiM = signedFromCoverage(m, n);
  const h = solveCapillary(phiM, n, { mmPerPx, capillary: 2.5, peak: 4 });
  const thin = h[64 * n + 23];
  const fat = h[64 * n + 80];
  assert.ok(Math.abs(fat - 4) < 0.25, `peak lands on the requested height, got ${fat.toFixed(2)}`);
  assert.ok(thin < fat * 0.6, `thin stroke stays lower than the fat one (${thin.toFixed(2)} vs ${fat.toFixed(2)})`);
  assert.ok(thin > 0, 'thin stroke still rises');
  assert.equal(h[64 * n + 10], 0, 'nothing outside the mask');
  assert.ok(h.every((v) => v >= 0 && v <= 4.01), 'height stays within bounds');

  // Small capillary length = runny: the fat stroke flattens into a plateau, so
  // its centre and a point well inside its edge end up at nearly one height.
  const runny = solveCapillary(phiM, n, { mmPerPx, capillary: 0.8, peak: 4 });
  const springy = solveCapillary(phiM, n, { mmPerPx, capillary: 12, peak: 4 });
  const flatness = (f) => f[64 * n + 68] / f[64 * n + 80];
  assert.ok(flatness(runny) > flatness(springy),
    `low capillary length flattens wide areas (${flatness(runny).toFixed(2)} vs ${flatness(springy).toFixed(2)})`);
}

// --- no pixel-scale ripple -------------------------------------------------
// Red-black sweeps trade the odd/even lattices' difference away at ~0.998 per
// sweep for this operator, so anything checkerboard-shaped that enters (a
// block-copied pyramid upsample, say) survives to the print as a fine ripple.
{
  const disc = new Uint8Array(n * n);
  const C = n / 2 - 0.5;
  const R = n * 0.3;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) disc[y * n + x] = Math.hypot(x - C, y - C) <= R ? 1 : 0;
  }
  const h = solveCapillary(signedFromCoverage(disc, n), n, { mmPerPx: 90 / n, capillary: 2.5, peak: 4 });
  let worst = 0;
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      if (Math.hypot(x - C, y - C) > R - 6) continue;
      const i = y * n + x;
      worst = Math.max(worst, Math.abs(h[i] - (h[i - 1] + h[i + 1] + h[i - n] + h[i + n]) / 4));
    }
  }
  assert.ok(worst < 0.02, `no pixel-scale ripple, worst ${worst.toFixed(4)} mm`);
}

// --- the contact line is not pixelated -------------------------------------
// On a disc the solved surface must be the same all the way round at a given
// distance from the contact line. It is not, if the solver's domain is a
// thresholded mask: every point's stencil is then cut differently and points
// equally deep come out up to 0.5mm apart. That ridge hides under the
// silhouette until an outline band puts it in the middle of a surface, which
// is exactly when it becomes the most visible artefact on the print.
{
  const big = 384;
  const C = big / 2 - 0.5;
  const R = big * 0.28;
  const cov = new Float32Array(big * big);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (Math.hypot(x - C + (sx + 0.5) / 4 - 0.5, y - C + (sy + 0.5) / 4 - 0.5) <= R) hits++;
        }
      }
      cov[y * big + x] = hits / 16;
    }
  }
  const phi = signedFromCoverage(cov, big);
  const solved = solveCapillary(phi, big, { mmPerPx: 90 / big, capillary: 2.5, peak: 4 });

  const bilinear = (fx, fy) => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const g = (x, y) => solved[y * big + x];
    return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty)
         + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
  };
  for (const [depth, limit] of [[2, 0.12], [4, 0.05]]) {
    const rr = R - depth;
    const steps = Math.round(2 * Math.PI * rr);
    const vals = [];
    for (let a = 0; a < steps; a++) {
      const th = (a / steps) * 2 * Math.PI;
      vals.push(bilinear(C + rr * Math.cos(th), C + rr * Math.sin(th)));
    }
    const range = Math.max(...vals) - Math.min(...vals);
    let step = 0;
    for (let i = 0; i < vals.length; i++) step = Math.max(step, Math.abs(vals[i] - vals[(i + 1) % vals.length]));
    assert.ok(range < limit, `${depth}px in, the ridge is even (range ${range.toFixed(3)} mm)`);
    assert.ok(step < 0.02, `${depth}px in, no pixel-scale steps (${step.toFixed(4)} mm)`);
  }

  // Layers joined with a plain max(), or a liquid foot left at its full contact
  // angle, leave a crease. A crease running diagonally across the grid has no
  // vertices on it, so it is rendered as a zigzag -- the stepped line that
  // shows up around every stroke once an outline band is on.
  const creaseField = buildHeightField(cov, big, {
    mode: 'surface', sizeMM: 90, letterHeight: 4, letterRadius: 4, capillary: 2.5,
    meniscus: 0.3, floorBoost: 0.35, minThickness: 0.8, outlineWidth: 2.5,
    outlineHeight: 1.5, baseShape: 'none', baseThickness: 1.6, quilt: 0, quiltPitch: 11,
  });
  const mmPerPx = 90 / big;
  const row = Math.round(C);
  const profile = [];
  for (let x = row; x < big; x++) {
    if (creaseField.phi[row * big + x] <= 0) break;
    profile.push(creaseField.height[row * big + x]);
  }
  let kink = 0;
  for (let i = 1; i < profile.length - 1; i++) {
    const before = Math.atan2(profile[i] - profile[i - 1], mmPerPx);
    const after = Math.atan2(profile[i + 1] - profile[i], mmPerPx);
    kink = Math.max(kink, Math.abs(after - before) * 180 / Math.PI);
  }
  assert.ok(kink < 30, `no hard crease inside the surface (worst ${kink.toFixed(1)} deg)`);
  assert.ok(Math.max(...profile) > 5, `the puff keeps its height (${Math.max(...profile).toFixed(2)} mm)`);
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

// --- the rim sits at one height -------------------------------------------
// Every surface meets the outline at the minimum thickness, so a disc's rim
// must come out dead level. Interpolating it from grid samples instead varies
// with wherever the crossing lands on the shoulder, which reads as ragged.
{
  const rimField = buildHeightField(square, n, { ...opts, baseShape: 'none', outlineWidth: 0 });
  let lo = Infinity;
  let hi = -Infinity;
  emitTriangles(rimField, (ax, ay, az, bx, by, bz, cx, cy, cz, kind) => {
    if (kind !== WALL) return;
    for (const z of [az, bz, cz]) if (z > 0) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  });
  assert.equal(lo, hi, `rim is level (${lo} .. ${hi})`);
  assert.equal(lo, rimField.edgeHeight, 'rim sits at the minimum thickness');
}

// --- sub-pixel outline ----------------------------------------------------
// A disc rasterized with antialiasing: the mesher must place its wall vertices
// on the true circle, not on pixel corners. Thresholded occupancy would leave
// errors of half a pixel; marching squares over the coverage-derived field
// should be an order of magnitude better.
{
  const R = 20.3;
  const coverage = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Box-filter the disc over the pixel, the way a rasterizer would.
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          // Samples must straddle the pixel centre, which sits at x - n/2 + 0.5.
          const px = x - n / 2 + (sx + 0.5) / 4;
          const py = y - n / 2 + (sy + 0.5) / 4;
          if (Math.hypot(px, py) <= R) hits++;
        }
      }
      coverage[y * n + x] = hits / 16;
    }
  }
  const phi = signedFromCoverage(coverage, n);
  const height = new Float32Array(n * n).fill(2);
  const mmPerPx = 1;

  let worst = 0;
  emitTriangles({ height, phi, n, mmPerPx }, (ax, ay, az, bx, by, bz, cx, cy, cz, kind) => {
    if (kind !== WALL) return;
    for (const [x, y] of [[ax, ay], [bx, by], [cx, cy]]) {
      // World origin sits at the grid centre, half a pixel off the disc centre.
      worst = Math.max(worst, Math.abs(Math.hypot(x + 0.5, y - 0.5) - R));
    }
  });
  // Occupancy-based meshing would sit at ~0.5px (half a cell). The floor here
  // is the linear coverage → distance inversion, which is exact for an
  // axis-aligned edge and off by ~0.15px at worst on a diagonal one.
  assert.ok(worst < 0.12, `outline is sub-pixel accurate, worst error ${worst.toFixed(3)} px`);
}

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
