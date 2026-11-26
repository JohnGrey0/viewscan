// jpegll.js — JPEG Lossless (ITU T.81 process 14, Huffman) decoder.
// Covers DICOM transfer syntaxes 1.2.840.10008.1.2.4.57 and .70.
// Returns interleaved samples (Uint8Array for <=8 bit, Uint16Array otherwise).

function buildTable(counts, symbols) {
  // 16-bit direct lookup: entry = (codeLength << 8) | symbol, 0 = invalid.
  const lut = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++, k++) {
      const first = code << (16 - len);
      const span = 1 << (16 - len);
      const entry = (len << 8) | symbols[k];
      lut.fill(entry, first, first + span);
      code++;
    }
    code <<= 1;
  }
  return lut;
}

export function decodeJpegLossless(data) {
  let pos = 0;
  const end = data.length;
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('JPEG: missing SOI');
  pos = 2;
  const tables = [];
  let precision = 0, height = 0, width = 0, comps = [], restart = 0;
  let scan = null;

  while (pos < end && !scan) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xff) { pos--; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    const len = (data[pos] << 8) | data[pos + 1];
    const seg = pos + 2;
    switch (marker) {
      case 0xc3: // SOF3 lossless
        precision = data[seg];
        height = (data[seg + 1] << 8) | data[seg + 2];
        width = (data[seg + 3] << 8) | data[seg + 4];
        comps = [];
        for (let i = 0, n = data[seg + 5]; i < n; i++) {
          comps.push({ id: data[seg + 6 + i * 3], h: data[seg + 7 + i * 3] >> 4, v: data[seg + 7 + i * 3] & 15 });
        }
        break;
      case 0xc4: { // DHT
        let p = seg;
        while (p < pos + len) {
          const id = data[p] & 15;
          const counts = data.subarray(p + 1, p + 17);
          let total = 0;
          for (let i = 0; i < 16; i++) total += counts[i];
          tables[id] = buildTable(counts, data.subarray(p + 17, p + 17 + total));
          p += 17 + total;
        }
        break;
      }
      case 0xdd: restart = (data[seg] << 8) | data[seg + 1]; break;
      case 0xda: { // SOS
        const ns = data[seg];
        const sel = [];
        for (let i = 0; i < ns; i++) {
          const cid = data[seg + 1 + i * 2];
          const ci = comps.findIndex((c) => c.id === cid);
          sel.push({ comp: ci < 0 ? i : ci, table: data[seg + 2 + i * 2] >> 4 });
        }
        scan = { sel, predictor: data[seg + 1 + ns * 2], pt: data[seg + 3 + ns * 2] & 15 };
        break;
      }
      case 0xc0: case 0xc1: case 0xc2:
        throw new Error('JPEG: not a lossless stream');
      default: break;
    }
    pos += len;
  }
  if (!scan || !width || !height) throw new Error('JPEG: incomplete header');
  if (comps.some((c) => c.h !== 1 || c.v !== 1)) throw new Error('JPEG lossless: subsampling not supported');

  const nc = scan.sel.length;
  const out = precision > 8 ? new Uint16Array(width * height * nc) : new Uint8Array(width * height * nc);
  const luts = scan.sel.map((s) => {
    if (!tables[s.table]) throw new Error('JPEG: missing Huffman table');
    return tables[s.table];
  });
  const psv = scan.predictor, pt = scan.pt;
  const initial = 1 << (precision - pt - 1);
  const mask = precision > 8 ? 0xffff : 0xff;

  // bit reader (MSB first, 0xFF00 unstuffing, stops feeding at a marker)
  let buf = 0, cnt = 0, atMarker = false;
  const fill = () => {
    while (cnt <= 24) {
      let b = 0;
      if (!atMarker && pos < end) {
        b = data[pos++];
        if (b === 0xff) {
          const b2 = data[pos];
          if (b2 === 0) pos++;
          else { pos--; atMarker = true; b = 0; }
        }
      }
      buf |= b << (24 - cnt);
      cnt += 8;
    }
  };
  const decodeDiff = (lut) => {
    fill();
    const e = lut[buf >>> 16];
    const len = e >> 8, s = e & 255;
    if (len === 0) throw new Error('JPEG: bad Huffman code');
    buf <<= len; cnt -= len;
    if (s === 0) return 0;
    if (s === 16) return 32768;
    fill();
    const v = buf >>> (32 - s);
    buf <<= s; cnt -= s;
    return v < (1 << (s - 1)) ? v - (1 << s) + 1 : v;
  };

  const rowLen = width * nc;
  let mcuLeft = restart || -1;
  let firstRow = true; // true at image start and after each restart marker
  for (let y = 0; y < height; y++) {
    const row = y * rowLen;
    for (let x = 0; x < width; x++) {
      if (mcuLeft === 0) {
        // restart: realign to the RSTn marker and reset prediction
        buf = 0; cnt = 0; atMarker = false;
        while (pos < end - 1 && !(data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7)) pos++;
        pos += 2;
        mcuLeft = restart;
        firstRow = true;
      }
      for (let c = 0; c < nc; c++) {
        const i = row + x * nc + c;
        let pred;
        if (x === 0) pred = firstRow ? initial : out[i - rowLen];
        else if (firstRow) pred = out[i - nc];
        else {
          const ra = out[i - nc], rb = out[i - rowLen], rc = out[i - rowLen - nc];
          switch (psv) {
            case 1: pred = ra; break;
            case 2: pred = rb; break;
            case 3: pred = rc; break;
            case 4: pred = ra + rb - rc; break;
            case 5: pred = ra + ((rb - rc) >> 1); break;
            case 6: pred = rb + ((ra - rc) >> 1); break;
            case 7: pred = (ra + rb) >> 1; break;
            default: pred = 0;
          }
        }
        out[i] = (pred + decodeDiff(luts[c])) & mask;
      }
      if (mcuLeft > 0) mcuLeft--;
    }
    firstRow = false;
  }
  if (pt) for (let i = 0; i < out.length; i++) out[i] <<= pt;
  return { data: out, width, height, components: nc, precision };
}
