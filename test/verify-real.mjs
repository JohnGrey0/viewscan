// Checks the lossless-JPEG decoder against real data: the hospital originals
// (JPEG Lossless) must decode to exactly the same Hounsfield values as the
// uncompressed copies of the same slices exported by 3D Slicer.
//   node test/verify-real.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDicom, str, num, nums } from '../public/js/dicom.js';
import { decodeFrame } from '../public/js/pixels.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CT Brain Scan');
const origDir = path.join(root, 'data', '2079216', 'DF9D9DF88C2742BB9F9B2C15D2086E2A');
const load = async (p) => readDicom(new Uint8Array(fs.readFileSync(p)));
const key = (ds) => `${str(ds, '0008103e')}|${(nums(ds, '00200032') || []).map((v) => v.toFixed(1)).join(',')}`;

// index a sample of the uncompressed export
const ref = new Map();
for (const d of fs.readdirSync(path.join(root, 'DICOM'))) {
  const files = fs.readdirSync(path.join(root, 'DICOM', d)).filter((f) => f.endsWith('.dcm'));
  for (const f of [files[0], files[files.length >> 1], files[files.length - 1]]) {
    const p = path.join(root, 'DICOM', d, f);
    ref.set(key(await load(p)), p);
  }
}
let checked = 0, bad = 0, ms = 0;
for (const f of fs.readdirSync(origDir).filter((x) => x.endsWith('.dcm'))) {
  const head = Buffer.alloc(16384);
  const fd = fs.openSync(path.join(origDir, f), 'r'); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
  const hds = await readDicom(new Uint8Array(head), { stopAtPixel: true, partial: true });
  const refPath = ref.get(key(hds));
  if (!refPath) continue;
  const ds = await load(path.join(origDir, f));
  const t = performance.now();
  const a = await decodeFrame(ds, 0);
  ms += performance.now() - t;
  const b = await decodeFrame(await load(refPath), 0);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
  checked++;
  if (diff || a.data.length !== b.data.length) bad++;
  console.log(`${diff ? 'FAIL' : 'ok  '} S${num(ds, '00200011')} ${str(ds, '0008103e').padEnd(18)} ${a.cols}x${a.rows} ${a.data.constructor.name} range ${a.min}..${a.max} ${a.unit} wc/ww ${a.wc}/${a.ww} differing=${diff}`);
}
console.log(`\n${checked} slices compared, ${bad} mismatched, avg decode ${(ms / checked).toFixed(1)} ms`);
process.exit(bad || !checked ? 1 : 0);
