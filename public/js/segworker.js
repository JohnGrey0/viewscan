// segworker.js — automatic segmentation and surface extraction, off the main thread.
//
// Approach (after reviewing 3D Slicer, InVesalius and the CT_BET skull-strip
// recipe): resample the scan onto an isotropic grid aligned with the
// acquisition, build masks with Hounsfield thresholds + millimeter-accurate
// morphology (exact Euclidean distance transforms) + connected components,
// then extract a closed surface from each lightly blurred mask (Surface Nets)
// and smooth it without shrinkage (Taubin).

import { LINES, lineCount, EDT_INF } from './seglines.js';

const post = (p, text) => self.postMessage({ type: 'progress', p, text });

// ---- multi-core: helper threads that share memory with this worker -----------
let PORTS = [];            // one MessagePort per helper thread
let SYNC = null;           // shared counter: helpers still busy / error flag
const canShare = () => PORTS.length > 0 && typeof SharedArrayBuffer !== 'undefined';
/** A Float32 volume; on shared memory when helper threads are available. */
function floatVolume() {
  return new Float32Array(canShare() ? new SharedArrayBuffer(N * 4) : N * 4);
}
/** Run one pass (all lines along `axis`) of LINES[op] over `arr`, split across threads. */
function runLines(op, arr, axis, kernel) {
  const count = lineCount(X, Y, Z, axis);
  const H = canShare() && arr.buffer instanceof SharedArrayBuffer ? PORTS.length : 0;
  if (!H) { LINES[op](arr, X, Y, Z, axis, 0, count, kernel); return; }
  const per = Math.ceil(count / (H + 1));
  Atomics.store(SYNC, 0, H);
  for (let h = 0; h < H; h++) {
    PORTS[h].postMessage({ op, buf: arr.buffer, X, Y, Z, axis, from: Math.min(count, (h + 1) * per), to: Math.min(count, (h + 2) * per), kernel, sync: SYNC.buffer });
  }
  LINES[op](arr, X, Y, Z, axis, 0, Math.min(per, count), kernel);
  for (;;) {
    const left = Atomics.load(SYNC, 0);
    if (left <= 0) break;
    Atomics.wait(SYNC, 0, left, 200);
  }
  if (Atomics.load(SYNC, 1)) throw new Error('A helper thread failed');
}

// ---------------------------------------------------------------- grid -----
let X = 0, Y = 0, Z = 0, N = 0, XY = 0, VOX = 1;
let PREVIEW = null; // { grid, dims } kept between live-preview requests

function resample(vol, voxel) {
  const { nx, ny, nz, data, origin, dx, dy, dz, basis } = vol;
  const e = [basis[0], basis[1], basis[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot(dz, e[2]) < 0) e[2] = e[2].map((v) => -v);
  // bounding box of the (possibly sheared) volume in the e-frame, relative to origin
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of [-0.5, nx - 0.5]) for (const j of [-0.5, ny - 0.5]) for (const k of [-0.5, nz - 0.5]) {
    const p = [0, 1, 2].map((c) => i * dx[c] + j * dy[c] + k * dz[c]);
    for (let a = 0; a < 3; a++) { const v = dot(p, e[a]); if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  }
  const pad = 3; // empty border so every surface closes
  X = Math.ceil((hi[0] - lo[0]) / voxel) + 2 * pad; Y = Math.ceil((hi[1] - lo[1]) / voxel) + 2 * pad; Z = Math.ceil((hi[2] - lo[2]) / voxel) + 2 * pad;
  XY = X * Y; N = XY * Z; VOX = voxel;
  const w0 = [0, 1, 2].map((c) => origin[c] + [0, 1, 2].reduce((s, a) => s + e[a][c] * (lo[a] + voxel * (0.5 - pad)), 0));
  // world -> source index (rows of the inverse of [dx dy dz])
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const r0 = cr(dy, dz), r1 = cr(dz, dx), r2 = cr(dx, dy), det = dot(dx, r0);
  const inv = [r0, r1, r2].map((r) => r.map((v) => v / det));
  const toIdx = (p) => { const q = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]; return [dot(inv[0], q), dot(inv[1], q), dot(inv[2], q)]; };
  const A0 = toIdx(w0);
  const step = e.map((ea) => { const q = toIdx([w0[0] + ea[0] * voxel, w0[1] + ea[1] * voxel, w0[2] + ea[2] * voxel]); return [q[0] - A0[0], q[1] - A0[1], q[2] - A0[2]]; });
  const [sx, sy, sz] = step;

  let fill = Infinity;
  for (let i = 0; i < data.length; i += 97) if (data[i] < fill) fill = data[i];
  const out = new Float32Array(N).fill(fill);
  const cover = new Uint8Array(N); // 1 where the scan has data (the rest of the grid is padding)
  const s = nx * ny;
  // Slices far apart (thick-slice MRI, 5 mm CT): straight-line blending between
  // them leaves a ridge at every slice, so run a smooth curve through four slices.
  const slice = Math.hypot(dz[0], dz[1], dz[2]);
  const cubic = slice >= 2.5 && slice > voxel * 1.5 && nz >= 4;
  const bil = (zi, x0, x1, y0, y1, tx, ty) => {
    const a = zi * s + y0 * nx, b = zi * s + y1 * nx;
    return (data[a + x0] * (1 - tx) + data[a + x1] * tx) * (1 - ty) + (data[b + x0] * (1 - tx) + data[b + x1] * tx) * ty;
  };
  // average 2x2 sub-samples in-plane when shrinking, to avoid aliasing thin bone
  const srcSpacing = Math.hypot(dx[0], dx[1], dx[2]);
  const sub = voxel > srcSpacing * 1.5 ? [-0.25, 0.25] : [0];
  const wgt = 1 / (sub.length * sub.length);
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      let o = z * XY + y * X;
      for (let x = 0; x < X; x++, o++) {
        let acc = 0, cnt = 0;
        for (const ox of sub) for (const oy of sub) {
          const fx = A0[0] + (x + ox) * sx[0] + (y + oy) * sy[0] + z * sz[0];
          const fy = A0[1] + (x + ox) * sx[1] + (y + oy) * sy[1] + z * sz[1];
          const fz = A0[2] + (x + ox) * sx[2] + (y + oy) * sy[2] + z * sz[2];
          if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nx - 0.5 || fy > ny - 0.5 || fz > nz - 0.5) continue;
          const cx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx, cy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy, cz = fz < 0 ? 0 : fz > nz - 1 ? nz - 1 : fz;
          const x0 = cx | 0, y0 = cy | 0, z0 = cz | 0;
          const x1 = x0 + 1 < nx ? x0 + 1 : x0, y1 = y0 + 1 < ny ? y0 + 1 : y0, z1 = z0 + 1 < nz ? z0 + 1 : z0;
          const tx = cx - x0, ty = cy - y0, tz = cz - z0;
          const a = z0 * s + y0 * nx, b = z0 * s + y1 * nx, c = z1 * s + y0 * nx, d = z1 * s + y1 * nx;
          const v0 = (data[a + x0] * (1 - tx) + data[a + x1] * tx) * (1 - ty) + (data[b + x0] * (1 - tx) + data[b + x1] * tx) * ty;
          const v1 = (data[c + x0] * (1 - tx) + data[c + x1] * tx) * (1 - ty) + (data[d + x0] * (1 - tx) + data[d + x1] * tx) * ty;
          if (cubic) {
            const pa = z0 > 0 ? bil(z0 - 1, x0, x1, y0, y1, tx, ty) : v0, pb = z1 + 1 < nz ? bil(z1 + 1, x0, x1, y0, y1, tx, ty) : v1;
            let v = v0 + 0.5 * tz * (v1 - pa + tz * (2 * pa - 5 * v0 + 4 * v1 - pb + tz * (3 * (v0 - v1) + pb - pa)));
            const lo4 = Math.min(pa, v0, v1, pb), hi4 = Math.max(pa, v0, v1, pb);
            acc += v < lo4 ? lo4 : v > hi4 ? hi4 : v;
          } else acc += v0 * (1 - tz) + v1 * tz;
          cnt++;
        }
        if (cnt) { out[o] = cnt === sub.length * sub.length ? acc * wgt : acc / cnt; cover[o] = 1; }
      }
    }
  }
  // which grid axis runs head-foot (for per-slice hole filling)
  let zAxis = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(e[a][2]) > Math.abs(e[zAxis][2])) zAxis = a;
  return { field: out, cover, e, w0, zAxis, fill, slice };
}

// ----------------------------------------------------------- filtering -----
function gaussian(src, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const out = floatVolume();
  out.set(src);
  for (let axis = 0; axis < 3; axis++) runLines('gauss', out, axis, k);
  return out;
}

// Blur along one grid axis only (axis 2 is the direction the slices are stacked in).
function gaussianAxis(src, sigma, axis) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const out = floatVolume();
  out.set(src);
  runLines('gauss', out, axis, k);
  return out;
}

// Squared Euclidean distance (in voxels) from every voxel to the nearest set voxel.
function edt(mask) {
  const d = floatVolume();
  for (let i = 0; i < N; i++) d[i] = mask[i] ? 0 : EDT_INF;
  for (let axis = 0; axis < 3; axis++) runLines('edt', d, axis);
  return d;
}
const r2 = (mm) => { const r = mm / VOX; return r * r + 1e-6; };
function dilate(mask, mm) {
  const d = edt(mask), lim = r2(mm), out = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (d[i] <= lim) out[i] = 1;
  return out;
}
function erode(mask, mm) {
  const invm = new Uint8Array(N);
  for (let i = 0; i < N; i++) invm[i] = mask[i] ? 0 : 1;
  const d = edt(invm), lim = r2(mm), out = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (d[i] > lim) out[i] = 1;
  return out;
}
const closing = (mask, mm) => erode(dilate(mask, mm), mm);
const opening = (mask, mm) => dilate(erode(mask, mm), mm);

// 6-connected components. keep(size, largest) decides which survive.
function components(mask, keep) {
  const lab = new Uint8Array(N); // 0 unvisited, 1 visited
  let stack = new Int32Array(1 << 16);
  const comps = [];
  const flood = (seed, mark) => {
    let sp = 0, size = 0;
    stack[sp++] = seed; lab[seed] = mark;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % X, y = ((i / X) | 0) % Y, z = (i / XY) | 0;
      if (sp + 6 >= stack.length) { const g = new Int32Array(stack.length * 2); g.set(stack); stack = g; }
      let j;
      if (x > 0 && mask[j = i - 1] && lab[j] !== mark) { lab[j] = mark; stack[sp++] = j; }
      if (x < X - 1 && mask[j = i + 1] && lab[j] !== mark) { lab[j] = mark; stack[sp++] = j; }
      if (y > 0 && mask[j = i - X] && lab[j] !== mark) { lab[j] = mark; stack[sp++] = j; }
      if (y < Y - 1 && mask[j = i + X] && lab[j] !== mark) { lab[j] = mark; stack[sp++] = j; }
      if (z > 0 && mask[j = i - XY] && lab[j] !== mark) { lab[j] = mark; stack[sp++] = j; }
      if (z < Z - 1 && mask[j = i + XY] && lab[j] !== mark) { lab[j] = mark; stack[sp++] = j; }
    }
    return size;
  };
  for (let i = 0; i < N; i++) if (mask[i] && !lab[i]) comps.push({ seed: i, size: flood(i, 1) });
  let largest = 0;
  for (const c of comps) if (c.size > largest) largest = c.size;
  for (const c of comps) if (keep(c.size, largest)) flood(c.seed, 2);
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (lab[i] === 2) out[i] = 1;
  return out;
}
const largestComponent = (mask) => components(mask, (s, l) => s === l);

