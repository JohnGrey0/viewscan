// worker.js — fetches / reads DICOM files off the main thread, parses them and
// decodes pixel data. One task per file.
import { readDicom } from './dicom.js';
import { summarize } from './series.js';
import { decodeFrame } from './pixels.js';

const HEAD = 262144;

async function bytesOf(src, headOnly) {
  if (src.file) {
    const blob = headOnly ? src.file.slice(0, HEAD) : src.file;
    return new Uint8Array(await blob.arrayBuffer());
  }
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`Could not read file (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

self.onmessage = async (ev) => {
  const { id, type, src } = ev.data;
  try {
    if (type === 'header') {
      // quick summary of a local file, for organizing a dropped folder
      let bytes = await bytesOf(src, true);
      const magic = bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
      if (!magic && !/\.(dcm|dicom|ima)$/i.test(src.file.name)) return self.postMessage({ id, ok: true, summary: null });
      let ds = await readDicom(bytes, { stopAtPixel: true, partial: true });
      if (ds._truncated && src.file.size > bytes.length) {
        bytes = await bytesOf(src, false);
        ds = await readDicom(bytes, { stopAtPixel: true });
      }
      return self.postMessage({ id, ok: true, summary: summarize(ds) });
    }
    if (type === 'frames') {
      const ds = await readDicom(await bytesOf(src, false));
      const frames = [];
      const transfer = [];
      for (const f of ev.data.frames) {
        try {
          const fr = await decodeFrame(ds, f, { float: ev.data.float });
          fr.frame = f;
          frames.push(fr);
          transfer.push(fr.data.buffer);
        } catch (err) {
          frames.push({ frame: f, error: String(err.message || err) });
        }
      }
      return self.postMessage({ id, ok: true, frames }, transfer);
    }
    throw new Error('Unknown task ' + type);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err.message || err) });
  }
};
