// segment.js — main-thread side of the automatic 3D-model builder, plus mesh export.

export const TARGETS = [
  { key: 'bone', name: 'Bone', color: [0.93, 0.89, 0.8], opacity: 1, modalities: ['CT'], default: true, hint: 'Skull and facial bones' },
  { key: 'brain', name: 'Brain', color: [0.96, 0.62, 0.68], opacity: 1, modalities: ['CT', 'MR'], default: true, hint: 'Everything inside the skull', hintMR: 'Approximate, found by shape' },
  { key: 'vessels', name: 'Blood vessels', color: [0.9, 0.16, 0.2], opacity: 1, modalities: ['CT'], default: true, hint: 'In the head; needs contrast dye' },
  { key: 'skin', name: 'Skin', color: [0.9, 0.72, 0.62], opacity: 0.3, modalities: ['CT', 'MR'], default: false, hint: 'Outer surface of the head' },
];

const newWorker = () => new Worker(new URL('./segworker.js', import.meta.url), { type: 'module' });
/** A model-builder worker of your own (the live MRI preview keeps one alive). */
export const newSegWorker = newWorker;
/** Wrap a label grid from the worker as the overlay the slice views draw. */
export function labelVolume(data, dims, grid) {
  const { X, Y, Z, VOX } = dims, { e, w0 } = grid, d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const w2i = new Float32Array([
    e[0][0] / VOX, e[1][0] / VOX, e[2][0] / VOX, 0,
    e[0][1] / VOX, e[1][1] / VOX, e[2][1] / VOX, 0,
    e[0][2] / VOX, e[1][2] / VOX, e[2][2] / VOX, 0,
    -d(e[0], w0) / VOX, -d(e[1], w0) / VOX, -d(e[2], w0) / VOX, 1,
  ]);
  return { data, dims: [X, Y, Z], w2i, version: Date.now() + Math.random() };
}

// Helper threads share memory with the builders, so the heavy passes run on many
// processor cores at once. That needs an "isolated" page (the server sends the
// headers for it; over plain http it only applies on localhost). Without it the
// builder still works, one core per part.
// Every build starts its own helper threads and ends them when it is done. A
// shared, long-lived set was tried first: memory shared with a helper stayed alive
// there after the build, and after a dozen builds the tab could allocate no more.
function helperCount() {
  const ok = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated;
  const cores = navigator.hardwareConcurrency || 4;
  return ok ? Math.max(0, Math.min(28, cores - (cores > 16 ? 4 : 3))) : 0;
}
function startHelpers(n) {
  return Array.from({ length: n }, () => new Worker(new URL('./seghelper.js', import.meta.url), { type: 'module' }));
}
/** Ports that connect a builder to the given helper threads. */
function connect(list) {
  return list.map((h) => { const ch = new MessageChannel(); h.postMessage({ port: ch.port2 }, [ch.port2]); return ch.port1; });
}
export function threadCount() { return helperCount() + 1; }

/**
 * Brain tissue found by a neural network on the graphics card (see brainnet.js).
 * The answer is kept with the volume, so trying other settings does not run it again.
 * @returns {Promise<{labels:Uint8Array, prob:Uint8Array, c0:number[], axes:number[][], classes:number, ms:number}>}
 */
// Models trained at home (viewscan-train): key -> description, from models/own/index.json.
// The folder is not part of the app's code; without it there are simply none.
export const OWN = {};
export async function ownModels() {
  try {
    const r = await fetch(new URL('../models/own/index.json', import.meta.url), { cache: 'no-cache' });
    const list = r.ok ? await r.json() : [];
    for (const m of Array.isArray(list) ? list : []) if (m && m.key && m.dir) OWN[m.key] = m;
  } catch { /* none */ }
  return Object.values(OWN);
}
let aiLine = Promise.resolve(); // one network at a time: they share one graphics card
export function brainModel(vol, key, onProgress = () => {}, others = []) {
  const kept = vol.ai || (vol.ai = new Map()), model = key;
  const plain = (v) => ({ nx: v.nx, ny: v.ny, nz: v.nz, data: v.data, origin: v.origin, dx: v.dx, dy: v.dy, dz: v.dz });
  if (others.length) key = model + '+study'; // a study model with the other series: kept apart from its answer for this series alone
  if (!kept.has(key)) {
    const turn = aiLine;
    const job = turn.then(() => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./aiworker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') return job.report && job.report(m.p, m.text);
        w.terminate();
        if (m.type === 'done') resolve({ ...m.result, key: model, cereb: OWN[model] ? OWN[model].cerebellum : m.result.classes === 18 ? [5, 6] : null }); else reject(new Error(m.error));
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The brain model stopped unexpectedly')); };
      w.postMessage({ model, def: OWN[model], vol: plain(vol), others: others.map(plain) });
    }));
    aiLine = job.catch(() => {});
    job.catch(() => kept.delete(key)); // a failed run may be tried again
    kept.set(key, job);
  }
  const job = kept.get(key);
  job.report = onProgress;
  return job;
}
/**
 * The model's answer for a scan, sharpened with its answers for the other series of
 * the same study (see mergeAnswers in brainnet.js). `others` are the other series'
 * volumes; with none this is just brainModel(). Kept per scan and model.
 */
