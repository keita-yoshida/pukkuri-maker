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

/**
 * Invert a pixel's coverage into the signed distance from its centre to the
 * edge, given the edge's direction.
 *
 * Coverage is the area of the unit pixel cut off by a straight edge, which is
 * piecewise quadratic in that distance and depends on the edge's angle: only
 * for an axis-aligned edge is it the straight `coverage − 0.5`. Taking the
 * linear version costs up to 0.165px, and near a contact line where the surface
 * climbs ~0.6mm per pixel that becomes a 0.2mm ripple along the ridge.
 *
 * @param {number} c coverage in (0,1)
 * @param {number} nx unit normal pointing into the shape
 * @param {number} ny
 */
function distanceFromCoverage(c, nx, ny) {
  let a = Math.abs(nx);
  let b = Math.abs(ny);
  if (a < b) { const t = a; a = b; b = t; }
  if (a < 1e-6) return c - 0.5;
  // Distance measured from the corner the edge reaches first.
  const ab = a * b;
  let u;
  if (c <= b / (2 * a)) u = Math.sqrt(2 * ab * c);
  else if (c <= 1 - b / (2 * a)) u = a * c + b / 2;
  else u = a + b - Math.sqrt(2 * ab * (1 - c));
  return u - (a + b) / 2;
}

const FAR = 1e9;
const BIG = 1e6;

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
  const vx = new Float32Array(n * n);
  const vy = new Float32Array(n * n);
  const at = (x, y) => coverage[y * n + x];

  // Pass 1 takes the edge direction from the coverage gradient. Coverage
  // saturates at 0 and 1 within a pixel of the edge, so that direction is
  // biased; pass 2 re-reads it from ∇φ, which is a clean unit vector, and
  // re-places every seed. Two passes cut the error roughly in half.
  const seed = (normals) => {
    vx.fill(FAR);
    vy.fill(FAR);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const c = coverage[i];
        if (c > 0 && c < 1) {
          let gx;
          let gy;
          if (normals) {
            gx = normals.x[i];
            gy = normals.y[i];
          } else {
            const l = x > 0 ? at(x - 1, y) : c;
            const r = x < n - 1 ? at(x + 1, y) : c;
            const u = y > 0 ? at(x, y - 1) : c;
            const d = y < n - 1 ? at(x, y + 1) : c;
            gx = (r - l) / 2;
            gy = (d - u) / 2;
          }
          const len = Math.hypot(gx, gy);
          if (len < 1e-6) { gx = 0; gy = 0; } else { gx /= len; gy /= len; }
          const s = distanceFromCoverage(c, gx, gy);
          vx[i] = -s * gx;
          vy[i] = -s * gy;
          continue;
        }
        // Fully covered or fully empty. Only a hard edge — a 0 pixel touching a
        // 1 pixel with no antialiased pixel between them — seeds anything here,
        // and then the edge is exactly halfway between the two centres.
        const consider = (nx, ny, dx, dy) => {
          const cn = coverage[ny * n + nx];
          if (cn !== 0 && cn !== 1) return;
          if ((c - 0.5) * (cn - 0.5) > 0) return;
          vx[i] = dx * 0.5;
          vy[i] = dy * 0.5;
        };
        if (x > 0) consider(x - 1, y, -1, 0);
        if (x < n - 1) consider(x + 1, y, 1, 0);
        if (y > 0) consider(x, y - 1, 0, -1);
        if (y < n - 1) consider(x, y + 1, 0, 1);
      }
    }
  };

  // Four sweeps propagate each pixel's nearest boundary point to its neighbours.
  const relax = (i, j, dx, dy) => {
    if (vx[j] >= FAR) return;
    const cx = vx[j] + dx;
    const cy = vy[j] + dy;
    if (cx * cx + cy * cy < vx[i] * vx[i] + vy[i] * vy[i]) { vx[i] = cx; vy[i] = cy; }
  };
  const propagate = () => {
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
  };

  const phi = new Float32Array(n * n);
  const resolve = () => {
    for (let i = 0; i < phi.length; i++) {
      const sign = coverage[i] > 0.5 ? 1 : -1;
      phi[i] = vx[i] >= FAR ? sign * n : sign * Math.hypot(vx[i], vy[i]);
    }
  };

  seed(null);
  propagate();
  resolve();

  const nx = new Float32Array(n * n);
  const ny = new Float32Array(n * n);
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      nx[i] = (phi[i + 1] - phi[i - 1]) / 2;
      ny[i] = (phi[i + n] - phi[i - n]) / 2;
    }
  }
  seed({ x: nx, y: ny });
  propagate();
  resolve();

  reinitialize(phi, n);
  return phi;
}

/**
 * Enforce |∇φ| = 1 away from the outline (fast sweeping, Godunov upwind),
 * keeping the samples next to the zero level set exactly where they are. The
 * vector sweep is accurate at the outline itself but drifts a little further
 * in, and everything downstream multiplies that drift by a slope.
 */
function reinitialize(phi, n) {
  const fixed = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const s = phi[i] > 0;
      fixed[i] = (x > 0 && (phi[i - 1] > 0) !== s) || (x < n - 1 && (phi[i + 1] > 0) !== s)
              || (y > 0 && (phi[i - n] > 0) !== s) || (y < n - 1 && (phi[i + n] > 0) !== s) ? 1 : 0;
    }
  }

  const u = new Float32Array(n * n);
  for (let i = 0; i < u.length; i++) u[i] = fixed[i] ? Math.abs(phi[i]) : BIG;

  const update = (x, y) => {
    const i = y * n + x;
    if (fixed[i]) return;
    const a = Math.min(x > 0 ? u[i - 1] : BIG, x < n - 1 ? u[i + 1] : BIG);
    const b = Math.min(y > 0 ? u[i - n] : BIG, y < n - 1 ? u[i + n] : BIG);
    const diff = Math.abs(a - b);
    const candidate = diff >= 1 ? Math.min(a, b) + 1 : (a + b + Math.sqrt(2 - diff * diff)) / 2;
    if (candidate < u[i]) u[i] = candidate;
  };

  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) update(x, y);
    for (let y = 0; y < n; y++) for (let x = n - 1; x >= 0; x--) update(x, y);
    for (let y = n - 1; y >= 0; y--) for (let x = n - 1; x >= 0; x--) update(x, y);
    for (let y = n - 1; y >= 0; y--) for (let x = 0; x < n; x++) update(x, y);
  }

  for (let i = 0; i < phi.length; i++) phi[i] = phi[i] > 0 ? u[i] : -u[i];
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
