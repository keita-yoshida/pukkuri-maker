import { rasterizeText, rasterizeSVG, rasterizeDXF } from './raster.js';
import { dilate } from './edt.js';
import { buildHeightField } from './puff.js';
import { buildMesh } from './mesh.js';
import { renderPreview } from './preview.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const previewCanvas = $('preview');

let mode = 'text';
let svgText = null;
let dxfText = null;
let lastField = null;
let pending = null;

const numeric = [
  'bold', 'tracking', 'dxfStroke', 'size', 'letterHeight', 'letterRadius',
  'capillary', 'meniscus', 'floorBoost', 'minThickness',
  'outlineWidth', 'outlineHeight', 'baseThickness', 'quilt', 'quiltPitch',
];

function readOptions() {
  const opts = {};
  for (const id of numeric) opts[id] = parseFloat($(id).value);
  opts.sizeMM = opts.size;
  opts.mode = $('mode').value;
  opts.baseShape = $('baseShape').value;
  opts.resolution = parseInt($('resolution').value, 10);
  opts.text = $('text').value;
  opts.fontFamily = $('fontFamily').value;
  opts.dxfFill = $('dxfFill').checked;
  return opts;
}

function syncOutputs() {
  for (const input of document.querySelectorAll('input[type="range"]')) {
    const out = input.parentElement.querySelector('output');
    if (out) out.textContent = input.value;
  }
}

async function buildMask(n, opts) {
  if (mode === 'svg') {
    if (!svgText) return null;
    return rasterizeSVG(n, svgText);
  }
  if (mode === 'dxf') {
    if (!dxfText) return null;
    return rasterizeDXF(n, dxfText, {
      fill: opts.dxfFill,
      strokeMM: opts.dxfStroke,
      sizeMM: opts.sizeMM,
    });
  }
  return rasterizeText(n, opts);
}

async function regenerate() {
  const opts = readOptions();
  const n = opts.resolution;
  statusEl.textContent = '計算中…';
  await new Promise((r) => requestAnimationFrame(r));

  try {
    let mask = await buildMask(n, opts);
    if (!mask) {
      statusEl.textContent = mode === 'svg' ? 'SVGファイルを選んでください。' : 'DXFファイルを選んでください。';
      return;
    }
    if (mode === 'text' && opts.bold > 0) {
      mask = dilate(mask, n, n, (opts.bold / opts.sizeMM) * n);
    }

    const started = performance.now();
    lastField = buildHeightField(mask, n, opts);
    const elapsed = Math.round(performance.now() - started);
    renderPreview(previewCanvas, lastField, { base: [196, 181, 253], letter: [124, 58, 237] });

    let maxH = 0;
    for (const h of lastField.height) if (h > maxH) maxH = h;
    statusEl.textContent = `${opts.sizeMM}×${opts.sizeMM} mm / 最大高さ ${maxH.toFixed(1)} mm / ${elapsed} ms`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `エラー: ${err.message}`;
  }
}

function schedule() {
  syncOutputs();
  clearTimeout(pending);
  pending = setTimeout(regenerate, 120);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Some browsers only honour `download` for anchors that are in the document.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('download').addEventListener('click', async () => {
  if (!lastField) return;
  const button = $('download');
  button.disabled = true;
  statusEl.textContent = 'STLを生成中…';
  await new Promise((r) => requestAnimationFrame(r));
  try {
    const { buffer, triangles } = buildMesh(lastField);
    const name = mode === 'text'
      ? ($('text').value.split('\n')[0].trim() || 'pukkuri')
      : 'pukkuri';
    download(new Blob([buffer], { type: 'model/stl' }), `${name}.stl`);
    statusEl.textContent = `完了：三角形 ${triangles.toLocaleString()} 個`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `エラー: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

$('downloadPng').addEventListener('click', () => {
  previewCanvas.toBlob((blob) => download(blob, 'pukkuri-preview.png'));
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.tabpage').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.page !== mode);
    });
    schedule();
  });
}

$('svgFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  svgText = await file.text();
  schedule();
});

$('dxfFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  dxfText = await file.text();
  schedule();
});

for (const el of document.querySelectorAll('input, select, textarea')) {
  el.addEventListener('input', schedule);
  el.addEventListener('change', schedule);
}

// Wait for webfonts so the first raster matches what the user sees.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
syncOutputs();
regenerate();