export function brainAnswer(vol, key, onProgress = () => {}, others = []) {
  if (!others.length) return brainModel(vol, key, onProgress);
  if (OWN[key] && OWN[key].inputs > 1) return brainModel(vol, key, onProgress, others); // a study model takes the series in itself
  const kept = vol.aiStudy || (vol.aiStudy = new Map());
  if (!kept.has(key)) {
    const n = others.length + 1, geo = (v) => ({ nx: v.nx, ny: v.ny, nz: v.nz, origin: v.origin, dx: v.dx, dy: v.dy, dz: v.dz });
    const job = (async () => {
      const base = await brainModel(vol, key, (p, text) => job.report && job.report(p / n, text));
      const got = [];
      for (const [i, o] of others.entries()) {
        try { const a = await brainModel(o, key, (p, text) => job.report && job.report((i + 1 + p) / n, `Series ${i + 2} of ${n} of this study: ${text}`)); got.push({ prob: a.prob, c0: a.c0, geo: geo(o) }); }
        catch { /* a series the model cannot read is left out */ }
      }
      if (!got.length) return base;
      job.report && job.report(0.99, 'Putting the answers for all series together…');
      const merged = await new Promise((resolve, reject) => {
        const w = new Worker(new URL('./aiworker.js', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => { w.terminate(); if (ev.data.type === 'done') resolve(ev.data.result); else reject(new Error(ev.data.error)); };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Merging stopped unexpectedly')); };
        w.postMessage({ merge: { base: { prob: base.prob, c0: base.c0, geo: geo(vol) }, others: got } });
      });
      return { ...base, prob: merged.prob, study: { used: merged.used + 1, of: n } };
    })();
    job.catch(() => kept.delete(key));
    kept.set(key, job);
  }
  const job = kept.get(key);
  job.report = onProgress;
  return job;
}

/** True once a graphics device good enough for the brain models has actually been opened. */
let gpuProbe = null;
export function gpuReady() {
  if (!gpuProbe) gpuProbe = (async () => {
    try {
      if (!navigator.gpu) return false;
      const a = await navigator.gpu.requestAdapter();
      if (!a) return false;
      const d = await a.requestDevice();
      d.destroy();
      return true;
    } catch { return false; }
  })();
  return gpuProbe;
}

/**
 * Segment a volume and build surface meshes.
 * Stage 1 (one worker) finds every part; stage 2 cleans and meshes the parts
 * side by side, one worker (one processor core) per part.
 * @param {import('./volume.js').Volume} vol
 * @param {{targets:string[], alone?:boolean, helpers?:number, voxel:number, boneHU:number, modality:'CT'|'MR', finish:object, solid:object, mr?:object}} opts  mr = MRI fine-tuning, see segmentMR
 * @param {(fraction:number, text:string)=>void} onProgress
 */
export function buildModels(vol, optsIn, onProgress) {
  const { others, ...opts } = optsIn; // other series of the study (volumes): used here, not sent to the workers
  const t0 = performance.now();
  const workers = [];
  const stop = () => { for (const w of workers) w.terminate(); };
  const run = (message, transfer, onMessage) => new Promise((resolve, reject) => {
    const w = newWorker();
    workers.push(w);
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return onMessage(m);
      if (m.type === 'error') return reject(new Error(m.error.split('\n')[0]));
      w.terminate();
      resolve(m);
    };
    w.onerror = (e) => reject(new Error(e.message || 'The model builder stopped unexpectedly'));
    w.postMessage(message, transfer);
  });

  return (async () => {
    // opts.alone: build without helper threads; opts.helpers: use at most this many.
    // Used when many builds run side by side (the compare grid) and share the cores.
    const pool = opts.alone ? [] : startHelpers(Math.min(helperCount(), opts.helpers ?? Infinity));
    workers.push(...pool); // ended with the build
    const segPorts = connect(pool);
    // MRI brain by neural network: runs first, on the graphics card; if it cannot run,
    // the classic method is used and the model says so
    let ai = null, aiNote = '';
    const wantModel = opts.modality === 'MR' && opts.targets.includes('brain') && opts.mr && opts.mr.model && opts.mr.model !== 'classic';
    if (wantModel) {
      try { ai = await brainAnswer(vol, opts.mr.model, (p, text) => onProgress(p * 0.3, text), opts.mr.study ? others || [] : []); }
      catch (err) { aiNote = `The AI brain model could not run (${err.message}); the classic method was used instead.`; }
    }
    const segOpts = ai ? { ...opts, ai: { labels: ai.labels, prob: ai.prob, c0: ai.c0, axes: ai.axes, classes: ai.classes, key: ai.key, cereb: ai.cereb } } : opts;
    const seg = await run({
      type: 'segment',
      vol: { nx: vol.nx, ny: vol.ny, nz: vol.nz, data: vol.data, origin: vol.origin, dx: vol.dx, dy: vol.dy, dz: vol.dz, basis: vol.basis },
      opts: segOpts, ports: segPorts,
    }, segPorts, (m) => onProgress(ai ? 0.3 + m.p * 0.4 : m.p * 0.75, m.text));
    if (aiNote) for (const pt of seg.parts) if (pt.key === 'brain') pt.note = pt.note ? aiNote + ' ' + pt.note : aiNote;

    const { X, Y, Z, VOX } = seg.dims;
    const tSeg = performance.now();
    let done = 0;
    const doing = new Map();
    // share the helper threads between the parts, most to the heaviest ones
    const weight = { brain: 4, bone: 2, skin: 2, vessels: 1 };
    const total = seg.parts.reduce((n, pt) => n + (pt.mask ? weight[pt.key] || 1 : 0), 0) || 1;
    let next = 0;
    const results = await Promise.all(seg.parts.map((part) => {
      const share = part.mask ? Math.floor(pool.length * (weight[part.key] || 1) / total) : 0;
      const ports = connect(pool.slice(next, next + share));
      next += share;
      const transfer = [...ports];
      const give = (a) => { if (a && a.buffer instanceof ArrayBuffer && !transfer.includes(a.buffer)) transfer.push(a.buffer); };
      give(part.mask);
      if (part.surface) { give(part.surface.field); give(part.surface.within); }
      return run({ type: 'part', dims: seg.dims, grid: seg.grid, opts, ports, ...part }, transfer, (m) => {
        doing.set(m.key, m.text);
        onProgress(0.6 + 0.4 * (done / seg.parts.length), [...doing.values()].pop());
      }).then((r) => { r.item.seconds = (performance.now() - tSeg) / 1000; done++; doing.delete(part.key); onProgress(0.6 + 0.4 * (done / seg.parts.length), done < seg.parts.length ? [...doing.values()].pop() || 'Building the models…' : 'Finishing…'); return r; });
    }));

    // color overlay for the slices: one bit per part
    const labels = new Uint8Array(X * Y * Z);
    for (const r of results) {
      if (!r.mask) continue;
      const bit = 1 << r.item.bit, mask = r.mask;
      for (let i = 0; i < labels.length; i++) if (mask[i]) labels[i] |= bit;
    }
    return {
      labels: labelVolume(labels, seg.dims, seg.grid),
      items: results.map((r) => r.item).sort((a, b) => a.bit - b.bit),
      notes: seg.notes,
      used: seg.used,
      seconds: (performance.now() - t0) / 1000,
      timing: { findParts: (tSeg - t0) / 1000, buildParts: (performance.now() - tSeg) / 1000, threads: pool.length + 1 },
    };
  })().finally(stop);
}

/** Binary STL. Coordinates are the scan's own patient coordinates (LPS) in millimeters. */
export function exportSTL(mesh, title = 'Viewscan') {
  const { positions: p, indices: idx } = mesh;
  const nt = idx.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(title.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(head);
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    for (const [k, v] of [[12, a], [24, b], [36, c]]) {
      dv.setFloat32(o + k, p[v], true); dv.setFloat32(o + k + 4, p[v + 1], true); dv.setFloat32(o + k + 8, p[v + 2], true);
    }
    o += 50;
  }
  return new Blob([buf], { type: 'model/stl' });
}

/** Wavefront OBJ with vertex normals (millimeters, LPS). */
export function exportOBJ(mesh, name = 'model') {
  const { positions: p, normals: n, indices: idx } = mesh;
  const parts = [`# Viewscan model, millimeters, patient LPS coordinates\no ${name.replace(/\s+/g, '_')}\n`];
  let chunk = [];
  const flush = () => { parts.push(chunk.join('\n') + '\n'); chunk = []; };
  for (let i = 0; i < p.length; i += 3) { chunk.push(`v ${p[i].toFixed(3)} ${p[i + 1].toFixed(3)} ${p[i + 2].toFixed(3)}`); if (chunk.length > 50000) flush(); }
  for (let i = 0; i < n.length; i += 3) { chunk.push(`vn ${n[i].toFixed(3)} ${n[i + 1].toFixed(3)} ${n[i + 2].toFixed(3)}`); if (chunk.length > 50000) flush(); }
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] + 1, b = idx[i + 1] + 1, c = idx[i + 2] + 1;
    chunk.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`); if (chunk.length > 50000) flush();
  }
  flush();
  return new Blob(parts, { type: 'model/obj' });
}
