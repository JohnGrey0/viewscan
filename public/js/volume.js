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
export const display = { leftOnLeft: false };
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
    this.inv = inv3(this.dx, this.dy, this.dz);
    this.basis = [row, col, norm(normal)];
    this.center = this.toWorld((this.nx - 1) / 2, (this.ny - 1) / 2, (this.nz - 1) / 2);
    this.radius = 0.5 * len(add(add(mul(this.dx, this.nx), mul(this.dy, this.ny)), mul(this.dz, this.nz)));
    this.views = this.assignViews();
    this.id = `vol${stack.uid}`;
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
