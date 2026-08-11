// Shaded preview of the height field. Not a 3D viewer — it lights the surface
// normals directly, which is enough to judge how puffy the result reads.

const LIGHT = (() => {
  const v = [-0.45, -0.6, 0.65];
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
})();

export function renderPreview(canvas, field, colors) {
  const { height, solid, n, mmPerPx } = field;
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(n, n);
  const data = img.data;

  const at = (x, y) => (solid[y * n + x] ? height[y * n + x] : 0);
  let maxH = 0;
  for (let i = 0; i < height.length; i++) if (height[i] > maxH) maxH = height[i];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const o = i * 4;
      if (!solid[i]) {
        data[o] = 239; data[o + 1] = 234; data[o + 2] = 248; data[o + 3] = 255;
        continue;
      }
      const xm = Math.min(n - 1, x + 1), xp = Math.max(0, x - 1);
      const ym = Math.min(n - 1, y + 1), yp = Math.max(0, y - 1);
      const dzdx = (at(xm, y) - at(xp, y)) / (2 * mmPerPx);
      const dzdy = (at(x, ym) - at(x, yp)) / (2 * mmPerPx);
      let nx = -dzdx, ny = -dzdy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;

      const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const spec = Math.pow(diffuse, 24) * 0.7;
      const shade = 0.32 + 0.68 * diffuse;

      const t = Math.min(1, height[i] / (maxH || 1));
      const base = colors.base;
      const top = colors.letter;
      const mix = (a, b) => a + (b - a) * Math.min(1, t * 1.3);
      const r = mix(base[0], top[0]) * shade + 255 * spec;
      const g = mix(base[1], top[1]) * shade + 255 * spec;
      const b = mix(base[2], top[2]) * shade + 255 * spec;
      data[o] = Math.min(255, r);
      data[o + 1] = Math.min(255, g);
      data[o + 2] = Math.min(255, b);
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
