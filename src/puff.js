// Mask -> height field. The "pukkuri" look comes from mapping the distance to
// the nearest edge onto a circular arc: vertical-ish at the outline, flat on
// top, which is exactly how the pressed/inflated uchiwa letters read.

import { insideDistance, dilate } from './edt.js';

/** Circular dome profile: 0 at the edge, `height` once `d >= radius`. */
function dome(d, radius, height) {
  if (d <= 0) return 0;
  const t = Math.min(1, d / radius);
  return height * Math.sqrt(1 - (1 - t) * (1 - t));
}

function baseMask(n, shape) {
  const mask = new Uint8Array(n * n);
  if (shape === 'none') return mask;
  const r = n / 2 - 1;
  const corner = n * 0.14;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let inside;
      if (shape === 'circle') {
        inside = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) <= r;
      } else {
        const dx = Math.max(0, Math.abs(x - n / 2 + 0.5) - (r - corner));
        const dy = Math.max(0, Math.abs(y - n / 2 + 0.5) - (r - corner));
        inside = Math.hypot(dx, dy) <= corner && Math.abs(x - n / 2) <= r && Math.abs(y - n / 2) <= r;
      }
      mask[y * n + x] = inside ? 1 : 0;
    }
  }
  return mask;
}

/**
 * @param {Uint8Array} artMask letters/artwork, n x n
 * @returns {{height: Float32Array, solid: Uint8Array, n: number, mmPerPx: number}}
 */
export function buildHeightField(artMask, n, opts) {
  const {
    sizeMM, letterHeight, letterRadius, outlineWidth, outlineHeight,
    baseShape, baseThickness, quilt, quiltPitch,
  } = opts;
  const mmPerPx = sizeMM / n;
  const toPx = (mm) => mm / mmPerPx;

  const plate = baseMask(n, baseShape);
  const outline = outlineWidth > 0 ? dilate(artMask, n, n, toPx(outlineWidth)) : artMask;

  // A letter-only model still needs a body, so the outline layer becomes it.
  const solid = new Uint8Array(n * n);
  for (let i = 0; i < solid.length; i++) solid[i] = plate[i] || outline[i] ? 1 : 0;

  const dArt = insideDistance(artMask, n, n);
  const dOutline = insideDistance(outline, n, n);
  const dPlate = baseShape === 'none' ? null : insideDistance(plate, n, n);

  const artR = Math.max(1, toPx(letterRadius));
  const outR = Math.max(1, toPx(Math.min(outlineWidth || letterRadius, letterRadius)));
  const plateR = Math.max(1, toPx(Math.min(sizeMM * 0.04, baseThickness * 2)));
  const quiltPx = Math.max(2, toPx(quiltPitch));

  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!solid[i]) continue;
      let h = 0;

      if (dPlate) {
        // Rounded-over plate edge so the base is not a raw cylinder.
        h = dome(dPlate[i], plateR, baseThickness);
        if (quilt > 0) {
          const s = Math.sin((x / quiltPx) * Math.PI * 2 + (y / quiltPx) * Math.PI * 2)
                  * Math.sin((x / quiltPx) * Math.PI * 2 - (y / quiltPx) * Math.PI * 2);
          const fade = Math.min(1, dPlate[i] / Math.max(1, quiltPx * 0.6));
          h -= quilt * 0.5 * (1 - s) * fade;
        }
      }

      if (outlineHeight > 0 && dOutline[i] > 0) h += dome(dOutline[i], outR, outlineHeight);
      if (dArt[i] > 0) h += dome(dArt[i], artR, letterHeight);

      height[i] = Math.max(h, 0.2);
    }
  }
  return { height, solid, n, mmPerPx };
}