// Fill enclosed background in every slice perpendicular to `axis`.
function fillSlices(mask, axis) {
  const out = new Uint8Array(mask);
  const dims = [X, Y, Z], strides = [1, X, XY];
  const ua = (axis + 1) % 3, va = (axis + 2) % 3;
  const U = dims[ua], V = dims[va], su = strides[ua], sv = strides[va], sa = strides[axis];
  const seen = new Uint8Array(U * V), q = new Int32Array(U * V);
  for (let a = 0; a < dims[axis]; a++) {
    seen.fill(0);
    let qt = 0;
    const base = a * sa;
    const push = (u, v) => { const k = v * U + u; if (!seen[k] && !mask[base + u * su + v * sv]) { seen[k] = 1; q[qt++] = k; } };
    for (let u = 0; u < U; u++) { push(u, 0); push(u, V - 1); }
    for (let v = 0; v < V; v++) { push(0, v); push(U - 1, v); }
    for (let qh = 0; qh < qt; qh++) {
      const k = q[qh], u = k % U, v = (k / U) | 0;
      if (u > 0) push(u - 1, v); if (u < U - 1) push(u + 1, v); if (v > 0) push(u, v - 1); if (v < V - 1) push(u, v + 1);
    }
    for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) if (!seen[v * U + u]) out[base + u * su + v * sv] = 1;
  }
  return out;
}
// Fill cavities fully enclosed in 3-D.
function fillHoles(mask) {
  const bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) bg[i] = mask[i] ? 0 : 1;
  const outside = components(bg, (s, l) => s === l); // the surrounding air is the largest background piece
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}
// Clear everything in a mask more than `mm` below its top (toward the feet).
// Returns the height that is left, in millimeters.
function trimBelow(mask, grid, mm) {
  const axis = grid.zAxis, stride = [1, X, XY][axis], n = [X, Y, Z][axis];
  const up = grid.e[axis][2] > 0; // does this grid axis run toward the head?
  let lo = n, hi = -1;
  for (let i = 0; i < N; i++) if (mask[i]) { const k = ((i / stride) | 0) % n; if (k < lo) lo = k; if (k > hi) hi = k; }
  if (hi < lo) return 0;
  const keep = Math.round(mm / VOX);
  if (hi - lo + 1 <= keep) return (hi - lo + 1) * VOX;
  const from = up ? hi - keep + 1 : lo, to = up ? hi : lo + keep - 1;
  for (let i = 0; i < N; i++) if (mask[i]) { const k = ((i / stride) | 0) % n; if (k < from || k > to) mask[i] = 0; }
  return keep * VOX;
}
// Grow a mask (in place) `steps` voxels outward, but only through voxels of `within`.
function growWithin(mask, within, steps) {
  if (steps <= 0) return;
  let front = [];
  const tryAdd = (j, list) => { if (within[j] && !mask[j]) { mask[j] = 1; list.push(j); } };
  for (let i = XY; i < N - XY; i++) {
    if (!mask[i]) continue;
    if (!mask[i - 1] || !mask[i + 1] || !mask[i - X] || !mask[i + X] || !mask[i - XY] || !mask[i + XY]) front.push(i);
  }
  for (let s = 0; s < steps && front.length; s++) {
    const next = [];
    for (const i of front) {
      if (i < XY || i >= N - XY) continue;
      tryAdd(i - 1, next); tryAdd(i + 1, next); tryAdd(i - X, next); tryAdd(i + X, next); tryAdd(i - XY, next); tryAdd(i + XY, next);
    }
    front = next;
  }
}
const count = (m) => { let n = 0; for (let i = 0; i < N; i++) n += m[i]; return n; };
const and = (a, b) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = a[i] & b[i]; return o; };
const andNot = (a, b) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = a[i] & (b[i] ^ 1); return o; };
const thresh = (f, lo, hi = Infinity) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) { const v = f[i]; if (v >= lo && v <= hi) o[i] = 1; } return o; };

// ------------------------------------------------------------- meshing -----
// Naive Surface Nets on a blurred mask; vertices are returned in grid coordinates.
// With `intensity` ({ field, level, width }) the surface follows the scan's own
// values at `level` inside the mask (sub-voxel accurate, no stair-steps);
// otherwise it follows the mask outline after a light blur.
function surfaceNets(mask, sigma, intensity) {
  let f;
  if (intensity) {
    f = new Float32Array(N);
    const { field, level, width, sign = 1, within = null, soften = 0.8, force = null } = intensity;
    // `force` marks voxels that are inside no matter what the scan says there
    // (the filled core of a solid part); blurred so it meets the surface smoothly
    let core = null;
    if (force) {
      const c = new Float32Array(N);
      for (let i = 0; i < N; i++) c[i] = force[i];
      core = gaussian(c, 0.8);
    }
    // `within` (a hull) bounds the surface with a soft edge, so the outside of the
    // shape is smooth while the scan's values carve the detail inside it.
    let soft = null;
    if (within) {
      const h = new Float32Array(N);
      for (let i = 0; i < N; i++) h[i] = within[i];
      soft = gaussian(h, soften);
    }
    for (let i = XY; i < N - XY; i++) {
      if (soft) {
        if (soft[i] < 0.02) continue;
      } else if (!(mask[i] || mask[i - 1] || mask[i + 1] || mask[i - X] || mask[i + X] || mask[i - XY] || mask[i + XY])) continue;
      let v = 0.5 + sign * (field[i] - level) / width;
      v = v < 0 ? 0 : v > 2 ? 2 : v;
      if (core && core[i] > v) v = core[i];
      f[i] = soft && soft[i] < v ? soft[i] : v;
    }
  } else {
    const f0 = new Float32Array(N);
    for (let i = 0; i < N; i++) f0[i] = mask[i];
    f = sigma > 0 ? gaussian(f0, sigma) : f0;
  }
  const iso = 0.5;
  let pos = new Float32Array(3 << 16), np = 0;
  let idx = new Uint32Array(6 << 16), ni = 0;
  let prev = new Int32Array(XY).fill(-1), cur = new Int32Array(XY).fill(-1);
  const g = new Float32Array(8);
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (ni + 6 > idx.length) { const n2 = new Uint32Array(idx.length * 2); n2.set(idx); idx = n2; }
    idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d;
  };
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let z = 0; z < Z - 1; z++) {
    cur.fill(-1);
    for (let y = 0; y < Y - 1; y++) {
      for (let x = 0; x < X - 1; x++) {
        const o = z * XY + y * X + x;
        g[0] = f[o]; g[1] = f[o + 1]; g[2] = f[o + X]; g[3] = f[o + X + 1];
        g[4] = f[o + XY]; g[5] = f[o + XY + 1]; g[6] = f[o + XY + X]; g[7] = f[o + XY + X + 1];
        let bits = 0;
        for (let c = 0; c < 8; c++) if (g[c] >= iso) bits |= 1 << c;
        if (bits === 0 || bits === 255) continue;
        let px = 0, py = 0, pz = 0, n = 0;
        for (let k = 0; k < 12; k++) {
          const a = EDGES[k][0], b = EDGES[k][1];
          if (((bits >> a) & 1) === ((bits >> b) & 1)) continue;
          const t = (iso - g[a]) / (g[b] - g[a]);
          px += (a & 1) + t * ((b & 1) - (a & 1));
          py += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          pz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          n++;
        }
        if (np * 3 + 3 > pos.length) { const n2 = new Float32Array(pos.length * 2); n2.set(pos); pos = n2; }
        pos[np * 3] = x + px / n; pos[np * 3 + 1] = y + py / n; pos[np * 3 + 2] = z + pz / n;
        const c = y * X + x;
        cur[c] = np++;
        const in0 = bits & 1;
        // edges leaving corner 0 along x, y, z
        if (((bits >> 1) & 1) !== in0 && y > 0 && z > 0) { // x edge: cells differing in y,z
          if (in0) quad(cur[c], cur[c - X], prev[c - X], prev[c]); else quad(cur[c], prev[c], prev[c - X], cur[c - X]);
        }
        if (((bits >> 2) & 1) !== in0 && x > 0 && z > 0) { // y edge: cells differing in z,x
          if (in0) quad(cur[c], prev[c], prev[c - 1], cur[c - 1]); else quad(cur[c], cur[c - 1], prev[c - 1], prev[c]);
        }
        if (((bits >> 4) & 1) !== in0 && x > 0 && y > 0) { // z edge: cells differing in x,y
          if (in0) quad(cur[c], cur[c - 1], cur[c - 1 - X], cur[c - X]); else quad(cur[c], cur[c - X], cur[c - 1 - X], cur[c - 1]);
        }
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  return { positions: pos.slice(0, np * 3), indices: idx.slice(0, ni) };
}

// Taubin λ|μ smoothing: removes voxel stair-steps without shrinking the shape.
function taubin(positions, indices, iterations) {
  const nv = positions.length / 3;
  const deg = new Uint32Array(nv + 1);
  for (let i = 0; i < indices.length; i += 3) { deg[indices[i]] += 2; deg[indices[i + 1]] += 2; deg[indices[i + 2]] += 2; }
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) start[i + 1] = start[i] + deg[i];
  const fillp = new Uint32Array(start.subarray(0, nv));
  const adj = new Uint32Array(start[nv]);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    adj[fillp[a]++] = b; adj[fillp[a]++] = c; adj[fillp[b]++] = a; adj[fillp[b]++] = c; adj[fillp[c]++] = a; adj[fillp[c]++] = b;
  }
  let p = positions, q = new Float32Array(p.length);
  const step = (k) => {
    for (let v = 0; v < nv; v++) {
      const s = start[v], e = start[v + 1], n = e - s;
      if (!n) { q[v * 3] = p[v * 3]; q[v * 3 + 1] = p[v * 3 + 1]; q[v * 3 + 2] = p[v * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let j = s; j < e; j++) { const w = adj[j] * 3; x += p[w]; y += p[w + 1]; z += p[w + 2]; }
      q[v * 3] = p[v * 3] + k * (x / n - p[v * 3]);
      q[v * 3 + 1] = p[v * 3 + 1] + k * (y / n - p[v * 3 + 1]);
      q[v * 3 + 2] = p[v * 3 + 2] + k * (z / n - p[v * 3 + 2]);
    }
    const t = p; p = q; q = t;
  };
  for (let i = 0; i < iterations; i++) { step(0.5); step(-0.53); }
  return p;
}

// Reduce the triangle count by collapsing the edges that change the shape least
// (quadric error metric, after Garland & Heckbert / Forstmann's fast variant).
// Works in place on grid coordinates; closed meshes stay closed.
function simplify(pos, idx, target) {
  const nv = pos.length / 3;
  let nt = idx.length / 3;
  if (target >= nt || nt < 16) return { positions: pos, indices: idx };
  const P = new Float64Array(pos), Q = new Float64Array(nv * 10);
  const T = new Uint32Array(idx);
  const tDel = new Uint8Array(nt), tDirty = new Uint8Array(nt);
  const tErr = new Float64Array(nt * 4), tN = new Float64Array(nt * 3);
  const vStart = new Uint32Array(nv), vCount = new Uint32Array(nv);
  let refT = new Uint32Array(nt * 6), refS = new Uint8Array(nt * 6), nRef = 0;
  const q = new Float64Array(10), p = new Float64Array(3);
  const det = (a, b, c, d, e, f, g, h, i) => q[a] * q[e] * q[i] + q[c] * q[d] * q[h] + q[b] * q[f] * q[g] - q[c] * q[e] * q[g] - q[a] * q[f] * q[h] - q[b] * q[d] * q[i];
  const vErr = (x, y, z) => q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  // best position for merging vertices a and b; result in p, returns the error
  const calc = (a, b) => {
    for (let k = 0; k < 10; k++) q[k] = Q[a * 10 + k] + Q[b * 10 + k];
    const d = det(0, 1, 2, 1, 4, 5, 2, 5, 7);
    if (Math.abs(d) > 1e-12) {
      p[0] = -det(1, 2, 3, 4, 5, 6, 5, 7, 8) / d;
      p[1] = det(0, 2, 3, 1, 5, 6, 2, 7, 8) / d;
      p[2] = -det(0, 1, 3, 1, 4, 6, 2, 5, 8) / d;
      return vErr(p[0], p[1], p[2]);
    }
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const e1 = vErr(ax, ay, az), e2 = vErr(bx, by, bz), e3 = vErr((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    const m = Math.min(e1, e2, e3);
    if (m === e1) { p[0] = ax; p[1] = ay; p[2] = az; } else if (m === e2) { p[0] = bx; p[1] = by; p[2] = bz; } else { p[0] = (ax + bx) / 2; p[1] = (ay + by) / 2; p[2] = (az + bz) / 2; }
    return m;
  };
  const normal = (t) => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    tN[t * 3] = x / l; tN[t * 3 + 1] = y / l; tN[t * 3 + 2] = z / l;
  };
  const errors = (t) => {
    let m = Infinity;
    for (let j = 0; j < 3; j++) { const e = calc(T[t * 3 + j], T[t * 3 + (j + 1) % 3]); tErr[t * 4 + j] = e; if (e < m) m = e; }
    tErr[t * 4 + 3] = m;
  };
  const rebuild = (first) => {
    if (!first) { // drop deleted triangles
      let d = 0;
      for (let t = 0; t < nt; t++) {
        if (tDel[t]) continue;
        if (d !== t) {
          T[d * 3] = T[t * 3]; T[d * 3 + 1] = T[t * 3 + 1]; T[d * 3 + 2] = T[t * 3 + 2];
          for (let k = 0; k < 4; k++) tErr[d * 4 + k] = tErr[t * 4 + k];
          tN[d * 3] = tN[t * 3]; tN[d * 3 + 1] = tN[t * 3 + 1]; tN[d * 3 + 2] = tN[t * 3 + 2];
        }
        d++;
      }
      nt = d; tDel.fill(0);
    } else {
      for (let t = 0; t < nt; t++) {
        normal(t);
        const a = T[t * 3] * 3, nx = tN[t * 3], ny = tN[t * 3 + 1], nz = tN[t * 3 + 2];
        const dd = -(nx * P[a] + ny * P[a + 1] + nz * P[a + 2]);
        const pl = [nx * nx, nx * ny, nx * nz, nx * dd, ny * ny, ny * nz, ny * dd, nz * nz, nz * dd, dd * dd];
        for (let j = 0; j < 3; j++) { const v = T[t * 3 + j] * 10; for (let k = 0; k < 10; k++) Q[v + k] += pl[k]; }
      }
      for (let t = 0; t < nt; t++) errors(t);
    }
    vCount.fill(0);
    for (let i = 0; i < nt * 3; i++) vCount[T[i]]++;
    let s = 0;
    for (let v = 0; v < nv; v++) { vStart[v] = s; s += vCount[v]; vCount[v] = 0; }
    if (refT.length < nt * 6) { refT = new Uint32Array(nt * 6); refS = new Uint8Array(nt * 6); }
    for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) { const v = T[t * 3 + j], r = vStart[v] + vCount[v]++; refT[r] = t; refS[r] = j; }
    nRef = nt * 3;
  };
  const d0 = [], d1 = [];
  const flipped = (i0, i1, del) => {
    for (let k = 0; k < vCount[i0]; k++) {
      const t = refT[vStart[i0] + k];
      if (tDel[t]) continue;
      const s = refS[vStart[i0] + k], id1 = T[t * 3 + (s + 1) % 3], id2 = T[t * 3 + (s + 2) % 3];
      if (id1 === i1 || id2 === i1) { del[k] = 1; continue; }
      let ax = P[id1 * 3] - p[0], ay = P[id1 * 3 + 1] - p[1], az = P[id1 * 3 + 2] - p[2];
      let bx = P[id2 * 3] - p[0], by = P[id2 * 3 + 1] - p[1], bz = P[id2 * 3 + 2] - p[2];
      const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
      ax /= la; ay /= la; az /= la; bx /= lb; by /= lb; bz /= lb;
      if (Math.abs(ax * bx + ay * by + az * bz) > 0.999) return true;
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      del[k] = 0;
      if ((nx * tN[t * 3] + ny * tN[t * 3 + 1] + nz * tN[t * 3 + 2]) / l < 0.2) return true;
    }
    return false;
  };
  let deleted = 0;
  const total = nt;
  const retarget = (i0, v, del) => {
    const start = vStart[v], n = vCount[v];
    for (let k = 0; k < n; k++) {
      const t = refT[start + k];
      if (tDel[t]) continue;
      if (del[k]) { tDel[t] = 1; deleted++; continue; }
      const s = refS[start + k];
      T[t * 3 + s] = i0; tDirty[t] = 1;
      normal(t); errors(t);
      if (nRef >= refT.length) { const a = new Uint32Array(refT.length * 2); a.set(refT); refT = a; const b = new Uint8Array(refS.length * 2); b.set(refS); refS = b; }
      refT[nRef] = t; refS[nRef] = s; nRef++;
    }
  };
  for (let iter = 0; iter < 100; iter++) {
    if (total - deleted <= target) break;
    if (iter % 5 === 0) rebuild(iter === 0);
    tDirty.fill(0);
    const thr = 1e-9 * Math.pow(iter + 3, 7);
    for (let t = 0; t < nt; t++) {
      if (tErr[t * 4 + 3] > thr || tDel[t] || tDirty[t]) continue;
      for (let j = 0; j < 3; j++) {
        if (tErr[t * 4 + j] >= thr) continue;
        const i0 = T[t * 3 + j], i1 = T[t * 3 + (j + 1) % 3];
        calc(i0, i1);
        const px = p[0], py = p[1], pz = p[2];
        if (flipped(i0, i1, d0)) continue;
        if (flipped(i1, i0, d1)) continue;
        P[i0 * 3] = px; P[i0 * 3 + 1] = py; P[i0 * 3 + 2] = pz;
        for (let k = 0; k < 10; k++) Q[i0 * 10 + k] += Q[i1 * 10 + k];
        const start = nRef;
        retarget(i0, i0, d0); retarget(i0, i1, d1);
        vStart[i0] = start; vCount[i0] = nRef - start;
        break;
      }
      if (total - deleted <= target) break;
    }
  }
  // compact
  const remap = new Int32Array(nv).fill(-1);
  const outI = new Uint32Array((total - deleted) * 3);
  let k = 0, n = 0;
  for (let t = 0; t < nt; t++) {
    if (tDel[t]) continue;
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const v of [a, b, c]) { if (remap[v] < 0) remap[v] = n++; outI[k++] = remap[v]; }
  }
  const outP = new Float32Array(n * 3);
  for (let v = 0; v < nv; v++) { const r = remap[v]; if (r >= 0) { outP[r * 3] = P[v * 3]; outP[r * 3 + 1] = P[v * 3 + 1]; outP[r * 3 + 2] = P[v * 3 + 2]; } }
  return { positions: outP, indices: outI.slice(0, k) };
}

