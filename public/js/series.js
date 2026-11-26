// series.js — turns parsed DICOM headers into studies → series → stacks.
// Shared by the server (folder index) and the browser (dropped folders).
//
// A "stack" is what the viewer actually opens: a set of frames with the same
// size and orientation, sorted along the slice normal. One DICOM series can
// hold several (two acquisitions interleaved, a localizer next to a volume,
// multiple echoes / b-values / time points in MR), so series are split here.

import { str, num, nums } from './dicom.js';

// ---- per-frame attributes (classic single-frame and enhanced multi-frame) ----

/** Attribute lookup that honors enhanced multi-frame functional groups. */
export function frameAttr(ds, f, seqTag, tag) {
  const per = ds['52009230'];
  const shared = ds['52009229'];
  let v = per && per[f] && per[f][seqTag] && per[f][seqTag][0] ? per[f][seqTag][0][tag] : undefined;
  if (v === undefined && shared && shared[0] && shared[0][seqTag] && shared[0][seqTag][0]) v = shared[0][seqTag][0][tag];
  if (v === undefined) v = ds[tag];
  return v;
}

function first(v) { return Array.isArray(v) ? v[0] : v; }
function numOf(v, dflt) { v = first(v); if (typeof v === 'string') v = Number(v); return typeof v === 'number' && Number.isFinite(v) ? v : dflt; }
function numsOf(v, n) {
  if (!Array.isArray(v) || v.length < n) return null;
  const a = v.slice(0, n).map(Number);
  return a.every(Number.isFinite) ? a : null;
}

/** Geometry + display attributes of one frame. Used by the indexer and the pixel decoder. */
export function frameInfo(ds, f) {
  const ps = numsOf(frameAttr(ds, f, '00289110', '00280030'), 2) || numsOf(ds['00181164'], 2);
  return {
    ipp: numsOf(frameAttr(ds, f, '00209113', '00200032'), 3),
    iop: numsOf(frameAttr(ds, f, '00209116', '00200037'), 6),
    ps: ps && ps[0] > 0 && ps[1] > 0 ? ps : null,
    thick: numOf(frameAttr(ds, f, '00289110', '00180050')),
    slope: numOf(frameAttr(ds, f, '00289145', '00281053'), 1) || 1,
    intercept: numOf(frameAttr(ds, f, '00289145', '00281052'), 0),
    wc: numOf(frameAttr(ds, f, '00289132', '00281050')),
    ww: numOf(frameAttr(ds, f, '00289132', '00281051')),
  };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Summarize one parsed file: series-level `info` plus one compact entry per frame.
 * Returns null when the file has no displayable pixel data.
 */
export function summarize(ds) {
  const rows = num(ds, '00280010'), cols = num(ds, '00280011');
  if (!ds._pixel || !rows || !cols) return null;
  const nFrames = Math.max(1, num(ds, '00280008', 1));
  const info = {
    studyUID: str(ds, '0020000d') || 'unknown-study',
    seriesUID: str(ds, '0020000e') || 'unknown-series',
    sop: str(ds, '00080018'),
    patient: str(ds, '00100010').replace(/\^+/g, ' ').trim(),
    patientId: str(ds, '00100020'),
    birth: str(ds, '00100030'),
    sex: str(ds, '00100040'),
    age: str(ds, '00101010'),
    studyDate: str(ds, '00080020'),
    studyTime: str(ds, '00080030'),
    studyDesc: str(ds, '00081030'),
    accession: str(ds, '00080050'),
    institution: str(ds, '00080080'),
    modality: str(ds, '00080060') || 'OT',
    manufacturer: str(ds, '00080070'),
    model: str(ds, '00081090'),
    seriesNumber: num(ds, '00200011', 0),
    seriesDesc: str(ds, '0008103e'),
    seriesDate: str(ds, '00080021'),
    seriesTime: str(ds, '00080031'),
    bodyPart: str(ds, '00180015'),
    protocol: str(ds, '00181030'),
    kernel: str(ds, '00181210'),
    kvp: num(ds, '00180060'),
    tubeCurrent: num(ds, '00181151'),
    tilt: num(ds, '00181120'),
    tr: num(ds, '00180080'),
    te: num(ds, '00180081'),
    ti: num(ds, '00180082'),
    flip: num(ds, '00181314'),
    field: num(ds, '00180087'),
    sequence: str(ds, '00180024') || str(ds, '00180020'),
    position: str(ds, '00185100'),
    frameOfRef: str(ds, '00200052'),
    ts: ds._ts,
    lossy: str(ds, '00282110') === '01',
  };
  // enhanced multi-frame files (one file per series) keep the timing with the frames
  if (info.tr === undefined) info.tr = numOf(frameAttr(ds, 0, '00189112', '00180080'));
  if (info.te === undefined) info.te = numOf(frameAttr(ds, 0, '00189114', '00189082'));
  if (info.ti === undefined) info.ti = numOf(frameAttr(ds, 0, '00189115', '00189079'));
  if (!info.sequence) info.sequence = str(ds, '00189005');
  for (const k of Object.keys(info)) if (info[k] === '' || info[k] === undefined) delete info[k];

  const base = {
    rows, cols,
    spp: num(ds, '00280002', 1),
    photo: str(ds, '00280004', 'MONOCHROME2'),
    inst: num(ds, '00200013', 0),
    acq: num(ds, '00200012'),
    itype: str(ds, '00080008') || str(ds, '00089007'),
    echo: num(ds, '00180086'),
    tpos: num(ds, '00200100'),
    trig: num(ds, '00181060'),
  };
  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const fi = frameInfo(ds, f);
    const fr = { ...base, frame: f };
    if (fi.ipp) fr.ipp = fi.ipp.map(r4);
    if (fi.iop) fr.iop = fi.iop;
    if (fi.ps) fr.ps = fi.ps;
    if (fi.thick !== undefined) fr.thick = fi.thick;
    const te = numOf(frameAttr(ds, f, '00189114', '00189082'), info.te);
    if (te !== undefined) fr.te = te;
    const bval = numOf(frameAttr(ds, f, '00189117', '00189087'));
    if (bval !== undefined) fr.bval = bval;
    if (nFrames > 1) {
      const tIdx = numOf(frameAttr(ds, f, '00209111', '00209128'));
      if (tIdx !== undefined) fr.tpos = tIdx;
      const stackId = frameAttr(ds, f, '00209111', '00209056');
      if (stackId !== undefined) fr.stackId = String(stackId);
    }
    for (const k of Object.keys(fr)) if (fr[k] === undefined || fr[k] === '') delete fr[k];
    frames.push(fr);
  }
  return { info, frames };
}

