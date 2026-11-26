// fuseworker.js — runs fuse.js off the main thread.
// in:  { vols: [{ nx, ny, nz, data, origin, dx, dy, dz, basis, thick }], opts }
// out: { type: 'progress', p, text } …, then { type: 'done', result } or { type: 'error', error }
import { fuseVolumes } from './fuse.js';

self.onmessage = (ev) => {
  try {
    const result = fuseVolumes(ev.data.vols, ev.data.opts || {}, (p, text) => self.postMessage({ type: 'progress', p, text }));
    self.postMessage({ type: 'done', result }, [result.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
