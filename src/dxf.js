// Minimal DXF reader: extracts LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC /
// SPLINE (control-point approximation) as polylines in DXF coordinates.
// Enough for the 2D outlines people export from Illustrator or CAD tools.

function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

function arcPoints(cx, cy, r, startDeg, endDeg) {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;
  const steps = Math.max(6, Math.ceil(sweep / 4));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + (sweep * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// A bulge is the tangent of a quarter of the included angle between two
// LWPOLYLINE vertices; expand it into a short arc.
function bulgeArc(p0, p1, bulge) {
  if (!bulge) return [p1];
  const theta = 4 * Math.atan(bulge);
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return [p1];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (p0[0] + p1[0]) / 2;
  const my = (p0[1] + p1[1]) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const sign = theta > 0 ? 1 : -1;
  const cx = mx - (sign * h * dy) / chord;
  const cy = my + (sign * h * dx) / chord;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const steps = Math.max(4, Math.ceil((Math.abs(theta) * 180) / Math.PI / 4));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (theta * i) / steps;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** @returns {{points: [number,number][], closed: boolean}[]} */
export function parseDXF(text) {
  const pairs = tokenize(text);
  const paths = [];

  let i = 0;
  // Skip to ENTITIES if the file has proper sections; otherwise scan everything.
  const entIdx = pairs.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  if (entIdx >= 0) i = entIdx + 1;

  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code !== 0) { i++; continue; }
    if (value === 'ENDSEC' || value === 'EOF') break;

    const type = value;
    const fields = new Map();
    const xs = [], ys = [], bulges = [];
    let flags = 0;
    i++;
    while (i < pairs.length && pairs[i][0] !== 0) {
      const [c, v] = pairs[i];
      const num = parseFloat(v);
      if (c === 10) xs.push(num);
      else if (c === 20) ys.push(num);
      else if (c === 42) { bulges[xs.length - 1] = num; }
      else if (c === 70) flags = parseInt(v, 10) || 0;
      else fields.set(c, num);
      i++;
    }

    if (type === 'LINE') {
      const x2 = fields.get(11), y2 = fields.get(21);
      if (xs.length && Number.isFinite(x2)) {
        paths.push({ points: [[xs[0], ys[0]], [x2, y2]], closed: false });
      }
    } else if (type === 'POLYLINE') {
      // Legacy form: the vertices arrive as separate VERTEX entities below.
      paths.push({ points: [], closed: (flags & 1) === 1, fromPolyline: true });
    } else if (type === 'LWPOLYLINE') {
      const pts = [];
      for (let k = 0; k < xs.length; k++) {
        const p = [xs[k], ys[k]];
        if (k === 0) pts.push(p);
        else pts.push(...bulgeArc(pts[pts.length - 1], p, bulges[k - 1]));
      }
      const closed = (flags & 1) === 1;
      if (closed && pts.length > 1) pts.push(...bulgeArc(pts[pts.length - 1], pts[0], bulges[xs.length - 1]));
      if (pts.length > 1) paths.push({ points: pts, closed });
    } else if (type === 'VERTEX') {
      // Vertices of a legacy POLYLINE follow it as separate entities.
      const last = paths[paths.length - 1];
      if (last && last.fromPolyline && xs.length) last.points.push([xs[0], ys[0]]);
    } else if (type === 'CIRCLE') {
      const r = fields.get(40);
      if (xs.length && r > 0) paths.push({ points: arcPoints(xs[0], ys[0], r, 0, 360), closed: true });
    } else if (type === 'ARC') {
      const r = fields.get(40);
      const a0 = fields.get(50) ?? 0;
      const a1 = fields.get(51) ?? 360;
      if (xs.length && r > 0) paths.push({ points: arcPoints(xs[0], ys[0], r, a0, a1), closed: false });
    } else if (type === 'SPLINE') {
      // Control polygon is a coarse but predictable stand-in for the curve.
      const pts = xs.map((x, k) => [x, ys[k]]).filter((p) => Number.isFinite(p[1]));
      if (pts.length > 1) paths.push({ points: pts, closed: (flags & 1) === 1 });
    }
  }
  return paths.filter((p) => p.points.length > 1);
}

export function pathsBounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
