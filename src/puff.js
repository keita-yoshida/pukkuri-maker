// Mask -> height field.
//
// Two ways to get the puffy look:
//
//   surface  the liquid model — the shape resin takes when it is pinned at the
//            outline and pulled up by surface tension (see capillary.js).
//            Thin strokes sit lower than fat ones and junctions fillet
//            themselves, which is what makes it read as liquid.
//   classic  distance mapped onto a circular arc. Cheap and perfectly even,
//            but every stroke reaches the same height and wide areas plateau.

import { insideDistance, dilate } from './edt.js?v=20260811a';
import { solveCapillary } from './capillary.js?v=20260811a';

/** Circular dome profile: 0 at the edge, `height` once `d >= radius`. */
function dome(d, radius, height) {
  if (d <= 0) return 0;
  const t = Math.min(1, d / radius);
  return height * Math.sqrt(1 - (1 - t) * (1 - t));
}

/** Arc-of-a-circle layer over a mask, in mm. */
function domeLayer(mask, n, height, radiusPx) {
  const d = insideDistance(mask, n, n);
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = dome(d[i], Math.max(1, radiusPx), height);
  return out;
}

function baseMask(n, shape) {
  const mask = new Uint8Array(n * n);
  if (shape === 'none') return mask;
  const r = n / 2 - 1;
  const corner = n * 0.14;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = Math.abs(x - n / 2 + 0.5);
      const dy = Math.abs(y - n / 2 + 0.5);
      let inside;
      if (shape === 'circle') {
        inside = Math.hypot(dx, dy) <= r;
      } else {
        const ox = Math.max(0, dx - (r - corner));
        const oy = Math.max(0, dy - (r - corner));
        inside = dx <= r && dy <= r && Math.hypot(ox, oy) <= corner;
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
    mode = 'surface', sizeMM, letterHeight, letterRadius, capillary, meniscus,
    minThickness, floorBoost, outlineWidth, outlineHeight,
    baseShape, baseThickness, quilt, quiltPitch,
  } = opts;
  const mmPerPx = sizeMM / n;
  const toPx = (mm) => mm / mmPerPx;

  const liquid = meniscus > 0 ? dilate(artMask, n, n, toPx(meniscus)) : artMask;
  const hasOutline = outlineWidth > 0 && outlineHeight > 0;
  const outline = hasOutline ? dilate(liquid, n, n, toPx(outlineWidth)) : liquid;
  const plate = baseMask(n, baseShape);

  const solid = new Uint8Array(n * n);
  for (let i = 0; i < solid.length; i++) solid[i] = plate[i] || outline[i] ? 1 : 0;

  const height = new Float32Array(n * n);

  // Base plate: rounded edge so it is not a raw cylinder, plus quilting.
  if (baseShape !== 'none') {
    const dPlate = insideDistance(plate, n, n);
    const plateR = Math.max(1, toPx(Math.min(sizeMM * 0.04, baseThickness * 2)));
    const quiltPx = Math.max(2, toPx(quiltPitch));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (!plate[i]) continue;
        let h = dome(dPlate[i], plateR, baseThickness);
        if (quilt > 0) {
          const u = ((x + y) / quiltPx) * Math.PI;
          const v = ((x - y) / quiltPx) * Math.PI;
          const fade = Math.min(1, dPlate[i] / Math.max(1, quiltPx * 0.6));
          h -= quilt * 0.5 * (1 - Math.sin(u) * Math.sin(v)) * fade;
        }
        height[i] = h;
      }
    }
  }

  // Outline rim under the letters.
  if (hasOutline) {
    const rim = domeLayer(outline, n, outlineHeight, toPx(Math.min(outlineWidth, letterRadius)));
    for (let i = 0; i < height.length; i++) height[i] += rim[i];
  }

  // The letters themselves.
  let top;
  if (mode === 'classic') {
    top = domeLayer(liquid, n, letterHeight, toPx(letterRadius));
  } else {
    top = solveCapillary(liquid, n, { mmPerPx, capillary, peak: letterHeight });
    if (floorBoost > 0) {
      // Physically honest liquid leaves thin strokes very low; this lifts them
      // back toward the classic dome so fine text stays printable.
      const floor = domeLayer(liquid, n, letterHeight * floorBoost, toPx(letterRadius));
      for (let i = 0; i < top.length; i++) if (floor[i] > top[i]) top[i] = floor[i];
    }
  }
  for (let i = 0; i < height.length; i++) height[i] += top[i];

  // A liquid surface tapers to nothing at the contact line, which does not
  // print, so every solid pixel gets at least this much material under it.
  const floorMM = Math.max(0.2, minThickness);
  for (let i = 0; i < height.length; i++) {
    if (solid[i] && height[i] < floorMM) height[i] = floorMM;
  }
  return { height, solid, n, mmPerPx };
}
