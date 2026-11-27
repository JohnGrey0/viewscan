// fixes.js — marks made by hand on the slices: "this is brain" / "this is not brain".
// A set of marks has the scan's own grid, one value per scan voxel (0 no mark,
// 1 brain, 2 not brain), so a mark on a thick slice covers that whole slice. The
// model builder lets the marks win over whatever found the brain (applyFix in
// segworker.js). Marks are saved by the server next to its header index, never in
// a scan folder; where there is no server they are kept in this browser.

export const BRAIN = 1, NOT_BRAIN = 2;
/** Set `server` to false where the page has no Viewscan server behind it (marks then stay in the browser). */
export const fixStore = { server: true };

export function newFix(vol) {
  return { data: new Uint8Array(vol.nx * vol.ny * vol.nz), dims: [vol.nx, vol.ny, vol.nz], version: 1, undo: [], stroke: null, count: 0, saved: true, built: 0 };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The scan's index axis a slice view looks along (ni) and the two it shows. */
function axesOf(vol, g) {
  const ni = [0, 1, 2].reduce((b, i) => (Math.abs(dot(vol.basis[i], g.n)) > Math.abs(dot(vol.basis[b], g.n)) ? i : b), 0);
  return { ni, ia: (ni + 1) % 3, ib: (ni + 2) % 3 };
}
function put(fix, i, val) {
  const old = fix.data[i];
  if (old === val) return;
  if (!fix.stroke.has(i)) fix.stroke.set(i, old);
  fix.data[i] = val;
  fix.count += (val ? 1 : 0) - (old ? 1 : 0);
}

export function beginStroke(fix) { fix.stroke = new Map(); }
export function endStroke(fix) {
  if (fix.stroke && fix.stroke.size) { fix.undo.push(fix.stroke); if (fix.undo.length > 60) fix.undo.shift(); fix.saved = false; }
  fix.stroke = null; fix.version++;
}
export function undo(fix) {
  const s = fix.undo.pop();
  if (!s) return false;
  for (const [i, old] of s) { fix.count += (old ? 1 : 0) - (fix.data[i] ? 1 : 0); fix.data[i] = old; }
  fix.version++; fix.saved = false;
  return true;
}
/** Take every mark away (one step that Undo brings back). */
export function clearAll(fix) {
  beginStroke(fix);
  for (let i = 0; i < fix.data.length; i++) if (fix.data[i]) put(fix, i, 0);
  endStroke(fix);
}

/**
 * A round brush dragged from world point w0 to w1 on the slice a view shows.
 * @param g the view's plane ({ n }); radius in millimeters; val 0 rubs marks out
 */
export function brush(vol, fix, g, w0, w1, radius, val) {
  const { ni, ia, ib } = axesOf(vol, g), dims = fix.dims, sp = vol.spacing, stride = [1, dims[0], dims[0] * dims[1]];
  const p0 = vol.toIndex(w0), p1 = vol.toIndex(w1), k = Math.round(p1[ni]);
  if (k < 0 || k >= dims[ni]) return;
  const len = Math.hypot((p1[ia] - p0[ia]) * sp[ia], (p1[ib] - p0[ib]) * sp[ib]);
  const steps = Math.max(1, Math.ceil(len / Math.max(radius * 0.5, Math.min(sp[ia], sp[ib]) * 0.5)));
  const ra = radius / sp[ia], rb = radius / sp[ib], r2 = radius * radius;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, ca = p0[ia] + (p1[ia] - p0[ia]) * t, cb = p0[ib] + (p1[ib] - p0[ib]) * t;
    const na = Math.round(ca), nb = Math.round(cb); // the voxel under the pointer is always marked
    if (na >= 0 && nb >= 0 && na < dims[ia] && nb < dims[ib]) put(fix, k * stride[ni] + na * stride[ia] + nb * stride[ib], val);
    for (let a = Math.max(0, Math.ceil(ca - ra)); a <= Math.min(dims[ia] - 1, Math.floor(ca + ra)); a++) {
      for (let b = Math.max(0, Math.ceil(cb - rb)); b <= Math.min(dims[ib] - 1, Math.floor(cb + rb)); b++) {
        if (((a - ca) * sp[ia]) ** 2 + ((b - cb) * sp[ib]) ** 2 <= r2) put(fix, k * stride[ni] + a * stride[ia] + b * stride[ib], val);
      }
    }
  }
}

