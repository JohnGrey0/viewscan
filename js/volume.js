// volume.js — a loaded stack as a 3-D grid with patient-space geometry.
// Patient coordinates are DICOM LPS millimeters (x → patient left,
// y → posterior, z → head). The index → world map is affine, so gantry-tilted
// (sheared) CT acquisitions are handled exactly.

import { cross, dot } from './series.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
export const vec = { add, sub, mul, len, norm, cross, dot };

function inv3(c0, c1, c2) {
  // inverse of the matrix whose columns are c0,c1,c2; returned as rows
  const r0 = cross(c1, c2), r1 = cross(c2, c0), r2 = cross(c0, c1);
  const det = dot(c0, r0);
  return [mul(r0, 1 / det), mul(r1, 1 / det), mul(r2, 1 / det)];
}

const AXES = { SAG: [1, 0, 0], COR: [0, 1, 0], AX: [0, 0, 1] };
// preferred screen-right / screen-down directions per anatomical view
// How pictures are laid out. Hospitals draw top-down and front pictures with the patient's left on the
// right of the screen (as if facing the patient); leftOnLeft mirrors those two, letters included.
export const display = { leftOnLeft: false, unwrap: true }; // unwrap: put wrapped-around parts back (see Volume.unwrap)
const SCREEN = { AX: [[1, 0, 0], [0, 1, 0]], COR: [[1, 0, 0], [0, 0, -1]], SAG: [[0, 1, 0], [0, 0, -1]] };

export class Volume {
  /** @param {import('./loader.js').Stack} stack fully loaded, desc.volume === true */
  constructor(stack) {
    const d = stack.desc;
    const f0 = stack.frames.find((f) => f && f.ipp);
    const iop = f0.iop, ps = f0.ps || d.ps || [1, 1];
    this.stack = stack;
    this.nx = stack.cols; this.ny = stack.rows; this.nz = stack.n;
    this.data = stack.buffer;
    this.isFloat = this.data instanceof Float32Array;
    const row = norm(iop.slice(0, 3)), col = norm(iop.slice(3, 6));
    const normal = cross(row, col);
    const first = stack.frames[0].ipp, last = stack.frames[this.nz - 1].ipp;
    let dz = mul(sub(last, first), 1 / (this.nz - 1));

    if (d.layout === 'irregular') {
      // uneven slice spacing: resample onto an even grid along the stack direction
      const pos = stack.frames.map((f) => dot(f.ipp, normal));
      const steps = pos.slice(1).map((p, i) => p - pos[i]).filter((s) => s > 0.01).sort((a, b) => a - b);
      // the usual spacing, not the smallest: a joined stack has one odd gap at the seam
      const step = Math.max(steps[steps.length >> 1] || 1, (pos[pos.length - 1] - pos[0]) / 600);
      const nz = Math.floor((pos[pos.length - 1] - pos[0]) / step) + 1;
      const size = this.nx * this.ny;
      const out = new this.data.constructor(size * nz);
      let k = 0;
      for (let z = 0; z < nz; z++) {
        const p = pos[0] + z * step;
        while (k < pos.length - 2 && pos[k + 1] < p) k++;
        const t = Math.min(1, Math.max(0, (p - pos[k]) / ((pos[k + 1] - pos[k]) || 1)));
        const a = this.data.subarray(k * size, (k + 1) * size), b = this.data.subarray((k + 1) * size, (k + 2) * size);
        const o = out.subarray(z * size, (z + 1) * size);
        for (let i = 0; i < size; i++) o[i] = a[i] + (b[i] - a[i]) * t;
      }
      this.data = out; this.nz = nz;
      dz = mul(sub(last, first), step / (pos[pos.length - 1] - pos[0]));
    }

    this.origin = first;                 // center of voxel (0,0,0)
    this.dx = mul(row, ps[1]);           // step for +1 column
    this.dy = mul(col, ps[0]);           // step for +1 row
    this.dz = dz;                        // step for +1 slice
    this.spacing = [ps[1], ps[0], len(dz)];
    this.unwrapped = display.unwrap && stack.unit !== 'HU' ? this.unwrap() : [];
    this.inv = inv3(this.dx, this.dy, this.dz);
    this.basis = [row, col, norm(normal)];
    this.center = this.toWorld((this.nx - 1) / 2, (this.ny - 1) / 2, (this.nz - 1) / 2);
    this.radius = 0.5 * len(add(add(mul(this.dx, this.nx), mul(this.dy, this.ny)), mul(this.dz, this.nz)));
    this.views = this.assignViews();
    this.id = `vol${stack.uid}`;
  }

