// Height field -> watertight triangle soup -> binary STL.
//
// Occupancy is per cell (a cell is solid only when all four of its corners
// are), which keeps the top surface, the flat bottom and the side walls
// sharing the same boundary edges, so the result is manifold.

export const TOP = 0;
export const BOTTOM = 1;
export const WALL = 2;

function cellSolid(solid, n, x, y) {
  return (
    solid[y * n + x] &&
    solid[y * n + x + 1] &&
    solid[(y + 1) * n + x] &&
    solid[(y + 1) * n + x + 1]
  );
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
export function emitTriangles({ height, solid, n, mmPerPx }, emit) {
  const cells = n - 1;
  const occ = new Uint8Array(cells * cells);
  let solidCells = 0;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const v = cellSolid(solid, n, x, y) ? 1 : 0;
      occ[y * cells + x] = v;
      solidCells += v;
    }
  }
  if (!solidCells) throw new Error('形が空です。文字やファイルを指定してください。');

  let walls = 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= cells || y >= cells ? 0 : occ[y * cells + x]);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (!occ[y * cells + x]) continue;
      if (!at(x - 1, y)) walls++;
      if (!at(x + 1, y)) walls++;
      if (!at(x, y - 1)) walls++;
      if (!at(x, y + 1)) walls++;
    }
  }


  const px = (x) => (x - n / 2) * mmPerPx;
  const py = (y) => (n / 2 - y) * mmPerPx;
  const z = (x, y) => height[y * n + x];

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (!occ[y * cells + x]) continue;
      const x0 = px(x), x1 = px(x + 1);
      const y0 = py(y), y1 = py(y + 1);
      const z00 = z(x, y), z10 = z(x + 1, y), z01 = z(x, y + 1), z11 = z(x + 1, y + 1);

      // Top (counter-clockwise seen from +Z)
      emit(x0, y0, z00, x0, y1, z01, x1, y1, z11, TOP);
      emit(x0, y0, z00, x1, y1, z11, x1, y0, z10, TOP);
      // Bottom (reversed winding, flat at z = 0)
      emit(x0, y0, 0, x1, y1, 0, x0, y1, 0, BOTTOM);
      emit(x0, y0, 0, x1, y0, 0, x1, y1, 0, BOTTOM);

      if (!at(x - 1, y)) {
        emit(x0, y0, 0, x0, y1, 0, x0, y1, z01, WALL);
        emit(x0, y0, 0, x0, y1, z01, x0, y0, z00, WALL);
      }
      if (!at(x + 1, y)) {
        emit(x1, y0, 0, x1, y0, z10, x1, y1, z11, WALL);
        emit(x1, y0, 0, x1, y1, z11, x1, y1, 0, WALL);
      }
      if (!at(x, y - 1)) {
        emit(x0, y0, 0, x0, y0, z00, x1, y0, z10, WALL);
        emit(x0, y0, 0, x1, y0, z10, x1, y0, 0, WALL);
      }
      if (!at(x, y + 1)) {
        emit(x0, y1, 0, x1, y1, 0, x1, y1, z11, WALL);
        emit(x0, y1, 0, x1, y1, z11, x0, y1, z01, WALL);
      }
    }
  }
  return solidCells * 4 + walls * 2;
}

/** Height field -> binary STL. */
export function buildMesh(field) {
  let triCount = 0;
  const count = () => { triCount++; };
  emitTriangles(field, count);

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
