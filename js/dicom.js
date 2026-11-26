// dicom.js — small dependency-free DICOM Part 10 reader.
// Runs unchanged in the browser, in Web Workers and in Node (the server uses it
// to index folders). It decodes the header into a plain object keyed by
// "ggggeeee" tag strings and records where the pixel data sits; it never copies
// pixel bytes.

export const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATE_LE: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
  JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
  JPEG_LOSSLESS: '1.2.840.10008.1.2.4.57',
  JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
  JPEG_LS: '1.2.840.10008.1.2.4.80',
  JPEG_LS_NEAR: '1.2.840.10008.1.2.4.81',
  JPEG_2000_LOSSLESS: '1.2.840.10008.1.2.4.90',
  JPEG_2000: '1.2.840.10008.1.2.4.91',
  RLE: '1.2.840.10008.1.2.5',
};

// Explicit VRs that use the long (4-byte length) header form.
const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'OD', 'OL', 'UC', 'UR', 'OV', 'SV', 'UV']);
const STRING_VR = new Set(['AE', 'AS', 'CS', 'DA', 'DT', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UI', 'UT', 'UC', 'UR']);

// VR dictionary, used only for Implicit VR files (which do not carry VRs).
// Limited to the attributes this viewer reads.
const DICT = {
  '00020010': 'UI',
  '00080005': 'CS', '00080008': 'CS', '00080016': 'UI', '00080018': 'UI', '00080020': 'DA', '00080021': 'DA',
  '00080022': 'DA', '00080023': 'DA', '00080030': 'TM', '00080031': 'TM', '00080032': 'TM', '00080033': 'TM',
  '00080050': 'SH', '00080060': 'CS', '00080070': 'LO', '00080080': 'LO', '00081030': 'LO', '0008103e': 'LO',
  '00081090': 'LO', '00089007': 'CS',
  '00100010': 'PN', '00100020': 'LO', '00100030': 'DA', '00100040': 'CS', '00101010': 'AS',
  '00180015': 'CS', '00180020': 'CS', '00180021': 'CS', '00180023': 'CS', '00180024': 'SH', '00180050': 'DS',
  '00180060': 'DS', '00180080': 'DS', '00180081': 'DS', '00180082': 'DS', '00180086': 'IS', '00180087': 'DS',
  '00180088': 'DS', '00181030': 'LO', '00181060': 'DS', '00181120': 'DS', '00181150': 'IS', '00181151': 'IS',
  '00181152': 'IS', '00181164': 'DS', '00181210': 'SH', '00181314': 'DS', '00185100': 'CS', '00189082': 'FD',
  '00189087': 'FD', '00189114': 'SQ', '00189117': 'SQ',
  '0020000d': 'UI', '0020000e': 'UI', '00200010': 'SH', '00200011': 'IS', '00200012': 'IS', '00200013': 'IS',
  '00200032': 'DS', '00200037': 'DS', '00200052': 'UI', '00200100': 'IS', '00201041': 'DS', '00209056': 'SH',
  '00209057': 'UL', '00209111': 'SQ', '00209113': 'SQ', '00209116': 'SQ', '00209128': 'UL', '00209157': 'UL',
  '00280002': 'US', '00280004': 'CS', '00280006': 'US', '00280008': 'IS', '00280010': 'US', '00280011': 'US',
  '00280030': 'DS', '00280100': 'US', '00280101': 'US', '00280102': 'US', '00280103': 'US', '00280120': 'US',
  '00281050': 'DS', '00281051': 'DS', '00281052': 'DS', '00281053': 'DS', '00281054': 'LO', '00282110': 'CS',
  '00289110': 'SQ', '00289132': 'SQ', '00289145': 'SQ',
  '52009229': 'SQ', '52009230': 'SQ',
  '7fe00010': 'OW',
};

const NUM_READERS = {
  US: [2, (dv, o, le) => dv.getUint16(o, le)],
  SS: [2, (dv, o, le) => dv.getInt16(o, le)],
  UL: [4, (dv, o, le) => dv.getUint32(o, le)],
  SL: [4, (dv, o, le) => dv.getInt32(o, le)],
  FL: [4, (dv, o, le) => dv.getFloat32(o, le)],
  FD: [8, (dv, o, le) => dv.getFloat64(o, le)],
};

const UNDEFINED = 0xffffffff;
const STOP = Symbol('stop');
const MAX_VALUE_BYTES = 4096; // longer plain values are skipped (never needed for display)

class Truncated extends Error {}

function hex4(n) { return n.toString(16).padStart(4, '0'); }

function makeDecoder(charset) {
  const cs = String(charset || '').toUpperCase();
  let label = 'latin1';
  if (cs.includes('192')) label = 'utf-8';
  else if (cs.includes('IR 13') || cs.includes('IR 87')) label = 'shift_jis';
  else if (cs.includes('IR 144')) label = 'iso-8859-5';
  else if (cs.includes('GB18030') || cs.includes('GBK')) label = 'gb18030';
  try { return new TextDecoder(label); } catch { return new TextDecoder('latin1'); }
}

function readDataset(c, end, out, depth) {
  const { dv, bytes } = c;
  while (c.off + 8 <= end) {
    const start = c.off;
    const g = dv.getUint16(c.off, c.le);
    const e = dv.getUint16(c.off + 2, c.le);
    if (g === 0xfffe) { // item / sequence delimiters carry no VR
      c.off += 8;
      if (e === 0xe00d || e === 0xe0dd) return;
      continue;
    }
    const tag = hex4(g) + hex4(e);
    let vr, len;
    if (c.explicit) {
      if (c.off + 8 > end) throw new Truncated();
      vr = String.fromCharCode(bytes[c.off + 4], bytes[c.off + 5]);
      if (LONG_VR.has(vr)) {
        if (c.off + 12 > bytes.length) throw new Truncated();
        len = dv.getUint32(c.off + 8, c.le);
        c.off += 12;
      } else {
        len = dv.getUint16(c.off + 6, c.le);
        c.off += 8;
      }
    } else {
      vr = DICT[tag] || (e === 0 ? 'UL' : 'UN');
      len = dv.getUint32(c.off + 4, c.le);
      c.off += 8;
    }

    if (tag === '7fe00010' && depth === 0) {
      const px = { vr, offset: c.off, length: len, encapsulated: len === UNDEFINED, fragments: null };
      out._pixel = px;
      if (px.encapsulated && !c.stopAtPixel) px.fragments = readFragments(c);
      return STOP;
    }

    if (len === UNDEFINED || vr === 'SQ') {
      // Sequence. A UN element of undefined length is an implicit-VR sequence.
      const saved = [c.explicit, c.le];
      if (vr === 'UN') { c.explicit = false; c.le = true; }
      const seqEnd = len === UNDEFINED ? bytes.length : c.off + len;
      if (len !== UNDEFINED && seqEnd > bytes.length) throw new Truncated();
      const items = [];
      while (c.off + 8 <= seqEnd) {
        const ig = dv.getUint16(c.off, c.le);
        const ie = dv.getUint16(c.off + 2, c.le);
        const il = dv.getUint32(c.off + 4, c.le);
        if (ig !== 0xfffe) throw new Error(`Bad sequence item at ${c.off} in (${tag})`);
        c.off += 8;
        if (ie === 0xe0dd) break;
        if (ie !== 0xe000) continue;
        const item = {};
        if (il === UNDEFINED) {
          if (readDataset(c, bytes.length, item, depth + 1) === STOP) return STOP;
        } else {
          const itemEnd = c.off + il;
          if (itemEnd > bytes.length) throw new Truncated();
          readDataset(c, itemEnd, item, depth + 1);
          c.off = itemEnd;
        }
        items.push(item);
      }
      [c.explicit, c.le] = saved;
      if (!(g & 1)) out[tag] = items;
      continue;
    }

    const valueEnd = c.off + len;
    if (valueEnd > bytes.length) {
      c.off = start;
      throw new Truncated();
    }
    if (!(g & 1) && len > 0 && len <= MAX_VALUE_BYTES) {
      const num = NUM_READERS[vr];
      if (num) {
        const [size, fn] = num;
        const n = Math.floor(len / size);
        if (n === 1) out[tag] = fn(dv, c.off, c.le);
        else { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = fn(dv, c.off + i * size, c.le); out[tag] = a; }
      } else if (vr === 'DS' || vr === 'IS') {
        const s = latin1(bytes, c.off, len).replace(/[\0\s]+$/, '');
        const parts = s.split('\\').map((p) => (p.trim() === '' ? NaN : Number(p)));
        out[tag] = parts.length === 1 ? parts[0] : parts;
      } else if (STRING_VR.has(vr)) {
        const raw = bytes.subarray(c.off, valueEnd);
        const s = (vr === 'UI' || vr === 'CS' || vr === 'DA' || vr === 'TM') ? latin1(bytes, c.off, len) : c.text.decode(raw);
        out[tag] = s.replace(/[\0 ]+$/, '');
        if (tag === '00080005' && depth === 0) c.text = makeDecoder(out[tag]);
      }
    }
    c.off = valueEnd;
  }
}

function latin1(bytes, off, len) {
  let s = '';
  for (let i = off, e = off + len; i < e; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// Encapsulated pixel data: an offset table item followed by fragment items.
function readFragments(c) {
  const { dv, bytes } = c;
  const frags = [];
  let first = true;
  let offsetTable = [];
  while (c.off + 8 <= bytes.length) {
    const g = dv.getUint16(c.off, true), e = dv.getUint16(c.off + 2, true);
    const len = dv.getUint32(c.off + 4, true);
    c.off += 8;
    if (g !== 0xfffe || e === 0xe0dd) break;
    if (c.off + len > bytes.length) throw new Truncated();
    if (first) {
      for (let i = 0; i + 4 <= len; i += 4) offsetTable.push(dv.getUint32(c.off + i, true));
      first = false;
    } else {
      frags.push({ offset: c.off, length: len, itemStart: c.off - 8 });
    }
    c.off += len;
  }
  frags.offsetTable = offsetTable;
  return frags;
}

async function inflateRaw(bytes) {
  // Read chunk by chunk and keep what was produced: deflated files are padded
  // after the end of the stream, which strict decoders report as an error.
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
  } catch (err) {
    if (!total) throw err;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Parse a DICOM file.
 * @param {Uint8Array} bytes  whole file, or just its head when opts.stopAtPixel is set
 * @param {{stopAtPixel?: boolean}} opts
 * @returns {Promise<object>} dataset keyed by tag; `_pixel` describes pixel data,
 *   `_ts` is the transfer syntax, `_bytes` the buffer offsets refer to,
 *   `_truncated` is true when the buffer ended before the pixel data was reached.
 */
export async function readDicom(bytes, opts = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  let dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ds = {};
  let off = 0;
  const hasPreamble = bytes.length > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
  if (hasPreamble) off = 132;
  else if (!looksLikeDataset(bytes, dv)) throw new Error('Not a DICOM file');

  const c = { dv, bytes, off, le: true, explicit: true, stopAtPixel: !!opts.stopAtPixel, text: makeDecoder('') };

  // File meta group (0002,xxxx) is always Explicit VR Little Endian.
  if (hasPreamble || dv.getUint16(off, true) === 0x0002) {
    const meta = {};
    while (c.off + 8 <= bytes.length && dv.getUint16(c.off, true) === 0x0002) {
      const e = dv.getUint16(c.off + 2, true);
      const vr = String.fromCharCode(bytes[c.off + 4], bytes[c.off + 5]);
      let len, hdr;
      if (LONG_VR.has(vr)) { len = dv.getUint32(c.off + 8, true); hdr = 12; } else { len = dv.getUint16(c.off + 6, true); hdr = 8; }
      if (e === 0x0010) meta.ts = latin1(bytes, c.off + hdr, len).replace(/[\0 ]+$/, '');
      c.off += hdr + len;
    }
    ds._ts = meta.ts || TS.EXPLICIT_LE;
  } else {
    // No meta header: raw dataset. Guess explicit vs implicit from the first element.
    const vr = String.fromCharCode(bytes[4], bytes[5]);
    ds._ts = /^[A-Z]{2}$/.test(vr) ? TS.EXPLICIT_LE : TS.IMPLICIT_LE;
  }

  if (ds._ts === TS.DEFLATE_LE) {
    const inflated = await inflateRaw(bytes.subarray(c.off));
    bytes = inflated;
    dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    c.bytes = bytes; c.dv = dv; c.off = 0;
  }
  c.explicit = ds._ts !== TS.IMPLICIT_LE;
  c.le = ds._ts !== TS.EXPLICIT_BE;

  try {
    readDataset(c, bytes.length, ds, 0);
  } catch (err) {
    if (!(err instanceof Truncated) && !(err instanceof RangeError)) throw err;
    ds._truncated = true;
  }
  if (!ds._pixel && c.stopAtPixel && c.off + 8 > bytes.length && opts.partial) ds._truncated = true;
  ds._bytes = bytes;
  ds._littleEndian = c.le;
  return ds;
}

function looksLikeDataset(bytes, dv) {
  if (bytes.length < 16) return false;
  const g = dv.getUint16(0, true);
  const e = dv.getUint16(2, true);
  if (g !== 0x0008 && g !== 0x0002) return false;
  if (e > 0x0100) return false;
  const vr = String.fromCharCode(bytes[4], bytes[5]);
  if (/^[A-Z]{2}$/.test(vr)) return true;
  return dv.getUint32(4, true) < 256; // implicit: small first element
}

/** True when the first bytes look like a DICOM Part 10 file. */
export function hasDicomMagic(bytes) {
  return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

// ---- small typed accessors ---------------------------------------------------
export function str(ds, tag, dflt = '') {
  const v = ds[tag];
  return v === undefined || v === null ? dflt : String(v);
}
export function num(ds, tag, dflt = undefined) {
  let v = ds[tag];
  if (Array.isArray(v)) v = v[0];
  if (typeof v === 'string') v = Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
export function nums(ds, tag) {
  const v = ds[tag];
  if (v === undefined) return null;
  const a = Array.isArray(v) ? v : [v];
  return a.every((x) => typeof x === 'number' && Number.isFinite(x)) ? a : null;
}
