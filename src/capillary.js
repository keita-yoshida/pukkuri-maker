// Surface-tension height field: the shape a liquid takes when it is pinned at
// the outline of the artwork.
//
// Young-Laplace with gravity, divided through by the surface tension γ:
//
//     ∇·( ∇h / √(1+|∇h|²) )  =  h / Lc²  −  P
//
//   Lc = √(γ / ρg)   capillary length (mm) — how wide a puddle can get before
//                    gravity flattens it. Small Lc = runny, wide areas go flat
//                    and thin strokes stay low. Large Lc behaves like a
//                    membrane (∇²h = −P), so height grows with width².
//   P  = Δp / γ      the internal pressure, i.e. how much liquid was poured on.
//                    We do not ask the user for it: it is solved for so that
//                    the tallest point lands on the requested height.
//
// h = 0 on the contact line (the liquid is pinned at the edge of the shape),
// which is what actually happens to resin sitting inside a letter outline.
//
// Solved with lagged-diffusivity red-black Gauss-Seidel on an image pyramid:
// coarse levels find the pressure cheaply and hand a good starting guess down
// to the fine levels.

/** Half the resolution, keeping a pixel when at least half its children are set. */
function downsampleMask(mask, n) {
  const m = n >> 1;
  const out = new Uint8Array(m * m);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const s = mask[2 * y * n + 2 * x] + mask[2 * y * n + 2 * x + 1]
              + mask[(2 * y + 1) * n + 2 * x] + mask[(2 * y + 1) * n + 2 * x + 1];
      out[y * m + x] = s >= 2 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Bilinear, not nearest-neighbour: block-copying a coarse level injects
 * pixel-scale steps, and the odd/even lattices of a red-black sweep only trade
 * their difference away at ~0.998 per sweep for this operator — so anything
 * checkerboard-shaped that gets in here stays in, and lands on the print as a
 * fine ripple.
 */
function upsample(h, n, fineMask, fineN) {
  const out = new Float32Array(fineN * fineN);
  const sample = (x, y) => h[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let y = 0; y < fineN; y++) {
    for (let x = 0; x < fineN; x++) {
      const i = y * fineN + x;
      if (!fineMask[i]) continue;
      const fx = (x - 0.5) / 2;
      const fy = (y - 0.5) / 2;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const top = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
      const bot = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
      out[i] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

/**
 * One [1 2 1] pass over pixels that are entirely surrounded by liquid. Red-black
 * sweeps cannot remove an odd/even split on their own, and this kernel is zero
 * exactly on it. Interior only, so the contact line is left where it is.
 */
function despeckle(h, mask, n) {
  const tmp = Float32Array.from(h);
  const interior = (i, x, y) => x > 0 && y > 0 && x < n - 1 && y < n - 1
    && mask[i - 1] && mask[i + 1] && mask[i - n] && mask[i + n];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!mask[i] || !interior(i, x, y)) continue;
      tmp[i] = (h[i - 1] + h[i + 1] + 2 * h[i]) / 4;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!mask[i] || !interior(i, x, y)) continue;
      h[i] = (tmp[i - n] + tmp[i + n] + 2 * tmp[i]) / 4;
    }
  }
}

/**
 * Metric coefficients 1/√(1+|∇h|²), lagged one iteration behind h and sampled
 * on the *faces* between grid points.
 *
 * Sampling them at grid points with central differences decouples the odd and
 * even lattices — each converges to its own answer and the surface ends up with
 * a one-pixel checkerboard ripple baked in (~0.03mm, and finer but never gone
 * at higher resolution). Face-centred differences couple neighbours directly.
 */
function faceCoefficients(h, mask, n, dx, aX, aY) {
  const H = (x, y) => {
    if (x < 0 || y < 0 || x >= n || y >= n) return 0;
    const i = y * n + x;
    return mask[i] ? h[i] : 0;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Face towards +x: gradient across it, plus the transverse slope averaged
      // over the two samples it separates.
      const gx = (H(x + 1, y) - H(x, y)) / dx;
      const gxT = (H(x, y + 1) + H(x + 1, y + 1) - H(x, y - 1) - H(x + 1, y - 1)) / (4 * dx);
      aX[i] = 1 / Math.sqrt(1 + gx * gx + gxT * gxT);
      // Face towards +y.
      const gy = (H(x, y + 1) - H(x, y)) / dx;
      const gyT = (H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y) - H(x - 1, y + 1)) / (4 * dx);
      aY[i] = 1 / Math.sqrt(1 + gy * gy + gyT * gyT);
    }
  }
}

