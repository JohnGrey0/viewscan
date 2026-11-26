// Research harness: runs the MRI brain finder on one series in node (one core,
// a few seconds) and saves a montage of slices with the brain tinted pink and
// the outline drawn in green, so a change can be judged on many series quickly.
//   node test/mrlab.mjs <folder> <series-number|-1> <tag> [mr-json] [voxel]
// The picture goes to test/shots/<tag>.png (set NOPIC=1 for numbers only). The
// decoded scan is cached in the system temp folder, never in the project.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
const JS = new URL('../public/js/', import.meta.url).href;
const { readDicom } = await import(JS + 'dicom.js');
const { summarize, organize } = await import(JS + 'series.js');
const { decodeFrame } = await import(JS + 'pixels.js');
const { Volume } = await import(JS + 'volume.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [root, wantS, tag, mrJson = '{}', voxelS = '1.4'] = process.argv.slice(2);
const want = Number(wantS), voxel = Number(voxelS);
const cacheDir = path.join(os.tmpdir(), 'viewscan-mrlab'); fs.mkdirSync(cacheDir, { recursive: true });
const key = path.basename(root).replace(/[^\w]/g, '_') + '_' + want;
const metaF = path.join(cacheDir, key + '.json'), binF = path.join(cacheDir, key + '.bin');

let meta, data;
if (fs.existsSync(metaF)) {
  meta = JSON.parse(fs.readFileSync(metaF, 'utf8'));
  const b = fs.readFileSync(binF);
  data = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
} else {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(root);
  const sums = [];
  for (const f of files) { try { const b = fs.readFileSync(f); const ds = await readDicom(new Uint8Array(b.buffer, b.byteOffset, b.length), { stopAtPixel: true }); const s = summarize(ds); if (s) sums.push({ file: f, ...s }); } catch {} }
  let found = null;
  for (const st of organize(sums)) for (const se of st.series) if (se.modality === 'MR' && (want < 0 || se.number === want)) { const s = se.stacks.find((x) => x.volume); if (s && !found) found = { se, s }; }
  if (!found) { console.log('no such series'); process.exit(1); }
  const { se, s } = found;
  const stack = { desc: s, frames: [], cols: s.cols, rows: s.rows, n: s.n, uid: 1 };
  const size = s.cols * s.rows;
  stack.buffer = new Float32Array(size * s.n);
  const open = new Map();
  for (let i = 0; i < s.n; i++) {
    const fr = s.frames[i];
    if (!open.has(fr.file)) { open.clear(); const b = fs.readFileSync(fr.file); open.set(fr.file, await readDicom(new Uint8Array(b.buffer, b.byteOffset, b.length))); }
    const f = await decodeFrame(open.get(fr.file), fr.frame);
    stack.buffer.set(f.data, i * size);
    stack.frames.push({ ipp: f.ipp, iop: f.iop, ps: f.ps });
  }
  const v = new Volume(stack);
  data = v.data instanceof Float32Array ? v.data : Float32Array.from(v.data);
  meta = { nx: v.nx, ny: v.ny, nz: v.nz, origin: v.origin, dx: v.dx, dy: v.dy, dz: v.dz, basis: v.basis, info: { tr: se.info.tr, te: se.info.te, ti: se.info.ti }, desc: se.desc, number: se.number };
  fs.writeFileSync(metaF, JSON.stringify(meta));
  fs.writeFileSync(binF, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

// ---- run the worker code in this process ----
let result = null; const msgs = [];
globalThis.self = { postMessage: (m) => { if (m.type === 'segmented') result = m; else if (m.type === 'error') { console.log(m.error); process.exit(1); } else if (m.type === 'debug') msgs.push(m); } };
const workerFile = process.env.SEGW || fileURLToPath(new URL('../public/js/segworker.js', import.meta.url));
await import(pathToFileURL(workerFile).href + '?t=' + Date.now());
const t0 = Date.now();
const mr = JSON.parse(mrJson);
self.onmessage({ data: { type: process.env.LAB_TYPE || 'segment', vol: { ...meta, data }, opts: { targets: ['brain'], voxel, modality: 'MR', mr, mrInfo: meta.info, finish: {}, lab: true } } });
const secs = (Date.now() - t0) / 1000;
const { X, Y, Z, VOX } = result.dims;
const part = result.parts[0];
const mask = part.mask, field = part.surface ? part.surface.field : result.field;
const ml = mask ? mask.reduce((n, v) => n + v, 0) * VOX ** 3 / 1000 : 0;
console.log(`#${meta.number} ${meta.desc} [${tag}] ${X}x${Y}x${Z} ${secs.toFixed(1)}s brain ${Math.round(ml)} mL`, JSON.stringify(result.used), part.note || '');
for (const m of msgs) console.log('   ', JSON.stringify(m.d));
if (process.env.NOPIC) process.exit(0);

// ---- montage ----
const N = X * Y * Z;
const samp = []; for (let i = 0; i < N; i += 37) if (field[i] > 0) samp.push(field[i]); samp.sort((a, b) => a - b);
const hiV = samp[Math.floor(samp.length * 0.985)] || 1;
const extra = result.extra || null; // optional second mask (shown in green outline)
const dims = [X, Y, Z], str = [1, X, X * Y];
const ext = [[X, 0], [Y, 0], [Z, 0]];
for (let i = 0; i < N; i++) if (mask[i]) { const p = [i % X, ((i / X) | 0) % Y, (i / (X * Y)) | 0]; for (let a = 0; a < 3; a++) { if (p[a] < ext[a][0]) ext[a][0] = p[a]; if (p[a] > ext[a][1]) ext[a][1] = p[a]; } }
const tiles = [];
const tile = (axis, k) => {
  const ua = axis === 0 ? 1 : 0, va = axis === 2 ? 1 : 2;
  const U = dims[ua], V = dims[va], px = new Uint8Array(U * V * 3);
  const at = (u, v) => k * str[axis] + u * str[ua] + v * str[va];
  for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) {
    const i = at(u, v); let g = Math.max(0, Math.min(255, field[i] / hiV * 255));
    let r = g, gg = g, b = g;
    if (mask[i]) {
      const edge = u === 0 || v === 0 || u === U - 1 || v === V - 1 || !mask[at(u - 1, v)] || !mask[at(u + 1, v)] || !mask[at(u, v - 1)] || !mask[at(u, v + 1)];
      if (edge) { r = 255; gg = 40; b = 160; } else { r = g * 0.75 + 64; gg = g * 0.75; b = g * 0.75 + 30; }
    }
    if (extra && extra[i]) { const e2 = !extra[at(Math.max(0, u - 1), v)] || !extra[at(Math.min(U - 1, u + 1), v)] || !extra[at(u, Math.max(0, v - 1))] || !extra[at(u, Math.min(V - 1, v + 1))]; if (e2) { r = 40; gg = 255; b = 80; } }
    const o = ((axis === 2 ? v : V - 1 - v) * U + u) * 3; px[o] = r; px[o + 1] = gg; px[o + 2] = b;
  }
  tiles.push({ U, V, px });
};
const span = (axis, n, padv) => { const lo = Math.max(1, ext[axis][0] - padv), hi = Math.min(dims[axis] - 2, ext[axis][1] + padv); return Array.from({ length: n }, (_, i) => Math.round(lo + (hi - lo) * (i + 0.5) / n)); };
const zUp = result.grid.zAxis;
for (const k of span(2, 12, 4)) tile(2, k);
for (const k of span(0, 6, 2)) tile(0, k);
for (const k of span(1, 6, 2)) tile(1, k);
const cols = 6, cw = Math.max(...tiles.map((t) => t.U)), ch = Math.max(...tiles.map((t) => t.V));
const rowsN = Math.ceil(tiles.length / cols), Wd = cols * cw, Ht = rowsN * ch;
const img = Buffer.alloc((Wd * 3 + 1) * Ht);
tiles.forEach((t, n) => { const ox = (n % cols) * cw, oy = Math.floor(n / cols) * ch; for (let v = 0; v < t.V; v++) for (let u = 0; u < t.U; u++) { const o = (oy + v) * (Wd * 3 + 1) + 1 + (ox + u) * 3, s = (v * t.U + u) * 3; img[o] = t.px[s]; img[o + 1] = t.px[s + 1]; img[o + 2] = t.px[s + 2]; } });
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(Wd, 0); ihdr.writeUInt32BE(Ht, 4); ihdr[8] = 8; ihdr[9] = 2;
const outDir = path.join(HERE, 'shots'); fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${tag}.png`), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(img)), chunk('IEND', Buffer.alloc(0))]));