  /**
   * MRI wrap-around: what sticks out of the measured box on one side is drawn at the
   * opposite side (a nose tip floating behind the head on a quick overview scan). The
   * fold is exact, so it can be undone: the picture is rotated along that direction
   * until the cut falls in the empty gap between the head and the stray piece, and the
   * grid's origin moves with it, so the head stays where it was and the piece lands
   * where it belongs. Only done when the signs are clear: tissue at both ends of a
   * direction, an empty gap inside, and a small piece on one side of it.
   * The stack's own pictures are not changed (a copy is rotated).
   * @returns the directions that were put right (0 columns, 1 rows, 2 slices)
   */
  unwrap() {
    const { nx, ny, nz } = this, dims = [nx, ny, nz], steps = [this.dx, this.dy, this.dz], done = [];
    let data = this.data;
    const sample = [];
    for (let i = 0, st = Math.max(1, Math.floor(data.length / 200000)); i < data.length; i += st) sample.push(data[i]);
    sample.sort((a, b) => a - b);
    const thr = sample[0] + (sample[Math.floor(sample.length * 0.99)] - sample[0]) * 0.15; // brighter than this is tissue
    for (let a = 0; a < 3; a++) {
      const n = dims[a];
      if (n < 24) continue;
      // tissue per plane across this direction (every second voxel is enough)
      const prof = new Float64Array(n), sx = a === 0 ? 1 : 2, sy = a === 1 ? 1 : 2, sz = a === 2 ? 1 : 2;
      for (let z = 0; z < nz; z += sz) for (let y = 0; y < ny; y += sy) {
        const row = (z * ny + y) * nx;
        for (let x = 0; x < nx; x += sx) if (data[row + x] > thr) prof[a === 0 ? x : a === 1 ? y : z]++;
      }
      const few = Math.max(3, dims[(a + 1) % 3] * dims[(a + 2) % 3] / 4 * 0.0008), empty = (i) => prof[i] < few;
      // tissue must reach both ends (scanners blank a plane or two at the very edge)
      let first = 0, last = n - 1;
      while (first < n && empty(first)) first++;
      while (last > first && empty(last)) last--;
      // a half-blanked plane next to them (far less tissue than its inner neighbor) counts as blank too
      for (let t = 0; t < 2 && first < last - 2 && prof[first] < 0.3 * prof[first + 1]; t++) first++;
      for (let t = 0; t < 2 && last > first + 2 && prof[last] < 0.3 * prof[last - 1]; t++) last--;
      const edge = Math.max(3, Math.round(n * 0.025));
      if (first > edge || n - 1 - last > edge) continue;
      let g0 = 0, g1 = -1;
      for (let i = first, s = -1; i <= last + 1; i++) {
        if (i <= last && empty(i)) { if (s < 0) s = i; } else if (s >= 0) { if (i - s > g1 - g0 + 1) { g0 = s; g1 = i - 1; } s = -1; }
      }
      if (g1 - g0 + 1 < Math.max(3, n * 0.03)) continue;
      let low = 0, high = 0;
      for (let i = 0; i < g0; i++) low += prof[i];
      for (let i = g1 + 1; i < n; i++) high += prof[i];
      const piece = Math.min(low, high), all = low + high;
      if (piece > all * 0.25 || piece < all * 0.0005) continue;
      const k = (g0 + g1 + 1) >> 1; // the plane that becomes the first one: the middle of the gap
      const out = new data.constructor(data.length), stride = [1, nx, nx * ny][a], block = stride * n;
      // rotate by k planes along direction a: new plane i holds old plane (i + k) mod n
      for (let base = 0; base < data.length; base += block) {
        const shift = k * stride;
        out.set(data.subarray(base + shift, base + block), base);
        out.set(data.subarray(base, base + shift), base + block - shift);
      }
      // The scanner blanks a plane or two at each edge of its box, which would leave a thin empty
      // slit where the piece rejoins. The piece is moved up against the head across those planes
      // (the owner asked for that, not for the slit to be filled in with made-up values).
      const pa = ((last - k) % n + n) % n, pb = ((first - k) % n + n) % n, blank = pb - pa - 1;
      if (blank > 0 && blank <= 2 * edge) {
        const by = blank * stride;
        for (let base = 0; base < out.length; base += block) {
          // the piece lies before the blank planes (it came from the high end) or after them
          if (high < low) out.copyWithin(base + by, base, base + (pa + 1) * stride);
          else out.copyWithin(base + (pa + 1) * stride, base + pb * stride, base + block);
        }
      }
      data = out;
      const by = high < low ? k - n : k; // the stray piece was at the high end: it belongs before the first plane
      this.origin = this.origin.map((v, c) => v + steps[a][c] * by);
      done.push(a);
    }
    this.data = data;
    return done;
  }