/** Everything inside a line drawn around an area (world points on one slice of a view). */
export function lasso(vol, fix, g, points, val) {
  const { ni, ia, ib } = axesOf(vol, g), dims = fix.dims, stride = [1, dims[0], dims[0] * dims[1]];
  const idx = points.map((w) => vol.toIndex(w)), k = Math.round(idx[0][ni]);
  if (k < 0 || k >= dims[ni]) return;
  const A = idx.map((p) => p[ia]), B = idx.map((p) => p[ib]), n = A.length;
  const b0 = Math.max(0, Math.ceil(Math.min(...B))), b1 = Math.min(dims[ib] - 1, Math.floor(Math.max(...B)));
  for (let b = b0; b <= b1; b++) {
    // where the outline crosses this row; filled between pairs of crossings
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) if ((B[i] > b) !== (B[j] > b)) xs.push(A[i] + (b - B[i]) / (B[j] - B[i]) * (A[j] - A[i]));
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let a = Math.max(0, Math.ceil(xs[i])); a <= Math.min(dims[ia] - 1, Math.floor(xs[i + 1])); a++) put(fix, k * stride[ni] + a * stride[ia] + b * stride[ib], val);
    }
  }
}

/** On how many of the scan's own slices there are marks. */
export function slicesMarked(fix) {
  const size = fix.dims[0] * fix.dims[1], d = fix.data;
  let n = 0;
  for (let z = 0; z < fix.dims[2]; z++) { for (let i = z * size, e = i + size; i < e; i++) if (d[i]) { n++; break; } }
  return n;
}

// ---- saving ----
const fileId = (stack) => String(stack.id).replace(/[^\w.-]/g, '_').slice(-150);
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
function toBase64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromBase64(s) { const b = atob(s), u8 = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i); return u8; }

/**
 * Save the marks of a series: on the server when there is one, else in this browser.
 * The file holds the scan's grid (so the marks can be matched to the series again) and no names.
 * @returns {Promise<'server'|'browser'>}
 */
export async function saveFix(stack, vol, fix) {
  const version = fix.version;
  const body = JSON.stringify({
    v: 1, dims: fix.dims, origin: [...vol.origin], dx: [...vol.dx], dy: [...vol.dy], dz: [...vol.dz], marks: fix.count,
    values: { 0: 'no mark', 1: 'brain', 2: 'not brain' }, saved: new Date().toISOString(),
    gz: toBase64(await pipe(fix.data, new CompressionStream('gzip'))),
  });
  let where = 'browser';
  if (fixStore.server) try {
    const r = await fetch('api/fix/' + fileId(stack), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (r.ok) where = 'server';
  } catch { /* no server here */ }
  if (where === 'browser') localStorage.setItem('viewscan.fix.' + fileId(stack), body);
  if (fix.version === version) fix.saved = true;
  return where;
}

/** The saved marks of a series, or null. */
export async function loadFix(stack, vol) {
  let saved = null;
  if (fixStore.server) try {
    const r = await fetch('api/fix/' + fileId(stack), { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) saved = await r.json();
  } catch { /* no server here */ }
  if (!saved) { try { saved = JSON.parse(localStorage.getItem('viewscan.fix.' + fileId(stack)) || 'null'); } catch { saved = null; } }
  if (!saved || !saved.gz || !Array.isArray(saved.dims)) return null;
  if (saved.dims[0] !== vol.nx || saved.dims[1] !== vol.ny || saved.dims[2] !== vol.nz) return null; // marks of another grid
  if (Array.isArray(saved.origin) && saved.origin.some((v, i) => Math.abs(v - vol.origin[i]) > 0.01)) return null; // made with wrap-around handled the other way
  const data = await pipe(fromBase64(saved.gz), new DecompressionStream('gzip'));
  if (data.length !== vol.nx * vol.ny * vol.nz) return null;
  const fix = newFix(vol);
  fix.data = data;
  for (let i = 0; i < data.length; i++) if (data[i]) fix.count++;
  return fix;
}
