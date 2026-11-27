// brainnet.js — finds brain tissue with a small neural network, on the graphics card.
//
// The networks are the "MeshNet" models of brainchop / brain2print (MIT license, see
// public/models/LICENSE-brain2print.txt): a stack of 3x3x3 convolutions with growing
// and shrinking reach, then one layer that scores every class for every voxel. They
// were trained on T1-weighted head MRI brought to a standard 256-cube at 1 mm.
// This file runs them with WebGPU compute shaders written for Viewscan (no library):
//   1. the scan is resampled to that standard cube (left, down, front; 1 mm);
//   2. brightness is scaled the way the models were trained;
//   3. the empty border is cropped off and the layers are run one after another;
//   4. every voxel gets its most likely class and how sure the network is that the
//      voxel is brain at all.
// Nothing leaves the computer: the model files are part of the app.

// The same list brain2print offers, with its settings for each: how brightness is
// scaled (quantile), how empty space is cropped (thr: share of the brightest value;
// pad: empty voxels added round the crop), and whether the fast mask model runs
// first to find the box the brain is in (pre).
export const MODELS = {
  partsBig: { dir: 'model30chan18cls', quantile: false, thr: 0.2, pad: 0, name: 'Subcortical + GWM (high memory, fast)' },
  parts: { dir: 'model18cls', quantile: false, thr: 0.2, pad: 0, name: 'Subcortical + GWM (low memory, faster)' },
  tissue: { dir: 'model20chan3cls', quantile: true, thr: 0.2, pad: 0, name: 'Tissue GWM (high accuracy)' },
  tissueFast: { dir: 'model5_gw_ae', quantile: false, thr: 0, pad: 18, name: 'Tissue GWM (light)' },
  maskFast: { dir: 'model5_gw_ae', quantile: false, thr: 0, pad: 17, name: 'Brain mask (fast)' },
  mask: { dir: 'model11_gw_ae', quantile: true, thr: 0, pad: 0, name: 'Brain mask (high accuracy)' },
  areas50: { dir: 'model30chan50cls', quantile: true, thr: 0, pad: 0, pre: 'maskFast', name: 'Aparc+Aseg 50' },
  areas104: { dir: 'model21_104class', quantile: false, thr: 0, pad: 0, pre: 'maskFast', name: 'Aparc+Aseg 104' },
};
// Models trained at home with viewscan-train are listed in models/own/index.json and
// added here when the app starts (see ownModels in segment.js). Such a model says
// how many of its first classes are not brain (notBrain) and which class numbers
// are the cerebellum.
/** Class numbers of the 18-part models (FreeSurfer names). */
export const PARTS = ['Unknown', 'Cerebral-White-Matter', 'Cerebral-Cortex', 'Lateral-Ventricle', 'Inferior-Lateral-Ventricle', 'Cerebellum-White-Matter', 'Cerebellum-Cortex', 'Thalamus', 'Caudate', 'Putamen', 'Pallidum', '3rd-Ventricle', '4th-Ventricle', 'Brain-Stem', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC'];

export const SIZE = 256; // the standard cube
// Axes of the cube in patient coordinates (x to the patient's left, y to the back,
// z up): first index runs to the left, second down, third to the front.
const AXES = [[1, 0, 0], [0, 0, -1], [0, -1, 0]];

export function gpuAvailable() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

const cache = new Map();
/** Reads a model: its layers in order, each with kernel and bias in one array. */
export async function loadModel(key) {
  const def = MODELS[key];
  if (def && cache.has(def.dir) && (!def.ver || cache.get(def.dir).ver === def.ver)) return { ...cache.get(def.dir), key, def };
  if (!def) throw new Error('Unknown model ' + key);
  if (def.ver && cache.has(def.dir) && cache.get(def.dir).ver !== def.ver) cache.delete(def.dir); // retrained since
  const base = new URL(`../models/${def.dir}/`, import.meta.url);
  const fresh = def.ver ? { cache: 'no-cache' } : undefined;
  const json = await (await fetch(new URL('model.json', base), fresh)).json();
  const man = json.weightsManifest[0];
  const bin = await (await fetch(new URL(man.paths[0], base), fresh)).arrayBuffer();
  const at = new Map();
  let off = 0;
  for (const w of man.weights) { const n = w.shape.reduce((a, b) => a * b, 1); at.set(w.name, { off, n, shape: w.shape }); off += n * 4; }
  if (off !== bin.byteLength) throw new Error('Model file does not match its description');
  const topo = json.modelTopology.model_config ? json.modelTopology.model_config.config : json.modelTopology.config;
  const layers = [];
  let act = 'elu';
  for (const l of topo.layers) {
    if (l.class_name === 'Activation') { act = l.config.activation; continue; }
    if (l.class_name !== 'Conv3D') continue;
    const k = at.get(l.config.name + '/kernel'), b = at.get(l.config.name + '/bias');
    if (!k || !b || k.shape[0] !== l.config.kernel_size[0] || k.shape[4] !== l.config.filters) throw new Error('Model file does not match its description');
    const w = new Float32Array(k.n + b.n);
    w.set(new Float32Array(bin, k.off, k.n));
    w.set(new Float32Array(bin, b.off, b.n), k.n);
    layers.push({ size: k.shape[0], cin: k.shape[3], cout: k.shape[4], dil: l.config.dilation_rate[0], w });
  }
  const model = { key, def, layers, act, classes: layers[layers.length - 1].cout, ver: def.ver };
  cache.set(def.dir, model);
  return model;
}

/**
 * The scan in the standard cube: 256 x 256 x 256 voxels of 1 mm, centered on the
 * scan, brightness 0 to 255 (the darkest and brightest 2% are clipped).
 * @returns {{data:Uint8Array, c0:number[], axes:number[][]}} c0 = patient position of voxel (0,0,0)
 */
export function conform(vol, opts = {}) {
  const { nx, ny, nz, data, origin, dx, dy, dz } = vol;
  const S = SIZE, out = new Uint8Array(S * S * S);
  const sample = [];
  let least = Infinity;
  for (let i = 0; i < data.length; i += 97) if (data[i] < least) least = data[i];
  // air does not count: the range is taken from the voxels that show something
  for (let i = 0; i < data.length; i += Math.max(1, Math.floor(data.length / 800000))) if (data[i] > least) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const lo = least, hi = sample.length ? sample[Math.floor((sample.length - 1) * (opts.hiQ ?? 0.98))] : least + 1;
  const scale = 255 / Math.max(1e-9, hi - lo);
  const center = [0, 1, 2].map((c) => origin[c] + (nx - 1) / 2 * dx[c] + (ny - 1) / 2 * dy[c] + (nz - 1) / 2 * dz[c]);
  const half = (S - 1) / 2;
  const AX = opts.axes || AXES;
  const c0 = [0, 1, 2].map((c) => center[c] - half * (AX[0][c] + AX[1][c] + AX[2][c]));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const r0 = cr(dy, dz), r1 = cr(dz, dx), r2 = cr(dx, dy), det = dot(dx, r0);
  const inv = [r0, r1, r2].map((r) => r.map((v) => v / det));
  const toIdx = (p) => { const q = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]; return [dot(inv[0], q), dot(inv[1], q), dot(inv[2], q)]; };
  const A0 = toIdx(c0);
  const step = AX.map((a) => { const q = toIdx([c0[0] + a[0], c0[1] + a[1], c0[2] + a[2]]); return [q[0] - A0[0], q[1] - A0[1], q[2] - A0[2]]; });
  const s = nx * ny;
  for (let d = 0, o = 0; d < S; d++) for (let h = 0; h < S; h++) {
    const bx = A0[0] + d * step[0][0] + h * step[1][0], by = A0[1] + d * step[0][1] + h * step[1][1], bz = A0[2] + d * step[0][2] + h * step[1][2];
    for (let w = 0; w < S; w++, o++) {
      const fx = bx + w * step[2][0], fy = by + w * step[2][1], fz = bz + w * step[2][2];
      if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nx - 0.5 || fy > ny - 0.5 || fz > nz - 0.5) continue;
      const cx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx, cy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy, cz = fz < 0 ? 0 : fz > nz - 1 ? nz - 1 : fz;
      const x0 = cx | 0, y0 = cy | 0, z0 = cz | 0;
      const x1 = x0 + 1 < nx ? x0 + 1 : x0, y1 = y0 + 1 < ny ? y0 + 1 : y0, z1 = z0 + 1 < nz ? z0 + 1 : z0;
      const tx = cx - x0, ty = cy - y0, tz = cz - z0;
      const a = z0 * s + y0 * nx, b = z0 * s + y1 * nx, c = z1 * s + y0 * nx, e = z1 * s + y1 * nx;
      const v0 = (data[a + x0] * (1 - tx) + data[a + x1] * tx) * (1 - ty) + (data[b + x0] * (1 - tx) + data[b + x1] * tx) * ty;
      const v1 = (data[c + x0] * (1 - tx) + data[c + x1] * tx) * (1 - ty) + (data[e + x0] * (1 - tx) + data[e + x1] * tx) * ty;
      const v = ((v0 * (1 - tz) + v1 * tz) - lo) * scale;
      out[o] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
  return { data: out, c0, axes: AX };
}

/**
 * Merges a model's answers for several series of one study into the first one's cube.
 * A hospital study is the same head scanned several times, with thick slices in
 * different directions: each answer is sharp where the others are coarse, so their
 * average is better than any one of them. All series share the scanner's coordinates,
 * so an answer only has to be shifted. An answer that does not fit the first one
 * (the head moved, or the model failed on that series) is left out.
 * @param base    {prob, c0, geo:{nx,ny,nz,origin,dx,dy,dz}}
 * @param others  the same, for the other series
 * @returns {{prob:Uint8Array, used:number, total:number}}
 */
export function mergeAnswers(base, others) {
  const S = SIZE, N = S * S * S, AX = AXES;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // which voxels of the base cube lie inside a scan
  const coverage = (g) => {
    const r0 = cr(g.dy, g.dz), r1 = cr(g.dz, g.dx), r2 = cr(g.dx, g.dy), det = dot(g.dx, r0);
    const inv = [r0, r1, r2].map((r) => r.map((v) => v / det));
    const toIdx = (p) => { const q = [p[0] - g.origin[0], p[1] - g.origin[1], p[2] - g.origin[2]]; return [dot(inv[0], q), dot(inv[1], q), dot(inv[2], q)]; };
    const A0 = toIdx(base.c0);
    const step = AX.map((a) => { const q = toIdx([base.c0[0] + a[0], base.c0[1] + a[1], base.c0[2] + a[2]]); return [q[0] - A0[0], q[1] - A0[1], q[2] - A0[2]]; });
    const m = new Uint8Array(N), hi = [g.nx - 0.5, g.ny - 0.5, g.nz - 0.5];
    for (let d = 0, o = 0; d < S; d++) for (let h = 0; h < S; h++) {
      const bx = A0[0] + d * step[0][0] + h * step[1][0], by = A0[1] + d * step[0][1] + h * step[1][1], bz = A0[2] + d * step[0][2] + h * step[1][2];
      for (let w = 0; w < S; w++, o++) {
        const fx = bx + w * step[2][0], fy = by + w * step[2][1], fz = bz + w * step[2][2];
        if (fx >= -0.5 && fy >= -0.5 && fz >= -0.5 && fx <= hi[0] && fy <= hi[1] && fz <= hi[2]) m[o] = 1;
      }
    }
    return m;
  };
  const sum = new Float32Array(N), cnt = coverage(base.geo);
  for (let i = 0; i < N; i++) if (cnt[i]) sum[i] = base.prob[i];
  const tmp = new Int16Array(N);
  let used = 0;
  for (const o of others) {
    const diff = [base.c0[0] - o.c0[0], base.c0[1] - o.c0[1], base.c0[2] - o.c0[2]];
    const off = AX.map((a) => dot(a, diff)); // base voxel p is voxel p + off of the other cube
    const i0 = off.map(Math.floor), f = off.map((v, k) => v - i0[k]);
    const wts = [], jump = [];
    for (let c = 0; c < 8; c++) { const a = c & 1, b = (c >> 1) & 1, e = (c >> 2) & 1; wts.push((a ? f[0] : 1 - f[0]) * (b ? f[1] : 1 - f[1]) * (e ? f[2] : 1 - f[2])); jump.push((a * S + b) * S + e); }
    const m = coverage(o.geo), P = o.prob;
    let both = 0, na = 0, nb = 0;
    for (let d = 0, i = 0; d < S; d++) for (let h = 0; h < S; h++) for (let w = 0; w < S; w++, i++) {
      tmp[i] = -1;
      if (!m[i]) continue;
      const qd = d + i0[0], qh = h + i0[1], qw = w + i0[2];
      if (qd < 0 || qh < 0 || qw < 0 || qd >= S - 1 || qh >= S - 1 || qw >= S - 1) continue;
      const q = (qd * S + qh) * S + qw;
      let v = 0;
      for (let c = 0; c < 8; c++) v += wts[c] * P[q + jump[c]];
      tmp[i] = v;
      if (cnt[i] && sum[i] >= 0) { const a = base.prob[i] > 127, b = v > 127; if (a) na++; if (b) nb++; if (a && b) both++; }
    }
    if (na < 1000 || 2 * both / (na + nb) < 0.75) continue; // does not fit: left out
    used++;
    for (let i = 0; i < N; i++) if (tmp[i] >= 0) { sum[i] += tmp[i]; cnt[i]++; }
  }
  const prob = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (cnt[i]) prob[i] = Math.round(sum[i] / cnt[i]);
  return { prob, used, total: others.length };
}

const CONV = /* wgsl */ `
struct P { D: u32, H: u32, W: u32, cin: u32, cout: u32, dil: i32, d0: u32, act: u32 };
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> wt: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let d = g.z + p.d0; let h = g.y; let w = g.x;
  if (d >= p.D || h >= p.H || w >= p.W) { return; }
  var acc: array<f32, 32>;
  let kb = 27u * p.cin * p.cout;
  for (var c = 0u; c < p.cout; c++) { acc[c] = wt[kb + c]; }
  for (var t = 0u; t < 27u; t++) {
    let dd = i32(d) + (i32(t / 9u) - 1) * p.dil;
    let hh = i32(h) + (i32((t / 3u) % 3u) - 1) * p.dil;
    let ww = i32(w) + (i32(t % 3u) - 1) * p.dil;
    if (dd < 0 || hh < 0 || ww < 0 || dd >= i32(p.D) || hh >= i32(p.H) || ww >= i32(p.W)) { continue; }
    let sb = ((u32(dd) * p.H + u32(hh)) * p.W + u32(ww)) * p.cin;
    let wb = t * p.cin * p.cout;
    for (var ci = 0u; ci < p.cin; ci++) {
      let s = src[sb + ci];
      let wo = wb + ci * p.cout;
      for (var co = 0u; co < p.cout; co++) { acc[co] += s * wt[wo + co]; }
    }
  }
  let ob = ((d * p.H + h) * p.W + w) * p.cout;
  for (var c = 0u; c < p.cout; c++) {
    var v = acc[c];
    if (p.act == 1u) { v = max(v, 0.0); } else if (p.act == 2u && v < 0.0) { v = exp(v) - 1.0; }
    dst[ob + c] = v;
  }
}`;
// last layer: score every class, keep the best one and how likely "brain" is: one minus
// the share of the first classes, which are not brain (p.act holds how many; 1 = background only)
const HEAD = /* wgsl */ `
struct P { D: u32, H: u32, W: u32, cin: u32, cout: u32, dil: i32, d0: u32, act: u32 };
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> wt: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let d = g.z + p.d0; let h = g.y; let w = g.x;
  if (d >= p.D || h >= p.H || w >= p.W) { return; }
  let v = (d * p.H + h) * p.W + w;
  let sb = v * p.cin;
  let kb = p.cin * p.cout;
  var best = 0u; var bestV = -1e30; var zero = 0.0; var top = -1e30;
  var logit: array<f32, 128>;
  for (var co = 0u; co < p.cout; co++) {
    var a = wt[kb + co];
    for (var ci = 0u; ci < p.cin; ci++) { a += src[sb + ci] * wt[ci * p.cout + co]; }
    logit[co] = a;
    if (a > bestV) { bestV = a; best = co; }
  }
  var sum = 0.0;
  for (var co = 0u; co < p.cout; co++) { sum += exp(logit[co] - bestV); }
  dst[v * 2u] = f32(best);
  var out = 0.0;
  for (var co = 0u; co < p.act && co < p.cout; co++) { out += exp(logit[co] - bestV); }
  dst[v * 2u + 1u] = 1.0 - out / sum;
}`;

let gpu = null; // { adapter, device, conv, head } kept between runs
async function getDevice(bytes) {
  if (gpu && gpu.limit >= bytes && !gpu.lost) return gpu;
  if (!gpuAvailable()) throw new Error('This browser has no WebGPU, which the brain models need. A current Chrome or Edge has it.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No graphics card was found for WebGPU.');
  const most = Math.min(adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize);
  if (bytes > most) throw new Error('The graphics card cannot hold this model for a scan this size.');
  const limit = Math.min(most, Math.max(bytes, 1 << 28));
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit } });
  const make = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  gpu = { adapter, device, limit, conv: make(CONV), head: make(HEAD), lost: false };
  device.lost.then(() => { if (gpu && gpu.device === device) gpu.lost = true; });
  return gpu;
}

