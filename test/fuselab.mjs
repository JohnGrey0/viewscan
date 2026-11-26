// Research harness for combining scans (public/js/fuse.js), in node.
//   node test/fuselab.mjs <folder> <series,series,...> <tag> [options-json]
// The first series is the base. Saves test/shots/<tag>.png: three rows (the base
// scan alone, the plain average of the scans, the combined result), each shown
// in the three planes of the base scan, so the gain in sharpness can be judged.
// The decoded scans are cached in the system temp folder, never in the project.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
const JS = new URL('../public/js/', import.meta.url).href;
const { readDicom } = await import(JS + 'dicom.js');
const { summarize, organize } = await import(JS + 'series.js');
const { decodeFrame } = await import(JS + 'pixels.js');
const { Volume } = await import(JS + 'volume.js');
const { fuseVolumes } = await import(JS + 'fuse.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [root, list, tag, optJson = '{}'] = process.argv.slice(2);
const cacheDir = path.join(os.tmpdir(), 'viewscan-mrlab'); fs.mkdirSync(cacheDir, { recursive: true });

let library = null;
async function load(want) {
  const key = path.basename(root).replace(/[^\w]/g, '_') + '_f' + want;
  const metaF = path.join(cacheDir, key + '.json'), binF = path.join(cacheDir, key + '.bin');
  if (fs.existsSync(metaF)) {
    const meta = JSON.parse(fs.readFileSync(metaF, 'utf8')), b = fs.readFileSync(binF);
    return { ...meta, data: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  }
  if (!library) {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(root);
    const sums = [];
    for (const f of files) { try { const b = fs.readFileSync(f); const ds = await readDicom(new Uint8Array(b.buffer, b.byteOffset, b.length), { stopAtPixel: true }); const s = summarize(ds); if (s) sums.push({ file: f, ...s }); } catch { /* not DICOM */ } }
    library = organize(sums);
  }
  let found = null;
  for (const st of library) for (const se of st.series) if (se.number === want) { const s = se.stacks.find((x) => x.volume); if (s && !found) found = { se, s }; }
  if (!found) throw new Error('no series ' + want);
  const { se, s } = found, size = s.cols * s.rows;
  const stack = { desc: s, frames: [], cols: s.cols, rows: s.rows, n: s.n, uid: 1, buffer: new Float32Array(size * s.n) };
  for (let i = 0; i < s.n; i++) {
    const fr = s.frames[i], b = fs.readFileSync(fr.file);
    const f = await decodeFrame(await readDicom(new Uint8Array(b.buffer, b.byteOffset, b.length)), fr.frame);
    stack.buffer.set(f.data, i * size);
    stack.frames.push({ ipp: f.ipp, iop: f.iop, ps: f.ps });
  }
  const v = new Volume(stack);
  const meta = { nx: v.nx, ny: v.ny, nz: v.nz, origin: v.origin, dx: v.dx, dy: v.dy, dz: v.dz, basis: v.basis, thick: s.thick || 0, desc: se.desc, number: se.number };
  fs.writeFileSync(metaF, JSON.stringify(meta));
  fs.writeFileSync(binF, Buffer.from(v.data instanceof Float32Array ? v.data.buffer : Float32Array.from(v.data).buffer));
  return { ...meta, data: v.data instanceof Float32Array ? v.data : Float32Array.from(v.data) };
}

const vols = [];
for (const n of list.split(',').map(Number)) vols.push(await load(n));
console.log(vols.map((v) => `#${v.number} ${v.desc} ${v.nx}x${v.ny}x${v.nz} thick ${v.thick}`).join(' | '));
const opts = JSON.parse(optJson);
let t0 = Date.now();
const fused = fuseVolumes(vols, { ...opts, keepStart: true });
console.log(`combined in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${fused.nx}x${fused.ny}x${fused.nz} at ${fused.spacing.toFixed(2)} mm`);
for (const [k, m] of fused.moves.entries()) if (k) console.log(`  #${vols[k].number}: shift ${m.t.map((v) => v.toFixed(1))} mm, turn ${m.r.map((v) => v.toFixed(1))} deg, match ${m.before.toFixed(4)} -> ${m.after.toFixed(4)}${m.moved ? '' : ' (left as scanned)'}, gain ${m.gain.toFixed(2)}`);
if (process.env.NOPIC) process.exit(0);
const alone = fuseVolumes([vols[0]], { voxel: fused.spacing });

const { nx: X, ny: Y, nz: Z } = fused, dims = [X, Y, Z], str = [1, X, X * Y];
const samp = []; for (let i = 0; i < fused.data.length; i += 41) if (fused.data[i] > 0) samp.push(fused.data[i]); samp.sort((a, b) => a - b);
const hiV = samp[Math.floor(samp.length * 0.985)] || 1;
const tiles = [];
const tile = (data, axis, frac) => {
  const k = Math.round(dims[axis] * frac), ua = axis === 0 ? 1 : 0, va = axis === 2 ? 1 : 2, U = dims[ua], V = dims[va], px = new Uint8Array(U * V);
  for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) px[(axis === 2 ? v : V - 1 - v) * U + u] = Math.max(0, Math.min(255, data[k * str[axis] + u * str[ua] + v * str[va]] / hiV * 255));
  tiles.push({ U, V, px });
};
for (const data of [alone.data, fused.start, fused.data]) for (const [axis, frac] of [[2, 0.5], [1, 0.5], [0, 0.42], [1, 0.36]]) tile(data, axis, frac);
const cols = 4, cw = Math.max(...tiles.map((t) => t.U)), ch = Math.max(...tiles.map((t) => t.V)), Wd = cols * cw, Ht = Math.ceil(tiles.length / cols) * ch;
const img = Buffer.alloc((Wd + 1) * Ht);
tiles.forEach((t, n) => { const ox = (n % cols) * cw, oy = Math.floor(n / cols) * ch; for (let v = 0; v < t.V; v++) for (let u = 0; u < t.U; u++) img[(oy + v) * (Wd + 1) + 1 + ox + u] = t.px[v * t.U + u]; });
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(Wd, 0); ihdr.writeUInt32BE(Ht, 4); ihdr[8] = 8; ihdr[9] = 0;
const outDir = process.env.VIEWSCAN_SHOTS || path.join(HERE, 'shots'); fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${tag}.png`), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(img)), chunk('IEND', Buffer.alloc(0))]));
console.log('saved', path.join(outDir, `${tag}.png`));

// How much fine detail each version holds in each direction of the base scan
// (average change from one voxel to the next, inside the head): higher is sharper.
{
  const { nx: X, ny: Y, nz: Z } = fused, str = [1, X, X * Y];
  const detail = (d) => [0, 1, 2].map((a) => { let s = 0, n = 0; for (let z = 20; z < Z - 20; z += 2) for (let y = 20; y < Y - 20; y += 2) for (let x = 20; x < X - 20; x += 2) { const i = z * X * Y + y * X + x; if (alone.data[i] > hiV * 0.25) { s += Math.abs(d[i + str[a]] - d[i]); n++; } } return (s / n / hiV * 100).toFixed(2); });
  console.log('detail across / down / through the base pictures:  base alone', detail(alone.data).join(' '), '| plain average', detail(fused.start).join(' '), '| combined', detail(fused.data).join(' '));
}
