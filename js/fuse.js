// fuse.js — combine scans of the same kind taken in different planes into one
// volume that is sharp in every direction.
//
// A thick-slice scan is sharp within each picture and blurred across the 5 to 6 mm
// between them. An axial, a coronal and a sagittal scan of the same head are each
// blurred in a different direction, so together they hold the detail for all
// three. The steps:
//   1. line up     the head moves a little between scans: each extra scan is
//                  shifted and turned (rigidly) until it matches the first
//   2. level       brightness of each extra scan is scaled to match the first
//   3. pick        every piece of detail is taken from the scans that are sharp
//                  in its direction, and from no others (a weighted mix in the
//                  Fourier domain); only the coarse shapes are averaged
// Pure functions, no DOM: used by fuseworker.js and by the node test harness.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** world -> index rows for a scan (inverse of the matrix with columns dx, dy, dz). */
function inverseRows(v) {
  const r0 = cross(v.dy, v.dz), r1 = cross(v.dz, v.dx), r2 = cross(v.dx, v.dy), det = dot(v.dx, r0);
  return [r0.map((x) => x / det), r1.map((x) => x / det), r2.map((x) => x / det)];
}
const matMul = (A, B) => A.map((r) => [0, 1, 2].map((c) => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
const matVec = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
function matInv(A) {
  const c0 = [A[0][0], A[1][0], A[2][0]], c1 = [A[0][1], A[1][1], A[2][1]], c2 = [A[0][2], A[1][2], A[2][2]];
  const r0 = cross(c1, c2), r1 = cross(c2, c0), r2 = cross(c0, c1), det = dot(c0, r0);
  return [r0.map((x) => x / det), r1.map((x) => x / det), r2.map((x) => x / det)];
}
/** Rotation matrix for small turns about x, y, z (degrees). */
function rotation(rx, ry, rz) {
  const [a, b, c] = [rx, ry, rz].map((d) => d * Math.PI / 180);
  const X = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Y = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Z = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  return matMul(Z, matMul(Y, X));
}

/** Value of a scan at a fractional index, or NaN outside it. */
function sampleScan(v, fx, fy, fz) {
  const { nx, ny, nz, data } = v;
  if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nx - 0.5 || fy > ny - 0.5 || fz > nz - 0.5) return NaN;
  const cx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx, cy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy, cz = fz < 0 ? 0 : fz > nz - 1 ? nz - 1 : fz;
  const x0 = cx | 0, y0 = cy | 0, z0 = cz | 0, x1 = x0 + 1 < nx ? x0 + 1 : x0, y1 = y0 + 1 < ny ? y0 + 1 : y0, z1 = z0 + 1 < nz ? z0 + 1 : z0;
  const tx = cx - x0, ty = cy - y0, tz = cz - z0, s = nx * ny;
  const a = z0 * s + y0 * nx, b = z0 * s + y1 * nx, c = z1 * s + y0 * nx, d = z1 * s + y1 * nx;
  return ((data[a + x0] * (1 - tx) + data[a + x1] * tx) * (1 - ty) + (data[b + x0] * (1 - tx) + data[b + x1] * tx) * ty) * (1 - tz)
    + ((data[c + x0] * (1 - tx) + data[c + x1] * tx) * (1 - ty) + (data[d + x0] * (1 - tx) + data[d + x1] * tx) * ty) * tz;
}

/** Fourier transform of one line, in place (length a power of two). */
function fft1(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2, ang = (inverse ? 2 : -2) * Math.PI / size, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let s = 0; s < n; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = s + k, b = a + half, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** Fourier transform of a volume, in place: one direction after the other. */
function fft3(re, im, nx, ny, nz, inverse) {
  const dims = [nx, ny, nz], strides = [1, nx, nx * ny];
  for (let axis = 0; axis < 3; axis++) {
    const n = dims[axis], st = strides[axis], a = (axis + 1) % 3, b = (axis + 2) % 3, lr = new Float64Array(n), li = new Float64Array(n);
    for (let v = 0; v < dims[b]; v++) for (let u = 0; u < dims[a]; u++) {
      const base = u * strides[a] + v * strides[b];
      for (let k = 0; k < n; k++) { lr[k] = re[base + k * st]; li[k] = im[base + k * st]; }
      fft1(lr, li, n, inverse);
      for (let k = 0; k < n; k++) { re[base + k * st] = lr[k]; im[base + k * st] = li[k]; }
    }
  }
}

/** The scan averaged onto a coarse lattice (spacing `cs` mm) laid over the target box. NaN where not covered. */
function coarse(v, grid, cs) {
  const inv = inverseRows(v), { e, w0, size } = grid;
  const cx = Math.max(2, Math.floor(size[0] / cs)), cy = Math.max(2, Math.floor(size[1] / cs)), cz = Math.max(2, Math.floor(size[2] / cs));
  const out = new Float32Array(cx * cy * cz), sub = [-1, 0, 1].map((k) => k * cs / 3);
  for (let z = 0, i = 0; z < cz; z++) for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++, i++) {
    let acc = 0, n = 0;
    for (const oz of sub) for (const oy of sub) for (const ox of sub) {
      const p = [(x + 0.5) * cs + ox, (y + 0.5) * cs + oy, (z + 0.5) * cs + oz];
      const w = [0, 1, 2].map((c) => w0[c] + p[0] * e[0][c] + p[1] * e[1][c] + p[2] * e[2][c] - v.origin[c]);
      const val = sampleScan(v, dot(inv[0], w), dot(inv[1], w), dot(inv[2], w));
      if (val === val) { acc += val; n++; }
    }
    out[i] = n >= 20 ? acc / n : NaN;
  }
  return { data: out, cx, cy, cz, cs };
}

/**
 * Line a scan up with the first one. Both are given on the same coarse lattice;
 * the scan is shifted (mm) and turned (degrees, about the middle of the box) to
 * make the two as alike as possible (highest correlation).
 * Returns { t:[x,y,z], r:[x,y,z], before, after } in the frame of the target grid.
 */
function align(base, other) {
  const { cx, cy, cz, cs } = base, A = base.data, B = other.data, sxy = cx * cy;
  // points to compare: inside the head (brighter than a tenth of the bright end), every other one
  const vals = [];
  for (let i = 0; i < A.length; i += 7) if (A[i] === A[i]) vals.push(A[i]);
  vals.sort((a, b) => a - b);
  const thr = 0.1 * (vals[Math.floor(vals.length * 0.98)] || 1);
  const pts = [];
  for (let z = 1; z < cz - 1; z++) for (let y = 1; y < cy - 1; y++) for (let x = (y + z) & 1; x < cx - 1; x += 2) { const i = z * sxy + y * cx + x; if (A[i] > thr) pts.push(x, y, z, A[i]); }
  const mid = [(cx - 1) / 2, (cy - 1) / 2, (cz - 1) / 2];
  const score = (p) => {
    const R = rotation(p[3], p[4], p[5]), t = [p[0] / cs, p[1] / cs, p[2] / cs];
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let k = 0; k < pts.length; k += 4) {
      const dx = pts[k] - mid[0], dy = pts[k + 1] - mid[1], dz = pts[k + 2] - mid[2];
      const fx = R[0][0] * dx + R[0][1] * dy + R[0][2] * dz + mid[0] + t[0], fy = R[1][0] * dx + R[1][1] * dy + R[1][2] * dz + mid[1] + t[1], fz = R[2][0] * dx + R[2][1] * dy + R[2][2] * dz + mid[2] + t[2];
      if (fx < 0 || fy < 0 || fz < 0 || fx >= cx - 1 || fy >= cy - 1 || fz >= cz - 1) continue;
      const x0 = fx | 0, y0 = fy | 0, z0 = fz | 0, tx = fx - x0, ty = fy - y0, tz = fz - z0, i = z0 * sxy + y0 * cx + x0;
      const b = ((B[i] * (1 - tx) + B[i + 1] * tx) * (1 - ty) + (B[i + cx] * (1 - tx) + B[i + cx + 1] * tx) * ty) * (1 - tz)
        + ((B[i + sxy] * (1 - tx) + B[i + sxy + 1] * tx) * (1 - ty) + (B[i + sxy + cx] * (1 - tx) + B[i + sxy + cx + 1] * tx) * ty) * tz;
      if (b !== b) continue;
      const a = pts[k + 3];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < pts.length / 8) return { ncc: -1, gain: 1 }; // moved mostly out of the picture
    const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return { ncc: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1, gain: sbb > 0 ? sab / sbb : 1 };
  };
  let p = [0, 0, 0, 0, 0, 0], best = score(p);
  const before = best.ncc, step = [2, 2, 2, 1.5, 1.5, 1.5];
  for (let round = 0; round < 60 && step[0] > 0.08; round++) {
    let moved = false;
    for (let k = 0; k < 6; k++) for (const dir of [1, -1]) {
      const q = p.slice(); q[k] += dir * step[k];
      const s = score(q);
      if (s.ncc > best.ncc + 1e-6) { p = q; best = s; moved = true; }
    }
    if (!moved) for (let k = 0; k < 6; k++) step[k] /= 2;
  }
  // only trust a believable correction that clearly helps; otherwise leave the scan where the scanner put it
  const ok = best.ncc > before + 0.002 && Math.hypot(p[0], p[1], p[2]) <= 15 && Math.max(Math.abs(p[3]), Math.abs(p[4]), Math.abs(p[5])) <= 12;
  if (!ok) { p = [0, 0, 0, 0, 0, 0]; best = score(p); }
  return { t: p.slice(0, 3), r: p.slice(3), before, after: best.ncc, gain: best.gain, moved: ok };
}