// ---- vector helpers ------------------------------------------------------------
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 'AX' | 'COR' | 'SAG' from a plane normal (patient LPS coordinates). */
export function planeName(normal) {
  const a = normal.map(Math.abs);
  if (a[2] >= a[0] && a[2] >= a[1]) return 'AX';
  return a[1] >= a[0] ? 'COR' : 'SAG';
}
export const PLANE_LABEL = { AX: 'Axial', COR: 'Coronal', SAG: 'Sagittal' };

// ---- stack splitting -----------------------------------------------------------

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

// Classify how a set of frames is laid out along its normal.
function layout(frames) {
  if (frames.length < 2) return { kind: 'single', step: 0 };
  const d = frames.map((f) => f._d).sort((a, b) => a - b);
  const steps = [];
  for (let i = 1; i < d.length; i++) steps.push(d[i] - d[i - 1]);
  const med = median(steps);
  if (steps.some((s) => s < 0.01)) return { kind: 'dups', step: med };
  const tol = Math.max(0.05, med * 0.05);
  if (steps.every((s) => Math.abs(s - med) <= tol)) return { kind: 'uniform', step: med };
  return { kind: 'irregular', step: med };
}

const SPLIT_KEYS = [
  ['acq', 'acq'], ['te', 'TE'], ['echo', 'echo'], ['bval', 'b'], ['tpos', 'phase'], ['trig', 'trigger'], ['stackId', 'stack'], ['itype', ''],
];

function partition(frames, key) {
  const m = new Map();
  for (const f of frames) {
    const v = f[key] === undefined ? '' : f[key];
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(f);
  }
  return m;
}

