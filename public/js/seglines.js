// seglines.js — the two heavy inner loops of the model builder, written so a
// range of lines can be processed independently. segworker.js splits each pass
// over the volume between itself and helper threads (seghelper.js) that work on
// the same shared memory.
//
// A "line" is one row of voxels along `axis` (0 = x, 1 = y, 2 = z).

function geometry(X, Y, Z, axis) {
  const XY = X * Y;
  if (axis === 0) return { n: X, stride: 1, base: (l) => l * X };
  if (axis === 1) return { n: Y, stride: X, base: (l) => Math.floor(l / X) * XY + (l % X) };
  return { n: Z, stride: XY, base: (l) => l };
}

export function lineCount(X, Y, Z, axis) {
  return axis === 0 ? Y * Z : axis === 1 ? X * Z : X * Y;
}

const INF = 1e12;

/** One pass of the exact squared Euclidean distance transform (Felzenszwalb). */
function edt(d, X, Y, Z, axis, from, to) {
  const { n, stride, base } = geometry(X, Y, Z, axis);
  const f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let l = from; l < to; l++) {
    const b = base(l);
    let any = false;
    for (let i = 0; i < n; i++) { f[i] = d[b + i * stride]; if (f[i] < INF) any = true; }
    if (!any) continue;
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k] && k > 0) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[b + q * stride] = (q - p) * (q - p) + f[p];
    }
  }
}

/** One pass of a separable blur with the given kernel (odd length, sums to 1). */
function gauss(a, X, Y, Z, axis, from, to, kernel) {
  const { n, stride, base } = geometry(X, Y, Z, axis);
  const r = (kernel.length - 1) >> 1;
  const line = new Float32Array(n);
  for (let l = from; l < to; l++) {
    const b = base(l);
    for (let i = 0; i < n; i++) line[i] = a[b + i * stride];
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) { const q = i + j; s += kernel[j + r] * line[q < 0 ? 0 : q >= n ? n - 1 : q]; }
      a[b + i * stride] = s;
    }
  }
}

export const LINES = { edt, gauss };
export const EDT_INF = INF;
