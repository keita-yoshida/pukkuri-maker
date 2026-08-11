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

/** Arc-of-a-circle layer over a shape, in mm. φ doubles as the inside distance. */
function domeLayer(phi, height, radiusPx) {
  const out = new Float32Array(phi.length);
  const r = Math.max(1, radiusPx);
  for (let i = 0; i < out.length; i++) out[i] = dome(phi[i], r, height);
  return out;
}

/**
 * The mesher interpolates heights across the outline, so it needs sane values
 * just outside it too — otherwise the surface dives to zero at the contact
 * line and the edge comes out as a knife.
 */
function extendOutward(height, phi, n, passes) {
  const out = Float32Array.from(height);
  const known = maskFrom(phi);
  for (let pass = 0; pass < passes; pass++) {
    const next = Uint8Array.from(known);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (known[i]) continue;
        let best = 0;
        let found = false;
        if (x > 0 && known[i - 1]) { best = Math.max(best, out[i - 1]); found = true; }
        if (x < n - 1 && known[i + 1]) { best = Math.max(best, out[i + 1]); found = true; }
        if (y > 0 && known[i - n]) { best = Math.max(best, out[i - n]); found = true; }
        if (y < n - 1 && known[i + n]) { best = Math.max(best, out[i + n]); found = true; }
        if (found) {
          out[i] = best;
          next[i] = 1;
        }
      }
    }
    known.set(next);
  }
  return out;
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
    top = solveCapillary(maskFrom(liquid), n, { mmPerPx, capillary, peak: letterHeight });
    if (floorBoost > 0) {
      // Physically honest liquid leaves thin strokes very low; this lifts them
      // back toward the classic dome so fine text stays printable.
      const floor = domeLayer(liquid, letterHeight * floorBoost, toPx(letterRadius));
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
  return { height: extendOutward(height, phi, n, 3), phi, solid, n, mmPerPx };
}