// Keep only the big connected shells of a mesh (drops specks, flakes and
// stray inner bubbles). keepFraction = 1 keeps just the largest shell.
function keepLargeShells(m, keepFraction) {
  const nv = m.positions.length / 3, idx = m.indices;
  const parent = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < idx.length; i += 3) {
    const a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]);
    if (a !== b) parent[b] = a;
    if (a !== c) parent[find(c)] = a;
  }
  const tris = new Uint32Array(nv);
  for (let i = 0; i < idx.length; i += 3) tris[find(idx[i])]++;
  let largest = 0;
  for (let i = 0; i < nv; i++) if (tris[i] > largest) largest = tris[i];
  const min = Math.max(1, largest * keepFraction);
  const remap = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let v = 0; v < nv; v++) if (tris[find(v)] >= min) remap[v] = n++;
  if (n === nv) return m;
  const pos = new Float32Array(n * 3);
  for (let v = 0; v < nv; v++) { const r = remap[v]; if (r >= 0) { pos[r * 3] = m.positions[v * 3]; pos[r * 3 + 1] = m.positions[v * 3 + 1]; pos[r * 3 + 2] = m.positions[v * 3 + 2]; } }
  const out = new Uint32Array(idx.length);
  let k = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = remap[idx[i]];
    if (a < 0) continue;
    out[k++] = a; out[k++] = remap[idx[i + 1]]; out[k++] = remap[idx[i + 2]];
  }
  return { positions: pos, indices: out.slice(0, k) };
}

// "Clean up for 3D printing": turn a raw mask into one solid, closed piece.
// "Solid inside": the region to fill so a part prints as one solid body while
// its outer surface stays exactly as it was.
//  - brain: everything deeper than 8 mm under the outer envelope (the fluid
//    chambers and the bottoms of the deepest folds); shallower folds are kept.
//  - bone:  the space the skull encloses (gaps in the skull are sealed first).
function solidCore(key, mask, grid) {
  if (key === 'brain' || key === 'skin') {
    const hull = fillHoles(closing(mask, 4));
    return erode(hull, 8);
  }
  if (key === 'bone') {
    const sealed = closing(mask, 6);
    return andNot(fillSlices(sealed, grid.zAxis), sealed);
  }
  return null;
}

// f = finish settings: { close, open (mm), pieces (0 keep all … 1 largest only), fill }
function cleanMask(key, mask, f) {
  const pieces = (m, frac) => (frac <= 0 ? m : frac >= 1 ? largestComponent(m) : components(m, (s, l) => s >= l * frac));
  let m = mask;
  if (key === 'vessels') {
    // thin by nature: only bridge tiny gaps, and never reduce to a single piece
    if (f.close > 0) m = closing(m, Math.min(f.close, 0.6));
    return pieces(m, f.pieces >= 1 ? 0.1 : f.pieces);
  }
  if (key === 'bone') {
    // seal pinholes in thin bone; an opening would eat the thin bones, so none here
    if (f.close > 0) m = closing(m, f.close);
    m = pieces(m, f.pieces);
  } else {
    // soft parts: drop flakes and thin bridges, then grow back to the original outline
    if (f.open > 0) m = and(dilate(pieces(opening(m, f.open), f.pieces), f.open), mask);
    else m = pieces(m, f.pieces);
    if (f.close > 0) m = closing(m, f.close * 0.8);
  }
  return f.fill ? fillHoles(m) : m;
}

function finishMesh(m, grid, smoothIters, reduce = 1, pieces = 0) {
  if (!m.indices.length) return null;
  let p = taubin(m.positions, m.indices, smoothIters);
  if (reduce < 1) {
    const r = simplify(p, m.indices, Math.round(m.indices.length / 3 * reduce));
    m = { positions: r.positions, indices: r.indices };
    if (pieces > 0) m = keepLargeShells(m, pieces); // collapsing can pinch off crumbs
    p = taubin(m.positions, m.indices, 1); // settle the new triangles
  }
  // grid -> world millimeters
  const { e, w0 } = grid, nv = p.length / 3;
  const out = new Float32Array(p.length);
  for (let v = 0; v < nv; v++) {
    const x = p[v * 3] * VOX, y = p[v * 3 + 1] * VOX, z = p[v * 3 + 2] * VOX;
    out[v * 3] = w0[0] + x * e[0][0] + y * e[1][0] + z * e[2][0];
    out[v * 3 + 1] = w0[1] + x * e[0][1] + y * e[1][1] + z * e[2][1];
    out[v * 3 + 2] = w0[2] + x * e[0][2] + y * e[1][2] + z * e[2][2];
  }
  // make triangles face outward (positive enclosed volume)
  const idx = m.indices;
  let vol6 = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    vol6 += out[a] * (out[b + 1] * out[c + 2] - out[b + 2] * out[c + 1]) - out[a + 1] * (out[b] * out[c + 2] - out[b + 2] * out[c]) + out[a + 2] * (out[b] * out[c + 1] - out[b + 1] * out[c]);
  }
  if (vol6 < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const nor = new Float32Array(out.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = out[b] - out[a], uy = out[b + 1] - out[a + 1], uz = out[b + 2] - out[a + 2];
    const vx = out[c] - out[a], vy = out[c + 1] - out[a + 1], vz = out[c + 2] - out[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { nor[k] += nx; nor[k + 1] += ny; nor[k + 2] += nz; }
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]) || 1;
    nor[v * 3] /= l; nor[v * 3 + 1] /= l; nor[v * 3 + 2] /= l;
  }
  return { positions: out, normals: nor, indices: idx, volumeMl: Math.abs(vol6) / 6 / 1000 };
}

// ------------------------------------------------------------ pipelines ----
function percentiles(f, fill) {
  const s = [];
  for (let i = 0; i < N; i += 53) if (f[i] !== fill) s.push(f[i]);
  s.sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { p2: at(0.02), p50: at(0.5), p98: at(0.98) };
}