  toWorld(i, j, k) {
    const { origin: o, dx, dy, dz } = this;
    return [o[0] + i * dx[0] + j * dy[0] + k * dz[0], o[1] + i * dx[1] + j * dy[1] + k * dz[1], o[2] + i * dx[2] + j * dy[2] + k * dz[2]];
  }
  toIndex(p) {
    const q = sub(p, this.origin);
    return [dot(this.inv[0], q), dot(this.inv[1], q), dot(this.inv[2], q)];
  }
  /** Column-major 4x4 world → index matrix for shaders. */
  worldToIndexMatrix() {
    const [r0, r1, r2] = this.inv, o = this.origin;
    return new Float32Array([
      r0[0], r1[0], r2[0], 0,
      r0[1], r1[1], r2[1], 0,
      r0[2], r1[2], r2[2], 0,
      -dot(r0, o), -dot(r1, o), -dot(r2, o), 1,
    ]);
  }
  /** Trilinear sample at a world point; NaN outside the volume. */
  sample(p) {
    const [x, y, z] = this.toIndex(p);
    const { nx, ny, nz, data } = this;
    if (x < -0.5 || y < -0.5 || z < -0.5 || x > nx - 0.5 || y > ny - 0.5 || z > nz - 0.5) return NaN;
    const cx = Math.min(nx - 1, Math.max(0, x)), cy = Math.min(ny - 1, Math.max(0, y)), cz = Math.min(nz - 1, Math.max(0, z));
    const x0 = Math.floor(cx), y0 = Math.floor(cy), z0 = Math.floor(cz);
    const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1);
    const fx = cx - x0, fy = cy - y0, fz = cz - z0;
    const s = nx * ny;
    const at = (i, j, k) => data[k * s + j * nx + i];
    const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx, c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
    const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx, c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }

  /**
   * Map the acquisition's own orthogonal frame (row, column, normal) onto the
   * three anatomical views, so the native plane shows the original slices
   * unresampled and the other two are exactly perpendicular to it.
   */
  assignViews() {
    const b = this.basis;
    const stepOf = [this.spacing[0], this.spacing[1], Math.abs(dot(this.dz, b[2]))];
    const names = ['SAG', 'COR', 'AX'];
    let best = null;
    for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const score = perm.reduce((s, bi, k) => s + Math.abs(dot(b[bi], AXES[names[k]])), 0);
      if (!best || score > best.score) best = { score, perm };
    }
    const views = {};
    names.forEach((name, k) => {
      const ni = best.perm[k];
      const others = [0, 1, 2].filter((x) => x !== ni);
      let [wantU, wantV] = SCREEN[name];
      if (display.leftOnLeft && name !== 'SAG') wantU = mul(wantU, -1);
      const ui = Math.abs(dot(b[others[0]], wantU)) >= Math.abs(dot(b[others[1]], wantU)) ? others[0] : others[1];
      const vi = others.find((x) => x !== ui);
      const u = mul(b[ui], Math.sign(dot(b[ui], wantU)) || 1);
      const v = mul(b[vi], Math.sign(dot(b[vi], wantV)) || 1);
      const n = mul(b[ni], Math.sign(dot(b[ni], AXES[name])) || 1);
      views[name] = { u, v, n, step: stepOf[ni], native: ni === 2, extent: this.extentAlong(n), extentU: this.extentAlong(u), extentV: this.extentAlong(v) };
    });
    return views;
  }
  /** Full size of the volume's bounding box measured along direction d (mm). */
  extentAlong(d) {
    return Math.abs(dot(this.dx, d)) * this.nx + Math.abs(dot(this.dy, d)) * this.ny + Math.abs(dot(this.dz, d)) * this.nz;
  }
}

/** Patient-direction letters for a world vector, e.g. "L", "AS". */
export function orientLetters(v) {
  const parts = [[Math.abs(v[0]), v[0] > 0 ? 'L' : 'R'], [Math.abs(v[1]), v[1] > 0 ? 'P' : 'A'], [Math.abs(v[2]), v[2] > 0 ? 'S' : 'I']];
  parts.sort((a, b) => b[0] - a[0]);
  let s = parts[0][1];
  if (parts[1][0] > 0.3) s += parts[1][1];
  return s;
}
