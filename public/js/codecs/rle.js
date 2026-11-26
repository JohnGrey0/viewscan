// rle.js — DICOM RLE Lossless (1.2.840.10008.1.2.5) frame decoder.
// Each segment is one PackBits-compressed byte plane, most significant byte first.

export function decodeRle(seg, rows, cols, spp, bytesPerSample) {
  const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const nSeg = dv.getUint32(0, true);
  if (nSeg < 1 || nSeg > 15) throw new Error('RLE: bad segment count');
  const npx = rows * cols;
  const out = bytesPerSample === 1 ? new Uint8Array(npx * spp) : new Uint16Array(npx * spp);
  for (let s = 0; s < nSeg; s++) {
    const sample = Math.floor(s / bytesPerSample);
    if (sample >= spp) break;
    const shift = 8 * (bytesPerSample - 1 - (s % bytesPerSample));
    let p = dv.getUint32(4 + 4 * s, true);
    const end = s + 1 < nSeg ? dv.getUint32(8 + 4 * s, true) : seg.length;
    let o = 0;
    while (p < end && o < npx) {
      const n = seg[p++];
      if (n < 128) { // literal run of n+1 bytes
        for (let i = 0; i <= n && o < npx; i++, o++) out[o * spp + sample] |= seg[p++] << shift;
      } else if (n > 128) { // repeat next byte 257-n times
        const v = seg[p++] << shift;
        for (let i = 257 - n; i > 0 && o < npx; i--, o++) out[o * spp + sample] |= v;
      }
    }
  }
  return out;
}