// Split the voxels inside a brain hull into fluid and brain tissue.
// Three brightness classes are found (k-means); the fluid class is whichever
// extreme class sits closest to the hull surface (fluid surrounds the brain,
// white matter is deep). Works for T1 (dark fluid) and T2/FLAIR (bright fluid).
// Three brightness classes (k-means) of a sorted list of values: centers and sizes.
function kmeans3(vals) {
  const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
  const c = [q(0.1), q(0.5), q(0.9)];
  let n = [0, 0, 0];
  for (let it = 0; it < 25; it++) {
    const sum = [0, 0, 0];
    n = [0, 0, 0];
    const b0 = (c[0] + c[1]) / 2, b1 = (c[1] + c[2]) / 2;
    for (const v of vals) { const k = v < b0 ? 0 : v < b1 ? 1 : 2; sum[k] += v; n[k]++; }
    for (let k = 0; k < 3; k++) if (n[k]) c[k] = sum[k] / n[k];
  }
  return { c, n };
}

function classifyTissue(field, hull, fluid = 'auto', folds = 0, maxValue = Infinity) {
  const vals = [];
  for (let i = 0; i < N; i += 7) if (hull[i] && field[i] <= maxValue) vals.push(field[i]);
  if (vals.length < 3000) return null;
  vals.sort((a, b) => a - b);
  const { c } = kmeans3(vals);
  if (!(c[2] - c[0] > 1e-6)) return null;
  const outside = new Uint8Array(N);
  for (let i = 0; i < N; i++) outside[i] = hull[i] ^ 1;
  const depth = edt(outside);
  const b0 = (c[0] + c[1]) / 2, b1 = (c[1] + c[2]) / 2;
  let dLo = 0, nLo = 0, dHi = 0, nHi = 0;
  for (let i = 0; i < N; i += 3) {
    if (!hull[i]) continue;
    const v = field[i];
    if (v < b0) { dLo += Math.sqrt(depth[i]); nLo++; } else if (v >= b1) { dHi += Math.sqrt(depth[i]); nHi++; }
  }
  const fluidIsDark = fluid === 'dark' || (fluid !== 'bright' && (dLo / Math.max(nLo, 1)) <= (dHi / Math.max(nHi, 1)));
  // folds (-1 … 1) moves the line between fluid and brain: positive cuts the folds deeper
  const k = Math.max(-1, Math.min(1, folds)) * 0.42;
  return fluidIsDark
    ? { level: (c[0] + c[1]) / 2 + k * (c[1] - c[0]), width: 2 * (c[1] - c[0]), sign: 1, classes: c }
    : { level: (c[1] + c[2]) / 2 - k * (c[2] - c[1]), width: 2 * (c[2] - c[1]), sign: -1, classes: c };
}

// Brain tissue inside a hull: drop the fluid so the folds of the cortex remain.
function carveBrain(field, hull, cls) {
  const t = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (hull[i] && cls.sign * (field[i] - cls.level) > 0) t[i] = 1;
  return largestComponent(t);
}

function segmentCT(grid, opts, want, report) {
  const W = grid.field, masks = {}, notes = {}, surfaces = {};
  const smooth = gaussian(W, 1 / VOX);
  report(0.16, 'Finding the head…');
  let head = thresh(smooth, -300);
  head = largestComponent(opening(head, 2));
  head = fillSlices(head, grid.zAxis);
  masks.skin = head;
  if (!(want.bone || want.brain || want.vessels)) return { masks, notes, surfaces };

  report(0.3, 'Finding bone…');
  const dense = and(thresh(W, 700), head);
  const bone0 = and(thresh(W, opts.boneHU), head);
  // the space the skull encloses: seal gaps in the skull, then fill each cross-section
  const sealed = closing(bone0, 6);
  report(0.42, 'Finding the inside of the skull…');
  const inside = andNot(and(fillSlices(sealed, grid.zAxis), head), sealed);
  // contrast dye? look for bright (150–700 HU) tissue inside the skull but away from dense bone
  const nearDense = dilate(dense, 2.5);
  let dye = 0;
  for (let i = 0; i < N; i++) if (inside[i] && !nearDense[i] && W[i] >= 150 && W[i] < 700) dye++;
  const dyeMl = dye * VOX ** 3 / 1000;
  const contrast = dyeMl > 1.5;
  notes.contrast = contrast;

  let bone = bone0;
  if (contrast) {
    // Dye-filled vessels are as bright as thin bone. Keep only "bone" that is
    // attached to unmistakably dense bone within a few millimeters.
    const reach = dilate(dense, 3.5);
    bone = and(bone0, reach);
  }
  bone = components(bone, (s, l) => s >= l * 0.01);
  masks.bone = bone;

  if (want.brain || want.vessels) {
    report(0.56, 'Finding the brain…');
    const cand = new Uint8Array(N);
    const top = contrast ? 700 : 100;
    for (let i = 0; i < N; i++) if (inside[i] && !bone[i] && smooth[i] >= -10 && smooth[i] <= top) cand[i] = 1;
    let core = largestComponent(erode(cand, 4));
    let brain = and(dilate(core, 4.6), cand);
    brain = and(closing(brain, 2.5), inside);
    brain = and(fillHoles(brain), andNot(head, bone));
    // keep the folds: cerebrospinal fluid is ~0-15 HU, brain tissue ~25-45 HU
    const cls = { level: 19, width: 36, sign: 1 };
    masks.brain = carveBrain(smooth, brain, cls);
    surfaces.brain = { field: smooth, ...cls, within: brain };
    if (count(brain) * VOX ** 3 / 1000 < 300) notes.brain = 'Could not find a closed skull around the brain in this series';

    if (want.vessels) {
      report(0.7, 'Finding blood vessels…');
      if (!contrast) { notes.vessels = 'No contrast dye found in this series'; masks.vessels = new Uint8Array(N); }
      else {
        const zone = dilate(brain, 2);
        const boneGuard = dilate(bone, 1.2);
        let v = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (zone[i] && !boneGuard[i] && W[i] >= 160 && W[i] < 900) v[i] = 1;
        const minVox = 60 / VOX ** 3; // drop specks under 60 mm³
        masks.vessels = components(v, (s) => s >= minVox);
      }
    }
  }
  return { masks, notes, surfaces };
}

// ---- brain outline: a balloon that grows until it meets the skull -------------
// A sphere made of triangles (an icosahedron, each face split `level` times).
function icosphere(level) {
  const g = (1 + Math.sqrt(5)) / 2;
  let pos = [[-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0], [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g], [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]]
    .map((p) => { const l = Math.hypot(...p); return p.map((v) => v / l); });
  let tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < level; s++) {
    const mid = new Map(), next = [];
    const m = (a, b) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      let i = mid.get(key);
      if (i === undefined) {
        const p = [0, 1, 2].map((c) => pos[a][c] + pos[b][c]), l = Math.hypot(...p);
        i = pos.length; pos.push(p.map((v) => v / l)); mid.set(key, i);
      }
      return i;
    };
    for (const [a, b, c] of tris) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    tris = next;
  }
  const n = pos.length, sets = Array.from({ length: n }, () => new Set());
  for (const [a, b, c] of tris) { sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b); }
  const start = new Int32Array(n + 1), nbr = [];
  sets.forEach((s, i) => { for (const j of s) nbr.push(j); start[i + 1] = nbr.length; });
  return { n, unit: Float64Array.from(pos.flat()), tris: Int32Array.from(tris.flat()), start, nbr: Int32Array.from(nbr) };
}

// Grow a closed surface from a small sphere inside the brain until it lies on
// the edge of the brain (after Smith's Brain Extraction Tool, 2002). Each point
// of the surface looks a short way inward along its own direction: while it sees
// only brain-bright tissue it moves out, and it stops where the dark skull and
// fluid begin. Because it judges brightness against what is nearby, a dim part
// of the scan (the top slices) is followed as well as a bright one, and because
// the surface resists sharp bends it cannot leak out along a nerve or the neck.
//   P.t2, P.t, P.tm   darkest value, "not air" value, typical brain brightness
//   P.bt     0…1  how bright the tissue must stay for the surface to keep growing
//   P.stiff  1 = normal; higher resists bends more
// Positions are in grid voxels. Returns { pos, tris }.
function growSurface(field, center, radius, P) {
  const ico = icosphere(4), nv = ico.n, { tris, start, nbr } = ico;
  let p = new Float64Array(nv * 3), q = new Float64Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) p[i] = center[i % 3] + ico.unit[i] * radius;
  const nrm = new Float64Array(nv * 3);
  const { t2, t, tm, bt } = P;
  const rmin = 3.33 * P.stiff, rmax = 10 * P.stiff; // radii of curvature (mm) between "fine" and "too sharp"
  const E = (1 / rmin + 1 / rmax) / 2, F = 6 / (1 / rmin - 1 / rmax);
  const d1 = Math.round(P.d1 || 20), d2 = Math.round(P.d2 || 10), mm = 1 / VOX;
  const sample = (x, y, z) => {
    const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
    if (xi < 0 || yi < 0 || zi < 0 || xi >= X || yi >= Y || zi >= Z) return t2;
    return field[zi * XY + yi * X + xi];
  };
  const iters = P.iters || 1000;
  for (let it = 0; it < iters; it++) {
    nrm.fill(0);
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k] * 3, b = tris[k + 1] * 3, c = tris[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz; nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz; nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    // mean distance between neighboring points
    let l = 0;
    for (let v = 0; v < nv; v++) for (let k = start[v]; k < start[v + 1]; k++) { const j = nbr[k] * 3, i = v * 3; l += Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1], p[j + 2] - p[i + 2]); }
    l /= nbr.length;
    const lmm = l * VOX;
    for (let v = 0; v < nv; v++) {
      const i = v * 3;
      let nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      let mx = 0, my = 0, mz = 0;
      const cnt = start[v + 1] - start[v];
      for (let k = start[v]; k < start[v + 1]; k++) { const j = nbr[k] * 3; mx += p[j]; my += p[j + 1]; mz += p[j + 2]; }
      const sx = mx / cnt - p[i], sy = my / cnt - p[i + 1], sz = mz / cnt - p[i + 2];
      const sn = sx * nx + sy * ny + sz * nz;
      // 1. along the surface: keep the points evenly spread
      const tx = sx - sn * nx, ty = sy - sn * ny, tz = sz - sn * nz;
      // 2. smoothness: gentle bends are left alone, sharp ones are flattened
      const rinv = 2 * Math.abs(sn) * VOX / (lmm * lmm);
      const f2 = (1 + Math.tanh(F * (rinv - E))) / 2;
      // 3. brightness seen looking inward
      let Imin = tm, Imax = t;
      for (let d = 1; d < d1; d++) {
        let I = sample(p[i] - nx * d * mm, p[i + 1] - ny * d * mm, p[i + 2] - nz * d * mm);
        if (d <= 3 && I > P.fat) I = t2; // fat and marrow right at the surface stop it like the skull does
        if (I < Imin) Imin = I;
        if (d < d2 && I > Imax) Imax = I;
      }
      if (Imin < t2) Imin = t2;
      if (Imax > tm) Imax = tm;
      const tl = (Imax - t2) * bt + t2;
      const f3 = (Imax - t2 > 0 ? 2 * (Imin - tl) / (Imax - t2) : 2 * (Imin - tl)) * 0.05 * l;
      const m = f2 * sn + f3;
      q[i] = p[i] + 0.5 * tx + m * nx; q[i + 1] = p[i + 1] + 0.5 * ty + m * ny; q[i + 2] = p[i + 2] + 0.5 * tz + m * nz;
    }
    const sw = p; p = q; q = sw;
  }
  return { pos: p, tris };
}

