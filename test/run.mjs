// Decoder tests against public DICOM sample files (pydicom's test data).
//   node test/run.mjs [folder]
// The folder defaults to test/fixtures, or the VIEWSCAN_FIXTURES environment variable.
// Files that are not present are skipped, so the test runs with whatever samples you have.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDicom, num } from '../public/js/dicom.js';
import { summarize, organize } from '../public/js/series.js';
import { decodeFrame, UnsupportedError } from '../public/js/pixels.js';

const dir = process.argv[2] || process.env.VIEWSCAN_FIXTURES || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let failed = 0, passed = 0, skipped = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (cond) passed++; else failed++; };
const skip = (msg) => { console.log(`skip ${msg}`); skipped++; };
const has = (name) => fs.existsSync(path.join(dir, name));

async function frames(name) {
  const ds = await readDicom(new Uint8Array(fs.readFileSync(path.join(dir, name))));
  const n = Math.max(1, num(ds, '00280008', 1));
  const out = [];
  for (let f = 0; f < n; f++) out.push(await decodeFrame(ds, f));
  return { ds, out, sum: summarize(ds) };
}
const same = (a, b) => a.length === b.length && a.every((fa, i) => fa.data.length === b[i].data.length && fa.data.every((v, k) => v === b[i].data[k]));

// one image stored several different ways must decode to identical values
const groups = [
  ['MR_small.dcm', ['MR_small_implicit.dcm', 'MR_small_bigendian.dcm', 'MR_small_expb.dcm', 'MR_small_RLE.dcm', 'MR_small_jp2klossless.dcm', 'MR_small_jpeg_ls_lossless.dcm']],
  ['emri_small.dcm', ['emri_small_RLE.dcm', 'emri_small_jpeg_2k_lossless.dcm', 'emri_small_jpeg_ls_lossless.dcm']],
  ['SC_rgb.dcm', ['SC_rgb_rle.dcm']],
];
for (const [ref, others] of groups) {
  if (!has(ref)) { skip(`${ref} (not in ${dir})`); continue; }
  const r = await frames(ref);
  const f0 = r.out[0];
  ok(r.out.length > 0 && f0.data.length === f0.rows * f0.cols * (f0.color ? 4 : 1), `${ref}: ${r.out.length} frame(s) ${f0.cols}x${f0.rows} ${f0.data.constructor.name}${f0.color ? ' color' : ` range ${f0.min}..${f0.max}`}`);
  for (const o of others) {
    if (!has(o)) { skip(o); continue; }
    try { ok(same(r.out, (await frames(o)).out), `${o} matches ${ref}`); }
    catch (err) { if (err instanceof UnsupportedError) skip(`${o}: ${err.message}`); else ok(false, `${o}: ${err.message}`); }
  }
}
for (const name of ['CT_small.dcm', 'JPEG-LL.dcm', 'image_dfl.dcm', 'rtdose.dcm', 'MR-SIEMENS-DICOM-WithOverlays.dcm']) {
  if (!has(name)) { skip(name); continue; }
  try {
    const r = await frames(name);
    const f0 = r.out[0];
    ok(Number.isFinite(f0.min) && f0.max > f0.min, `${name}: ${r.out.length} frame(s) ${f0.cols}x${f0.rows} ${f0.data.constructor.name} range ${f0.min}..${f0.max} ${f0.unit}`);
  } catch (err) { ok(false, `${name}: ${err.message}`); }
}
// multi-frame MR file
if (has('emri_small.dcm')) {
  const r = await frames('emri_small.dcm');
  const st = organize([{ file: 0, info: r.sum.info, frames: r.sum.frames }])[0].series[0].stacks;
  // this sample carries no per-frame positions, so it must come out as one plain 10-frame stack
  ok(r.sum.frames.length === 10 && st.length === 1 && st[0].n === 10 && !st[0].volume, `emri_small: multi-frame file becomes one ${st[0].n}-frame stack (${st[0].layout})`);
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed || !passed ? 1 : 0);