/**
 * Runs a model on a scan.
 * @param {{nx,ny,nz,data,origin,dx,dy,dz}} vol
 * @param {string} key  a key of MODELS
 * @param {(fraction:number, text:string)=>void} [onProgress]
 * @returns {Promise<{labels:Uint8Array, prob:Uint8Array, c0:number[], axes:number[][], classes:number, ms:number, box:number[]}>}
 *   labels and prob (0-255: how sure that a voxel is brain) fill the standard cube.
 */
export async function runModel(vol, key, onProgress = () => {}, opts = {}) {
  const t0 = performance.now();
  onProgress(0, 'Loading the brain model…');
  const model = await loadModel(key);
  onProgress(0.03, 'Preparing the scan for the model…');
  const cube = conform(vol, opts), S = SIZE, img = cube.data;
  // brightness the way the model was trained: by quantiles or by the brightest value, over the whole cube
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.length; i++) hist[img[i]]++;
  const rank = (q) => { let n = Math.floor(q * (img.length - 1)), v = 0; while (v < 255 && n >= hist[v]) n -= hist[v++]; return v; };
  let sub = 0, div = 255;
  if (model.def.quantile) { sub = rank(0.05); div = Math.max(1, rank(0.95) - sub); } else { let m = 255; while (m > 1 && !hist[m]) m--; div = m; }
  let max = 255; while (max > 1 && !hist[max]) max--;
  // crop: to the box the fast mask model finds the brain in, or to what is not empty air
  const lo = [S, S, S], hi = [-1, -1, -1];
  let pre = null;
  if (model.def.pre) pre = (await runModel(vol, model.def.pre, (p, text) => onProgress(0.03 + 0.12 * p, text), opts)).labels;
  const cut = sub + model.def.thr * (max - sub);
  for (let d = 0, o = 0; d < S; d++) for (let h = 0; h < S; h++) for (let w = 0; w < S; w++, o++) {
    if (pre ? !pre[o] : img[o] <= cut) continue;
    if (d < lo[0]) lo[0] = d; if (d > hi[0]) hi[0] = d; if (h < lo[1]) lo[1] = h; if (h > hi[1]) hi[1] = h; if (w < lo[2]) lo[2] = w; if (w > hi[2]) hi[2] = w;
  }
  if (hi[0] < 0) throw new Error('The scan looks empty to the brain model.');
  const box = [lo.slice(), hi.slice()], pad = model.def.pad;
  for (let a = 0; a < 3; a++) { lo[a] = Math.max(0, lo[a] - pad); hi[a] = Math.min(S - 1, hi[a] + pad); }
  const D = hi[0] - lo[0] + 1, H = hi[1] - lo[1] + 1, W = hi[2] - lo[2] + 1, V = D * H * W;
  const input = new Float32Array(V);
  for (let d = 0, o = 0; d < D; d++) for (let h = 0; h < H; h++) { let i = ((d + lo[0]) * S + h + lo[1]) * S + lo[2]; for (let w = 0; w < W; w++, o++, i++) input[o] = (img[i] - sub) / div; }
  // the padding round the crop is empty, as it was when the model was trained
  if (pad) for (let d = 0, o = 0; d < D; d++) for (let h = 0; h < H; h++) for (let w = 0; w < W; w++, o++) {
    const dd = d + lo[0], hh = h + lo[1], ww = w + lo[2];
    if (dd < box[0][0] || dd > box[1][0] || hh < box[0][1] || hh > box[1][1] || ww < box[0][2] || ww > box[1][2]) input[o] = 0;
  }

  const C = Math.max(2, ...model.layers.slice(0, -1).map((l) => l.cout));
  const { device, conv, head } = await getDevice(V * C * 4);
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const bufs = [device.createBuffer({ size: V * C * 4, usage }), device.createBuffer({ size: V * C * 4, usage })];
  const uni = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const garbage = [...bufs, uni];
  try {
    for (let o = 0; o < V; o += 1 << 22) device.queue.writeBuffer(bufs[0], o * 4, input, o, Math.min(1 << 22, V - o));
    const SLAB = 16, slabs = Math.ceil(D / SLAB), total = model.layers.length * slabs;
    let done = 0, from = 0;
    for (let li = 0; li < model.layers.length; li++) {
      const L = model.layers[li], last = li === model.layers.length - 1;
      const wbuf = device.createBuffer({ size: L.w.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      garbage.push(wbuf);
      device.queue.writeBuffer(wbuf, 0, L.w);
      const pipe = last ? head : conv;
      if (last && L.size !== 1) throw new Error('Unexpected model layout');
      const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: bufs[from] } }, { binding: 1, resource: { buffer: bufs[1 - from] } },
        { binding: 2, resource: { buffer: wbuf } }, { binding: 3, resource: { buffer: uni } }] });
      for (let s = 0; s < slabs; s++) {
        const u = new ArrayBuffer(32), u32 = new Uint32Array(u), i32 = new Int32Array(u);
        u32[0] = D; u32[1] = H; u32[2] = W; u32[3] = L.cin; u32[4] = L.cout; i32[5] = L.dil; u32[6] = s * SLAB; u32[7] = last ? (model.def.notBrain || 1) : model.act === 'relu' ? 1 : 2;
        device.queue.writeBuffer(uni, 0, u);
        const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(W / 4), Math.ceil(H / 4), SLAB / 4);
        pass.end();
        device.queue.submit([enc.finish()]);
        done++;
        // let the card finish now and then: keeps the rest of the computer responsive and shows progress
        if (s % 2 === 1 || s === slabs - 1) { await device.queue.onSubmittedWorkDone(); onProgress(0.08 + 0.87 * done / total, `Running the brain model on the graphics card… layer ${li + 1} of ${model.layers.length}`); }
      }
      from = 1 - from;
    }
    // read the answer back
    const read = device.createBuffer({ size: V * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    garbage.push(read);
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(bufs[from], 0, read, 0, V * 8);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const res = new Float32Array(read.getMappedRange());
    const labels = new Uint8Array(S * S * S), prob = new Uint8Array(S * S * S);
    for (let d = 0, o = 0; d < D; d++) for (let h = 0; h < H; h++) { let i = ((d + lo[0]) * S + h + lo[1]) * S + lo[2]; for (let w = 0; w < W; w++, o++, i++) { labels[i] = res[o * 2]; prob[i] = Math.round(res[o * 2 + 1] * 255); } }
    read.unmap();
    onProgress(1, 'Brain model done');
    return { labels, prob, c0: cube.c0, axes: cube.axes, classes: model.classes, ms: performance.now() - t0, box: [D, H, W] };
  } finally {
    for (const b of garbage) b.destroy();
  }
}