// The voxels enclosed by a closed triangle surface (positions in grid voxels).
// Every column of voxels is crossed by the surface an even number of times; a
// voxel is inside when the crossings below it do not cancel out.
function fillSurface(pos, tris) {
  const cols = new Map(); // column index -> [z, direction, z, direction…]
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k] * 3, b = tris[k + 1] * 3, c = tris[k + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2], bx = pos[b], by = pos[b + 1], bz = pos[b + 2], cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const dir = area > 0 ? 1 : -1;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(X - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(Y - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5003, py = y + 0.4997; // just off the grid, so no ray runs exactly along an edge
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area, w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area, w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const key = y * X + x;
      let list = cols.get(key);
      if (!list) cols.set(key, list = []);
      list.push(w0 * az + w1 * bz + w2 * cz, dir);
    }
  }
  const out = new Uint8Array(N);
  for (const [key, list] of cols) {
    const hits = [];
    for (let i = 0; i < list.length; i += 2) hits.push([list[i], list[i + 1]]);
    hits.sort((u, v) => u[0] - v[0]);
    let wind = 0;
    for (let h = 0; h < hits.length - 1; h++) {
      wind += hits[h][1];
      if (!wind) continue;
      const z0 = Math.max(0, Math.ceil(hits[h][0] - 0.5)), z1 = Math.min(Z - 1, Math.floor(hits[h + 1][0] - 0.5));
      for (let z = z0; z <= z1; z++) out[z * XY + key] = 1;
    }
  }
  return out;
}

// Is fluid dark or bright in this MRI series? Read from its timing when the
// scan says: a long echo time shows fluid bright (T2) unless an inversion pulse
// nulls it (FLAIR); a short echo time shows it dark (T1). '' = cannot tell.
function fluidFromTiming(info) {
  if (!info || !(info.te > 0)) return '';
  if (info.te >= 50) return info.ti > 1500 ? 'dark' : 'bright';
  return info.te <= 20 ? 'dark' : '';
}

// The average of `field` over the voxels that pass `ok`, within about `sigma`
// voxels of each voxel (`fallback` where there are none nearby). It changes slowly,
// so it is worked out on a grid several times coarser and read back smoothly.
function localMean(field, ok, sigma, fallback) {
  const f = Math.max(1, Math.floor(sigma / 3)), cx = Math.ceil(X / f), cy = Math.ceil(Y / f), cz = Math.ceil(Z / f), cn = cx * cy * cz;
  let num = new Float32Array(cn), den = new Float32Array(cn);
  for (let z = 0, i = 0; z < Z; z++) for (let y = 0; y < Y; y++) {
    const row = ((z / f) | 0) * cx * cy + ((y / f) | 0) * cx;
    for (let x = 0; x < X; x++, i++) if (ok(i)) { const c = row + ((x / f) | 0); num[c] += field[i]; den[c] += 1; }
  }
  const s = sigma / f, r = Math.max(1, Math.ceil(s * 2.5)), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * s * s));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const blur = (a) => {
    for (const [n, stride, d1, s1, d2, s2] of [[cx, 1, cy, cx, cz, cx * cy], [cy, cx, cx, 1, cz, cx * cy], [cz, cx * cy, cx, 1, cy, cx]]) {
      const out = new Float32Array(cn);
      for (let b = 0; b < d2; b++) for (let a1 = 0; a1 < d1; a1++) {
        const base = b * s2 + a1 * s1;
        for (let p = 0; p < n; p++) {
          let v = 0;
          for (let j = -r; j <= r; j++) { const q = p + j; if (q >= 0 && q < n) v += a[base + q * stride] * k[j + r]; }
          out[base + p * stride] = v;
        }
      }
      a = out;
    }
    return a;
  };
  num = blur(num); den = blur(den);
  const mean = new Float32Array(cn);
  for (let i = 0; i < cn; i++) mean[i] = den[i] > 0.02 * f * f * f ? num[i] / den[i] : fallback;
  const out = floatVolume();
  for (let z = 0, i = 0; z < Z; z++) {
    const gz = Math.max(0, Math.min(cz - 1, (z + 0.5) / f - 0.5)), z0 = gz | 0, z1 = Math.min(cz - 1, z0 + 1), tz = gz - z0;
    for (let y = 0; y < Y; y++) {
      const gy = Math.max(0, Math.min(cy - 1, (y + 0.5) / f - 0.5)), y0 = gy | 0, y1 = Math.min(cy - 1, y0 + 1), ty = gy - y0;
      const a = z0 * cx * cy + y0 * cx, b = z0 * cx * cy + y1 * cx, c = z1 * cx * cy + y0 * cx, d = z1 * cx * cy + y1 * cx;
      for (let x = 0; x < X; x++, i++) {
        const gx = Math.max(0, Math.min(cx - 1, (x + 0.5) / f - 0.5)), x0 = gx | 0, x1 = Math.min(cx - 1, x0 + 1), tx = gx - x0;
        const lo = (mean[a + x0] * (1 - tx) + mean[a + x1] * tx) * (1 - ty) + (mean[b + x0] * (1 - tx) + mean[b + x1] * tx) * ty;
        const hi = (mean[c + x0] * (1 - tx) + mean[c + x1] * tx) * (1 - ty) + (mean[d + x0] * (1 - tx) + mean[d + x1] * tx) * ty;
        out[i] = lo * (1 - tz) + hi * tz;
      }
    }
  }
  return out;
}

// Is fluid dark or bright, judged from the outline of the brain alone? Fluid lies
// around the brain and in its folds, white matter lies deep. So of the darkest and
// the brightest tissue inside the outline, fluid is the one nearer the surface.
// Values above `limit` (fat, marrow, dye-filled vessels) are left out.
function fluidFromShape(field, env, limit) {
  const vals = [];
  for (let i = 0; i < N; i += 7) if (env[i] && field[i] <= limit) vals.push(field[i]);
  if (vals.length < 1000) return 'dark';
  vals.sort((a, b) => a - b);
  const { c } = kmeans3(vals);
  const outside = new Uint8Array(N);
  for (let i = 0; i < N; i++) outside[i] = env[i] ^ 1;
  const depth = edt(outside), b0 = (c[0] + c[1]) / 2, b1 = (c[1] + c[2]) / 2;
  let dLo = 0, nLo = 0, dHi = 0, nHi = 0;
  for (let i = 0; i < N; i += 3) {
    const v = field[i];
    if (!env[i] || v > limit) continue;
    if (v < b0) { dLo += Math.sqrt(depth[i]); nLo++; } else if (v >= b1) { dHi += Math.sqrt(depth[i]); nHi++; }
  }
  return dLo / Math.max(nLo, 1) <= dHi / Math.max(nHi, 1) ? 'dark' : 'bright';
}

// MRI has no fixed brightness scale, so everything is measured against the
// scan itself. The brain is found in four steps:
//   1. head     everything brighter than the background, filled in
//   2. start    the middle of the biggest solid lump of brain-bright tissue
//   3. outline  a closed surface grown from there until it meets the dark skull
//               (growSurface). It is judged against the brightness nearby, so
//               dim parts of a scan are kept, and it cannot leak along a nerve.
//   4. folds    inside the outline, fluid is told from brain tissue
// opts.mr fine-tunes the steps (anything left out is chosen automatically):
//   reach  -1…1  outline: tighter … fuller (0 = automatic)
//   stiff  0.5…3 how strongly the outline resists bumps (1 = normal)
//   grow   mm    move the finished outline out (+) or in (-)
//   bottom mm    cut everything more than this far below the top of the brain
//   folds  -1…1  shallower … deeper folds; 'none' keeps the whole outline
//   fluid  'auto' | 'dark' | 'bright'
//   fat    bool  treat tissue much brighter than brain (fat, marrow) as not brain
//   blend  mm    extra blending between slices (thick-slice scans)
//   split  0…3   how much deeper to cut between the two halves of the brain (1 = normal)
//   hind   bool  keep the cerebellum and brain stem smooth (no fine wrinkles)
// Steps are remembered on the grid (grid.memo), so the live preview only redoes
// what a changed setting affects.
// The brain as a neural network found it (opts.ai, see brainnet.js): its answer lives
// in a standard 1 mm cube; here it is brought onto the working grid. The surface is
// drawn where the network is half sure a voxel is brain, so it follows the outside of
// the gray matter: folds stay as full as they are, and the gap between the two halves
// and around the cerebellum is whatever the network saw there.
function brainFromModel(grid, opts, rest, report) {
  report(0.3, 'Placing the brain model\u2019s answer on the scan…');
  const ai = opts.ai, mr = opts.mr || {}, S = 256, S2 = S * S;
  const E = grid.e, w0 = grid.w0, A = ai.axes, c0 = ai.c0, prob = ai.prob, lab = ai.labels;
  const dotA = (a, v) => A[a][0] * v[0] + A[a][1] * v[1] + A[a][2] * v[2];
  const q0 = [0, 1, 2].map((a) => dotA(a, [w0[0] - c0[0], w0[1] - c0[1], w0[2] - c0[2]]));
  const st = [0, 1, 2].map((g) => [0, 1, 2].map((a) => dotA(a, E[g]) * VOX)); // cube step per grid step
  const P = floatVolume(), part = new Uint8Array(N);
  for (let z = 0, o = 0; z < Z; z++) for (let y = 0; y < Y; y++) {
    const bx = q0[0] + y * st[1][0] + z * st[2][0], by = q0[1] + y * st[1][1] + z * st[2][1], bz = q0[2] + y * st[1][2] + z * st[2][2];
    for (let x = 0; x < X; x++, o++) {
      const d = bx + x * st[0][0], h = by + x * st[0][1], w = bz + x * st[0][2];
      if (d < 0 || h < 0 || w < 0 || d > S - 1 || h > S - 1 || w > S - 1) { P[o] = 0; continue; }
      const d0 = d | 0, h0 = h | 0, w0i = w | 0, d1 = d0 < S - 1 ? d0 + 1 : d0, h1 = h0 < S - 1 ? h0 + 1 : h0, w1 = w0i < S - 1 ? w0i + 1 : w0i;
      const td = d - d0, th = h - h0, tw = w - w0i;
      const a = d0 * S2 + h0 * S, b = d0 * S2 + h1 * S, c = d1 * S2 + h0 * S, e = d1 * S2 + h1 * S;
      const v0 = (prob[a + w0i] * (1 - tw) + prob[a + w1] * tw) * (1 - th) + (prob[b + w0i] * (1 - tw) + prob[b + w1] * tw) * th;
      const v1 = (prob[c + w0i] * (1 - tw) + prob[c + w1] * tw) * (1 - th) + (prob[e + w0i] * (1 - tw) + prob[e + w1] * tw) * th;
      P[o] = (v0 * (1 - td) + v1 * td) / 255;
      part[o] = lab[Math.round(d) * S2 + Math.round(h) * S + Math.round(w)];
    }
  }
  // "fold depth" moves how sure the network must be: deeper asks for more
  const folds = mr.folds === 'none' ? -1 : Math.max(-1, Math.min(1, Number(mr.folds) || 0));
  const level = 0.5 + 0.35 * folds;
  let brain = largestComponent(thresh(P, level));
  // Tidy up. Below the cerebellum only a short stump of the brain stem is kept: further
  // down the network sometimes takes bits of the neck for brain, joined on through the
  // spinal cord. Then anything that only hangs on by a thread (under 3 mm thick) goes.
  const cereb = ai.cereb || (ai.classes === 18 ? [5, 6] : null); // class numbers of the cerebellum, where the model has them
  const ups = [];
  for (let i = 0; i < N; i += 3) if (cereb && brain[i] && cereb.includes(part[i])) { const x = i % X, y = ((i / X) | 0) % Y, z = (i / XY) | 0; ups.push(w0[2] + VOX * (x * E[0][2] + y * E[1][2] + z * E[2][2])); }
  if (cereb && ups.length > 2000) {
    ups.sort((a, b) => a - b);
    const floor = ups[Math.floor(ups.length * 0.02)] - (mr.stump ?? 8);
    if ((mr.stump ?? 8) < 30)
    for (let z = 0, o = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++, o++) if (brain[o] && w0[2] + VOX * (x * E[0][2] + y * E[1][2] + z * E[2][2]) < floor) brain[o] = 0;
  }
  brain = and(brain, dilate(largestComponent(opening(brain, 1.6)), 2.4));
  brain = largestComponent(brain);
  const grow = Number(mr.grow) || 0;
  if (grow > 0.2) brain = dilate(brain, grow); else if (grow < -0.2) brain = largestComponent(erode(brain, -grow));
  const ml = count(brain) * VOX ** 3 / 1000;
  const notes = { ...rest.notes };
  notes.brain = ml < 600 || ml > 2200 ? 'The AI brain model gave an unusual size for this scan. It was trained on T1-weighted scans of the whole head; try “Classic” under “Fine-tune the MRI brain”.' : '';
  const masks = { ...rest.masks, brain }, surfaces = { ...rest.surfaces };
  if (Math.abs(grow) <= 0.2) surfaces.brain = { field: P, level, width: 1, sign: 1, within: dilate(brain, 1.5) };
  const used = { tightened: 0, bottom: 0, level, blend: 0, fluid: '', ml: Math.round(ml), slice: grid.slice, model: ai.key };
  return { masks, notes, surfaces, used, outline: brain, fine: grid.field, parts: part };
}

