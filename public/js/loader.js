// loader.js — worker pool + Stack (the decoded frames of one series/volume).

const POOL_SIZE = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

class Pool {
  constructor(n) {
    this.idle = [];
    this.queue = [];
    this.jobs = new Map();
    this.seq = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this.done(w, ev.data);
      w.onerror = (ev) => console.error('worker error', ev.message);
      this.idle.push(w);
    }
  }
  /** Lower `prio` runs first. */
  run(task, prio = 5) {
    return new Promise((resolve, reject) => {
      const job = { id: ++this.seq, task, prio, resolve, reject };
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].prio > prio) i--;
      this.queue.splice(i, 0, job);
      this.pump();
    });
  }
  pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.jobs.set(job.id, job);
      w.postMessage({ id: job.id, ...job.task });
    }
  }
  done(w, msg) {
    const job = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);
    this.idle.push(w);
    this.pump();
    if (!job) return;
    if (msg.ok) job.resolve(msg); else job.reject(new Error(msg.error));
  }
  /** Drop queued (not yet started) jobs matching a predicate. */
  cancel(pred) {
    this.queue = this.queue.filter((j) => {
      if (!pred(j.task)) return true;
      j.reject(new Error('canceled'));
      return false;
    });
  }
}

export const pool = new Pool(POOL_SIZE);

/** Where file bytes come from: the local server, or files the user dropped in. */
export function srcFor(source, file) {
  return source.type === 'local' ? { file: source.files[file] } : { url: `/api/file/${file}` };
}

function percentileWindow(data) {
  // robust default window: 1st–99th percentile of a sample of the frame
  const n = data.length, step = Math.max(1, Math.floor(n / 20000));
  const s = [];
  for (let i = 0; i < n; i += step) s.push(data[i]);
  s.sort((a, b) => a - b);
  const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)];
  return { wc: (lo + hi) / 2, ww: Math.max(1, hi - lo) };
}

let stackSeq = 0;

export class Stack {
  constructor(desc, series, study, source) {
    Object.assign(this, { desc, series, study, source });
    this.uid = ++stackSeq;
    this.id = desc.id;
    this.n = desc.n; this.rows = desc.rows; this.cols = desc.cols;
    this.color = !!desc.color;
    this.frames = new Array(this.n).fill(null);
    this.loaded = 0; this.failed = 0;
    this.buffer = null;       // one contiguous array holding every grayscale frame
    this.display = null;      // { wc, ww, invert }
    this.defaultDisplay = null;
    this.unit = ''; this.min = Infinity; this.max = -Infinity;
    this.annots = [];
    this.listeners = new Set();
    this.started = false; this.done = false;
    this.volume = null;       // built lazily by volume.js
    this.bytes = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, i) { for (const fn of this.listeners) fn(kind, i); }
  get title() {
    const d = this.series.desc || `Series ${this.series.number}`;
    return this.desc.label ? `${d} · ${this.desc.label}` : d;
  }

  /** Start decoding. Frames closest to `around` come first. Returns when all are in. */
  load(around = this.n >> 1, prio = 1) {
    if (this.started) return this.promise;
    this.started = true;
    const byFile = new Map();
    this.desc.frames.forEach((f, i) => {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push({ frame: f.frame, i });
    });
    const tasks = [...byFile.entries()].map(([file, list]) => ({ file, list, dist: Math.min(...list.map((x) => Math.abs(x.i - around))) }));
    tasks.sort((a, b) => a.dist - b.dist);
    this.promise = Promise.all(tasks.map((t) => pool.run({ type: 'frames', src: srcFor(this.source, t.file), frames: t.list.map((x) => x.frame), stack: this.uid }, prio)
      .then((msg) => {
        msg.frames.forEach((fr, k) => this.accept(t.list[k].i, fr));
      }, (err) => {
        if (err.message !== 'canceled') for (const x of t.list) this.accept(x.i, { error: err.message });
      }))).then(() => { this.done = true; this.emit('done'); return this; });
    return this.promise;
  }

  accept(i, fr) {
    if (fr.error) {
      this.frames[i] = { error: fr.error };
      this.failed++;
    } else if (fr.color) {
      this.frames[i] = fr;
      this.bytes += fr.data.byteLength;
    } else {
      const size = this.rows * this.cols;
      if (fr.rows !== this.rows || fr.cols !== this.cols) {
        this.frames[i] = { error: 'Image size differs from the rest of the series' };
        this.failed++; this.loaded++; this.emit('frame', i); return;
      }
      const isFloat = fr.data instanceof Float32Array;
      if (!this.buffer) {
        this.buffer = isFloat ? new Float32Array(size * this.n) : new Int16Array(size * this.n);
        this.bytes = this.buffer.byteLength;
      } else if (isFloat && !(this.buffer instanceof Float32Array)) {
        // a frame needs floating point: upgrade the whole stack
        const up = new Float32Array(size * this.n);
        up.set(this.buffer);
        this.buffer = up; this.bytes = up.byteLength;
        this.frames.forEach((f, k) => { if (f && f.data && !f.color) f.data = up.subarray(k * size, (k + 1) * size); });
      }
      this.buffer.set(fr.data, i * size);
      fr.data = this.buffer.subarray(i * size, (i + 1) * size);
      this.frames[i] = fr;
      if (fr.min < this.min) this.min = fr.min;
      if (fr.max > this.max) this.max = fr.max;
      this.unit = fr.unit || this.unit;
      if (!this.display || this.display.provisional) {
        const mid = i === (this.n >> 1);
        if (!this.display || mid) {
          const w = fr.ww > 0 && Number.isFinite(fr.wc) ? { wc: fr.wc, ww: fr.ww } : percentileWindow(fr.data);
          this.display = { ...w, invert: !!fr.invert, provisional: !mid && this.n > 1 };
          this.defaultDisplay = { ...this.display };
        }
      }
    }
    this.loaded++;
    this.emit('frame', i);
  }

  /** Nearest loaded frame index to i (for showing something while loading). */
  nearestLoaded(i) {
    if (this.frames[i] && !this.frames[i].error) return i;
    for (let d = 1; d < this.n; d++) {
      if (i - d >= 0 && this.frames[i - d] && !this.frames[i - d].error) return i - d;
      if (i + d < this.n && this.frames[i + d] && !this.frames[i + d].error) return i + d;
    }
    return -1;
  }
}
