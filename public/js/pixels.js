// pixels.js — turns the pixel data of one frame into display-ready values.
//
// Grayscale frames come back in "modality units" (rescale slope/intercept
// applied: Hounsfield units for CT, scanner units for MR) as an Int16Array when
// the values fit, otherwise a Float32Array. Color frames come back as RGBA.

import { TS, num, str } from './dicom.js';
import { frameInfo } from './series.js';
import { decodeJpegLossless } from './codecs/jpegll.js';
import { decodeRle } from './codecs/rle.js';

// Extension point for codecs this file does not implement (JPEG 2000, JPEG-LS):
// registerCodec([transferSyntaxUID], async (bytes, info) => ({ data, signed })).
const external = new Map();
export function registerCodec(transferSyntaxes, fn) {
  for (const ts of transferSyntaxes) external.set(ts, fn);
}

const TS_NAMES = {
  [TS.JPEG_EXTENDED]: 'JPEG Extended (12-bit lossy)',
  [TS.JPEG_LS]: 'JPEG-LS', [TS.JPEG_LS_NEAR]: 'JPEG-LS',
  [TS.JPEG_2000_LOSSLESS]: 'JPEG 2000', [TS.JPEG_2000]: 'JPEG 2000',
  '1.2.840.10008.1.2.4.201': 'HTJ2K', '1.2.840.10008.1.2.4.202': 'HTJ2K', '1.2.840.10008.1.2.4.203': 'HTJ2K',
  '1.2.840.10008.1.2.4.100': 'MPEG-2 video', '1.2.840.10008.1.2.4.102': 'MPEG-4 video',
};

export class UnsupportedError extends Error {}

function frameFragments(ds, f, nFrames) {
  const frags = ds._pixel.fragments;
  if (!frags || !frags.length) throw new Error('No pixel data fragments');
  const bytes = ds._bytes;
  let list;
  if (nFrames === 1) list = frags;
  else if (frags.length === nFrames) list = [frags[f]];
  else if (frags.offsetTable && frags.offsetTable.length === nFrames) {
    const base = frags[0].itemStart;
    const lo = frags.offsetTable[f];
    const hi = f + 1 < nFrames ? frags.offsetTable[f + 1] : Infinity;
    list = frags.filter((fr) => fr.itemStart - base >= lo && fr.itemStart - base < hi);
  } else throw new UnsupportedError('Multi-frame compressed data without an offset table');
  if (list.length === 1) return bytes.subarray(list[0].offset, list[0].offset + list[0].length);
  const total = list.reduce((n, fr) => n + fr.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const fr of list) { out.set(bytes.subarray(fr.offset, fr.offset + fr.length), o); o += fr.length; }
  return out;
}

// 8-bit lossy JPEG: let the browser decode it.
async function decodeBrowserJpeg(bytes, rows, cols) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new UnsupportedError('Baseline JPEG needs a browser to decode');
  }
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
  const cv = new OffscreenCanvas(cols, rows);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, cols, rows);
  bmp.close?.();
  return ctx.getImageData(0, 0, cols, rows).data;
}