function segmentMR(grid, opts, want, report) {
  if (opts.ai && want.brain) {
    const others = Object.keys(want).some((k) => k !== 'brain' && want[k]);
    const rest = others ? segmentMR(grid, { ...opts, ai: null }, { ...want, brain: false }, report) : { masks: {}, notes: {}, surfaces: {} };
    return brainFromModel(grid, opts, rest, report);
  }
  const W = grid.field, masks = {}, notes = {}, surfaces = {}, mr = opts.mr || {};
  const memo = grid.memo || (grid.memo = {});
  const auto = (v) => v === undefined || v === null || v === 'auto';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

  // ---- 1. the head, and how bright things are (does not depend on settings) ----
  if (!memo.base) {
    const smooth = gaussian(W, 1 / VOX);
    const { p2, p98 } = percentiles(smooth, grid.fill);
    const t = p2 + 0.12 * (p98 - p2);
    report(0.2, 'Finding the head…');
    const tissue = thresh(smooth, t);
    let head = largestComponent(opening(tissue, 2));
    for (const a of [grid.zAxis, (grid.zAxis + 1) % 3, (grid.zAxis + 2) % 3]) head = fillSlices(head, a);
    memo.base = { smooth, p2, p98, t, tissue, head };
  }
  const { smooth, p2, p98, t, tissue, head } = memo.base;
  masks.skin = head;
  if (!want.brain) return { masks, notes, surfaces };

  if (!memo.deep) {
    report(0.3, 'Measuring the brain…');
    // depth under the skin. Where the scan simply ends (top slice, edge of the
    // picture) there is no skin, so only air that was actually scanned counts.
    const air = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (grid.cover[i] && !head[i]) air[i] = 1;
    const under = edt(air);
    // how bright brain tissue is in this scan: look at what lies deep inside the head
    let deepest = 0;
    for (let i = 0; i < N; i += 5) if (head[i] && under[i] < EDT_INF && under[i] > deepest) deepest = under[i];
    const deepLim = Math.min(r2(25), deepest * 0.3);
    const vals = [];
    for (let i = 0; i < N; i += 3) if (tissue[i] && head[i] && under[i] >= deepLim) vals.push(smooth[i]);
    vals.sort((x, y) => x - y);
    const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] ?? p98;
    memo.deep = { under, mid: q(0.5), top: q(0.9), k3: kmeans3(vals) };
  }
  const { under, mid, top, k3 } = memo.deep;

  // thick slices: blend a little more along the stacking direction so the
  // surface does not show a terrace at every slice
  const thick = grid.slice > VOX * 2 && grid.slice >= 2.5;
  const blend = auto(mr.blend) ? (thick ? Math.min(2, grid.slice * 0.2) : 0) : Number(mr.blend) || 0;
  if (!memo.fine || memo.fine.blend !== blend) {
    let fine = gaussian(W, 0.55);
    if (blend > 0.05) fine = gaussianAxis(fine, blend / VOX, 2);
    memo.fine = { blend, fine };
  }
  const fine = memo.fine.fine;

  // Is fluid dark or bright? The scan's own timing says it most reliably (T1 and
  // FLAIR: dark, T2: bright). A scan that does not say is settled after the outline
  // is found, from where the fluid lies (see fluidFromShape).
  const known = mr.fluid === 'dark' || mr.fluid === 'bright' ? mr.fluid : fluidFromTiming(opts.mrInfo);
  // anything this bright is fat or marrow (on a bright-fluid scan: fluid), not brain
  const useFat = mr.fat !== false;
  const fatLimit = (kind) => (!useFat ? Infinity : kind === 'dark' ? top * 1.3 : kind === 'bright' ? k3.c[1] + 0.75 * (k3.c[2] - k3.c[1]) : Infinity);

  // ---- 2 and 3. where to start, and the outline ----
  const reach = clamp(mr.reach, -1, 1), stiff = Math.max(0.4, Number(mr.stiff) || 1);
  const outKey = JSON.stringify([known, useFat, reach, stiff, auto(mr.bottom) ? 'auto' : Number(mr.bottom)]);
  if (!memo.out || memo.out.key !== outKey) {
    report(0.42, 'Finding the brain…');
    // brain-like brightness, away from the skin: only used to find a safe starting point
    const tFat = fatLimit(known);
    const tDark = known === 'dark' ? p2 + 0.68 * (mid - p2) : known === 'bright' ? p2 + 0.55 * (k3.c[0] - p2) : p2 + 0.5 * (mid - p2);
    const peel = r2(5), tis = new Uint8Array(N), bg = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const v = fine[i]; if (head[i] && v >= tDark && v <= tFat && under[i] > peel) tis[i] = 1; else bg[i] = 1; }
    const depth = edt(bg); // squared distance to the nearest voxel that is not such tissue
    let core = null;
    for (const r of [10, 8, 6, 4, 3]) {
      const lim = r2(r), er = new Uint8Array(N);
      let any = 0;
      for (let i = 0; i < N; i++) if (depth[i] > lim) { er[i] = 1; any = 1; }
      if (!any) continue;
      const c = largestComponent(er);
      if (count(c) * VOX ** 3 / 1000 >= 15) { core = c; break; }
    }
    memo.out = { key: outKey, env: null };
    if (core) {
      let cx = 0, cy = 0, cz = 0, cn = 0;
      for (let i = 0; i < N; i++) if (core[i]) { cx += i % X; cy += ((i / X) | 0) % Y; cz += (i / XY) | 0; cn++; }
      cx /= cn; cy /= cn; cz /= cn;
      const ball = (R, step, fn) => {
        for (let z = Math.max(0, Math.floor(cz - R)); z < Math.min(Z, cz + R); z += step) for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(Y, cy + R); y += step) for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(X, cx + R); x += step) {
          if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= R * R) fn(x, y, z, z * XY + y * X + x);
        }
      };
      // that lump can sit in one half of the brain: re-center on all the brain-bright
      // tissue within 7.5 cm, twice, which pulls the point to the middle
      for (let pass = 0; pass < 2; pass++) {
        let sx = 0, sy = 0, sz = 0, sn = 0;
        ball(75 / VOX, 1, (x, y, z, i) => { if (tis[i]) { sx += x; sy += y; sz += z; sn++; } });
        if (sn) { cx = sx / sn; cy = sy / sn; cz = sz / sn; }
      }
      // typical brightness of what the skull holds: everything within 6 cm of that point
      const near = [];
      ball(60 / VOX, 2, (x, y, z, i) => { const v = smooth[i]; if (v > t && v < p98) near.push(v); });
      near.sort((a, b) => a - b);
      const tm = near[near.length >> 1] ?? mid;

      // The base of the skull is the weak spot: through it the outline can run on down
      // into the face and neck. A brain is under 1.65 litres and little hangs below it,
      // so when the outline comes out with more than that it is grown again, more
      // carefully each time. (Thick slices smear the skull into the brain, so there the
      // outline starts out a little more careful; bright fluid runs down the spine.)
      const base = (thick ? 0.7 : 0.65) - 0.2 * reach;
      const leakMl = known === 'dark' ? 35 : 60;
      let env = null, bt = base, leaked = false, steps = 0, length = 170, bottom = 135;
      for (; steps < 4; steps++) {
        bt = base + 0.05 * steps;
        report(0.5 + 0.04 * steps, 'Tracing the outline of the brain…');
        const surf = growSurface(smooth, [cx, cy, cz], 45 / VOX, { t2: p2, t, tm, bt, fat: tFat, stiff });
        env = and(fillSurface(surf.pos, surf.tris), head);
        // Heads differ in size. A brain is about four fifths as tall (top to the underside
        // of the cerebellum) as it is long (front to back), and its length is the one
        // measure a leak downward does not spoil, so heights are taken from the length.
        let ya = Infinity, yb = -Infinity;
        for (let k = 0; k < Z; k += 2) for (let j = 0; j < Y; j += 2) for (let i = 0; i < X; i += 2) {
          if (!env[k * XY + j * X + i]) continue;
          const yw = (i * grid.e[0][1] + j * grid.e[1][1] + k * grid.e[2][1]) * VOX;
          if (yw < ya) ya = yw; if (yw > yb) yb = yw;
        }
        length = yb > ya ? yb - ya : 170;
        bottom = auto(mr.bottom) ? Math.max(120, Math.min(165, Math.round(0.8 * length))) : Number(mr.bottom) || 135;
        const kept = new Uint8Array(env);
        trimBelow(kept, grid, bottom);
        const vol = count(kept) * VOX ** 3 / 1000, below = count(env) * VOX ** 3 / 1000 - vol;
        leaked = below > leakMl || vol > 1650;
        if (!leaked || reach !== 0) break; // a hand-set outline is taken as it is
      }
      if (steps > 3) steps = 3;
      Object.assign(memo.out, { env, tm, bt, leaked, steps, length, bottom, fluid: known || fluidFromShape(fine, env, top * 1.3) });
    }
  }
  const out = memo.out;
  if (!out.env) {
    masks.brain = new Uint8Array(N);
    notes.brain = 'Could not find the brain in this series';
    return { masks, notes, surfaces, used: null };
  }
  const bottom = out.bottom, tm = out.tm, fluidDark = out.fluid === 'dark', tFat = fatLimit(out.fluid);
  const grow = Number(mr.grow) || 0;
  let hull = grow > 0.05 ? and(dilate(out.env, grow), head) : grow < -0.05 ? erode(out.env, -grow) : new Uint8Array(out.env);
  trimBelow(hull, grid, bottom);
  const ml = count(hull) * VOX ** 3 / 1000;

  // ---- 4. folds: split fluid from brain inside the outline ----
  report(0.7, 'Tracing the folds of the brain…');
  const folds = mr.folds === 'none' ? 0 : clamp(mr.folds, -1, 1);
  let cls = null, carveField = fine, autoLevel = 0;
  const beyond = new Uint8Array(N);
  for (let i = 0; i < N; i++) beyond[i] = hull[i] ^ 1;
  const inside = edt(beyond); // squared depth of each voxel under the outline
  if (mr.folds === 'none') cls = null;
  else if (fluidDark) {
    // Dark fluid (T1, FLAIR): brain is whatever is brighter than a share of the brain
    // tissue around it. Measuring against nearby tissue, not one number for the
    // whole scan, keeps the dimmer parts of a scan (often the top slices).
    const floor = p2 + 0.55 * (tm - p2);
    const local = localMean(fine, (i) => hull[i] && fine[i] > floor && fine[i] <= tFat, 12 / VOX, tm);
    carveField = floatVolume();
    for (let i = 0; i < N; i++) carveField[i] = (fine[i] - p2) / Math.max(1e-6, local[i] - p2);
    // thick slices mix fluid into the tissue next to it, so the line sits higher there
    // Where to draw the line. On a scan that shows the fluid plainly a fixed share
    // works (thick slices mix fluid into the tissue next to it, so the line sits higher
    // there). But many scans show almost no fluid in the folds: the folds are narrower
    // than the scan can resolve, and all that is left of them is a slightly darker
    // band. With a fixed line nothing is cut and the brain comes out as a blob. So the
    // line is set from the outer few millimeters of the brain, where the folds are:
    // about a third of that shell is taken as fold. That high, the line follows the
    // darker gray rind of the brain down into the folds, which draws them.
    // a light blur first: a fold is a few millimeters wide and runs on, while speckle
    // is a voxel or two; blurred, the cut follows the folds and leaves fewer pits
    const calm = mr.foldSmooth ?? 1.1;
    if (calm > 0.05) carveField = gaussian(carveField, calm / VOX);
    const shell = [], near = r2(1.5), far = r2(7);
    for (let i = 0; i < N; i += 3) if (hull[i] && inside[i] > near && inside[i] < far) shell.push(carveField[i]);
    shell.sort((a, b) => a - b);
    autoLevel = Math.max(thick ? 0.72 : 0.6, Math.min(0.95, shell.length ? shell[Math.floor(shell.length * (mr.shellQ ?? 0.27))] : 0));
    cls = { level: Math.min(0.99, autoLevel + (folds > 0 ? Math.min(0.2, 1 - autoLevel) : 0.2) * folds), width: 0.6, sign: 1 };
  } else {
    // Bright fluid (T2): the same idea the other way round. Fluid in the big chambers is
    // far brighter than brain, but in the narrow folds it is mixed with the tissue next
    // to it and only a little brighter, so it too is judged against the tissue nearby.
    const k = classifyTissue(fine, hull, 'bright', 0, Infinity);
    if (k) {
      const ceil = (k.classes[1] + k.classes[2]) / 2, floor = p2 + 0.3 * (tm - p2);
      const local = localMean(fine, (i) => hull[i] && fine[i] > floor && fine[i] < ceil, 12 / VOX, tm);
      carveField = floatVolume();
      for (let i = 0; i < N; i++) carveField[i] = (fine[i] - p2) / Math.max(1e-6, local[i] - p2);
      cls = { level: (mr.levelB ?? 1.3) - 0.15 * folds, width: 0.6, sign: -1 };
    }
  }
  // ---- 4b. the parts of the brain are not all wrinkled alike ----
  // The cerebrum is folded and split into two halves; the cerebellum and the brain
  // stem underneath are compact. The scan says which way is left, back and up, so:
  //  - along the plane between the two halves the folds are cut deeper (only where
  //    the scan is already darker there, so the bridge between the halves stays);
  //  - in the lower back of the brain, where the cerebellum and brain stem sit, only
  //    real fluid gaps are cut, not the fine wrinkles; and a shallow groove marks
  //    where the cerebellum meets the cerebrum.
  // Where those parts are is estimated from the outline's size, so it is approximate.
  const split = mr.split === undefined ? 1 : Math.max(0, Number(mr.split) || 0), hind = mr.hind !== false;
  if (cls && (split > 0 || hind)) {
    // patient coordinates (mm) of a voxel: left, back, up
    const E = grid.e, W0 = grid.w0, cx = [0, 1, 2].map((d) => [E[0][d] * VOX, E[1][d] * VOX, E[2][d] * VOX]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, sx = 0, sn = 0;
    for (let k = 0; k < Z; k += 2) for (let j = 0; j < Y; j += 2) for (let i = 0; i < X; i += 2) {
      if (!hull[k * XY + j * X + i]) continue;
      const xw = W0[0] + i * cx[0][0] + j * cx[0][1] + k * cx[0][2], yw = W0[1] + i * cx[1][0] + j * cx[1][1] + k * cx[1][2], zw = W0[2] + i * cx[2][0] + j * cx[2][1] + k * cx[2][2];
      if (xw < x0) x0 = xw; if (xw > x1) x1 = xw; if (yw < y0) y0 = yw; if (yw > y1) y1 = yw; if (zw < z0) z0 = zw; if (zw > z1) z1 = zw;
      sx += xw; sn++;
    }
    if (sn > 1000) {
      const L = y1 - y0, H = 0.8 * out.length, top = z1;
      // "fluid-likeness": positive where a voxel looks like fluid
      const unit = 1; // the field is brightness as a share of the brain tissue nearby
      // the plane between the halves: the left-right position, near the middle, where the top of the brain looks most like fluid
      let mid = sx / sn;
      if (split > 0) {
        const bins = new Float64Array(33), cnt = new Float64Array(33);
        for (let k = 0; k < Z; k++) for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
          const v = k * XY + j * X + i;
          if (!hull[v]) continue;
          const zw = W0[2] + i * cx[2][0] + j * cx[2][1] + k * cx[2][2];
          if (zw < top - 0.4 * H) continue;
          const b = Math.round(W0[0] + i * cx[0][0] + j * cx[0][1] + k * cx[0][2] - mid) + 16;
          if (b < 0 || b > 32) continue;
          bins[b] += cls.sign * (cls.level - carveField[v]) / unit; cnt[b]++;
        }
        let best = 16, bestV = -Infinity;
        for (let b = 2; b <= 30; b++) { if (cnt[b] < 200) continue; const v = bins[b] / cnt[b] + 0.5 * (bins[b - 1] / Math.max(1, cnt[b - 1]) + bins[b + 1] / Math.max(1, cnt[b + 1])) / 2; if (v > bestV) { bestV = v; best = b; } }
        mid += best - 16;
      }
      const ramp = (v, a, b) => (v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a));
      const world = (i, j, k, d) => W0[d] + i * cx[d][0] + j * cx[d][1] + k * cx[d][2];
      // Where does the cerebellum end and the cerebrum above it begin? Between them
      // lies a thin sheet (the tentorium) that shows as a fluid-like gap in the scan.
      // Its height is looked up in the scan for every vertical column of the back
      // half of the brain, rather than assumed: going down a column, it is the level
      // where the scan looks most like fluid, with brain above and below. Columns
      // that disagree with their neighbors (a fold of the cerebrum, a fluid chamber)
      // are overruled by them, since the sheet is one smooth surface.
      const B = 3, ZB = 1.5; // column width and height step, mm
      const nxb = Math.ceil((x1 - x0) / B) + 1, nyb = Math.ceil((y1 - y0) / B) + 1, ncol = nxb * nyb;
      const zHi = top - 0.5 * H, zLo = top - 0.84 * H, nzb = Math.ceil((zHi - zLo) / ZB) + 1;
      let tent = null; // height of the sheet (patient "up", mm) per column
      if (hind) {
        const sum = new Float32Array(ncol * nzb), cnt = new Float32Array(ncol * nzb);
        for (let k = 0; k < Z; k++) for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
          const v = k * XY + j * X + i;
          if (!hull[v]) continue;
          const zw = world(i, j, k, 2);
          if (zw < zLo || zw > zHi) continue;
          const yw = world(i, j, k, 1);
          if ((yw - y0) / L < 0.42) continue;
          const b = (Math.floor((zw - zLo) / ZB) * nyb + Math.floor((yw - y0) / B)) * nxb + Math.floor((world(i, j, k, 0) - x0) / B);
          sum[b] += cls.sign * (cls.level - carveField[v]) / unit; cnt[b]++;
        }
        const height = new Float32Array(ncol).fill(NaN), prof = new Float32Array(nzb), have = new Uint8Array(nzb);
        let found = 0;
        for (let by = 1; by < nyb - 1; by++) for (let bx = 1; bx < nxb - 1; bx++) {
          // the column's profile, averaged with its eight neighbors and a little along its height
          let filled = 0, mean = 0;
          for (let bz = 0; bz < nzb; bz++) {
            let s = 0, n = 0;
            for (let dz = -1; dz <= 1; dz++) { const z = bz + dz; if (z < 0 || z >= nzb) continue; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = (z * nyb + by + dy) * nxb + bx + dx; s += sum[b]; n += cnt[b]; } }
            have[bz] = n >= 12 ? 1 : 0;
            prof[bz] = have[bz] ? s / n : 0;
            if (have[bz]) { filled++; mean += prof[bz]; }
          }
          if (filled < nzb * 0.6) continue;
          mean /= filled;
          const gap = Math.round(6 / ZB); // brain must be found this far above and below the gap
          let best = -1, bestV = mean + 0.1;
          for (let bz = gap; bz < nzb - gap; bz++) {
            if (!have[bz] || !have[bz - gap] || !have[bz + gap]) continue;
            if (prof[bz] > bestV && prof[bz - gap] < prof[bz] - 0.08 && prof[bz + gap] < prof[bz] - 0.08) { bestV = prof[bz]; best = bz; }
          }
          if (best >= 0) { height[by * nxb + bx] = zLo + (best + 0.5) * ZB; found++; }
        }
        if (found >= 40) {
          // neighbors decide: twice replace every column by the middle value of those around it
          let cur = height;
          const all = Array.from(cur).filter((v) => v === v).sort((a, b) => a - b), overall = all[all.length >> 1];
          for (let pass = 0; pass < 2; pass++) {
            const next = new Float32Array(ncol), near = [];
            for (let by = 0; by < nyb; by++) for (let bx = 0; bx < nxb; bx++) {
              near.length = 0;
              for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const y = by + dy, x = bx + dx; if (x < 0 || y < 0 || x >= nxb || y >= nyb) continue; const v = cur[y * nxb + x]; if (v === v) near.push(v); }
              near.sort((a, b) => a - b);
              next[by * nxb + bx] = near.length >= 6 ? near[near.length >> 1] : pass ? overall : NaN;
            }
            cur = next;
          }
          // the two sides of the head are alike: each column takes the average of itself and its mirror image
          {
            const next = new Float32Array(cur);
            for (let by = 0; by < nyb; by++) for (let bx = 0; bx < nxb; bx++) {
              const mx = Math.round((2 * mid - (x0 + (bx + 0.5) * B) - x0) / B - 0.5);
              if (mx >= 0 && mx < nxb) next[by * nxb + bx] = (cur[by * nxb + bx] + cur[by * nxb + mx]) / 2;
            }
            cur = next;
          }
          // and round it off, so the surface has no steps from one column to the next
          for (let pass = 0; pass < 3; pass++) {
            const next = new Float32Array(ncol);
            for (let by = 0; by < nyb; by++) for (let bx = 0; bx < nxb; bx++) {
              let sv = 0, n = 0;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const y = by + dy, x = bx + dx; if (x < 0 || y < 0 || x >= nxb || y >= nyb) continue; sv += cur[y * nxb + x]; n++; }
              next[by * nxb + bx] = sv / n;
            }
            cur = next;
          }
          tent = cur;
        }
      }
      // height of the sheet at a position, blended between the four columns around it
      const sheet = (xw, yw) => {
        const gx = Math.max(0, Math.min(nxb - 1.001, (xw - x0) / B - 0.5)), gy = Math.max(0, Math.min(nyb - 1.001, (yw - y0) / B - 0.5));
        const bx = gx | 0, by = gy | 0, tx = gx - bx, ty = gy - by, o = by * nxb + bx;
        return (tent[o] * (1 - tx) + tent[o + 1] * tx) * (1 - ty) + (tent[o + nxb] * (1 - tx) + tent[o + nxb + 1] * tx) * ty;
      };
      const depth = inside, grooveLim = r2(7);
      const adj = floatVolume();
      adj.set(carveField);
      for (let k = 0; k < Z; k++) for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
        const v = k * XY + j * X + i;
        if (!hull[v]) continue;
        const xw = world(i, j, k, 0), yw = world(i, j, k, 1), zw = world(i, j, k, 2);
        const down = (top - zw) / H, back = (yw - y0) / L, off = Math.abs(xw - mid);
        let w = 0, groove = 0;
        if (hind) {
          // how far below the sheet this voxel lies (mm); where the sheet was not found, a typical height is assumed
          const below = (tent ? sheet(xw, yw) : top - 0.66 * H) - zw;
          // cerebellum: under the sheet, in the back half
          const cereb = ramp(below, 1.5, 5) * ramp(back, 0.45, 0.55);
          // brain stem: a column near the middle, further forward
          const stem = ramp(down, 0.52, 0.62) * ramp(back, 0.36, 0.44) * (1 - ramp(back, 0.72, 0.8)) * (1 - ramp(off, 14, 22));
          w = Math.max(cereb, stem);
          // The cerebellum and the cerebrum only touch; they are joined through the
          // brain stem. A groove is cut along the sheet, in the outer 7 mm only, so the
          // model shows the two apart and still prints as one piece.
          if (tent && Math.abs(below) < 2.5 && back > 0.5 && depth[v] < grooveLim) groove = (1 - Math.abs(below) / 2.5) * (1 - depth[v] / grooveLim);
        }
        let d = w * 0.3 * (1 - groove);                                       // towards "brain": the wrinkles close, real fluid gaps stay
        if (split > 0 && off < 2.5) d -= (1 - w) * split * 0.22 * (1 - off / 2.5); // towards "fluid", strongest on the plane itself
        d -= groove * 0.3;
        if (d) adj[v] += cls.sign * d * unit;
      }
      if (opts.lab) self.postMessage({ type: 'debug', d: { tentFound: !!tent, tentDown: tent ? [0.3, 0.5, 0.7].map((fx) => [0.65, 0.8, 0.92].map((fy) => +((top - tent[Math.floor(fy * (nyb - 1)) * nxb + Math.floor(fx * (nxb - 1))]) / H).toFixed(2))) : null } });
      carveField = adj;
    }
  }
  // Pits: where a fold is too faint for the scan, the cut catches only its deepest
  // spots and leaves a row of holes. A real fold opens onto the surface as a long
  // slit; a pit as a small hole. So the cut is looked at in the outer 3.5 mm of the brain only
  // (deeper down everything joins up), and openings with a small footprint there are
  // closed again. A smooth patch is truer to the scan than a pitted one.
  const pitMm3 = mr.pits ?? 400;
  if (cls && pitMm3 > 0) {
    // the surface meant here is the brain's own (its tissue with every fold and pit bridged
    // over), not the outline, which lies a little outside it in the fluid
    const tissue = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (hull[i] && cls.sign * (carveField[i] - cls.level) > 0) tissue[i] = 1;
    const wrap = closing(largestComponent(tissue), 3), out2 = new Uint8Array(N);
    for (let i = 0; i < N; i++) out2[i] = wrap[i] ^ 1;
    const under = edt(out2), mouth = new Uint8Array(N), skin = r2(3.5);
    for (let i = 0; i < N; i++) if (wrap[i] && !tissue[i] && under[i] < skin) mouth[i] = 1;
    const minVox = pitMm3 / VOX ** 3, slits = components(mouth, (size) => size >= minVox);
    const fill = cls.level + cls.sign * 0.15;
    let own = carveField === fine ? null : carveField;
    for (let i = 0; i < N; i++) if (mouth[i] && !slits[i]) { if (!own) { own = floatVolume(); own.set(carveField); } own[i] = fill; }
    if (own) carveField = own;
  }
  if (cls) {
    masks.brain = carveBrain(carveField, hull, cls);
    // thin sheets clinging to the outside (membranes, skull marrow) are not brain:
    // only keep surface within 1.5 mm of tissue that survives a 1.2 mm opening
    const solid = dilate(largestComponent(opening(masks.brain, 1.2)), 1.5);
    masks.brain = and(masks.brain, solid);
    surfaces.brain = { field: carveField, ...cls, within: and(hull, solid) };
  } else masks.brain = hull;
  notes.brain = out.leaked ? 'The outline may run down into the face or neck. Try the “Skull or face is stuck on” preset, or a lower “Cut off below”, under “Fine-tune the MRI brain”.' : '';
  const used = { tightened: out.steps, bottom, level: cls ? cls.level : 0, blend, fluid: fluidDark ? 'dark' : 'bright', ml: Math.round(ml), slice: grid.slice };
  return { masks, notes, surfaces, used, outline: hull, fine };
}

