// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012).
// Input: Float32Array of per-pixel costs (0 inside the seed set, INF elsewhere).
// Output: Float32Array of squared distances to the nearest seed pixel.

const INF = 1e20;

function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dist = q - v[k];
    d[q] = dist * dist + f[v[k]];
  }
}

/** @param {Float32Array} cost  @returns {Float32Array} squared distances */
export function edt2d(cost, width, height) {
  const out = Float32Array.from(cost);
  const n = Math.max(width, height);
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = out[row + x];
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) out[row + x] = d[x];
  }
  return out;
}

/**
 * Signed-ish inside distance in pixels: how far each pixel is from the
 * outside of the mask. Zero for pixels that are not part of the mask.
 */
export function insideDistance(mask, width, height) {
  const cost = new Float32Array(width * height);
  for (let i = 0; i < cost.length; i++) cost[i] = mask[i] ? INF : 0;
  const sq = edt2d(cost, width, height);
  for (let i = 0; i < sq.length; i++) sq[i] = Math.sqrt(sq[i]);
  return sq;
}

/** Distance (px) from each pixel to the nearest mask pixel. 0 inside the mask. */
export function outsideDistance(mask, width, height) {
  const cost = new Float32Array(width * height);
  for (let i = 0; i < cost.length; i++) cost[i] = mask[i] ? 0 : INF;
  const sq = edt2d(cost, width, height);
  for (let i = 0; i < sq.length; i++) sq[i] = Math.sqrt(sq[i]);
  return sq;
}

/** Grow a mask by `radius` pixels. */
export function dilate(mask, width, height, radius) {
  if (radius <= 0) return Uint8Array.from(mask);
  const dist = outsideDistance(mask, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= radius ? 1 : 0;
  return out;
}
