// Height field -> watertight triangle soup -> binary STL.
//
// The outline of the solid is the zero level set of φ (see sdf.js), not the
// set of filled pixels: each cell is clipped against φ = 0 with marching
// squares, so boundary vertices land between grid points and silhouettes come
// out smooth instead of stair-stepped.
//
// Watertightness comes from neighbouring cells agreeing exactly: a crossing on
// a shared cell edge is interpolated from the same two φ values on both sides,
// so the top and bottom faces meet edge to edge and only the cut edges (plus
// the grid border) get side walls.

export const TOP = 0;
export const BOTTOM = 1;
export const WALL = 2;

/** Where φ crosses zero between two samples, clamped off the exact corners. */
function crossing(pa, pb) {
  const t = pa / (pa - pb);
  return Math.min(1 - 1e-4, Math.max(1e-4, t));
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Clip one cell against φ ≥ 0 by walking its boundary: corner, edge crossing,
 * corner, ... Returns the inside polygons (two of them for a saddle whose
 * centre is outside).
 */
function clipCell(phi, hs, x0, x1, y0, y1) {
  const inside = [phi[0] > 0, phi[1] > 0, phi[2] > 0, phi[3] > 0];
  const count = inside.reduce((a, b) => a + (b ? 1 : 0), 0);
  if (count === 0) return [];

  // Corners in walk order: (x0,y0) (x1,y0) (x1,y1) (x0,y1)
  const cx = [x0, x1, x1, x0];
  const cy = [y0, y0, y1, y1];
  const corner = (k) => ({ x: cx[k], y: cy[k], z: hs[k] });

  const poly = [];
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    if (inside[k]) poly.push(corner(k));
    if (inside[k] !== inside[k2]) {
      const t = crossing(phi[k], phi[k2]);
      poly.push({
        x: cx[k] + (cx[k2] - cx[k]) * t,
        y: cy[k] + (cy[k2] - cy[k]) * t,
        z: hs[k] + (hs[k2] - hs[k]) * t,
      });
    }
  }

  // Saddles (opposite corners inside) are ambiguous. The bilinear centre says
  // whether the two lobes join; when they do not, split them apart.
  const saddle = count === 2 && inside[0] === inside[2] && inside[1] === inside[3];
  if (saddle) {
    const centre = (phi[0] + phi[1] + phi[2] + phi[3]) / 4;
    if (centre <= 0) {
      // The walk starts on a corner only when corner 0 is the inside one, which
      // shifts where each lobe begins in the list.
      return inside[0]
        ? [[poly[5], poly[0], poly[1]], [poly[2], poly[3], poly[4]]]
        : [poly.slice(0, 3), poly.slice(3, 6)];
    }
  }
  return [poly];
}

/**
 * Walks the surface once, handing every triangle to `emit`. Shared by the STL
 * writer and the 3D preview so both always see the same solid.
 *
 * `kind` tells the consumer which part of the solid the triangle belongs to
 * (TOP / BOTTOM / WALL); the preview uses it to shade the top smoothly while
 * keeping the walls crisp.
 * @param {(ax,ay,az,bx,by,bz,cx,cy,cz,kind)=>void} emit
 * @returns {number} triangle count
 */
export function emitTriangles({ height, phi, n, mmPerPx }, emit) {
  const cells = n - 1;
  const px = (x) => (x - n / 2) * mmPerPx;
  const py = (y) => (n / 2 - y) * mmPerPx;

  const cellPhi = new Float32Array(4);
  const cellH = new Float32Array(4);
  let triangles = 0;

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const i00 = y * n + x;
      const i10 = i00 + 1;
      const i11 = i00 + n + 1;
      const i01 = i00 + n;
      cellPhi[0] = phi[i00]; cellPhi[1] = phi[i10]; cellPhi[2] = phi[i11]; cellPhi[3] = phi[i01];
      if (cellPhi[0] <= 0 && cellPhi[1] <= 0 && cellPhi[2] <= 0 && cellPhi[3] <= 0) continue;
      cellH[0] = height[i00]; cellH[1] = height[i10]; cellH[2] = height[i11]; cellH[3] = height[i01];

      const x0 = px(x), x1 = px(x + 1);
      const y0 = py(y), y1 = py(y + 1);
      const polys = clipCell(cellPhi, cellH, x0, x1, y0, y1);

      for (const poly of polys) {
        if (poly.length < 3) continue;
        // Keep every top face counter-clockwise seen from +Z so the walls and
        // the bottom can simply mirror it.
        if (signedArea(poly) < 0) poly.reverse();

        for (let k = 1; k < poly.length - 1; k++) {
          const a = poly[0], b = poly[k], c = poly[k + 1];
          emit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, TOP);
          emit(a.x, a.y, 0, c.x, c.y, 0, b.x, b.y, 0, BOTTOM);
          triangles += 2;
        }

        for (let k = 0; k < poly.length; k++) {
          const a = poly[k];
          const b = poly[(k + 1) % poly.length];
          // An edge running along a cell side is shared with the neighbouring
          // cell (which emits the matching face), so it needs no wall -- unless
          // that side is the edge of the grid.
          const onX0 = a.x === x0 && b.x === x0;
          const onX1 = a.x === x1 && b.x === x1;
          const onY0 = a.y === y0 && b.y === y0;
          const onY1 = a.y === y1 && b.y === y1;
          const shared = (onX0 && x > 0) || (onX1 && x < cells - 1)
                      || (onY0 && y > 0) || (onY1 && y < cells - 1);
          if (shared) continue;
          emit(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, b.z, WALL);
          emit(a.x, a.y, 0, b.x, b.y, b.z, a.x, a.y, a.z, WALL);
          triangles += 2;
        }
      }
    }
  }
  return triangles;
}

/** Height field -> binary STL. */
export function buildMesh(field) {
  let triCount = 0;
  emitTriangles(field, () => { triCount++; });
  if (!triCount) throw new Error('形が空です。文字やファイルを指定してください。');

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode('pukkuri-maker binary STL');
  new Uint8Array(buffer, 0, 80).set(header.subarray(0, 80));
  view.setUint32(80, triCount, true);

  let offset = 84;
  emitTriangles(field, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(offset, nx / len, true);
    view.setFloat32(offset + 4, ny / len, true);
    view.setFloat32(offset + 8, nz / len, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  });
  return { buffer, triangles: triCount };
}