// Clean, optionally fill, and mesh one part. Runs in its own worker so the
// parts are built side by side on separate processor cores.
// Marks made by hand on the slices (opts.fix, see fixes.js: one value per scan voxel,
// 1 = brain, 2 = not brain) win over whatever found the brain. They are put on the
// working grid and written into the brain mask and into the field its surface is
// traced from. A mark on a thick slice covers the whole slice.
function applyFix(grid, vol, fix, seg) {
  const brain = seg.masks.brain;
  if (!brain || !fix || !fix.data) return 0;
  const { origin, dx, dy, dz, nx, ny, nz } = vol, e = grid.e, w0 = grid.w0;
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const d3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const r0 = cr(dy, dz), r1 = cr(dz, dx), r2 = cr(dx, dy), det = d3(dx, r0);
  const rows = [r0, r1, r2].map((r) => r.map((v) => v / det)); // world -> scan index
  const rel = [w0[0] - origin[0], w0[1] - origin[1], w0[2] - origin[2]];
  const base = rows.map((r) => d3(r, rel)), st = [0, 1, 2].map((g) => rows.map((r) => d3(r, e[g]) * VOX)); // scan-index step per grid step
  const mark = new Uint8Array(N), data = fix.data;
  let n = 0;
  for (let z = 0, o = 0; z < Z; z++) for (let y = 0; y < Y; y++) {
    const bi = base[0] + y * st[1][0] + z * st[2][0], bj = base[1] + y * st[1][1] + z * st[2][1], bk = base[2] + y * st[1][2] + z * st[2][2];
    for (let x = 0; x < X; x++, o++) {
      const i = Math.round(bi + x * st[0][0]), j = Math.round(bj + x * st[0][1]), k = Math.round(bk + x * st[0][2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const m = data[(k * ny + j) * nx + i];
      if (m === 1) { brain[o] = 1; mark[o] = 1; n++; } else if (m === 2) { brain[o] = 0; mark[o] = 2; n++; }
    }
  }
  const s = seg.surfaces.brain;
  if (n && s) {
    const f = Float32Array.from(s.field), sign = s.sign ?? 1, inside = s.level + sign * s.width, outside = s.level - sign * s.width;
    const added = new Uint8Array(N);
    for (let o = 0; o < N; o++) if (mark[o] === 1) { f[o] = inside; added[o] = 1; } else if (mark[o] === 2) f[o] = outside;
    s.field = f;
    if (s.within) { const near = dilate(added, VOX * 1.01), within = Uint8Array.from(s.within); for (let o = 0; o < N; o++) if (near[o]) within[o] = 1; s.within = within; }
  }
  return n;
}

function buildPart(job) {
  const { key, bit, opts, grid, note } = job;
  let mask = job.mask;
  const intensity = job.surface || null;
  const f = opts.finish;
  const report = (text) => self.postMessage({ type: 'progress', key, text });
  const sigma = { bone: 0.55, brain: 0.8, skin: 0.8, vessels: 0.45 };
  const iters = { bone: 8, brain: 14, skin: 14, vessels: 6 };
  const cleaning = f.close > 0 || f.open > 0 || f.pieces > 0 || f.fill;
  const item = { key, bit, mesh: null, volumeMl: 0, note: note || '', solid: false };
  if (!mask || !count(mask)) return { item, mask: null };
  if (cleaning) {
    report(`Cleaning up the ${key} model…`);
    mask = cleanMask(key, mask, f);
    // let the scan's values shape the surface only right at the cleaned mask
    if (intensity) intensity.within = dilate(mask, VOX * 1.01);
  }
  if (opts.solid && opts.solid[key] && count(mask)) {
    report(`Filling the inside of the ${key} model…`);
    const core = solidCore(key, mask, grid);
    if (core && count(core)) {
      const solid = new Uint8Array(N);
      for (let i = 0; i < N; i++) solid[i] = mask[i] | core[i];
      mask = f.pieces >= 1 ? largestComponent(solid) : solid;
      if (intensity) { intensity.force = core; intensity.within = dilate(mask, VOX * 1.01); }
      item.solid = true;
    }
  }
  const vox = count(mask);
  if (!vox) return { item, mask: null };
  report(`Building the ${key} model…`);
  if (intensity) {
    intensity.soften = f.soften;
    // anti-aliasing: blur the scan values a little before tracing the surface
    // (half strength on bone, which has thin walls to keep)
    const extra = Math.max(0, f.soften - 0.8) * (key === 'bone' ? 0.5 : 1);
    if (extra > 0.05) intensity.field = gaussian(intensity.field, extra);
  }
  const pieces = key === 'vessels' ? Math.min(f.pieces, 0.05) : f.pieces;
  let raw = surfaceNets(mask, sigma[key] * (f.soften / 0.8), intensity);
  if (pieces > 0) raw = keepLargeShells(raw, pieces);
  const base = intensity ? (key === 'bone' ? 5 : opts.modality === 'CT' ? 8 : 3) : iters[key];
  const before = raw.indices.length / 3;
  if (f.reduce < 1) report(`Simplifying the ${key} model…`);
  const mesh = finishMesh(raw, grid, base + Math.round(f.smooth * 3), key === 'vessels' ? Math.max(f.reduce, 0.6) : f.reduce, pieces);
  if (mesh) {
    if (f.reduce < 1) item.reducedFrom = before;
    item.mesh = { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices };
    item.volumeMl = vox * VOX ** 3 / 1000;
  }
  return { item, mask };
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    PORTS = m.ports || [];
    SYNC = PORTS.length && typeof SharedArrayBuffer !== 'undefined' ? new Int32Array(new SharedArrayBuffer(8)) : null;
    if (m.type === 'segment') {
      // stage 1: find every part (one worker)
      const { vol, opts } = m;
      post(0.02, 'Preparing the scan…');
      const grid = resample(vol, opts.voxel);
      const want = Object.fromEntries(opts.targets.map((k) => [k, true]));
      const seg = opts.modality === 'CT' ? segmentCT(grid, opts, want, post) : segmentMR(grid, opts, want, post);
      const fixed = opts.fix ? applyFix(grid, vol, opts.fix, seg) : 0;
      const parts = opts.targets.map((key, bit) => {
        let surface = seg.surfaces[key] || null;
        if (!surface && key === 'bone' && opts.modality === 'CT') surface = { field: grid.field, level: opts.boneHU, width: 1600 };
        return { key, bit, mask: seg.masks[key] || null, surface, note: seg.notes[key] || '' };
      });
      self.postMessage({ type: 'segmented', fixed, dims: { X, Y, Z, VOX }, grid: { e: grid.e, w0: grid.w0, zAxis: grid.zAxis }, parts, notes: seg.notes, used: seg.used || null, extra: opts.lab ? seg.outline : undefined, field: opts.lab ? seg.fine : undefined });
    } else if (m.type === 'preview') {
      // Live preview while fine-tuning the MRI brain: this worker stays alive and
      // keeps the scan (on a coarse grid) and every step it has already worked out,
      // so a changed setting only redoes what depends on it. Nothing is meshed.
      if (m.vol) { const grid = resample(m.vol, m.opts.voxel); PREVIEW = { grid, dims: { X, Y, Z, VOX } }; }
      if (!PREVIEW) throw new Error('No scan to preview');
      // an AI model's answer comes along once and is kept with the scan
      if (m.ai) PREVIEW.ai = m.ai;
      const viaModel = m.opts.mr && m.opts.mr.model && m.opts.mr.model !== 'classic';
      if (viaModel && !(PREVIEW.ai && PREVIEW.ai.key === m.opts.mr.model)) throw new Error('The brain model has not answered for this scan');
      const seg = segmentMR(PREVIEW.grid, viaModel ? { ...m.opts, ai: PREVIEW.ai } : m.opts, { brain: true }, () => {});
      const { grid, dims } = PREVIEW;
      // 1 = brain, 2 = inside the outline but fluid
      const labels = new Uint8Array(N), brain = seg.masks.brain, outline = seg.outline;
      for (let i = 0; i < N; i++) labels[i] = brain[i] ? 1 : outline && outline[i] ? 2 : 0;
      self.postMessage({ type: 'preview', id: m.id, dims, grid: { e: grid.e, w0: grid.w0 }, labels, used: seg.used || null, note: seg.notes.brain || '', ml: count(brain) * VOX ** 3 / 1000 }, [labels.buffer]);
    } else if (m.type === 'part') {
      // stage 2: one worker per part
      ({ X, Y, Z, VOX } = m.dims);
      XY = X * Y; N = XY * Z;
      const { item, mask } = buildPart(m);
      const transfer = [];
      if (item.mesh) transfer.push(item.mesh.positions.buffer, item.mesh.normals.buffer, item.mesh.indices.buffer);
      if (mask) transfer.push(mask.buffer);
      self.postMessage({ type: 'partDone', item, mask }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.stack || err) });
  }
};