// Split one same-orientation group into volumes with consistent slice spacing.
function splitGroup(frames) {
  const lay = layout(frames);
  if (lay.kind === 'uniform' || lay.kind === 'single') return [{ frames, tag: '' }];
  for (const want of ['uniform', 'nodups']) {
    for (const [key, label] of SPLIT_KEYS) {
      const parts = partition(frames, key);
      if (parts.size < 2) continue;
      const ok = [...parts.values()].every((p) => {
        const k = layout(p).kind;
        return want === 'uniform' ? (k === 'uniform' || k === 'single') : k !== 'dups';
      });
      if (!ok) continue;
      return [...parts.entries()].map(([v, p]) => ({
        frames: p,
        tag: key === 'itype' ? String(v).split('\\').slice(2).join(' ').toLowerCase() : `${label} ${v}`,
      }));
    }
  }
  if (lay.kind === 'dups') {
    // Same positions repeated with nothing to tell them apart: deal frames out in
    // acquisition order so every volume gets each position once.
    const ordered = [...frames].sort((a, b) => a.inst - b.inst || a.frame - b.frame);
    const buckets = [];
    for (const f of ordered) {
      const k = Math.round(f._d * 50);
      let b = buckets.find((x) => !x.seen.has(k));
      if (!b) { b = { seen: new Set(), frames: [] }; buckets.push(b); }
      b.seen.add(k); b.frames.push(f);
    }
    return buckets.map((b, i) => ({ frames: b.frames, tag: `set ${i + 1}` }));
  }
  return [{ frames, tag: '' }]; // irregular spacing, kept as one stack
}

function splitSeries(frames) {
  // 1. same matrix / color model / orientation
  const groups = [];
  for (const f of frames) {
    const dims = `${f.rows}x${f.cols}|${f.spp}|${f.photo}`;
    let g = null;
    for (const c of groups) {
      if (c.dims !== dims) continue;
      if (!f.iop || !f.ipp) { if (!c.iop) { g = c; break; } continue; }
      if (c.iop && dot(c.iop, f.iop) > 0.9995 && dot(c.iop.slice(3), f.iop.slice(3)) > 0.9995) { g = c; break; }
    }
    if (!g) { g = { dims, iop: f.iop && f.ipp ? f.iop : null, frames: [] }; groups.push(g); }
    g.frames.push(f);
  }
  // 2. consistent spacing
  const stacks = [];
  for (const g of groups) {
    if (!g.iop) {
      g.frames.sort((a, b) => a.inst - b.inst || a.frame - b.frame);
      stacks.push({ frames: g.frames, tag: '', normal: null });
      continue;
    }
    const normal = cross(g.iop.slice(0, 3), g.iop.slice(3));
    for (const f of g.frames) f._d = dot(f.ipp, normal);
    for (const part of splitGroup(g.frames)) {
      part.frames.sort((a, b) => a._d - b._d || a.inst - b.inst || a.frame - b.frame);
      stacks.push({ ...part, normal, iop: g.iop });
    }
  }
  return stacks;
}

// Several passes over neighboring parts of the body (same grid, same spacing,
// overlapping or touching) can be joined into one taller stack. Useful when no
// single pass covers the whole head.
function joinParts(stacks) {
  const out = [];
  const used = new Set();
  for (const a of stacks) {
    if (used.has(a) || !a.normal || a.frames.length < 8) continue;
    const la = layout(a.frames);
    if (la.kind !== 'uniform') continue;
    const offset = (s) => { const f = s.frames[0]; return [dot(f.ipp, s.iop.slice(0, 3)), dot(f.ipp, s.iop.slice(3))]; };
    const oa = offset(a);
    const group = stacks.filter((b) => {
      if (b === a) return true;
      if (used.has(b) || !b.normal || b.frames.length < 8 || b.iop !== a.iop) return false;
      const lb = layout(b.frames), ob = offset(b);
      return lb.kind === 'uniform' && Math.abs(lb.step - la.step) < la.step * 0.02 && Math.abs(ob[0] - oa[0]) < 0.5 && Math.abs(ob[1] - oa[1]) < 0.5
        && b.frames[0].rows === a.frames[0].rows && b.frames[0].cols === a.frames[0].cols;
    }).sort((x, y) => x.frames[0]._d - y.frames[0]._d);
    if (group.length < 2) continue;
    const frames = [...group[0].frames];
    const parts = [group[0]];
    for (const g of group.slice(1)) {
      const top = frames[frames.length - 1]._d;
      if (g.frames[0]._d > top + la.step * 1.5) break; // a real gap: do not bridge it
      const extra = g.frames.filter((f) => f._d > top + la.step * 0.4);
      if (extra.length < 2) continue;
      frames.push(...extra); parts.push(g);
    }
    const longest = Math.max(...parts.map((g) => g.frames.length));
    if (parts.length < 2 || frames.length < longest * 1.1) continue;
    for (const g of parts) used.add(g);
    out.push({ frames, tag: `${parts.length} passes joined`, normal: a.normal, iop: a.iop, joined: true });
  }
  return out;
}

