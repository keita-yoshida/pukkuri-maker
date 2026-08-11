// Signed distance fields, in pixels, positive inside.
//
// The rasterizer hands us antialiased coverage, and along the outline of a
// shape the coverage of a pixel is very nearly how far that pixel's centre sits
// from the true edge. Keeping that fraction (instead of thresholding it away)
// is what lets the mesher put its boundary vertices between grid points, so
// silhouettes stop being staircases.
//
// Away from the edge, coverage is a flat 0 or 1 and carries no information, so
// the field is filled in with an exact Euclidean distance transform instead.

const FAR = 1e9;

/**
 * φ from antialiased coverage, accurate to a small fraction of a pixel.
 *
 * Partially covered pixels are placed first: coverage 0.5 means the edge runs
 * through the pixel centre, so the edge sits (coverage − 0.5) away along the
 * coverage gradient. Those sub-pixel points are then propagated across the grid
 * with a Danielsson vector sweep — carrying the nearest boundary *point* rather
 * than a distance is what keeps the offsets (bold, meniscus, outline) from
 * snapping back onto pixel corners.
 *
 * @param {Float32Array} coverage 0..1 per pixel
 * @returns {Float32Array} φ in pixels, positive inside
 */
export function signedFromCoverage(coverage, n) {
  const vx = new Float32Array(n * n).fill(FAR);
  const vy = new Float32Array(n * n).fill(FAR);
  const at = (x, y) => coverage[y * n + x];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const c = coverage[i];
      if (c > 0 && c < 1) {
        // Partly covered: the edge is (c − 0.5) away along the coverage slope.
        const l = x > 0 ? at(x - 1, y) : c;
        const r = x < n - 1 ? at(x + 1, y) : c;
        const u = y > 0 ? at(x, y - 1) : c;
        const d = y < n - 1 ? at(x, y + 1) : c;
        let gx = (r - l) / 2;
        let gy = (d - u) / 2;
        const len = Math.hypot(gx, gy);
        if (len < 1e-6) { gx = 0; gy = 0; } else { gx /= len; gy /= len; }
        const sgn = c - 0.5;
        vx[i] = -sgn * gx;
        vy[i] = -sgn * gy;
        continue;
      }
      // Fully covered or fully empty. Only a hard edge — a 0 pixel touching a 1
      // pixel with no antialiased pixel between them — seeds anything here, and
      // then the edge is exactly halfway between the two centres. Seeding these
      // from the coverage slope instead would misplace them by up to a pixel.
      let bestSq = Infinity;
      const consider = (nx, ny, dx, dy) => {
        const cn = coverage[ny * n + nx];
        if (cn !== 0 && cn !== 1) return;
        if ((c - 0.5) * (cn - 0.5) > 0) return;
        if (0.25 < bestSq) { bestSq = 0.25; vx[i] = dx * 0.5; vy[i] = dy * 0.5; }
      };
      if (x > 0) consider(x - 1, y, -1, 0);
      if (x < n - 1) consider(x + 1, y, 1, 0);
      if (y > 0) consider(x, y - 1, 0, -1);
      if (y < n - 1) consider(x, y + 1, 0, 1);
    }
  }

  // Four sweeps propagate each pixel's nearest boundary point to its neighbours.
  const relax = (i, j, dx, dy) => {
    if (vx[j] >= FAR) return;
    const cx = vx[j] + dx;
    const cy = vy[j] + dy;
    if (cx * cx + cy * cy < vx[i] * vx[i] + vy[i] * vy[i]) { vx[i] = cx; vy[i] = cy; }
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (y > 0) relax(i, i - n, 0, -1);
      if (x > 0) relax(i, i - 1, -1, 0);
      if (y > 0 && x > 0) relax(i, i - n - 1, -1, -1);
      if (y > 0 && x < n - 1) relax(i, i - n + 1, 1, -1);
    }
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      if (x < n - 1) relax(i, i + 1, 1, 0);
    }
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      if (y < n - 1) relax(i, i + n, 0, 1);
      if (x < n - 1) relax(i, i + 1, 1, 0);
      if (y < n - 1 && x < n - 1) relax(i, i + n + 1, 1, 1);
      if (y < n - 1 && x > 0) relax(i, i + n - 1, -1, 1);
    }
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (x > 0) relax(i, i - 1, -1, 0);
    }
  }

  const phi = new Float32Array(n * n);
  for (let i = 0; i < phi.length; i++) {
    const sign = coverage[i] > 0.5 ? 1 : -1;
    phi[i] = vx[i] >= FAR ? sign * n : sign * Math.hypot(vx[i], vy[i]);
  }
  return phi;
}

/** Grow (r > 0) or shrink (r < 0) a shape by r pixels. */
export function offset(phi, r) {
  if (!r) return phi;
  const out = new Float32Array(phi.length);
  for (let i = 0; i < out.length; i++) out[i] = phi[i] + r;
  return out;
}

/** Union of two shapes. */
export function union(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
  return out;
}

export function maskFrom(phi) {
  const mask = new Uint8Array(phi.length);
  for (let i = 0; i < mask.length; i++) mask[i] = phi[i] > 0 ? 1 : 0;
  return mask;
}

const EMPTY = -1e6;

/** Analytic plate outline, so the base never inherits any grid stair-stepping. */
export function plateSDF(n, shape) {
  const phi = new Float32Array(n * n);
  if (shape === 'none') {
    phi.fill(EMPTY);
    return phi;
  }
  const r = n / 2 - 1;
  const corner = n * 0.14;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = Math.abs(x - n / 2 + 0.5);
      const dy = Math.abs(y - n / 2 + 0.5);
      let d;
      if (shape === 'circle') {
        d = r - Math.hypot(dx, dy);
      } else {
        // Rounded rectangle: distance to the box, pulled in by the fillet.
        const ox = dx - (r - corner);
        const oy = dy - (r - corner);
        const outsideDist = Math.hypot(Math.max(ox, 0), Math.max(oy, 0));
        const insideDist = Math.min(Math.max(ox, oy), 0);
        d = corner - (outsideDist + insideDist);
      }
      phi[y * n + x] = d;
    }
  }
  return phi;
}
