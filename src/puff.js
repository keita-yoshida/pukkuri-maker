// Coverage -> height field.
//
// Every layer is described by a signed distance field rather than a set of
// filled pixels, which buys two things: growing a shape (bold, meniscus,
// outline) becomes an exact `φ + r` instead of a pixelated dilation, and the
// mesher can cut the outline between grid points (see mesh.js).
//
// Two ways to get the puffy look:
//
//   surface  the liquid model — the shape resin takes when it is pinned at the
//            outline and pulled up by surface tension (see capillary.js).
//            Thin strokes sit lower than fat ones and junctions fillet
//            themselves, which is what makes it read as liquid.
//   classic  distance mapped onto a circular arc. Cheap and perfectly even,
//            but every stroke reaches the same height and wide areas plateau.

import { signedFromCoverage, offset, union, maskFrom, plateSDF } from './sdf.js?v=20260811a';
import { solveCapillary } from './capillary.js?v=20260811a';

/** Circular dome profile: 0 at the edge, `height` once `d >= radius`. */
function dome(d, radius, height) {
  if (d <= 0) return 0;
  const t = Math.min(1, d / radius);
  return height * Math.sqrt(1 - (1 - t) * (1 - t));
}

/**
 * Arc-of-a-circle layer over a shape, in mm. φ doubles as the inside distance.
 *
 * The arc stands vertically at d = 0, and infinite slope is not something a
 * grid can hold: φ is only accurate to ~0.1px, and near the edge the arc turns
 * that into a ~0.2mm swing in height, which shows up as a ragged ridge running
 * along every outline. Inside the first cell the profile is a straight ramp
 * instead, which caps the amplification at one cell's worth of rise. At print
 * scale this only rounds the very lip of the bead.
 */
function domeLayer(phi, height, radiusPx) {
  const out = new Float32Array(phi.length);
  const r = Math.max(1, radiusPx);
  const lip = Math.min(1, r);           // one cell
  const lipHeight = dome(lip, r, height);
  for (let i = 0; i < out.length; i++) {
    const d = phi[i];
    out[i] = d <= 0 ? 0 : (d < lip ? lipHeight * (d / lip) : dome(d, r, height));
  }
  return out;
}

/** One [1 2 1] blur pass, used to round the foot of the liquid. */
function softenFoot(field, n) {
  const tmp = new Float32Array(field.length);
  const out = new Float32Array(field.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const l = x > 0 ? field[i - 1] : field[i];
      const r = x < n - 1 ? field[i + 1] : field[i];
      tmp[i] = (l + 2 * field[i] + r) / 4;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = y > 0 ? tmp[i - n] : tmp[i];
      const d = y < n - 1 ? tmp[i + n] : tmp[i];
      out[i] = (u + 2 * tmp[i] + d) / 4;
    }
  }
  return out;
}

/**
 * Blended maximum: `max` with the corner rounded over a width of k mm.
 *
 * A hard max() between two surfaces leaves a crease, and the crease sits
 * wherever they happen to cross — a contour whose position swings by ~0.15mm
 * from pixel to pixel, which the eye reads as a stepped line running around
 * every stroke. Rounding the join removes both the crease and the jitter, and
 * a liquid would not have a crease there to begin with.
 */
function smoothMax(a, b, k) {
  const d = Math.abs(a - b);
  const m = a > b ? a : b;
  return d >= k ? m : m + ((k - d) * (k - d)) / (4 * k);
}

/**
 * @param {Float32Array} coverage artwork coverage 0..1, n x n
 * @returns {{height: Float32Array, phi: Float32Array, solid: Uint8Array, n, mmPerPx}}
 */
export function buildHeightField(coverage, n, opts) {
  const {
    mode = 'surface', sizeMM, bold = 0, letterHeight, letterRadius, capillary,
    meniscus, minThickness, floorBoost, outlineWidth, outlineHeight,
    baseShape, baseThickness, quilt, quiltPitch,
  } = opts;
  const mmPerPx = sizeMM / n;
  const toPx = (mm) => mm / mmPerPx;

  const art = offset(signedFromCoverage(coverage, n), toPx(bold));
  const liquid = offset(art, toPx(meniscus));
  const hasOutline = outlineWidth > 0 && outlineHeight > 0;
  const outline = hasOutline ? offset(liquid, toPx(outlineWidth)) : liquid;
  const plate = plateSDF(n, baseShape);
  const phi = union(plate, outline);
  const solid = maskFrom(phi);

  const height = new Float32Array(n * n);

  // Base plate: rounded edge so it is not a raw cylinder, plus quilting.
  if (baseShape !== 'none') {
    const plateR = Math.max(1, toPx(Math.min(sizeMM * 0.04, baseThickness * 2)));
    const quiltPx = Math.max(2, toPx(quiltPitch));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const d = plate[i];
        if (d <= 0) continue;
        let h = dome(d, plateR, baseThickness);
        if (quilt > 0) {
          const u = ((x + y) / quiltPx) * Math.PI;
          const v = ((x - y) / quiltPx) * Math.PI;
          const fade = Math.min(1, d / Math.max(1, quiltPx * 0.6));
          h -= quilt * 0.5 * (1 - Math.sin(u) * Math.sin(v)) * fade;
        }
        height[i] = h;
      }
    }
  }

  // Outline rim under the letters.
  if (hasOutline) {
    const rim = domeLayer(outline, outlineHeight, toPx(Math.min(outlineWidth, letterRadius)));
    for (let i = 0; i < height.length; i++) height[i] += rim[i];
  }

  // The letters themselves.
  let top;
  if (mode === 'classic') {
    top = domeLayer(liquid, letterHeight, toPx(letterRadius));
  } else {
    top = solveCapillary(liquid, n, { mmPerPx, capillary, peak: letterHeight });
    if (floorBoost > 0) {
      // Physically honest liquid leaves thin strokes very low; this lifts them
      // back toward the classic dome so fine text stays printable.
      const floor = domeLayer(liquid, letterHeight * floorBoost, toPx(letterRadius));
      const k = Math.min(0.4, letterHeight * 0.15);
      for (let i = 0; i < top.length; i++) top[i] = smoothMax(top[i], floor[i], k);
    }
  }
  // The liquid meets the plate at its contact angle, which is a real crease --
  // but a crease that runs diagonally across the grid gets rendered as a
  // zigzag, since no vertex sits on it. Rounding its foot over about a cell
  // turns it into a small fillet, which is what resin does anyway.
  if (hasOutline || baseShape !== 'none') top = softenFoot(top, n);
  for (let i = 0; i < height.length; i++) height[i] += top[i];

  // A liquid surface tapers to nothing at the contact line, which does not
  // print, so every solid pixel gets at least this much material under it.
  const floorMM = Math.max(0.2, minThickness);
  const floorBlend = Math.min(0.4, floorMM * 0.5);
  for (let i = 0; i < height.length; i++) {
    if (solid[i]) height[i] = smoothMax(height[i], floorMM, floorBlend);
  }
  return { height, phi, solid, n, mmPerPx, edgeHeight: floorMM };
}
