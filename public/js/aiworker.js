// aiworker.js — runs a brain model (brainnet.js) off the main thread.
import { runModel } from './brainnet.js';
self.onmessage = async (ev) => {
  try {
    const r = await runModel(ev.data.vol, ev.data.model, (p, text) => self.postMessage({ type: 'progress', p, text }));
    self.postMessage({ type: 'done', result: r }, [r.labels.buffer, r.prob.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