function buildStack(s, idx) {
  const f0 = s.frames[0];
  const lay = s.normal ? layout(s.frames) : { kind: s.frames.length > 1 ? 'nogeom' : 'single', step: 0 };
  const out = {
    n: s.frames.length,
    rows: f0.rows, cols: f0.cols,
    color: f0.spp > 1 || /PALETTE/.test(f0.photo),
    layout: lay.kind,
    tag: s.tag,
    frames: s.frames.map((f) => ({ file: f.file, frame: f.frame, inst: f.inst })),
  };
  if (f0.ps) out.ps = f0.ps;
  if (f0.thick !== undefined) out.thick = f0.thick;
  if (s.normal) {
    out.plane = planeName(s.normal);
    out.iop = s.iop;
    out.step = r4(lay.step);
    out.first = f0.ipp; out.last = s.frames[s.frames.length - 1].ipp;
    if (lay.kind === 'irregular') out.pos = s.frames.map((f) => r4(f._d));
  }
  // A proper 3-D volume: enough evenly spaced (or resample-able) parallel slices.
  out.volume = !!s.normal && !out.color && out.n >= 8 && !!f0.ps && (lay.kind === 'uniform' || lay.kind === 'irregular');
  if (s.joined) out.joined = true;
  out.idx = idx;
  return out;
}

/**
 * Group file summaries into studies → series → stacks.
 * @param {Array<{file:any, info:object, frames:object[]}>} files
 */
export function organize(files) {
  const studies = new Map();
  const seen = new Set();
  for (const f of files) {
    if (!f || !f.info) continue;
    if (f.info.sop) { if (seen.has(f.info.sop)) continue; seen.add(f.info.sop); }
    let st = studies.get(f.info.studyUID);
    if (!st) { st = { uid: f.info.studyUID, info: f.info, series: new Map() }; studies.set(st.uid, st); }
    let se = st.series.get(f.info.seriesUID);
    if (!se) { se = { uid: f.info.seriesUID, info: f.info, frames: [], files: 0 }; st.series.set(se.uid, se); }
    se.files++;
    for (const fr of f.frames) se.frames.push({ ...fr, file: f.file });
  }
  const out = [];
  for (const st of studies.values()) {
    const i = st.info;
    const study = {
      uid: st.uid, patient: i.patient || '', patientId: i.patientId || '', birth: i.birth || '', sex: i.sex || '', age: i.age || '',
      date: i.studyDate || '', time: i.studyTime || '', desc: i.studyDesc || '', institution: i.institution || '', accession: i.accession || '',
      series: [],
    };
    for (const se of st.series.values()) {
      const raw = splitSeries(se.frames);
      const stacks = [...raw, ...joinParts(raw)].map(buildStack);
      // biggest first so the main volume leads and stray reference images trail
      stacks.sort((a, b) => b.n - a.n || String(a.tag).localeCompare(String(b.tag), undefined, { numeric: true }) || a.idx - b.idx);
      const planes = new Set(stacks.map((s) => s.plane));
      stacks.forEach((s, k) => {
        s.id = `${se.uid}#${k}`;
        const bits = [];
        if (stacks.length > 1) {
          if (planes.size > 1 && s.plane) bits.push(PLANE_LABEL[s.plane]);
          if (s.tag) bits.push(s.tag);
          if (!bits.length) bits.push(`part ${k + 1}`);
        }
        s.label = bits.join(' · ');
        delete s.idx; delete s.tag;
      });
      const { studyUID, seriesUID, sop, patient, patientId, birth, sex, age, studyDate, studyTime, studyDesc, accession, ...rest } = se.info;
      study.series.push({ uid: se.uid, number: se.info.seriesNumber || 0, desc: se.info.seriesDesc || '', modality: se.info.modality, info: rest, stacks });
    }
    study.series.sort((a, b) => a.number - b.number || a.desc.localeCompare(b.desc));
    // Drop re-exports of data already listed (same series number, description and
    // slice positions under a different UID, e.g. a 3D Slicer export next to the originals).
    const sigs = new Set();
    for (const se of study.series) {
      se.stacks = se.stacks.filter((s) => {
        if (!s.first) return true;
        const sig = [se.number, se.desc, s.n, s.rows, s.cols, s.first.map((v) => v.toFixed(1))].join('|');
        if (sigs.has(sig)) return false;
        sigs.add(sig);
        return true;
      });
    }
    study.series = study.series.filter((se) => se.stacks.length);
    study.modalities = [...new Set(study.series.map((s) => s.modality))];
    out.push(study);
  }
  out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return out;
}
