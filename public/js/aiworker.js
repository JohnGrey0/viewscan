// aiworker.js — runs a brain model (brainnet.js) off the main thread.
import { runModel, mergeAnswers, MODELS } from './brainnet.js';
self.onmessage = async (ev) => {
  try {
    if (ev.data.merge) { const r = mergeAnswers(ev.data.merge.base, ev.data.merge.others); return self.postMessage({ type: 'done', result: r }, [r.prob.buffer]); }
    if (ev.data.def) MODELS[ev.data.model] = ev.data.def; // a home-trained model: its description comes along
    const r = await runModel(ev.data.vol, ev.data.model, (p, text) => self.postMessage({ type: 'progress', p, text }), { others: ev.data.others || [] });
    self.postMessage({ type: 'done', result: r }, [r.labels.buffer, r.prob.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