function jpegPrecision(b) {
  for (let p = 2; p + 9 < b.length;) {
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[p + 4];
    if (m === 0xd8 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { p += m === 0xff ? 1 : 2; continue; }
    p += 2 + ((b[p + 2] << 8) | b[p + 3]);
  }
  return 0;
}

/**
 * Decode frame `f` of a parsed DICOM file.
 * @returns {Promise<object>} { rows, cols, color, data, min, max, wc, ww, invert, unit, ipp, iop, ps, thick }
 */
export async function decodeFrame(ds, f = 0, opts = {}) {
  const px = ds._pixel;
  if (!px) throw new Error('File has no pixel data');
  const rows = num(ds, '00280010'), cols = num(ds, '00280011');
  const spp = num(ds, '00280002', 1);
  const bitsAlloc = num(ds, '00280100', 16);
  const bitsStored = Math.min(num(ds, '00280101', bitsAlloc), bitsAlloc);
  const signed = num(ds, '00280103', 0) === 1;
  const photo = str(ds, '00280004', 'MONOCHROME2');
  const planar = num(ds, '00280006', 0) === 1;
  const nFrames = Math.max(1, num(ds, '00280008', 1));
  const ts = ds._ts;
  const npx = rows * cols;
  const fi = frameInfo(ds, f);
  const base = { rows, cols, ipp: fi.ipp, iop: fi.iop, ps: fi.ps, thick: fi.thick };

  if (bitsAlloc !== 8 && bitsAlloc !== 16 && bitsAlloc !== 32) throw new UnsupportedError(`${bitsAlloc}-bit pixels are not supported`);
  const bps = bitsAlloc / 8;

  let raw;         // interleaved samples
  let rgba = null; // set directly by the browser JPEG path
  let rawSigned = false; // true when a codec already produced signed values
  if (!px.encapsulated) {
    const frameBytes = npx * spp * bps;
    const start = px.offset + f * frameBytes;
    if (start + frameBytes > ds._bytes.length) throw new Error('Pixel data is shorter than the image size');
    const copy = ds._bytes.slice(start, start + frameBytes); // aligned private copy
    if (bps === 1) raw = copy;
    else {
      if (!ds._littleEndian) {
        if (bps === 2) for (let i = 0; i < copy.length; i += 2) { const t = copy[i]; copy[i] = copy[i + 1]; copy[i + 1] = t; }
        else for (let i = 0; i < copy.length; i += 4) { let t = copy[i]; copy[i] = copy[i + 3]; copy[i + 3] = t; t = copy[i + 1]; copy[i + 1] = copy[i + 2]; copy[i + 2] = t; }
      }
      raw = bps === 2 ? new Uint16Array(copy.buffer) : new Uint32Array(copy.buffer);
    }
    if (spp > 1 && planar) raw = interleave(raw, npx, spp);
  } else {
    const frag = frameFragments(ds, f, nFrames);
    if (ts === TS.JPEG_LOSSLESS || ts === TS.JPEG_LOSSLESS_SV1) {
      raw = decodeJpegLossless(frag).data;
    } else if (ts === TS.RLE) {
      raw = decodeRle(frag, rows, cols, spp, bps);
    } else if (ts === TS.JPEG_BASELINE || (ts === TS.JPEG_EXTENDED && jpegPrecision(frag) <= 8)) {
      rgba = await decodeBrowserJpeg(frag, rows, cols);
      if (spp === 1) { raw = new Uint8Array(npx); for (let i = 0; i < npx; i++) raw[i] = rgba[i * 4]; rgba = null; }
    } else if (external.has(ts)) {
      const r = await external.get(ts)(frag, { rows, cols, spp, bitsAlloc, bitsStored, signed, ts });
      raw = r.data; rawSigned = !!r.signed;
    } else {
      throw new UnsupportedError(`This image is compressed with ${TS_NAMES[ts] || 'transfer syntax ' + ts}, which this viewer cannot decode`);
    }
  }

  // ---- color ----
  if (rgba) return { ...base, color: true, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) };
  if (spp >= 3) {
    const out = new Uint8ClampedArray(npx * 4);
    const shift = Math.max(0, bitsStored - 8);
    const ybr = photo.startsWith('YBR_FULL') && !px.encapsulated;
    for (let i = 0, o = 0; i < npx; i++, o += 4) {
      let a = raw[i * spp] >> shift, b = raw[i * spp + 1] >> shift, c = raw[i * spp + 2] >> shift;
      if (ybr) {
        const y = a, cb = b - 128, cr = c - 128;
        a = y + 1.402 * cr; b = y - 0.344136 * cb - 0.714136 * cr; c = y + 1.772 * cb;
      }
      out[o] = a; out[o + 1] = b; out[o + 2] = c; out[o + 3] = 255;
    }
    return { ...base, color: true, data: out };
  }

  // ---- grayscale: stored value -> modality value ----
  const n = npx;
  const slope = fi.slope, intercept = fi.intercept;
  const shiftBits = 32 - bitsStored;
  const needMask = !rawSigned && bitsStored < 32 && !(raw instanceof Int16Array) ;
  let lo = Infinity, hi = -Infinity;
  const stored = new Int32Array(n);
  if (needMask) {
    if (signed) for (let i = 0; i < n; i++) { const v = (raw[i] << shiftBits) >> shiftBits; stored[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    else for (let i = 0; i < n; i++) { const v = (raw[i] << shiftBits) >>> shiftBits; stored[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  } else {
    for (let i = 0; i < n; i++) { const v = raw[i]; stored[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const a = lo * slope + intercept, b = hi * slope + intercept;
  const min = Math.min(a, b), max = Math.max(a, b);
  const asInt = !opts.float && Number.isInteger(slope) && Number.isInteger(intercept) && min >= -32768 && max <= 32767;
  const data = asInt ? new Int16Array(n) : new Float32Array(n);
  if (slope === 1 && intercept === 0) data.set(stored);
  else for (let i = 0; i < n; i++) data[i] = stored[i] * slope + intercept;

  const modality = str(ds, '00080060');
  const rtype = str(ds, '00281054');
  return {
    ...base, color: false, data, min, max,
    wc: fi.wc, ww: fi.ww,
    invert: photo === 'MONOCHROME1',
    unit: rtype === 'HU' || (modality === 'CT' && !/^(US|OD)$/.test(rtype)) ? 'HU' : '',
  };
}

function interleave(raw, npx, spp) {
  const out = new raw.constructor(raw.length);
  for (let s = 0; s < spp; s++) for (let i = 0; i < npx; i++) out[i * spp + s] = raw[s * npx + i];
  return out;
}
