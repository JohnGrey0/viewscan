// seghelper.js — a helper thread for the model builder. It receives ports from
// the page, and on each port takes "process these lines of this shared array"
// jobs from a segworker, signalling completion through a shared counter.
import { LINES } from './seglines.js';

function serve(port) {
  port.onmessage = (ev) => {
    const j = ev.data;
    const sync = new Int32Array(j.sync);
    try {
      LINES[j.op](new Float32Array(j.buf), j.X, j.Y, j.Z, j.axis, j.from, j.to, j.kernel);
    } catch (err) {
      Atomics.store(sync, 1, 1); // tell the client something went wrong
    } finally {
      Atomics.sub(sync, 0, 1);
      Atomics.notify(sync, 0);
    }
  };
}

self.onmessage = (ev) => {
  if (ev.data.port) serve(ev.data.port);
  if (ev.data.ping) self.postMessage({ ready: true });
};
