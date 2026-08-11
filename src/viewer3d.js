// Orbitable WebGL preview of the solid that will be exported. Hand-rolled
// rather than pulled from a library so the site stays dependency-free.
//
// Geometry comes from the same emitTriangles() the STL writer uses, so what is
// on screen is the exported solid, only sampled on a coarser grid. Top faces
// take their normals from the height field's gradient rather than the triangle
// they sit on, otherwise the alternating quad diagonals stripe the domes.

import { emitTriangles, TOP } from './mesh.js?v=20260811a';

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat3 uRot;
uniform float uMaxZ;
varying vec3 vNormal;
varying float vH;
void main() {
  vNormal = normalize(uRot * aNormal);
  vH = clamp(aPos.z / max(uMaxZ, 0.001), 0.0, 1.0);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform vec3 uBase;
uniform vec3 uTop;
varying vec3 vNormal;
varying float vH;
void main() {
  vec3 n = normalize(vNormal);
  vec3 key = normalize(vec3(-0.4, -0.5, 0.75));
  vec3 fill = normalize(vec3(0.6, 0.3, 0.2));
  float d = max(dot(n, key), 0.0);
  float f = max(dot(n, fill), 0.0) * 0.25;
  vec3 h = normalize(key + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.55;
  vec3 color = mix(uBase, uTop, smoothstep(0.0, 0.85, vH));
  gl_FragColor = vec4(color * (0.30 + 0.75 * d + f) + spec, 1.0);
}`;

const FOV = Math.PI / 5;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, center, up) {
  const z = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]];
  let len = Math.hypot(...z) || 1;
  z[0] /= len; z[1] /= len; z[2] /= len;
  const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  len = Math.hypot(...x) || 1;
  x[0] /= len; x[1] /= len; x[2] /= len;
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ];
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Sample the height field down so the preview stays interactive. */
function coarsen(field, maxN) {
  const { height, solid, phi, n, mmPerPx } = field;
  const step = Math.max(1, Math.ceil(n / maxN));
  if (step === 1) return field;
  const m = Math.floor(n / step);
  const h = new Float32Array(m * m);
  const s = new Uint8Array(m * m);
  const f = new Float32Array(m * m);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const src = (y * step) * n + x * step;
      h[y * m + x] = height[src];
      s[y * m + x] = solid[src];
      f[y * m + x] = phi[src] / step;
    }
  }
  return { height: h, solid: s, phi: f, n: m, mmPerPx: mmPerPx * step };
}

function getContext(canvas) {
  const attrs = { antialias: true, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false };
  for (const name of ['webgl2', 'webgl', 'experimental-webgl']) {
    try {
      const gl = canvas.getContext(name, attrs);
      if (gl) return gl;
    } catch { /* try the next one */ }
  }
  return null;
}

export class Viewer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = getContext(canvas);
    if (!this.gl) {
      throw new Error('このブラウザで WebGL を初期化できませんでした（ハードウェアアクセラレーションが無効かもしれません）');
    }
    const gl = this.gl;

    // A lost context silently blanks the canvas, so surface it instead.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => this.onContextRestored?.());

    this.program = gl.createProgram();
    gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program));
    }
    gl.useProgram(this.program);

    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.aNormal = gl.getAttribLocation(this.program, 'aNormal');
    this.uMVP = gl.getUniformLocation(this.program, 'uMVP');
    this.uRot = gl.getUniformLocation(this.program, 'uRot');
    this.uMaxZ = gl.getUniformLocation(this.program, 'uMaxZ');
    this.uBase = gl.getUniformLocation(this.program, 'uBase');
    this.uTop = gl.getUniformLocation(this.program, 'uTop');

    this.posBuffer = gl.createBuffer();
    this.normalBuffer = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.937, 0.918, 0.973, 1);

    this.yaw = -Math.PI / 2;
    this.pitch = 0.58;
    this.zoom = 1;
    this.vertexCount = 0;
    this.radius = 50;
    this.center = [0, 0];
    this.maxZ = 1;
    this.homeYaw = this.yaw;
    this.homePitch = this.pitch;

    this.#bindControls();
  }

  #bindControls() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.yaw -= (e.clientX - lastX) * 0.01;
      this.pitch += (e.clientY - lastY) * 0.01;
      const limit = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
      lastX = e.clientX;
      lastY = e.clientY;
      this.render();
    });
    const stop = (e) => {
      dragging = false;
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.4, Math.min(4, this.zoom * Math.exp(-e.deltaY * 0.001)));
      this.render();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => this.resetView());
    window.addEventListener('resize', () => this.render());
  }

  resetView() {
    this.yaw = this.homeYaw;
    this.pitch = this.homePitch;
    this.zoom = 1;
    this.render();
  }

  /** Rebuild the preview geometry from a height field. */
  setField(field, previewN = 384) {
    const gl = this.gl;
    const coarse = coarsen(field, previewN);

    let count = 0;
    emitTriangles(coarse, () => { count++; });
    const positions = new Float32Array(count * 9);
    const normals = new Float32Array(count * 9);

    // Analytic normal of the liquid surface at a world position.
    const { height: ch, solid: cs, n: cn, mmPerPx: cmm } = coarse;
    const heightAt = (xi, yi) => {
      if (xi < 0 || yi < 0 || xi >= cn || yi >= cn) return 0;
      const k = yi * cn + xi;
      return cs[k] ? ch[k] : 0;
    };
    const topNormal = (wx, wy, out) => {
      const xi = Math.round(wx / cmm + cn / 2);
      const yi = Math.round(cn / 2 - wy / cmm);
      const dzdx = (heightAt(xi + 1, yi) - heightAt(xi - 1, yi)) / (2 * cmm);
      const dzdy = (heightAt(xi, yi + 1) - heightAt(xi, yi - 1)) / (2 * cmm);
      // Grid y runs opposite to world y.
      const len = Math.hypot(dzdx, dzdy, 1);
      out[0] = -dzdx / len;
      out[1] = dzdy / len;
      out[2] = 1 / len;
    };
    const nrm = [0, 0, 0];

    let i = 0;
    let maxZ = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    emitTriangles(coarse, (ax, ay, az, bx, by, bz, cx, cy, cz, kind) => {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      positions.set([ax, ay, az, bx, by, bz, cx, cy, cz], i);
      if (kind === TOP) {
        topNormal(ax, ay, nrm); normals.set(nrm, i);
        topNormal(bx, by, nrm); normals.set(nrm, i + 3);
        topNormal(cx, cy, nrm); normals.set(nrm, i + 6);
      } else {
        normals.set([nx, ny, nz, nx, ny, nz, nx, ny, nz], i);
      }
      i += 9;
      if (az > maxZ) maxZ = az;
      if (bz > maxZ) maxZ = bz;
      if (cz > maxZ) maxZ = cz;
      if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
      if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
      if (by < minY) minY = by; if (by > maxY) maxY = by;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    });

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);

    this.vertexCount = count * 3;
    this.maxZ = maxZ || 1;
    // Frame what was actually built, not the whole grid, so letters-only
    // models do not sit tiny in the middle of an empty plate.
    this.radius = count
      ? Math.max(maxX - minX, maxY - minY, 1) / 2
      : (coarse.n * coarse.mmPerPx) / 2;
    this.center = [(minX + maxX) / 2, (minY + maxY) / 2];
    this.render();
    return count;
  }

  render() {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.vertexCount) return;

    // Frame the plate, then let the wheel zoom in from there.
    // Pull back far enough that the model's bounding sphere fits the frustum.
    const dist = (this.radius / Math.tan(FOV / 2)) * 1.2 / this.zoom;
    const cp = Math.cos(this.pitch);
    const center = [this.center[0], this.center[1], this.maxZ * 0.35];
    const eye = [
      center[0] + dist * cp * Math.cos(this.yaw),
      center[1] + dist * cp * Math.sin(this.yaw),
      center[2] + dist * Math.sin(this.pitch),
    ];
    const view = lookAt(eye, center, [0, 0, 1]);
    const proj = perspective(FOV, width / height, dist * 0.05, dist * 4 + this.radius * 4);
    const mvp = multiply(proj, view);

    // Model is never rotated, so the view rotation is the normal matrix.
    const rot = new Float32Array([view[0], view[1], view[2], view[4], view[5], view[6], view[8], view[9], view[10]]);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMVP, false, mvp);
    gl.uniformMatrix3fv(this.uRot, false, rot);
    gl.uniform1f(this.uMaxZ, this.maxZ);
    gl.uniform3f(this.uBase, 0.62, 0.55, 0.85);
    gl.uniform3f(this.uTop, 0.42, 0.24, 0.78);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.enableVertexAttribArray(this.aNormal);
    gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
  }
}