/**
 * Combine scans. vols[0] is the base: the result is laid out along its directions.
 * @param vols  [{ nx, ny, nz, data, origin, dx, dy, dz, basis, thick }]  thick = slice thickness in mm
 * @param opts  { voxel?: mm, align?: boolean, sharp?: number }  sharp > 1 takes less from the blurred direction of each scan
 * @param report (fraction, text) => void
 * @returns { nx, ny, nz, data: Float32Array, origin, dx, dy, dz, spacing, moves: [{t, r, before, after, moved}] }
 */
export function fuseVolumes(vols, opts = {}, report = () => {}) {
  const base = vols[0];
  // ---- the target grid: the base scan's box, along the base scan's directions ----
  const e = [base.basis[0], base.basis[1], base.basis[2].slice()];
  if (dot(base.dz, e[2]) < 0) e[2] = e[2].map((v) => -v);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of [-0.5, base.nx - 0.5]) for (const j of [-0.5, base.ny - 0.5]) for (const k of [-0.5, base.nz - 0.5]) {
    const p = [0, 1, 2].map((c) => i * base.dx[c] + j * base.dy[c] + k * base.dz[c]);
    for (let a = 0; a < 3; a++) { const v = dot(p, e[a]); if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  }
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  // as fine as the sharpest picture, within reason (at most about 20 million voxels)
  // (at most 256 voxels across, which keeps the transform in step 3 quick)
  const voxel = opts.voxel || Math.max(0.7, Math.min(...vols.map((v) => Math.min(len(v.dx), len(v.dy)))), Math.max(...size) / 256);
  const X = Math.round(size[0] / voxel), Y = Math.round(size[1] / voxel), Z = Math.round(size[2] / voxel), XY = X * Y, N = XY * Z;
  const corner = [0, 1, 2].map((c) => base.origin[c] + lo[0] * e[0][c] + lo[1] * e[1][c] + lo[2] * e[2][c]); // world position of the box corner
  const origin = [0, 1, 2].map((c) => corner[c] + 0.5 * voxel * (e[0][c] + e[1][c] + e[2][c]));         // center of voxel (0,0,0)
  const grid = { e, w0: corner, size };

  // ---- 1 and 2. line up and level ----
  report(0.05, 'Lining the scans up…');
  const cs = 3, C0 = coarse(base, grid, cs);
  const center = [0, 1, 2].map((c) => corner[c] + 0.5 * (size[0] * e[0][c] + size[1] * e[1][c] + size[2] * e[2][c]));
  const E = [[e[0][0], e[1][0], e[2][0]], [e[0][1], e[1][1], e[2][1]], [e[0][2], e[1][2], e[2][2]]]; // grid frame -> world (columns e0 e1 e2)
  const Et = [e[0], e[1], e[2]];                                                                         // world -> grid frame
  const scans = vols.map((v, k) => {
    let move = { t: [0, 0, 0], r: [0, 0, 0], before: 1, after: 1, gain: 1, moved: false };
    if (k > 0) {
      const Ck = coarse(v, grid, cs);
      move = opts.align === false ? { ...move, ...{ gain: align(C0, Ck).gain } } : align(C0, Ck);
      if (opts.align === false) { move.t = [0, 0, 0]; move.r = [0, 0, 0]; }
      report(0.05 + 0.2 * k / vols.length, 'Lining the scans up…');
    }
    // target index -> this scan's index:  f = A·x + b
    const Rw = matMul(E, matMul(rotation(...move.r), Et));          // the turn, in world axes
    const tw = matVec(E, move.t);                                     // the shift, in world axes
    const inv = inverseRows(v);
    const G = [0, 1, 2].map((r) => [e[0][r] * voxel, e[1][r] * voxel, e[2][r] * voxel]); // target index -> world (linear part)
    const A = matMul(inv, matMul(Rw, G));
    const o = [0, 1, 2].map((c) => origin[c] - center[c]);
    const Ro = matVec(Rw, o);
    const b = matVec(inv, [0, 1, 2].map((c) => Ro[c] + center[c] + tw[c] - v.origin[c]));
    // work with the pictures shrunk to about the target grain (keeps it quick; nothing finer could be shown anyway)
    const d = Math.max(1, Math.round(voxel / Math.min(len(v.dx), len(v.dy))));
    const mx = Math.ceil(v.nx / d), my = Math.ceil(v.ny / d), S = new Float32Array(mx * my * v.nz);
    for (let s = 0; s < v.nz; s++) for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++) {
      let acc = 0, n = 0;
      for (let yy = y * d; yy < Math.min(v.ny, y * d + d); yy++) for (let xx = x * d; xx < Math.min(v.nx, x * d + d); xx++) { acc += v.data[s * v.nx * v.ny + yy * v.nx + xx]; n++; }
      S[s * mx * my + y * mx + x] = acc / n * move.gain;
    }
    const sp = len(v.dz), th = Math.min(v.thick > 0 ? v.thick : sp, sp * 1.5);
    return { v, A, b, Ainv: matInv(A), d, mx, my, nz: v.nz, S, sp, th, move, off: (d - 1) / 2 };
  });

  // ---- 3. take the sharpest scan for every direction ----
  // Each scan, stretched onto the fine grid, is crisp across its pictures and
  // blurred through them. Split into waves (a Fourier transform), that means: a
  // wave that runs along a scan's slices is carried faithfully, a wave that runs
  // through them is lost. So every wave is taken from the scans that carry it,
  // in proportion to how well they do, and from no others. Detail seen in one
  // scan only comes from that scan alone (no blurry copy laid over it); coarse
  // shapes, which every scan carries, are averaged, which only lowers the noise.
  // value of a (shrunk) scan at a fractional position, blended between slices; NaN outside
  const sampleS = (sc, f0, f1, f2) => {
    const a = (f0 - sc.off) / sc.d, b = (f1 - sc.off) / sc.d, arr = sc.S;
    if (a < -0.5 || b < -0.5 || a > sc.mx - 0.5 || b > sc.my - 0.5 || f2 < -0.5 || f2 > sc.nz - 0.5) return NaN;
    const ca = a < 0 ? 0 : a > sc.mx - 1 ? sc.mx - 1 : a, cb = b < 0 ? 0 : b > sc.my - 1 ? sc.my - 1 : b, cz = f2 < 0 ? 0 : f2 > sc.nz - 1 ? sc.nz - 1 : f2;
    const x0 = ca | 0, y0 = cb | 0, x1 = x0 + 1 < sc.mx ? x0 + 1 : x0, y1 = y0 + 1 < sc.my ? y0 + 1 : y0, tx = ca - x0, ty = cb - y0;
    const at = (s) => { const o = s * sc.mx * sc.my; return (arr[o + y0 * sc.mx + x0] * (1 - tx) + arr[o + y0 * sc.mx + x1] * tx) * (1 - ty) + (arr[o + y1 * sc.mx + x0] * (1 - tx) + arr[o + y1 * sc.mx + x1] * tx) * ty; };
    const s0 = cz | 0, s1 = s0 + 1 < sc.nz ? s0 + 1 : s0, tz = cz - s0;
    return at(s0) * (1 - tz) + at(s1) * tz;
  };
  report(0.3, 'Laying the scans over each other…');
  // every scan on the fine grid; where a scan has no picture, the average of the others stands in
  const mean = new Float32Array(N), cover = new Uint8Array(N);
  const onGrid = scans.map((sc) => {
    const I = new Float32Array(N).fill(NaN), { A, b } = sc;
    for (let z = 0, i = 0; z < Z; z++) for (let y = 0; y < Y; y++) {
      let f0 = A[0][1] * y + A[0][2] * z + b[0], f1 = A[1][1] * y + A[1][2] * z + b[1], f2 = A[2][1] * y + A[2][2] * z + b[2];
      for (let x = 0; x < X; x++, i++, f0 += A[0][0], f1 += A[1][0], f2 += A[2][0]) {
        const v = sampleS(sc, f0, f1, f2);
        if (v === v) { I[i] = v; mean[i] += v; cover[i]++; }
      }
    }
    return I;
  });
  for (let i = 0; i < N; i++) if (cover[i]) mean[i] /= cover[i];
  const start = opts.keepStart ? new Float32Array(mean) : null;

  // transform size: the next power of two in each direction
  const pow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
  const PX = pow2(X), PY = pow2(Y), PZ = pow2(Z), PN = PX * PY * PZ;
  const accRe = new Float32Array(PN), accIm = new Float32Array(PN), re = new Float32Array(PN), im = new Float32Array(PN);
  // how far each scan smears along its own slice direction (mm): the slice thickness
  // plus the blending between slices, as the width of an equivalent bell curve
  const sharp = opts.sharp ?? 1;
  const info = scans.map((sc) => {
    const g = sc.A[2], gl = Math.hypot(g[0], g[1], g[2]);
    return { n: [g[0] / gl, g[1] / gl, g[2] / gl], sigma: Math.sqrt(sc.th * sc.th / 12 + sc.sp * sc.sp / 6) * sharp };
  });
  const fx = Float32Array.from({ length: PX }, (_, k) => (k <= PX / 2 ? k : k - PX) / PX / voxel);
  const fy = Float32Array.from({ length: PY }, (_, k) => (k <= PY / 2 ? k : k - PY) / PY / voxel);
  const fz = Float32Array.from({ length: PZ }, (_, k) => (k <= PZ / 2 ? k : k - PZ) / PZ / voxel);
  const K = scans.length, w = new Float64Array(K), c2 = info.map((s) => (2 * Math.PI * s.sigma) ** 2);
  for (let k = 0; k < K; k++) {
    report(0.35 + 0.5 * k / K, `Taking the sharp detail from scan ${k + 1} of ${K}…`);
    re.fill(0); im.fill(0);
    const I = onGrid[k];
    for (let z = 0, i = 0; z < Z; z++) for (let y = 0; y < Y; y++) { const o = z * PX * PY + y * PX; for (let x = 0; x < X; x++, i++) re[o + x] = I[i] === I[i] ? I[i] : mean[i]; }
    onGrid[k] = null;
    fft3(re, im, PX, PY, PZ, false);
    for (let z = 0, i = 0; z < PZ; z++) for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++, i++) {
      let sum = 0;
      for (let j = 0; j < K; j++) { const n = info[j].n, f = fx[x] * n[0] + fy[y] * n[1] + fz[z] * n[2]; sum += w[j] = Math.exp(-c2[j] * f * f); }
      const a = sum > 1e-30 ? w[k] / sum : 1 / K;
      accRe[i] += re[i] * a; accIm[i] += im[i] * a;
    }
  }
  report(0.88, 'Putting it together…');
  fft3(accRe, accIm, PX, PY, PZ, true);
  const V = new Float32Array(N);
  for (let z = 0, i = 0; z < Z; z++) for (let y = 0; y < Y; y++) { const o = z * PX * PY + y * PX; for (let x = 0; x < X; x++, i++) V[i] = cover[i] ? Math.max(0, accRe[o + x]) : 0; }
  report(1, 'Done');
  return {
    nx: X, ny: Y, nz: Z, data: V, start, origin,
    dx: e[0].map((v) => v * voxel), dy: e[1].map((v) => v * voxel), dz: e[2].map((v) => v * voxel),
    row: e[0], col: e[1], spacing: voxel,
    moves: scans.map((s) => ({ t: s.move.t, r: s.move.r, before: s.move.before, after: s.move.after, moved: s.move.moved, gain: s.move.gain })),
  };
}
