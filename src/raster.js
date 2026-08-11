// Turns the three input kinds (text, SVG, DXF) into a binary mask on a square
// grid. Everything downstream only ever sees the mask, so adding a new input
// kind means adding one function here.

import { parseDXF, pathsBounds } from './dxf.js';

/** Fraction of the grid left empty around the artwork. */
const MARGIN = 0.12;

function makeCanvas(n) {
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  return canvas;
}

/** Alpha channel of a canvas -> Uint8Array mask (1 where alpha > 128). */
function maskFromCanvas(canvas) {
  const n = canvas.width;
  const data = canvas.getContext('2d').getImageData(0, 0, n, n).data;
  const mask = new Uint8Array(n * n);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 128 ? 1 : 0;
  return mask;
}

export function rasterizeText(n, { text, fontFamily, tracking }) {
  const canvas = makeCanvas(n);
  const ctx = canvas.getContext('2d');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return new Uint8Array(n * n);

  const box = n * (1 - 2 * MARGIN);
  const probe = 100;
  ctx.font = `${probe}px ${fontFamily}`;
  ctx.textBaseline = 'alphabetic';

  const widthAt = (line) => {
    const base = ctx.measureText(line).width;
    return base + tracking * probe * Math.max(0, line.length - 1);
  };
  const widest = Math.max(...lines.map(widthAt));
  const lineGap = 1.12;
  const blockHeight = probe * lineGap * lines.length;
  const scale = Math.min(box / widest, box / blockHeight);
  const size = probe * scale;

  ctx.font = `${size}px ${fontFamily}`;
  ctx.fillStyle = '#000';
  const step = size * lineGap;
  const top = (n - step * lines.length) / 2;

  lines.forEach((line, row) => {
    const chars = [...line];
    const gap = tracking * size;
    let lineWidth = ctx.measureText(line).width + gap * (chars.length - 1);
    let x = (n - lineWidth) / 2;
    const y = top + step * row + size * 0.82;
    for (const ch of chars) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + gap;
    }
  });
  return maskFromCanvas(canvas);
}

// Chrome/Safari refuse to give an <img> an intrinsic size for an SVG that only
// carries a viewBox, so stamp explicit dimensions on before loading it.
function withExplicitSize(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg') throw new Error('SVGとして解釈できませんでした');
  const viewBox = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (!svg.getAttribute('width') || !svg.getAttribute('height')) {
    if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      svg.setAttribute('width', String(viewBox[2]));
      svg.setAttribute('height', String(viewBox[3]));
    } else {
      svg.setAttribute('width', '1000');
      svg.setAttribute('height', '1000');
    }
  }
  return new XMLSerializer().serializeToString(svg);
}

export function rasterizeSVG(n, rawSvgText) {
  return new Promise((resolve, reject) => {
    const svgText = withExplicitSize(rawSvgText);
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = makeCanvas(n);
      const ctx = canvas.getContext('2d');
      const box = n * (1 - 2 * MARGIN);
      const w = img.naturalWidth || img.width || box;
      const h = img.naturalHeight || img.height || box;
      const scale = Math.min(box / w, box / h);
      const dw = w * scale;
      const dh = h * scale;
      ctx.drawImage(img, (n - dw) / 2, (n - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      resolve(maskFromCanvas(canvas));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVGを読み込めませんでした'));
    };
    img.src = url;
  });
}

export function rasterizeDXF(n, dxfText, { fill, strokeMM, sizeMM }) {
  const paths = parseDXF(dxfText);
  if (!paths.length) throw new Error('DXFから図形を読み取れませんでした');

  const bounds = pathsBounds(paths);
  const box = n * (1 - 2 * MARGIN);
  const scale = Math.min(box / (bounds.width || 1), box / (bounds.height || 1));
  const offX = (n - bounds.width * scale) / 2;
  const offY = (n - bounds.height * scale) / 2;
  // DXF y grows upward, canvas y grows downward.
  const px = (x) => offX + (x - bounds.minX) * scale;
  const py = (y) => n - (offY + (y - bounds.minY) * scale);

  const canvas = makeCanvas(n);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, (strokeMM / sizeMM) * n);

  for (const path of paths) {
    ctx.beginPath();
    path.points.forEach(([x, y], k) => {
      if (k === 0) ctx.moveTo(px(x), py(y));
      else ctx.lineTo(px(x), py(y));
    });
    if (path.closed) {
      ctx.closePath();
      if (fill) ctx.fill('nonzero');
    }
    ctx.stroke();
  }
  return maskFromCanvas(canvas);
}