const OMEGA = 1.6; // over-relaxation; the nonlinearity keeps us below 2

function sweep(h, aX, aY, mask, n, dx, invLc2, P) {
  const inv = 1 / (dx * dx);
  let maxH = 0;
  for (let color = 0; color < 2; color++) {
    for (let y = 0; y < n; y++) {
      for (let x = (y + color) & 1; x < n; x += 2) {
        const i = y * n + x;
        if (!mask[i]) continue;
        // Neighbours outside the mask are the pinned contact line: h = 0.
        const aL = x > 0 ? aX[i - 1] : aX[i];
        const aR = x < n - 1 ? aX[i] : aX[i - 1];
        const aU = y > 0 ? aY[i - n] : aY[i];
        const aD = y < n - 1 ? aY[i] : aY[i - n];
        const sumA = aL + aR + aU + aD;
        let sumAH = 0;
        if (x > 0 && mask[i - 1]) sumAH += aL * h[i - 1];
        if (x < n - 1 && mask[i + 1]) sumAH += aR * h[i + 1];
        if (y > 0 && mask[i - n]) sumAH += aU * h[i - n];
        if (y < n - 1 && mask[i + n]) sumAH += aD * h[i + n];

        const next = (sumAH * inv + P) / (sumA * inv + invLc2);
        const v = h[i] + OMEGA * (next - h[i]);
        h[i] = v > 0 ? v : 0;
        if (h[i] > maxH) maxH = h[i];
      }
    }
  }
  return maxH;
}

function relax(h, mask, n, dx, invLc2, P, sweeps) {
  let maxH = 0;
  const aX = new Float32Array(n * n);
  const aY = new Float32Array(n * n);
  faceCoefficients(h, mask, n, dx, aX, aY);
  for (let s = 0; s < sweeps; s++) {
    if (s % 4 === 3) faceCoefficients(h, mask, n, dx, aX, aY);
    maxH = sweep(h, aX, aY, mask, n, dx, invLc2, P);
  }
  return maxH;
}

/**
 * Peak height grows monotonically with pressure, so bisect on P.
 * `h` is carried across probes as a warm start, which is why a handful of
 * sweeps per probe is enough.
 */
function fitPressure(h, mask, n, dx, invLc2, target, probes, sweeps) {
  let lo = 0;
  let hi = Math.max(1e-4, target * invLc2) || 1e-4;
  for (let i = 0; i < 40 && relax(h, mask, n, dx, invLc2, hi, sweeps) < target; i++) hi *= 2;
  for (let i = 0; i < probes; i++) {
    const mid = (lo + hi) / 2;
    if (relax(h, mask, n, dx, invLc2, mid, sweeps) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * @param {Uint8Array} mask   liquid footprint, n x n
 * @param {number} n          grid size
 * @param {object} opts
 * @param {number} opts.mmPerPx   grid spacing in mm
 * @param {number} opts.capillary capillary length Lc in mm ("とろみ")
 * @param {number} opts.peak      target height of the tallest point, mm
 * @returns {Float32Array} height in mm, 0 outside the mask
 */
export function solveCapillary(mask, n, { mmPerPx, capillary, peak }) {
  const invLc2 = 1 / (capillary * capillary);

  // Build the pyramid, coarsest first.
  const levels = [{ mask, n }];
  while (levels[0].n > 48) {
    const top = levels[0];
    levels.unshift({ mask: downsampleMask(top.mask, top.n), n: top.n >> 1 });
  }

  let h = new Float32Array(levels[0].n * levels[0].n);
  let P = 0;
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    const dx = mmPerPx * (n / level.n);
    if (li > 0) h = upsample(h, levels[li - 1].n, level.mask, level.n);

    const finest = li === levels.length - 1;
    if (!finest) {
      P = fitPressure(h, level.mask, level.n, dx, invLc2, peak, 14, 6);
    } else {
      // The pressure is already grid-converged; spend the budget on the shape.
      relax(h, level.mask, level.n, dx, invLc2, P, 40);
      P = fitPressure(h, level.mask, level.n, dx, invLc2, peak, 6, 4);
      relax(h, level.mask, level.n, dx, invLc2, P, 12);
      despeckle(h, level.mask, level.n);
    }
  }

  // Trim the last bit of bisection error so the slider means what it says.
  let maxH = 0;
  for (let i = 0; i < h.length; i++) if (h[i] > maxH) maxH = h[i];
  if (maxH > 0) {
    const k = peak / maxH;
    if (k < 0.98 || k > 1.02) for (let i = 0; i < h.length; i++) h[i] *= k;
  }
  return h;
}
