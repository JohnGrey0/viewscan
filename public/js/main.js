// main.js — application shell: library sidebar, toolbar, view layout, 3D models panel.

import { Stack, pool, srcFor } from './loader.js';
import { organize, PLANE_LABEL } from './series.js';
import { Volume, vec, display } from './volume.js';
import { GLRenderer } from './glrender.js';
import { StackView, SliceView, View3D, fmtDate } from './views.js';
import { TARGETS, buildModels, exportSTL, exportOBJ, newSegWorker, labelVolume, gpuReady, brainAnswer, ownModels, OWN } from './segment.js';
import { saveFolder, removeFolder, loadFolders, updateSummaries, SUMMARY_FORMAT } from './localstore.js';
import { newFix, beginStroke, endStroke, brush, lasso, undo as undoFix, clearAll as clearFix, slicesMarked, saveFix, loadFix, fixStore } from './fixes.js';

const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const icon = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICONS = {
  tint: icon('<path d="M12 3.5c3.8 4.6 5.8 7.7 5.8 10.6a5.8 5.8 0 0 1-11.6 0c0-2.9 2-6 5.8-10.6z"/><path d="M9.3 14.6a2.8 2.8 0 0 0 2.4 2.5"/>'),
  scroll: icon('<rect x="5" y="3" width="14" height="5" rx="1"/><rect x="5" y="10" width="14" height="5" rx="1"/><path d="M12 17v4m-2.5-2 2.5 2 2.5-2"/>'),
  wl: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 7.5h7M12 12h8.5M12 16.5h7" />'),
  pan: icon('<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>'),
  zoom: icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 8v5M8 10.5h5"/>'),
  cross: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>'),
  length: icon('<path d="M4 20 20 4M4 20v-5M4 20h5M20 4v5M20 4h-5"/>'),
  angle: icon('<path d="M5 19h15M5 19 16 5M10.5 19a6.5 6.5 0 0 0-1.7-4.4"/>'),
  roi: icon('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'),
  reset: icon('<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/>'),
  invert: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>'),
  rotate: icon('<path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6"/>'),
  flip: icon('<path d="M12 3v18M9 7 4 12l5 5zM15 7l5 5-5 5z"/>'),
  play: icon('<path d="M7 4.5v15l12-7.5z"/>'),
  pause: icon('<path d="M8 5v14M16 5v14"/>'),
  shot: icon('<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7 10 4h4l1.5 3"/>'),
  trash: icon('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  fix: icon('<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M14.5 6l3 3"/>'),
  eye: icon('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
};

const CT_PRESETS = [['Brain', 40, 80], ['Subdural', 75, 215], ['Stroke', 35, 40], ['Soft tissue', 40, 400], ['Angio', 300, 600], ['Bone', 600, 2800], ['Lung', -600, 1500]];
const MAX_CACHE_BYTES = 1.4e9;

const app = {
  tool: 'cross', mode: '2d', layout: 1, // "Locate" where there are three planes; 2D falls back to Scroll
  studies: [], sources: new Map(), stacks: new Map(),
  views: [], active: null, selected: null,
  smooth: true, hideNames: false, showCross: true,
  mpr: { focus: [0, 0, 0], slab: 0, slabMode: 1 },
  r3d: { show: 'volume', mode: 'surface', iso: 300, color: [0.93, 0.89, 0.8] },
  cut: { axis: '', pos: 0.5 }, showOverlay: true,
  gl: null, volume: null, cine: 0, fps: 12,
  // the "Fix brain" tool: mode 1 = brain, 2 = not brain, 0 = rub out; size is the brush's width in mm
  fixState: { mode: 1, shape: 'brush', size: 8, path: null, view: null },
  /** The hand-made marks to draw on the slices; the T key hides them together with the model colors. */
  fixShown() { const f = this.volume && this.volume.stack.fix; return f && this.showOverlay ? f : null; },
  fixPaint(view, w0, w1, first) {
    const vol = this.volume, st = this.fixState;
    if (!vol) return;
    const fix = vol.stack.fix || (vol.stack.fix = newFix(vol));
    if (first && !this.showOverlay) toggleOverlay(); // painting with the colors off would be painting blind
    if (first) { beginStroke(fix); st.view = view; st.path = st.shape === 'lasso' ? [w1] : null; }
    if (!fix.stroke) return;
    if (st.path) { if (!first) st.path.push(w1); }
    else { brush(vol, fix, view.g, w0 || w1, w1, st.size / 2, st.mode); fix.version++; }
    this.redrawAll();
  },
  fixEnd(view) {
    const vol = this.volume, st = this.fixState, fix = vol && vol.stack.fix;
    if (!fix) return;
    if (st.path) { if (st.path.length > 2) lasso(vol, fix, view.g, st.path, st.mode); st.path = null; }
    endStroke(fix);
    fixChanged();
  },

  activate(v) {
    if (this.active === v) return;
    this.active?.el.classList.remove('active');
    this.active = v; v.el.classList.add('active');
    if (v.kind === 'stack') markActiveSeries();
    updateToolbar();
  },
  toggleMax(v) {
    const host = $('#views');
    const on = !v.el.classList.contains('max');
    for (const o of this.views) o.el.classList.remove('max');
    host.classList.toggle('maxed', on);
    if (on) v.el.classList.add('max');
  },
  redrawAll() { for (const v of this.views) v.invalidate(); },
  displayChanged() { this.redrawAll(); syncPreset(); },
  sliceChanged() {},
  emptyText() { return this.studies.length ? 'Pick a series on the left' : ''; },
  setFocus(p) {
    const vol = this.volume; if (!vol) return;
    // snap to slice centers along each view normal, and keep inside the volume
    let q = vec.sub(p, vol.center), out = [...vol.center];
    for (const g of Object.values(vol.views)) {
      const N = Math.max(1, Math.round(g.extent / g.step));
      const idx = Math.max(0, Math.min(N - 1, Math.round(vec.dot(q, g.n) / g.step + (N - 1) / 2)));
      out = vec.add(out, vec.mul(g.n, (idx - (N - 1) / 2) * g.step));
    }
    this.mpr.focus = out;
    this.redrawAll();
  },
  models() { return this.volume ? this.volume.stack.models : null; },
  /** The live MRI preview, while it is the thing to show on the slices. */
  previewLabels() { const p = this.volume && this.volume.stack.preview; return p && this.showOverlay && previewOn() ? p.labels : null; },
  labels() { const m = this.models(); return this.previewLabels() || (m && this.showOverlay ? m.labels : null); },
  labelColors() {
    if (this.previewLabels()) return new Float32Array([0.98, 0.3, 0.62, 0.5, 0.3, 0.62, 1, 0.3, ...new Array(24).fill(0)]); // brain pink, fluid blue
    const m = this.models();
    if (!m || !this.showOverlay) return null;
    const c = new Float32Array(32);
    for (const it of m.items) if (it.visible) c.set([...it.color, 0.42], it.bit * 4);
    return c;
  },
  meshItems() {
    const m = this.models();
    return m ? m.items.filter((it) => it.visible && it.mesh).map((it) => ({ mesh: it.mesh, color: it.color, opacity: it.opacity })) : [];
  },
  clipPlane() {
    const vol = this.volume;
    if (this.cut.follow && vol) {
      // The cut follows the slice last scrolled through; what is above (in front of, left of) it is cut away.
      // The side is fixed: flipping it to face the viewer was tried, and the owner found the model
      // jumping or vanishing while he turned it.
      const plane = this.cut.plane || 'AX', g = vol.views[plane], want = { AX: [0, 0, 1], COR: [0, -1, 0], SAG: [1, 0, 0] }[plane];
      const n = vec.mul(g.n, Math.sign(vec.dot(g.n, want)) || 1);
      return [...n, vec.dot(this.mpr.focus, n)];
    }
    if (!this.cut.axis || !vol) return null;
    const n = { S: [0, 0, 1], A: [0, -1, 0], L: [1, 0, 0] }[this.cut.axis];
    const half = vol.extentAlong(n) / 2;
    return [...n, vec.dot(vol.center, n) + half * (1 - 2 * this.cut.pos)];
  },
};
window.viewscan = app;
// can this computer run the AI brain models? (asked once; the panel is refreshed when the answer is in)
gpuReady().then((ok) => { app.gpuOK = ok; showMethod(); });
// models trained at home get their own group at the top of the list, and versions in the compare grid
ownModels().then((list) => {
  if (!list.length) return;
  const group = h('optgroup', { label: 'Your own models (trained on this computer)' });
  for (const m of list) {
    group.append(h('option', { value: m.key }, m.name));
    MODEL_SHORT[m.key] = m.name;
    MODEL_WHY[m.key] = m.why || 'Trained at home with viewscan-train.';
    if (m.inputs > 1) AI_VARIANTS.unshift(aiVariant(m.key, {}, 'crisp', 0.7), aiVariant(m.key, {}, 'clean'), aiVariant(m.key, { level: 2 }, 'crisp', 0.7), aiVariant(m.key, {}, 'smooth', 0.7));
    else AI_VARIANTS.unshift(aiVariant(m.key, { study: 1 }, 'crisp', 0.7), aiVariant(m.key, { study: 1 }, 'clean'), aiVariant(m.key, { study: 1, level: 2 }, 'crisp', 0.7), aiVariant(m.key, { study: 1 }, 'smooth', 0.7), aiVariant(m.key, {}, 'crisp', 0.7), aiVariant(m.key, {}, 'clean'), aiVariant(m.key, { level: 2 }, 'crisp', 0.7), aiVariant(m.key, { level: -2 }, 'crisp', 0.7), aiVariant(m.key, {}, 'smooth', 0.7));
    OWN_KEYS.push(m.key);
  }
  $('#m-model').insertBefore(group, $('#m-model').children[1]);
  const stack = app.volume?.stack;
  if (stack) loadMethod(stack); else showMethod();
});
app.api = { openStack: (...a) => openStack(...a), setMode: (m) => setMode(m) }; // for tests and the console

// ------------------------------------------------------------ library ------
async function loadLibrary(rescan = false) {
  const splash = $('#splash');
  splash.classList.remove('hidden');
  for (let first = true; ; first = false) {
    let res;
    try { res = await (await fetch('/api/library' + (rescan && first ? '?rescan=1' : ''))).json(); }
    catch { $('#splash-text').textContent = 'Cannot reach the Viewscan server. Is it still running?'; await sleep(1500); continue; }
    if (res.status === 'ready') {
      app.sources.set('server', { type: 'server' });
      // projects taken off the list with "Remove" stay on disk; they are only left out here
      const hidden = hiddenProjects();
      app.removed = [...new Set(res.studies.map((s) => s.project))].filter((p) => hidden.includes(p));
      app.studies = app.studies.filter((s) => s.source !== 'server').concat(res.studies.filter((s) => !hidden.includes(s.project)).map((s) => ({ ...s, source: 'server' })));
      if (!projects().includes(app.project)) app.project = projects()[0];
      break;
    }
    if (res.status === 'error') { $('#splash-text').textContent = 'Could not read the scan folders: ' + res.error; return; }
    $('#splash-text').textContent = res.total ? `Reading scan files… ${res.scanned} / ${res.total}` : 'Looking for scans…';
    await sleep(400);
  }
  splash.classList.add('hidden');
  app.libraryLoaded = true;
  renderLibrary();
  if (!app.volume && !app.views.some((v) => v.stack)) openDefault();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stackKey(study, stackDesc) { return `${study.source}|${stackDesc.id}`; }
function getStack(study, series, desc) {
  const key = stackKey(study, desc);
  let s = app.stacks.get(key);
  if (!s) {
    s = new Stack(desc, series, study, app.sources.get(study.source));
    s.key = key;
    app.stacks.set(key, s);
  }
  s.lastUsed = performance.now();
  evict();
  return s;
}
function evict() {
  const inUse = new Set(app.views.map((v) => v.stack).filter(Boolean));
  if (app.volume) inUse.add(app.volume.stack);
  let total = 0;
  for (const s of app.stacks.values()) total += s.bytes;
  const old = [...app.stacks.values()].filter((s) => !inUse.has(s) && s.bytes && !s.pinned).sort((a, b) => a.lastUsed - b.lastUsed);
  while (total > MAX_CACHE_BYTES && old.length) {
    const s = old.shift();
    total -= s.bytes;
    pool.cancel((t) => t.stack === s.uid);
    app.stacks.delete(s.key);
  }
}

function describe(series, st) {
  const bits = [`${st.n} image${st.n > 1 ? 's' : ''}`];
  if (st.step) bits.push(`${+st.step.toFixed(2)} mm`);
  else if (st.thick) bits.push(`${+st.thick.toFixed(2)} mm`);
  return bits.join(' · ');
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('viewscan.' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('viewscan.' + k, v); } catch { /* private mode */ } },
};
const thumbs = new Map(); // stack key -> canvas, so re-sorting does not redraw thumbnails

/** Names of the server's scan folders this browser was told to leave off the list. */
function hiddenProjects() { try { const v = JSON.parse(store.get('hidden', '[]')); return Array.isArray(v) ? v : []; } catch { return []; } }
const BRING_BACK = '::bring-back::';
function projects() { return [...new Set(app.studies.map((s) => s.project))]; }
function currentStudies() { return app.studies.filter((s) => s.project === app.project); }
function setProject(name, open = true) {
  const list = projects();
  app.project = list.includes(name) ? name : list[0];
  store.set('project', app.project || '');
  renderLibrary();
  if (open && app.project) openDefault();
}

const SORTS = {
  scan: (a, b) => a.series.number - b.series.number || a.order - b.order,
  '3d': (a, b) => (b.st.volume ? 1 : 0) - (a.st.volume ? 1 : 0) || b.st.n - a.st.n || a.order - b.order,
  count: (a, b) => b.st.n - a.st.n || a.order - b.order,
  name: (a, b) => (a.series.desc || '').localeCompare(b.series.desc || '', undefined, { numeric: true }) || a.order - b.order,
  plane: (a, b) => (a.st.plane || 'ZZ').localeCompare(b.st.plane || 'ZZ') || a.order - b.order,
};

function renderLibrary() {
  const lib = $('#library');
  lib.textContent = '';
  const sel = $('#project');
  sel.textContent = '';
  const list = projects();
  if (!list.includes(app.project)) app.project = list[0];
  for (const p of list) {
    const n = app.studies.filter((s) => s.project === p).reduce((k, s) => k + s.series.reduce((m, se) => m + se.stacks.length, 0), 0);
    sel.append(h('option', { value: p, selected: p === app.project ? '' : null }, `${p}  (${n})`));
  }
  if (!list.length) sel.append(h('option', { value: '', selected: '', disabled: '' }, 'No projects'));
  for (const p of app.removed || []) sel.append(h('option', { value: BRING_BACK + p }, `Bring back “${p}”`));
  $('#btn-forget').hidden = !list.length;
  if (!app.studies.length) {
    lib.append(h('div', { class: 'side-note' }, 'No scans found yet. Put a folder of DICOM files inside the viewscan folder, or use “Open folder…”.'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); drawThumb(e.target); }
  }, { root: lib, rootMargin: '300px' });
  const sort = SORTS[app.sort] || SORTS.scan;
  const wide = parseInt(getComputedStyle($('#app')).getPropertyValue('--side'), 10) >= 340;
  let shown = 0;
  for (const study of currentStudies()) {
    const who = app.hideNames ? 'Patient' : (study.patient || 'Unknown patient');
    lib.append(h('div', { class: 'study-head' },
      h('div', { class: 'name' }, study.desc || 'Study'),
      h('div', { class: 'sub' }, [fmtDate(study.date), who].filter(Boolean).join(' · '))));
    const items = [];
    for (const series of study.series) for (const st of series.stacks) items.push({ series, st, order: items.length });
    for (const { series, st } of items.filter((it) => !app.only3d || it.st.volume).sort(sort)) {
      const key = stackKey(study, st);
      let cv = thumbs.get(key);
      const fresh = !cv;
      if (fresh) { cv = h('canvas', { width: 96, height: 96 }); thumbs.set(key, cv); }
      cv._ref = { study, series, st };
      const title = series.desc || `Series ${series.number}`;
      const sub = [st.label, describe(series, st)].filter(Boolean).join(' · ');
      const row = h('div', { class: `series${wide ? ' wide' : ''}`, title: `${title}\n${sub}\nClick to open. Drag onto a panel to compare.`, draggable: 'true',
        onclick: () => openStack(study, series, st),
        ondragstart: (e) => { e.dataTransfer.setData('text/viewscan', key); app.dragRef = { study, series, st }; } },
        cv,
        h('div', {},
          h('div', { class: 't' }, title),
          h('div', { class: 'm' }, sub),
          h('div', { class: 'badges' },
            h('span', { class: `badge ${series.modality}` }, series.modality),
            st.plane && h('span', { class: `badge ${st.plane}` }, PLANE_LABEL[st.plane]),
            st.volume && h('span', { class: 'badge vol', title: 'Can be opened in 3D' }, '3D'),
            st.combined && h('span', { class: 'badge combined', title: 'Made here by combining scans taken in different planes. Kept until the page is reloaded.' }, 'Combined'))));
      row.dataset.key = key;
      lib.append(row);
      if (fresh) io.observe(cv);
      shown++;
    }
  }
  if (!shown) lib.append(h('div', { class: 'side-note' }, 'Nothing here can be opened in 3D. Untick “3D only” to see every series.'));
  markActiveSeries();
}

async function drawThumb(cv) {
  const { study, st } = cv._ref;
  const ref = st.frames[st.n >> 1];
  try {
    // a combined scan lives in memory only; everything else is read from its file
    const f = st.combined ? app.stacks.get(stackKey(study, st))?.frames[st.n >> 1]
      : (await pool.run({ type: 'frames', src: srcFor(app.sources.get(study.source), ref.file), frames: [ref.frame] }, 8)).frames[0];
    if (!f || f.error) return;
    const tmp = document.createElement('canvas');
    tmp.width = f.cols; tmp.height = f.rows;
    const tctx = tmp.getContext('2d'), img = tctx.createImageData(f.cols, f.rows);
    if (f.color) img.data.set(f.data);
    else {
      let wc = f.wc, ww = f.ww;
      if (!(ww > 0)) { wc = (f.min + f.max) / 2; ww = Math.max(1, f.max - f.min); }
      const out = new Uint32Array(img.data.buffer), lo = wc - ww / 2, k = 255 / ww;
      for (let i = 0; i < f.data.length; i++) {
        let g = (f.data[i] - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        if (f.invert) g = 255 - g;
        out[i] = 0xff000000 | (g << 16) | (g << 8) | g;
      }
    }
    tctx.putImageData(img, 0, 0);
    const ctx = cv.getContext('2d');
    const ps = f.ps || [1, 1], wmm = f.cols * ps[1], hmm = f.rows * ps[0], s = 96 / Math.max(wmm, hmm);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, (96 - wmm * s) / 2, (96 - hmm * s) / 2, wmm * s, hmm * s);
  } catch { /* thumbnail is optional */ }
}

function markActiveSeries() {
  const cur = app.mode === '3d' ? app.volume?.stack : app.active?.stack;
  for (const row of document.querySelectorAll('.series')) row.classList.toggle('active', !!cur && row.dataset.key === cur.key);
  const st = cur?.study;
  $('#study-title').innerHTML = st ? `<b>${escapeHtml(st.desc || 'Study')}</b> · ${escapeHtml(fmtDate(st.date))}${st.institution ? ' · ' + escapeHtml(st.institution) : ''}` : '';
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function openDefault() {
  // open the most useful series first: the largest volume in the current project
  let best = null;
  const last = store.get('last.' + app.project, '');
  for (const study of currentStudies()) for (const series of study.series) for (const st of series.stacks) {
    const score = (st.id === last ? 1e7 : 0) + (st.volume ? 1e6 : 0) + (st.plane === 'AX' ? 5e5 : 0) + st.n;
    if (!best || score > best.score) best = { score, study, series, st };
  }
  if (!best) return;
  // start in "3D & models" whenever the series can be rebuilt as a volume
  if (best.st.volume && app.mode === '2d') {
    try {
      app.gl = app.gl || new GLRenderer();
      stopCine();
      app.mode = '3d';
      applyMode();
    } catch { /* no WebGL2: stay in 2D */ }
  }
  openStack(best.study, best.series, best.st);
}

function openStack(study, series, st, view) {
  const stack = getStack(study, series, st);
  app.currentRef = { study, series, st };
  store.set('last.' + study.project, st.id);
  if (study.project !== app.project) { app.project = study.project; store.set('project', app.project); renderLibrary(); } // opened from another project
  if (app.mode === '3d') {
    if (!st.volume) { setMode('2d'); return openStack(study, series, st); }
    return open3D(stack);
  }
  const v = view || (app.active && app.active.kind === 'stack' ? app.active : app.views[0]);
  v.setStack(stack);
  app.activate(v);
  markActiveSeries(); updateToolbar(); syncPreset();
}

// -------------------------------------------------------------- layout -----
function buildViews() {
  const host = $('#views');
  const keep = app.mode === '2d' ? app.views.filter((v) => v.kind === 'stack').map((v) => v.stack) : [];
  for (const v of app.views) v.destroy();
  app.views = []; app.active = null;
  host.classList.remove('maxed');
  if (app.mode === '2d') {
    host.className = `g${app.layout}`;
    for (let i = 0; i < app.layout; i++) {
      const v = new StackView(app, host);
      v.el.addEventListener('dragover', (e) => e.preventDefault());
      v.el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); const r = app.dragRef; if (r) openStack(r.study, r.series, r.st, v); });
      app.views.push(v);
    }
    app.views.forEach((v, i) => { if (keep[i]) v.setStack(keep[i]); else v.invalidate(); });
  } else {
    host.className = 'g4';
    app.views.push(new SliceView(app, host, 'AX'), new View3D(app, host), new SliceView(app, host, 'COR'), new SliceView(app, host, 'SAG'));
  }
  app.activate(app.views[0]);
}

function setMode(mode) {
  if (mode === app.mode) return;
  const cur = app.mode === '2d' ? app.active?.stack : app.volume?.stack;
  if (mode === '3d') {
    let target = cur && cur.desc.volume ? cur : null;
    if (!target) {
      // current series is not a volume: use the best volume of the same study
      let best = null;
      for (const study of cur ? [cur.study] : currentStudies()) for (const series of study.series) for (const st of series.stacks) if (st.volume && (!best || st.n > best.st.n)) best = { study, series, st };
      if (!best) return toast('This scan has no series that can be rebuilt in 3D.');
      target = getStack(best.study, best.series, best.st);
    }
    try { app.gl = app.gl || new GLRenderer(); } catch (err) { return toast(err.message); }
    stopCine();
    app.mode = '3d';
    applyMode();
    open3D(target);
  } else {
    stopCine();
    app.mode = '2d';
    const stack = app.volume?.stack;
    app.volume = null;
    applyMode();
    if (stack) { app.views[0].setStack(stack); }
  }
}
function applyMode() {
  $('#app').className = `mode-${app.mode}`;
  for (const b of document.querySelectorAll('#mode-switch button')) b.classList.toggle('on', b.dataset.mode === app.mode);
  if (app.mode === '3d' && !['scroll', 'wl', 'pan', 'zoom', 'cross', 'length', 'angle', 'roi', 'fix'].includes(app.tool)) app.tool = 'cross';
  if (app.mode !== '3d' && (app.tool === 'cross' || app.tool === 'fix')) app.tool = 'scroll';
  else if (app.mode === '3d' && app.tool === 'scroll' && !app.toolPicked) app.tool = 'cross';
  buildViews(); buildToolbar(); markActiveSeries();
}

async function open3D(stack) {
  const token = (app.open3dToken = {});
  for (const v of app.views) { v.setVolume?.(null); v.setMsg(''); }
  const first = app.views[0];
  const upd = () => first.setMsg(`Loading ${stack.title}… ${stack.loaded} / ${stack.n}`);
  upd();
  const off = stack.on(upd);
  await stack.load(stack.n >> 1, 0);
  off();
  if (app.open3dToken !== token || app.mode !== '3d') return;
  if (stack.loaded < stack.n) return; // loading was canceled (its folder was removed or replaced)
  if (stack.failed) { first.setMsg(`${stack.failed} image(s) of this series could not be read, so it cannot be rebuilt in 3D.`); return; }
  first.setMsg('');
  stack.volume = stack.volume || new Volume(stack);
  const vol = stack.volume;
  if (!app.gl.supports(vol)) { first.setMsg('This volume is too large for the graphics card.'); return; }
  app.volume = vol;
  app.mpr.focus = [...vol.center];
  for (const v of app.views) v.setVolume(vol);
  app.setFocus(vol.center);
  setup3DPanel();
  markActiveSeries(); updateToolbar(); syncPreset();
  // marks made by hand on an earlier visit come back with the series
  if (!stack.fix && !stack.fixAsked) {
    stack.fixAsked = true;
    fixStore.server = app.sources.has('server');
    loadFix(stack, vol).then((fix) => { if (fix && !stack.fix) { stack.fix = fix; if (app.volume === vol) { showFix(); app.redrawAll(); } } }).catch(() => {});
  }
  showFix();
}

// ------------------------------------------------------------- toolbar -----
function buildToolbar() {
  const bar = $('#toolbar');
  bar.textContent = '';
  const tool = (id, label, title, key) => {
    const b = h('button', { class: 'tool', 'data-tool': id, title: `${title}${key ? ` (${key})` : ''}`, onclick: () => setTool(id) });
    b.innerHTML = `${ICONS[id]}<span>${label}</span>`;
    return b;
  };
  const act = (id, label, title, fn) => {
    const b = h('button', { class: 'tool', 'data-act': id, title, onclick: fn });
    b.innerHTML = `${ICONS[id]}<span>${label}</span>`;
    return b;
  };
  const sep = () => h('div', { class: 'sep' });
  const is3 = app.mode === '3d';
  const put = (...kids) => bar.append(...kids.filter(Boolean));
  put(
    tool('scroll', 'Scroll', 'Drag up/down to move through the slices. The mouse wheel always does this.', 'S'),
    tool('wl', 'Contrast', 'Drag to change brightness and contrast (window / level)', 'W'),
    tool('pan', 'Move', 'Drag to move the picture. Middle mouse button also does this.', 'M'),
    tool('zoom', 'Zoom', 'Drag up/down to zoom. Right mouse button or Ctrl+wheel also zoom.', 'Z'),
    is3 && tool('cross', 'Locate', 'Click a spot to see it in all three planes', 'C'),
    sep(),
    tool('length', 'Length', 'Drag to measure a distance', 'L'),
    tool('angle', 'Angle', 'Drag the first line, then click to place the second', 'A'),
    tool('roi', 'Area', 'Drag an oval to get the average value inside it', 'O'),
    act('trash', 'Clear', 'Remove all measurements from this series', clearAnnots),
    sep());
  const preset = h('select', { id: 'preset', title: 'Brightness / contrast presets', onchange: (e) => applyPreset(e.target.value) });
  bar.append(h('label', {}, 'Look', preset));
  bar.append(act('invert', 'Invert', 'Swap black and white (I)', invert));
  if (!is3) {
    bar.append(act('rotate', 'Rotate', 'Rotate a quarter turn', () => withStackView((v) => { v.rot = (v.rot + 1) % 4; v.fit(); v.invalidate(); })),
      act('flip', 'Flip', 'Mirror left ↔ right', () => withStackView((v) => { v.flip = !v.flip; v.invalidate(); })));
  }
  const lol = act('flip', 'Left on left', 'Hospitals draw top-down and front pictures as if facing the patient, so the patient’s left is on the right of the screen (see the L and R letters). Switch this on to mirror them, so left is on the left.', () => setLeftOnLeft(!display.leftOnLeft));
  lol.id = 'btn-lol';
  bar.append(lol);
  bar.append(act('reset', 'Reset', 'Back to the starting view (R)', resetView), sep());
  const playBtn = act('play', 'Play', 'Play through the slices like a film (Space)', toggleCine);
  playBtn.id = 'btn-play';
  bar.append(playBtn);
  if (is3) {
    const slab = h('select', { title: 'Thick slab: blends several millimeters into one picture. MIP makes blood vessels stand out.',
      onchange: (e) => { app.mpr.slab = Number(e.target.value); app.redrawAll(); } },
      ...[[0, 'Thin slice'], [5, '5 mm'], [10, '10 mm'], [20, '20 mm'], [40, '40 mm']].map(([v, t]) => h('option', { value: v, selected: v === app.mpr.slab || null }, t)));
    const mode = h('select', { title: 'How the slab is blended', onchange: (e) => { app.mpr.slabMode = Number(e.target.value); app.redrawAll(); } },
      ...[[1, 'Brightest (MIP)'], [0, 'Average'], [2, 'Darkest']].map(([v, t]) => h('option', { value: v, selected: v === app.mpr.slabMode || null }, t)));
    bar.append(sep(), h('label', {}, 'Slab', slab, mode));
  } else {
    const lay = h('div', { class: 'seg', title: 'How many series to show side by side' },
      ...[1, 2, 4].map((n) => h('button', { class: n === app.layout ? 'on' : '', onclick: () => { app.layout = n; buildViews(); buildToolbar(); markActiveSeries(); } }, n === 1 ? '1 panel' : `${n}`)));
    bar.append(sep(), lay);
  }
  if (is3) {
    const tint = act('tint', 'Colors', 'Show or hide the colors on the slices (the pink brain and the other models), to see the scan itself (T)', toggleOverlay);
    tint.id = 'btn-tint';
    bar.append(sep(), tint);
    bar.append(tool('fix', 'Fix brain', 'Paint on the slices where the brain is colored in wrongly, then update the 3D model', 'F'));
  }
  bar.append(sep(), act('shot', 'Save picture', 'Save the selected panel as a PNG image', screenshot));
  updateToolbar();
  syncPreset();
}
/** "Left on left": mirror the top-down and front pictures (hospitals show the patient's left on the right). */
function setLeftOnLeft(on) {
  if (display.leftOnLeft === on) return;
  display.leftOnLeft = on;
  store.set('leftonleft', on ? '1' : '');
  for (const s of app.stacks.values()) {
    if (s.volume) s.volume.views = s.volume.assignViews();
    for (const a of s.annots) if (a.space === 'AX' || a.space === 'COR') for (const p of a.pts) p[0] = -p[0]; // measurements stay on their spot
  }
  if (app.volume) { const focus = [...app.mpr.focus]; for (const v of app.views) if (v.kind === 'slice') v.setVolume(app.volume); app.setFocus(focus); }
  updateToolbar(); app.redrawAll();
}
function setTool(id) { app.tool = id; app.toolPicked = true; updateToolbar(); app.redrawAll(); }
function toggleOverlay() {
  app.showOverlay = !app.showOverlay;
  store.set('overlay', app.showOverlay ? '1' : '');
  $('#show-overlay').checked = app.showOverlay;
  updateToolbar();
  app.redrawAll();
}
function updateToolbar() {
  $('#btn-lol')?.classList.toggle('toggled', display.leftOnLeft);
  const fixing = app.mode === '3d' && app.tool === 'fix';
  $('#fix-panel').hidden = !fixing;
  $('#app').classList.toggle('tool-fix', fixing);
  if (fixing) showFix();
  const tint = $('#btn-tint');
  if (tint) { tint.classList.toggle('toggled', app.showOverlay); tint.querySelector('span').textContent = app.showOverlay ? 'Colors on' : 'Colors off'; }
  for (const b of document.querySelectorAll('#toolbar [data-tool]')) b.classList.toggle('on', b.dataset.tool === app.tool);
  const play = $('#btn-play');
  if (play) { play.innerHTML = `${app.cine ? ICONS.pause : ICONS.play}<span>${app.cine ? 'Pause' : 'Play'}</span>`; play.classList.toggle('toggled', !!app.cine); }
}
// ---- marks made by hand ("Fix brain"; fixes.js) ----
let fixSaveTimer = 0;
function showFix() {
  const st = app.fixState, stack = app.volume?.stack, fix = stack?.fix;
  for (const b of document.querySelectorAll('#fix-mode button')) b.classList.toggle('on', Number(b.dataset.v) === st.mode);
  for (const b of document.querySelectorAll('#fix-shape button')) b.classList.toggle('on', b.dataset.v === st.shape);
  $('#fix-size').value = st.size; $('#fix-size-out').textContent = `${st.size} mm`;
  $('#fix-size-row').style.display = st.shape === 'brush' ? '' : 'none';
  $('#fix-undo').disabled = !(fix && fix.undo.length);
  $('#fix-clear').disabled = !(fix && fix.count);
  const box = $('#fix-status');
  const n = fix && fix.count ? slicesMarked(fix) : 0;
  const todo = !!fix && fix.version !== fix.built && (fix.count > 0 || fix.built > 0) && !!stack.models;
  box.classList.toggle('todo', todo);
  box.textContent = !fix || (!fix.count && !fix.undo.length) ? 'No marks on this series yet.'
    : `${n ? `Marks on ${n} slice${n === 1 ? '' : 's'}` : 'No marks left'}${fix.saved ? ` · saved ${fix.where === 'browser' ? 'in this browser' : 'on this computer'}` : ''}.`
      + (todo ? ' The 3D model does not have your latest marks yet.' : stack.models && fix.built === fix.version && n ? ' They are in the 3D model.' : '');
}
function fixChanged() {
  const vol = app.volume;
  if (!vol) return;
  const stack = vol.stack, fix = stack.fix;
  showFix(); app.redrawAll();
  clearTimeout(fixSaveTimer);
  fixStore.server = app.sources.has('server');
  if (fix && !fix.saved) fixSaveTimer = setTimeout(() => {
    saveFix(stack, vol, fix).then((where) => { fix.where = where; if (app.volume === vol) showFix(); })
      .catch((err) => { if (app.volume === vol) $('#fix-status').textContent = 'Your marks could not be saved: ' + err.message; });
  }, 900);
}
function initFix() {
  const st = app.fixState;
  for (const b of document.querySelectorAll('#fix-mode button')) b.onclick = () => { st.mode = Number(b.dataset.v); showFix(); app.redrawAll(); };
  for (const b of document.querySelectorAll('#fix-shape button')) b.onclick = () => { st.shape = b.dataset.v; showFix(); app.redrawAll(); };
  $('#fix-size').oninput = (e) => { st.size = Number(e.target.value); showFix(); app.redrawAll(); };
  $('#fix-undo').onclick = fixUndo;
  $('#fix-clear').onclick = () => { const fix = app.volume?.stack.fix; if (fix && fix.count) { clearFix(fix); fixChanged(); } };
  $('#fix-build').onclick = () => build();
}
function fixUndo() { const fix = app.volume?.stack.fix; if (fix && undoFix(fix)) fixChanged(); }
function fixSize(by) { const st = app.fixState; st.size = Math.max(1, Math.min(40, st.size + by)); showFix(); app.redrawAll(); }

function currentStack() { return app.mode === '3d' ? app.volume?.stack : (app.active?.stack || app.views.find((v) => v.stack)?.stack); }
function withStackView(fn) { const v = app.active && app.active.kind === 'stack' ? app.active : null; if (v && v.stack) fn(v); }

function syncPreset() {
  const sel = $('#preset'); if (!sel) return;
  const s = currentStack();
  const isCT = s && s.unit === 'HU';
  const opts = [['default', 'As scanned'], ['auto', 'Auto'], ...(isCT ? CT_PRESETS.map((p) => [p[0], p[0]]) : [['full', 'Full range']])];
  const sig = opts.map((o) => o[0]).join();
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig; sel.textContent = '';
    sel.append(h('option', { value: '', disabled: '', hidden: '' }, 'Custom'));
    for (const [v, t] of opts) sel.append(h('option', { value: v }, t));
  }
  let match = '';
  if (s && s.display) {
    const d = s.display, dd = s.defaultDisplay;
    if (dd && d.wc === dd.wc && d.ww === dd.ww) match = 'default';
    for (const p of CT_PRESETS) if (isCT && d.wc === p[1] && d.ww === p[2]) match = p[0];
  }
  sel.value = match;
}
function applyPreset(name) {
  const s = currentStack(); if (!s || !s.display) return;
  const d = s.display;
  if (name === 'default') Object.assign(d, { wc: s.defaultDisplay.wc, ww: s.defaultDisplay.ww });
  else if (name === 'full') Object.assign(d, { wc: (s.min + s.max) / 2, ww: Math.max(1, s.max - s.min) });
  else if (name === 'auto') {
    const idx = app.mode === '2d' && app.active?.stack === s ? app.active.index : s.n >> 1;
    const f = s.frames[s.nearestLoaded(idx)]; if (!f || !f.data) return;
    const smp = []; for (let i = 0; i < f.data.length; i += 13) smp.push(f.data[i]);
    smp.sort((a, b) => a - b);
    const body = smp.filter((v) => v > smp[0] + (smp[smp.length - 1] - smp[0]) * 0.02);
    const src = body.length > 100 ? body : smp;
    const lo = src[Math.floor(src.length * 0.02)], hi = src[Math.floor(src.length * 0.98)];
    Object.assign(d, { wc: (lo + hi) / 2, ww: Math.max(1, hi - lo) });
  } else { const p = CT_PRESETS.find((x) => x[0] === name); if (p) Object.assign(d, { wc: p[1], ww: p[2] }); }
  d.provisional = false;
  app.displayChanged();
}
function invert() { const s = currentStack(); if (s?.display) { s.display.invert = !s.display.invert; app.redrawAll(); } }
function resetView() {
  const s = currentStack();
  if (s?.defaultDisplay) Object.assign(s.display, s.defaultDisplay);
  if (app.mode === '3d') { for (const v of app.views) v.reset?.(); if (app.volume) app.setFocus(app.volume.center); }
  else if (app.active) app.active.reset?.();
  app.displayChanged();
}
function clearAnnots() { const s = currentStack(); if (s) { s.annots.length = 0; app.selected = null; app.redrawAll(); } }
function toggleCine() { if (app.cine) stopCine(); else startCine(); }
function startCine() {
  const v = app.active && app.active.kind !== '3d' ? app.active : app.views[0];
  if (!v) return;
  app.cine = setInterval(() => {
    if (v.kind === 'stack') v.scroll(1, true);
    else if (v.vol) { const i = v.sliceIndex(); v.scroll(i >= v.count() - 1 ? -i : 1); }
  }, 1000 / app.fps);
  updateToolbar();
}
function stopCine() { clearInterval(app.cine); app.cine = 0; updateToolbar(); }
function screenshot() {
  const v = app.active; if (!v) return;
  v.draw();
  v.canvas.toBlob((blob) => download(blob, `viewscan-${Date.now()}.png`));
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
let toastTimer = 0;
function toast(text) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', class: 'view-msg', style: 'position:fixed;top:auto;bottom:24px;z-index:40' }); document.body.append(t); }
  t.textContent = text; t.style.display = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4500);
}

// ------------------------------------------------------- 3D / models UI ----
const hex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const unhex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);

function setup3DPanel() {
  const vol = app.volume, s = vol.stack, isCT = s.unit === 'HU';
  // surface level slider
  const iso = $('#r3-iso');
  const lo = isCT ? -900 : s.min, hi = isCT ? 2000 : s.max;
  iso.min = lo; iso.max = hi; iso.step = isCT ? 10 : Math.max(1, Math.round((hi - lo) / 400));
  if (!s.r3iso) s.r3iso = isCT ? 300 : Math.round(s.min + (s.max - s.min) * 0.2);
  app.r3d.iso = s.r3iso; iso.value = s.r3iso; $('#r3-iso-out').textContent = Math.round(s.r3iso);
  const presets = $('#r3-presets'); presets.textContent = '';
  const ps = isCT ? [['Bone', 300, [0.93, 0.89, 0.8]], ['Skin', -300, [0.89, 0.72, 0.62]], ['Vessels + bone', 180, [0.95, 0.82, 0.78]]]
    : [['Head', s.min + (s.max - s.min) * 0.1, [0.89, 0.72, 0.62]], ['Bright tissue', s.min + (s.max - s.min) * 0.35, [0.9, 0.86, 0.8]]];
  for (const [name, v, col] of ps) presets.append(h('button', { onclick: () => { app.r3d.color = col; setIso(v); setR3('mode', 'surface'); setR3('show', 'volume'); } }, name));
  // targets
  const tg = $('#targets'); tg.textContent = '';
  const avail = TARGETS.filter((t) => t.modalities.includes(isCT ? 'CT' : 'MR'));
  for (const t of avail) {
    const solidOk = t.key === 'brain' || t.key === 'bone';
    const solidTip = t.key === 'brain'
      ? 'Fill the hollow chambers deep inside the brain so it prints as one solid piece. The folds on the outside stay as they are.'
      : 'Fill the space inside the skull so it prints as a solid head shape. Leave this off to keep the empty cavity.';
    tg.append(h('div', { class: 'target' },
      h('label', { class: 'pick' },
        h('input', { type: 'checkbox', 'data-target': t.key, checked: t.default ? '' : null }),
        h('span', { class: 'sw', style: `background:${hex(t.color)}` }),
        h('span', {}, t.name, h('small', {}, isCT ? t.hint : (t.hintMR || t.hint)))),
      solidOk && h('label', { class: 'solid', title: solidTip },
        h('input', { type: 'checkbox', 'data-solid': t.key, checked: solidPrefs()[t.key] ? '' : null,
          onchange: (e) => { const p = solidPrefs(); p[t.key] = e.target.checked; store.set('solid', JSON.stringify(p)); } }),
        'Solid inside')));
  }
  $('#bone-row').style.display = isCT ? '' : 'none';
  showMethod();
  $('#btn-compare').style.display = isCT ? 'none' : '';
  if (!isCT) loadMr(s);
  requestPreview();
  setupCombine();
  const gap = vol.spacing[2];
  $('#models-hint').textContent = isCT
    ? 'Finds each part automatically and turns it into a 3D model you can spin around and save for 3D printing.'
    : gap > 2.5
      ? `The slices of this series are ${+gap.toFixed(1)} mm apart, so the shape between them is estimated and fine folds are lost. Check the result on the slices; “Fine-tune the MRI brain” below shows the result on the slices as you adjust it.`
      : 'MRI has no fixed brightness scale, so parts are found by shape. Results are approximate — check them on the slices.';
  renderModels();
  setR3('show', s.models && s.models.items.some((i) => i.mesh) ? 'models' : 'volume');
}
function setIso(v) {
  app.r3d.iso = Number(v); if (app.volume) app.volume.stack.r3iso = app.r3d.iso;
  $('#r3-iso').value = v; $('#r3-iso-out').textContent = Math.round(v);
  app.redrawAll();
}
function setR3(key, v) {
  app.r3d[key] = v;
  for (const b of document.querySelectorAll(`#r3-${key} button`)) b.classList.toggle('on', b.dataset.v === v);
  $('#r3-volume').style.display = app.r3d.show === 'volume' ? '' : 'none';
  $('#r3-iso-row').style.display = app.r3d.mode === 'surface' ? '' : 'none';
  $('#r3-presets').style.display = app.r3d.mode === 'surface' ? '' : 'none';
  app.redrawAll();
}

function renderModels() {
  const box = $('#models'); box.textContent = '';
  const m = app.models();
  $('#model-opts').classList.toggle('on', !!(m && m.items.length));
  if (!m) return;
  for (const it of m.items) {
    const stats = it.mesh
      ? `${it.volumeMl >= 10 ? Math.round(it.volumeMl) : it.volumeMl.toFixed(1)} mL · ${(it.mesh.indices.length / 3000).toFixed(0)}k triangles${it.reducedFrom ? ` (from ${(it.reducedFrom / 1000).toFixed(0)}k)` : ''}`
      : (it.note || 'Nothing found');
    const tag = it.solid ? ' · solid inside' : '';
    box.append(h('div', { class: 'model' },
      h('div', { class: 'head' },
        h('input', { type: 'checkbox', checked: it.visible ? '' : null, title: 'Show / hide', onchange: (e) => { it.visible = e.target.checked; app.redrawAll(); } }),
        h('input', { type: 'color', value: hex(it.color), title: 'Color', oninput: (e) => { it.color = unhex(e.target.value); app.redrawAll(); } }),
        it.name),
      h('div', { class: 'stats' }, stats + (it.mesh ? tag : '')),
      it.how && h('div', { class: 'how ' + it.how.kind, title: it.how.title }, h('b', {}, it.how.kind === 'own' ? 'Home-trained model' : it.how.kind === 'ai' ? 'AI model' : 'Classic method'), it.how.text),
      it.mesh && it.note && h('div', { class: 'note' }, it.note),
      it.mesh && h('div', { class: 'acts' },
        h('input', { type: 'range', min: 5, max: 100, value: Math.round(it.opacity * 100), title: 'See-through', oninput: (e) => { it.opacity = e.target.value / 100; app.redrawAll(); } }),
        h('button', { class: 'btn', title: 'Save as STL (for 3D printing), in millimeters', onclick: () => saveModel(it, 'stl') }, 'STL'),
        h('button', { class: 'btn', title: 'Save as OBJ', onclick: () => saveModel(it, 'obj') }, 'OBJ'),
        it.key === 'brain' && h('button', { class: 'btn', title: 'Paint on the slices where the brain is colored in wrongly, then update the 3D model', onclick: () => setTool('fix') }, 'Fix by hand'))));
  }
}
/** Which brain finder made a brain model: shown under it, so a good result can be traced back. */
function foundBy(used) {
  const key = used && used.model;
  if (!key) return { kind: 'classic', text: 'outline and folds', title: 'The classic method found this brain.' };
  const name = (MODEL_SHORT[key] || key).replace(/^Home-trained: /, '');
  const many = used.series > 1 ? ` · ${used.series} series of this study` : '';
  return { kind: OWN[key] ? 'own' : 'ai', text: name + many, title: MODEL_WHY[key] || '' };
}
function saveModel(it, kind) {
  const s = app.volume.stack;
  const base = `${(s.series.desc || 'scan').replace(/[^\w-]+/g, '_')}-${it.key}`;
  if (kind === 'stl') download(exportSTL(it.mesh, `${it.name} - Viewscan (mm, LPS)`), `${base}.stl`);
  else download(exportOBJ(it.mesh, it.name), `${base}.obj`);
}

// which parts get their inside filled (remembered); the brain does by default
function solidPrefs() {
  let p = null;
  try { p = JSON.parse(store.get('solid', 'null')); } catch { /* ignore */ }
  return { brain: true, bone: false, ...(p || {}) };
}

// ---- model finish: presets + fine-tuning -------------------------------------
const FINISH = {
  raw: { smooth: 0, soften: 0.6, close: 0, open: 0, pieces: 0, reduce: 1, fill: false },
  crisp: { smooth: 0, soften: 0.6, close: 0, open: 0, pieces: 1, reduce: 1, fill: true },
  clean: { smooth: 1, soften: 0.8, close: 1, open: 1, pieces: 1, reduce: 1, fill: true },
  smooth: { smooth: 4, soften: 1.1, close: 1.5, open: 1.5, pieces: 1, reduce: 0.5, fill: true },
  xsmooth: { smooth: 8, soften: 1.5, close: 2, open: 2, pieces: 1, reduce: 0.3, fill: true },
};
const FINISH_KEYS = ['smooth', 'soften', 'close', 'open', 'pieces', 'reduce'];
function readFinish() {
  const f = { fill: $('#f-fill').checked };
  for (const k of FINISH_KEYS) f[k] = Number($(`#f-${k}`).value);
  return f;
}
function showFinish(f) {
  for (const k of FINISH_KEYS) $(`#f-${k}`).value = f[k];
  $('#f-fill').checked = !!f.fill;
  const unit = { smooth: (v) => (v === 0 ? 'off' : `${v}`), soften: (v) => v.toFixed(1), close: (v) => (v ? `${v} mm` : 'off'), open: (v) => (v ? `${v} mm` : 'off') };
  for (const k of Object.keys(unit)) $(`#f-${k}`).parentElement.querySelector('output').textContent = unit[k](Number($(`#f-${k}`).value));
}
function initFinish() {
  let saved = null;
  try { saved = JSON.parse(store.get('finish', 'null')); } catch { /* ignore */ }
  const name = saved && (FINISH[saved.name] || saved.name === 'custom') ? saved.name : 'clean';
  $('#seg-finish').value = name;
  showFinish(name === 'custom' ? { ...FINISH.clean, ...saved.values } : FINISH[name]);
  const save = () => store.set('finish', JSON.stringify({ name: $('#seg-finish').value, values: readFinish() }));
  $('#seg-finish').onchange = (e) => { if (FINISH[e.target.value]) showFinish(FINISH[e.target.value]); save(); };
  for (const id of [...FINISH_KEYS.map((k) => `#f-${k}`), '#f-fill']) {
    $(id).addEventListener('input', () => {
      const f = readFinish();
      const match = Object.keys(FINISH).find((n) => FINISH_KEYS.every((k) => FINISH[n][k] === f[k]) && FINISH[n].fill === f.fill);
      $('#seg-finish').value = match || 'custom';
      showFinish(f); save();
    });
  }
}

// ---- MRI brain fine-tuning (remembered for each series) ----------------------
// Slider positions as shown on the panel. 0 on "Outline" and -0.5 on "Blend
// slices" mean automatic; -6 on "Fold depth" means no folds at all.
const MR_DEFAULT = { preset: 'auto', reach: 0, stiff: 0, grow: 0, bottom: 95, folds: 0, split: 2, hind: true, blend: -0.5, fluid: 'auto', fat: true };
// What looks wrong -> what to change, with the reason in plain words.
const MR_PRESETS = [
  { key: 'auto', name: 'Nothing: choose automatically', why: 'Viewscan picks every setting itself. Start here.', set: {} },
  { key: 'missing', name: 'Parts of the brain are missing', why: 'Lets the outline reach further out. Use it when the top, the sides or the back of the brain are cut off.', set: { reach: 3, grow: 1 } },
  { key: 'stuck', name: 'Skull, eyes or face are stuck on', why: 'Pulls the outline in and stiffens it, so it cannot bulge out through the gaps in the skull behind the eyes and under the brain.', set: { reach: -2, stiff: 3 } },
  { key: 'neck', name: 'Neck or spine hangs underneath', why: 'Cuts the model off higher up, just under the brain.', set: { bottom: 115 } },
  { key: 'filled', name: 'The folds look filled in', why: 'Counts more of the gray area between the folds as fluid, so the grooves show.', set: { folds: 3 } },
  { key: 'eaten', name: 'The brain looks eaten away', why: 'Counts less as fluid, so thin or dim parts of the brain are kept. The folds get shallower.', set: { folds: -3 } },
  { key: 'ridges', name: 'Ridges or steps at every slice', why: 'For scans with slices far apart: blends neighboring slices into one smooth shape. Fine detail gets softer.', set: { blend: 3, folds: -1 } },
  { key: 'cast', name: 'I just want the overall shape', why: 'Keeps everything inside the outline, with no folds: a smooth cast of the inside of the skull. Quick to print.', set: { folds: -6 } },
];
const MR_INPUTS = ['#m-reach', '#m-stiff', '#m-grow', '#m-bottom', '#m-folds', '#m-split', '#m-hind', '#m-blend', '#m-fluid', '#m-fat'];
// Which way the MRI brain is found when the choice is "Auto": the AI model where the
// graphics card can run it and the scan is of a kind it was trained for (T1-like, and
// FLAIR works too); T2 and proton-density scans, where fluid is bright, go the classic way.
function autoModel(stack = app.volume?.stack) {
  if (!app.gpuOK) return 'classic';
  const kind = stack && stack.series ? scanKind(stack.series) : null;
  if (kind && /T2|PD/.test(kind.name)) return 'classic';
  // Home-trained models say what they are best at (`auto` in models/own/index.json; the first
  // of a kind in the list wins): "study" for thick slices when the study has more series,
  // "scout" for a low-detail overview scan, "single" for either of those when nothing fits better.
  // A sharp scan (about 1 mm) stays with the 18-part model, which was trained on such scans.
  const shape = scanShape(stack), own = Object.values(OWN), pick = (use) => own.find((m) => m.auto === use);
  const m = shape === 'thick' ? (studyPartners(stack).length && pick('study')) || pick('single') : shape === 'scout' ? pick('scout') || pick('single') : null;
  return m ? m.key : 'partsBig';
}
/** 'thick' (slices 3 mm or more apart and much coarser than within a slice), 'scout' (1.2 mm or coarser all round), 'fine', or '' when not known yet. */
function scanShape(stack) {
  const v = stack && stack.volume;
  if (!v) return '';
  const hi = Math.max(...v.spacing), lo = Math.min(...v.spacing);
  return hi >= 3 && hi / lo >= 2.5 ? 'thick' : hi >= 1.2 ? 'scout' : 'fine';
}
const AUTO_WHY = { thick: 'Picked for this scan because its slices are far apart.', scout: 'Picked for this scan because it is a low-detail overview scan.' };
/** The brain finder in use: the dropdown's choice, with "Auto" worked out. */
function chosenModel(stack = app.volume?.stack) { const v = $('#m-model').value; return v === 'auto' ? autoModel(stack) : v; }
const AI_DEFAULT = { level: 0, grow: 0, stump: 8, study: 0 };
const readAiRaw = () => ({ level: Number($('#a-level').value), grow: Number($('#a-grow').value), stump: Number($('#a-stump').value), study: $('#a-study').checked ? 1 : 0 });
// a study model (one that takes several series in at once) always looks at the other series
const studyModel = (model) => !!(OWN[model] && OWN[model].inputs > 1);
const aiFromRaw = (model, a) => ({ model, folds: a.level / 5, grow: a.grow, stump: a.stump, study: a.study || studyModel(model) ? 1 : 0 });
// The other series of the same study that a brain model can also look at (see brainAnswer):
// every MRI series that is a proper volume, except maps and overviews that do not show anatomy.
const STUDY_SKIP = /DIFF|DWI|ADC|TRACE|PERF|LOCAL|MIP|SWI|PHASE/i;
function studyPartners(stack) {
  if (!stack || stack.unit === 'HU' || stack.desc.combined) return [];
  const list = [];
  for (const se of stack.study.series) {
    if (se === stack.series || se.modality !== 'MR' || se.combined || STUDY_SKIP.test(se.desc || '')) continue;
    const st = se.stacks.filter((x) => x.volume && !x.combined && x.n >= 16).sort((a, b) => b.n - a.n)[0];
    if (st) list.push({ series: se, st });
  }
  return list;
}
/** Reads those series fully and returns their volumes (kept once read). */
async function studyVolumes(stack, say = () => {}) {
  const list = studyPartners(stack), vols = [];
  for (const [k, { series, st }] of list.entries()) {
    say(`Reading the other series of this study… ${k + 1} of ${list.length}`);
    try {
      const s = getStack(stack.study, series, st);
      await s.load();
      if (s.failed || !s.buffer || s.unit === 'HU') continue;
      vols.push(s.volume || (s.volume = new Volume(s)));
    } catch { /* a series that cannot be read is left out */ }
  }
  return vols;
}
function showAi(a) {
  const out = (id, text) => { $(id).parentElement.querySelector('output').textContent = text; };
  $('#a-level').value = a.level; $('#a-grow').value = a.grow; $('#a-stump').value = a.stump; $('#a-study').checked = !!a.study;
  $('#a-study-row').style.display = studyPartners(app.volume?.stack).length && !studyModel($('#m-model').value) ? '' : 'none';
  out('#a-level', a.level === 0 ? 'normal' : a.level > 0 ? `stricter +${a.level}` : `looser ${a.level}`);
  out('#a-grow', a.grow === 0 ? 'none' : `${a.grow > 0 ? '+' : ''}${a.grow} mm`);
  out('#a-stump', a.stump >= 30 ? 'all of it' : `${a.stump} mm`);
}
// what each AI model is good for, in a line
const MODEL_WHY = {
  partsBig: 'The best one: finds the whole brain, with the cerebellum and brain stem, as 18 parts.',
  parts: 'A smaller network for the same 18 parts: quicker, a little less exact.',
  tissue: 'Finds gray and white matter. Good folds, but it can miss parts of a scan with uneven brightness.',
  tissueFast: 'The lightest network: very quick but rough. It can leave parts out or take in muscle; try “18 parts (best)” if it does.',
  maskFast: 'The lightest network: very quick but rough. It can leave parts out or take in muscle; try “18 parts (best)” if it does.',
  mask: 'A mid-size network that marks what is brain. Quick; less complete than “18 parts (best)”.',
  areas50: 'Divides the brain into 50 named areas (the 3D model shows them as one brain). Leaves out some of the lower parts.',
  areas104: 'Divides the brain into 104 named areas (the 3D model shows them as one brain). Leaves out some of the lower parts.',
};
/** The dropdown, its one-line explanation, and which fine-tune panel belongs to the choice. */
function showMethod() {
  const stack = app.volume?.stack, isMR = !!stack && stack.unit !== 'HU';
  $('#brain-how').style.display = isMR ? '' : 'none';
  const pick = $('#m-model').value, how = chosenModel(stack), ai = how !== 'classic';
  $('#m-model').options[0].textContent = !ai ? 'Auto (classic)' : OWN[how] ? `Auto (${OWN[how].name.replace(/^Home-trained: /, 'home-trained ')})` : 'Auto (AI model)';
  $('#m-model-why').textContent = ai
    ? `${pick === 'auto' && OWN[how] ? (AUTO_WHY[scanShape(stack)] || '') + ' ' : ''}${MODEL_WHY[how] || ''} It runs on this computer’s graphics card; nothing leaves the computer.`
    : pick !== 'auto' ? 'An outline is grown inside the skull and the folds are cut by brightness. Works on any kind of scan.'
      : app.gpuOK ? 'Classic is used for this kind of scan: the AI models were trained on T1-weighted scans. You can still pick one.'
        : 'The AI models need WebGPU (a current Chrome or Edge with a graphics card); the classic method is used here.';
  $('#ai-more').style.display = isMR && ai ? '' : 'none';
  $('#mr-more').style.display = isMR && !ai ? '' : 'none';
}
/** A series opens with the finder and AI settings it was last built with (else the owner's usual finder). */
function loadMethod(stack) {
  const m = store.get('model.' + stack.id, '') || store.get('model', 'auto');
  $('#m-model').value = [...$('#m-model').options].some((o) => o.value === m) ? m : 'auto';
  let a = null;
  try { a = JSON.parse(store.get('ai.' + stack.id, 'null')); } catch { /* ignore */ }
  showAi({ ...AI_DEFAULT, ...(a || {}) });
  showMethod();
}
function setMethod(model, a = null, usual = false) {
  const stack = app.volume?.stack;
  $('#m-model').value = model;
  if (stack) store.set('model.' + stack.id, model);
  if (usual) store.set('model', model);
  if (a) { showAi({ ...AI_DEFAULT, ...a }); if (stack) store.set('ai.' + stack.id, JSON.stringify(readAiRaw())); }
  showMethod();
}
function readMrRaw() {
  return {
    preset: $('#m-preset').value,
    reach: Number($('#m-reach').value), stiff: Number($('#m-stiff').value), grow: Number($('#m-grow').value), bottom: Number($('#m-bottom').value),
    folds: Number($('#m-folds').value), split: Number($('#m-split').value), hind: $('#m-hind').checked,
    blend: Number($('#m-blend').value), fluid: $('#m-fluid').value, fat: $('#m-fat').checked,
  };
}
/** The settings in the form the model builder takes them (see segmentMR in segworker.js). */
function readMr() {
  if (app.mrTune) return app.mrTune; // set from tests / the console to bypass the panel
  const model = chosenModel();
  return model === 'classic' ? { model, ...mrFromRaw(readMrRaw()) } : aiFromRaw(model, readAiRaw());
}
function mrFromRaw(r) {
  return {
    reach: r.reach / 5, stiff: 1 + 0.2 * r.stiff, grow: r.grow, bottom: r.bottom <= 95 ? 'auto' : r.bottom, folds: r.folds <= -6 ? 'none' : r.folds / 5,
    split: r.split / 2, hind: r.hind, blend: r.blend < 0 ? 'auto' : r.blend, fluid: r.fluid, fat: r.fat,
  };
}
/** Put settings on the panel. Auto rows also show what the last build or preview picked. */
function showMr(r) {
  const used = app.volume?.stack.mrUsed;
  const out = (id, text) => { $(id).parentElement.querySelector('output').textContent = text; };
  const signed = (v, unit = '') => `${v > 0 ? '+' : ''}${v}${unit}`;
  $('#m-preset').value = MR_PRESETS.some((p) => p.key === r.preset) ? r.preset : 'custom';
  $('#m-preset-why').textContent = (MR_PRESETS.find((p) => p.key === r.preset) || { why: 'Your own mix of settings.' }).why;
  $('#m-reach').value = r.reach; $('#m-stiff').value = r.stiff; $('#m-grow').value = r.grow; $('#m-bottom').value = r.bottom; $('#m-folds').value = r.folds; $('#m-blend').value = r.blend;
  $('#m-fluid').value = r.fluid; $('#m-fat').checked = !!r.fat;
  $('#m-split').value = r.split; $('#m-hind').checked = !!r.hind;
  out('#m-split', r.split === 0 ? 'off' : r.split === 2 ? 'normal' : r.split > 2 ? `deeper +${r.split - 2}` : 'slight');
  out('#m-reach', r.reach === 0 ? (used && used.tightened ? 'Auto · tightened' : 'Auto') : r.reach > 0 ? `fuller ${signed(r.reach)}` : `tighter ${r.reach}`);
  out('#m-stiff', r.stiff === 0 ? 'normal' : r.stiff > 0 ? `stiffer ${signed(r.stiff)}` : `looser ${r.stiff}`);
  out('#m-grow', r.grow === 0 ? 'none' : `${signed(r.grow)} mm`);
  out('#m-bottom', r.bottom <= 95 ? (used && used.bottom ? `Auto · ${used.bottom} mm` : 'Auto') : `${r.bottom} mm`);
  out('#m-folds', r.folds <= -6 ? 'no folds' : r.folds === 0 ? 'normal' : r.folds > 0 ? `deeper ${signed(r.folds)}` : `shallower ${r.folds}`);
  out('#m-blend', r.blend < 0 ? (used ? `Auto · ${used.blend ? used.blend.toFixed(1) + ' mm' : 'off'}` : 'Auto') : r.blend ? `${r.blend} mm` : 'off');
  $('#m-fluid').options[0].textContent = used && used.fluid && r.fluid === 'auto' ? `Auto (${used.fluid})` : 'Auto';
}
function loadMr(stack) {
  let saved = null;
  try { saved = JSON.parse(store.get('mr.' + stack.id, 'null')); } catch { /* ignore */ }
  // this series' own settings, else the owner's default for this kind of scan, else automatic
  const r = { ...MR_DEFAULT }, mine = kindDefault(stack), from = saved || mine;
  for (const k of Object.keys(MR_DEFAULT)) if (from && typeof from[k] === typeof MR_DEFAULT[k]) r[k] = from[k]; // settings kept by an older version are dropped
  $('#m-default').hidden = !mine;
  if (mine) $('#m-default-text').textContent = `You have a default for ${kindName(stack)} scans${saved ? '' : ' (in use)'}.`;
  showMr(r);
  loadMethod(stack);
  // a series that was tuned by hand opens with its settings in view
  if (Object.keys(MR_DEFAULT).some((k) => r[k] !== MR_DEFAULT[k])) $('#mr-more').open = true;
}
/** Put settings on the panel, remember them for this series, and refresh the preview. */
function applyMr(r, preview = true) {
  const stack = app.volume?.stack;
  showMr(r);
  if (stack) store.set('mr.' + stack.id, JSON.stringify(r));
  if (preview) requestPreview();
}
function initMr() {
  const sel = $('#m-preset');
  for (const p of MR_PRESETS) sel.append(h('option', { value: p.key }, p.name));
  sel.append(h('option', { value: 'custom', hidden: '' }, 'My own settings'));
  const keep = applyMr;
  $('#m-undefault').onclick = () => {
    const stack = app.volume?.stack; if (!stack) return;
    try { localStorage.removeItem('viewscan.' + kindKey(stack)); } catch { /* private mode */ }
    $('#m-default').hidden = true;
    toast(`Forgot the default for ${kindName(stack)} scans. Series you already tuned keep their own settings.`);
  };
  sel.onchange = () => { const p = MR_PRESETS.find((x) => x.key === sel.value); if (p) keep({ ...MR_DEFAULT, ...p.set, preset: p.key }); };
  for (const id of MR_INPUTS) $(id).addEventListener('input', () => keep({ ...readMrRaw(), preset: 'custom' }));
  $('#m-model').addEventListener('change', () => { setMethod($('#m-model').value); requestPreview(); });
  for (const id of ['#a-level', '#a-grow', '#a-stump']) $(id).addEventListener('input', () => { setMethod($('#m-model').value, readAiRaw()); requestPreview(); });
  $('#a-study').onchange = () => { setMethod($('#m-model').value, readAiRaw()); requestPreview(); };
  $('#a-reset').onclick = () => { setMethod($('#m-model').value, AI_DEFAULT); requestPreview(); };
  $('#a-live').checked = store.get('ailive', '1') === '1';
  $('#a-live').onchange = (e) => { store.set('ailive', e.target.checked ? '1' : ''); requestPreview(); };
  $('#ai-more').addEventListener('toggle', () => requestPreview());
  showAi(AI_DEFAULT);
  $('#m-reset').onclick = () => keep({ ...MR_DEFAULT });
  $('#m-live').checked = store.get('mrlive', '1') === '1';
  $('#m-live').onchange = (e) => { store.set('mrlive', e.target.checked ? '1' : ''); requestPreview(); };
  $('#mr-more').addEventListener('toggle', () => requestPreview());
  showMr(MR_DEFAULT);
}

// ---- live preview of the MRI brain on the slices ------------------------------
// One worker stays alive, holding the scan on a coarse grid; every change on the
// panel asks it where the brain is now, and the answer is tinted on the slices
// (pink = brain, blue = fluid inside the outline). No 3D model is built.
const preview = { worker: null, volId: '', busy: false, want: false, seq: 0, vol: null };
const pvStatus = (text) => { for (const id of ['#m-status', '#a-status']) $(id).textContent = text; };
const previewOn = () => app.mode === '3d' && !!app.volume && app.volume.stack.unit !== 'HU'
  && (chosenModel() === 'classic' ? $('#mr-more').open && $('#m-live').checked : $('#ai-more').open && $('#a-live').checked);
function requestPreview() {
  const stack = app.volume?.stack;
  if (!previewOn()) {
    if (stack && stack.preview) { stack.preview = null; app.redrawAll(); }
    pvStatus('');
    return;
  }
  preview.want = true;
  pumpPreview();
}
function pumpPreview() {
  if (preview.busy || !preview.want || !previewOn() || app.building) return;
  preview.want = false;
  const vol = app.volume, stack = vol.stack;
  if (!preview.worker) {
    preview.worker = newSegWorker();
    preview.worker.onmessage = (ev) => {
      const m = ev.data;
      preview.busy = false;
      if (m.type === 'preview' && app.volume === preview.vol) {
        const st = app.volume.stack;
        st.preview = { labels: labelVolume(m.labels, m.dims, m.grid) };
        st.mrUsed = m.used || st.mrUsed;
        showMr(readMrRaw());
        pvStatus(m.used ? `Brain: about ${Math.round(m.ml / 10) * 10} mL${m.used.model && preview.series > 1 ? `, from ${preview.series} series of this study` : ''}${m.note ? '. ' + m.note : ''}` : m.note);
        app.previewCount = (app.previewCount || 0) + 1;
        app.redrawAll();
      } else if (m.type === 'error') {
        console.warn(m.error);
        pvStatus('The preview could not be worked out for this series.');
        preview.worker.terminate(); preview.worker = null; preview.volId = '';
      }
      pumpPreview();
    };
  }
  const mr = readMr();
  preview.busy = true;
  // an AI model answers first (once per scan; the answer is kept), then its result is laid on the slices
  if (mr.model !== 'classic') {
    pvStatus('Running the brain model on the graphics card…');
    const say = (text) => { if (app.volume === vol) pvStatus(text); };
    (mr.study ? studyVolumes(stack, say) : Promise.resolve([]))
      .then((others) => brainAnswer(vol, mr.model, (p, text) => say(text), others))
      .then((ai) => { if (app.volume !== vol) { preview.busy = false; return pumpPreview(); } preview.series = ai.study ? ai.study.used : 1; sendPreview(vol, stack, mr, ai); })
      .catch((err) => { preview.busy = false; pvStatus(`The AI model could not run (${err.message}). Pick “Classic” under “Brain finder”.`); });
    return;
  }
  sendPreview(vol, stack, mr, null);
}
function sendPreview(vol, stack, mr, ai) {
  const first = preview.volId !== vol.id;
  preview.vol = vol; preview.volId = vol.id;
  if (first) preview.aiKey = '';
  const aiId = ai ? ai.key + (ai.study ? '+study' : '') : '';
  const sendAi = ai && preview.aiKey !== aiId;
  if (sendAi) preview.aiKey = aiId;
  pvStatus(first ? 'Looking for the brain…' : 'Updating…');
  preview.worker.postMessage({
    type: 'preview', id: ++preview.seq,
    vol: first ? { nx: vol.nx, ny: vol.ny, nz: vol.nz, data: vol.data, origin: vol.origin, dx: vol.dx, dy: vol.dy, dz: vol.dz, basis: vol.basis } : null,
    ai: sendAi ? { labels: ai.labels, prob: ai.prob, c0: ai.c0, axes: ai.axes, classes: ai.classes, key: ai.key, cereb: ai.cereb } : null,
    opts: { voxel: 2, modality: 'MR', mr, mrInfo: { tr: stack.series.info.tr, te: stack.series.info.te, ti: stack.series.info.ti } },
  });
}

// ---- combining scans taken in different planes (optional, last resort) -------
// A thick-slice scan is sharp in its own plane only. When the same kind of scan
// was also taken in another plane, the two (or three) can be merged into one
// volume that is sharp all round: see fuse.js. Nothing is combined unless asked.
/** What kind of MRI scan a series is, so that only like is combined with like. */
function scanKind(series) {
  if (series.modality !== 'MR' || series.combined) return null;
  const i = series.info || {}, d = (series.desc || '').toUpperCase();
  if (/DIFF|DWI|ADC|TRACE|PERF|LOCAL|SCOUT/.test(d)) return null;
  const weight = i.ti > 1500 && i.te >= 50 ? 'FLAIR' : i.te >= 50 ? 'T2' : i.te > 0 && i.te <= 30 ? (i.tr > 1500 ? 'PD' : 'T1')
    : /FLAIR/.test(d) ? 'FLAIR' : /T2/.test(d) ? 'T2' : /T1/.test(d) ? 'T1' : '';
  if (!weight) return null;
  const family = ((i.sequence || '').toLowerCase().match(/[a-z]+/) || [''])[0]; // se, tse, tir, fl… (the scanner's name minus its numbering)
  const contrast = /\bPOST\b|\bGAD|\+ ?C\b|CONTRAST/.test(d) && !/\bPRE\b|W\/?O\b|WITHOUT/.test(d);
  return { key: `${weight}|${family}|${contrast}`, name: `${contrast ? 'post-contrast ' : ''}${weight}` };
}
/** The scans of the same kind as this one, in the same study: [{ series, st }], this one first. Empty when there is nothing to gain. */
function combinable(study, series, st) {
  const kind = scanKind(series);
  if (!kind || !st.volume || st.combined) return [];
  const list = [{ series, st }];
  for (const se of study.series) {
    if (se === series || scanKind(se)?.key !== kind.key) continue;
    const other = se.stacks.find((x) => x.volume && x.plane && x.plane !== st.plane && !list.some((l) => l.st.plane === x.plane));
    if (other) list.push({ series: se, st: other });
  }
  return list.length > 1 ? list : [];
}
function setupCombine() {
  const box = $('#combine-more'), stack = app.volume?.stack;
  const list = stack && stack.unit !== 'HU' ? combinable(stack.study, stack.series, stack.desc) : [];
  box.style.display = list.length ? '' : 'none';
  if (!list.length) return;
  const kind = scanKind(stack.series);
  $('#combine-hint').textContent = `This study has the same kind of scan (${kind.name}) taken in ${list.length} planes. Each is sharp in its own plane and blurred in the others; combined, they give one scan that is sharp all round. Try the single scan first: combining takes a little while and works best when the head did not move much between the scans.`;
  const rows = $('#combine-list');
  rows.textContent = '';
  list.forEach(({ series, st }, k) => rows.append(h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: '', disabled: k === 0 ? '' : null, 'data-k': k }),
    ` ${series.desc || 'Series ' + series.number} · ${PLANE_LABEL[st.plane]}${k === 0 ? ' (this one)' : ''}`)));
  $('#combine-status').textContent = '';
  $('#btn-combine').disabled = false;
  $('#btn-combine').onclick = () => combineScans(stack, list.filter((_, k) => rows.querySelector(`input[data-k="${k}"]`).checked));
}
async function combineScans(baseStack, list) {
  if (list.length < 2) return toast('Tick at least one other scan to combine with.');
  const btn = $('#btn-combine'), status = (t) => { $('#combine-status').textContent = t; };
  btn.disabled = true;
  const study = baseStack.study;
  try {
    // every scan has to be fully read first
    const vols = [];
    for (const [k, { series, st }] of list.entries()) {
      status(`Reading scan ${k + 1} of ${list.length}…`);
      const s = getStack(study, series, st);
      await s.load();
      if (s.failed || !s.buffer) throw new Error(`“${series.desc}” could not be read`);
      const v = s.volume || (s.volume = new Volume(s));
      vols.push({ nx: v.nx, ny: v.ny, nz: v.nz, data: v.data, origin: v.origin, dx: v.dx, dy: v.dy, dz: v.dz, basis: v.basis, thick: st.thick || 0 });
    }
    const result = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./fuseworker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') return status(m.text);
        w.terminate();
        if (m.type === 'done') resolve(m.result); else reject(new Error(m.error));
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The combining step stopped unexpectedly')); };
      w.postMessage({ vols, opts: {} });
    });
    const kind = scanKind(baseStack.series), sp = result.spacing, size = result.nx * result.ny;
    // present the result as one more series of the study
    const id = `combined:${list.map((l) => l.st.id).join('+')}`;
    const add = (a, b, t) => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
    const st = {
      id, n: result.nz, rows: result.ny, cols: result.nx, volume: true, plane: baseStack.desc.plane, layout: 'regular', combined: true,
      label: `${list.length} scans combined`, ps: [sp, sp], step: sp, thick: sp,
      frames: Array.from({ length: result.nz }, (_, k) => ({ ipp: add(result.origin, result.dz, k), iop: [...result.row, ...result.col], ps: [sp, sp] })),
    };
    const series = { ...baseStack.series, desc: `Combined ${kind.name}`, number: 9000 + study.series.filter((s) => s.combined).length, stacks: [st], combined: true };
    const old = study.series.findIndex((s) => s.combined && s.stacks[0].id === id);
    if (old >= 0) study.series.splice(old, 1); // combined again: replace
    study.series.push(series);
    const stack = new Stack(st, series, study, app.sources.get(study.source));
    stack.key = stackKey(study, st);
    stack.pinned = true; // made here, cannot be read again from files
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < result.data.length; i += 7) { const v = result.data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const d0 = baseStack.display;
    for (let k = 0; k < result.nz; k++) {
      stack.accept(k, { data: result.data.subarray(k * size, (k + 1) * size), rows: result.ny, cols: result.nx, min: lo, max: hi, unit: baseStack.unit || '', wc: d0?.wc, ww: d0?.ww, ...st.frames[k] });
    }
    stack.started = true; stack.done = true; stack.promise = Promise.resolve(stack);
    app.stacks.set(stack.key, stack);
    thumbs.delete(stack.key);
    const moved = result.moves.slice(1).filter((m) => m.moved).length;
    app.lastCombine = { moves: result.moves, dims: [result.nx, result.ny, result.nz], spacing: sp, id };
    renderLibrary();
    openStack(study, series, st);
    toast(`Combined ${list.length} scans into one${moved ? ` (${moved} had to be nudged into line)` : ''}. It is in the list as “${series.desc}” until the page is reloaded.`);
  } catch (err) {
    console.error(err);
    status('Could not combine the scans: ' + err.message);
    btn.disabled = false;
  }
}

// ---- compare: build the MRI brain many ways and pick the best -----------------
// Two dozen versions of the brain are built side by side, each with different
// settings, and shown in a grid that turns together. Picking one uses its model
// and its settings for this series; it can also be kept as the starting point for
// every scan of the same kind (see scanKind). "Try more" adds versions with
// settings that have not been tried on this series yet. Several versions are
// built at once, each on its own share of the processor.
// A version is { label, set (panel positions that differ from automatic),
// finish (name in CMP_FINISH, default 'clean'), voxel (mm, default: the Detail box) }.
const CMP_FINISH = {
  clean: { name: 'clean', values: FINISH.clean, text: '' },
  crisp: { name: 'crisp', values: FINISH.crisp, text: 'crisp finish (no smoothing, keeps every detail, one piece)' },
  raw: { name: 'custom', values: { ...FINISH.raw, pieces: 1 }, text: 'raw finish (exactly as found, no tidying)' },
  smooth: { name: 'smooth', values: FINISH.smooth, text: 'smooth finish' },
  xsmooth: { name: 'xsmooth', values: FINISH.xsmooth, text: 'extra smooth finish' },
};
// Spread wide on purpose: each version differs from the others in kind (finish,
// grid, how deep the folds go, how the outline sits), not by one notch of one slider.
const MR_VARIANTS = [
  { label: 'Classic, automatic', set: {} },
  { label: 'Fine grid, crisp, tight outline, deep split', set: { reach: -2, stiff: 2, split: 4 }, finish: 'crisp', voxel: 0.7 }, // the owner's favorite
  { label: 'Fine grid, smooth, deepest folds', set: { reach: -1, folds: 5 }, finish: 'smooth', voxel: 0.7 },
  { label: 'Fine grid, crisp, deepest folds', set: { folds: 5 }, finish: 'crisp', voxel: 0.7 },
  { label: 'Fine grid, raw', set: {}, finish: 'raw', voxel: 0.7 },
  { label: 'Crisp, deepest folds', set: { folds: 5 }, finish: 'crisp' },
  { label: 'Raw, deepest folds, no blending', set: { folds: 5, blend: 0 }, finish: 'raw' },
  { label: 'Smooth, deep folds', set: { folds: 3 }, finish: 'smooth' },
  { label: 'Extra smooth, deep folds', set: { folds: 4 }, finish: 'xsmooth' },
  { label: 'Crisp, gentle folds', set: { folds: -2 }, finish: 'crisp' },
  { label: 'Smooth, shallow folds', set: { folds: -4 }, finish: 'smooth' },
  { label: 'Tight outline, deepest folds', set: { reach: -2, stiff: 2, folds: 5 }, finish: 'crisp' },
  { label: 'Tight outline, raw', set: { reach: -2, stiff: 2 }, finish: 'raw' },
  { label: 'Full outline, deep folds, smooth', set: { reach: 3, grow: 1, folds: 4 }, finish: 'smooth' },
  { label: 'Full outline, rounded', set: { reach: 3, grow: 1.5, folds: -3 }, finish: 'smooth' },
  { label: 'Loose outline, deepest folds', set: { stiff: -2, folds: 5 }, finish: 'crisp' },
  { label: 'Stiff outline, deep folds', set: { stiff: 5, folds: 3 }, finish: 'clean' },
  { label: 'Shaved 1.5 mm, deepest folds', set: { grow: -1.5, folds: 5 }, finish: 'crisp' },
  { label: 'Padded 1.5 mm, deep folds', set: { grow: 1.5, folds: 4 }, finish: 'smooth' },
  { label: 'Deep split between the halves', set: { split: 4, folds: 4 }, finish: 'crisp' },
  { label: 'Plain: no split, cerebellum like the rest', set: { split: 0, hind: false }, finish: 'crisp' },
  { label: 'Wrinkled cerebellum, deepest folds', set: { hind: false, folds: 5 }, finish: 'smooth' },
  { label: 'No slice blending, deep folds', set: { blend: 0, folds: 4 }, finish: 'crisp' },
  { label: 'Strong slice blending, smooth', set: { blend: 3, folds: 2 }, finish: 'smooth' },
  { label: 'Coarse grid, bold folds', set: { folds: 5 }, finish: 'smooth', voxel: 1.4 },
  { label: 'Cut off high, deep folds', set: { bottom: 120, folds: 4 }, finish: 'crisp' },
  { label: 'Cut off low, deep folds', set: { bottom: 165, folds: 4 }, finish: 'smooth' },
  { label: 'Overall shape only', set: { folds: -6 }, finish: 'smooth' },
];
const cmp = { run: 0, tiles: [], queue: [], busy: 0, used: 0, load: 0, done: 0, cam: null, radius: 100, vol: null, fit: 1, t0: 0 };
// AI versions: every network, each with mixes of its own settings (how sure it must
// be, pad or shave, how much brain stem) and of finish and grid.
const OWN_KEYS = []; // home-trained models
const MODEL_SHORT = { partsBig: '18 parts (best)', parts: '18 parts (quicker)', tissue: 'Tissue GWM', tissueFast: 'Tissue GWM (light)', maskFast: 'Brain mask (fast)', mask: 'Brain mask (high accuracy)', areas50: 'Aparc+Aseg 50', areas104: 'Aparc+Aseg 104' };
function aiVariant(model, ai = {}, finish = 'crisp', voxel = 0) {
  const tags = [MODEL_SHORT[model]];
  if (ai.level) tags.push(ai.level > 0 ? `stricter +${ai.level}` : `looser ${ai.level}`);
  if (ai.study) tags.push('whole study');
  if (ai.grow) tags.push(ai.grow > 0 ? `padded ${ai.grow} mm` : `shaved ${-ai.grow} mm`);
  if (ai.stump !== undefined && ai.stump !== AI_DEFAULT.stump) tags.push(ai.stump >= 30 ? 'whole brain stem' : `brain stem ${ai.stump} mm`);
  if (voxel) tags.push(voxel < 1 ? 'fine grid' : 'coarse grid');
  tags.push(finish);
  const v = { label: tags.join(' · '), model, ai, set: {}, finish };
  if (voxel) v.voxel = voxel;
  return v;
}
const AI_VARIANTS = [
  aiVariant('partsBig', {}, 'crisp', 0.7), aiVariant('partsBig', {}, 'clean'), aiVariant('partsBig', {}, 'smooth', 0.7), aiVariant('partsBig', {}, 'raw'),
  aiVariant('partsBig', { level: 1 }, 'crisp', 0.7), aiVariant('partsBig', { level: 2 }, 'crisp', 0.7), aiVariant('partsBig', { level: 3 }, 'crisp', 0.7), aiVariant('partsBig', { level: 4 }, 'crisp', 0.7),
  aiVariant('partsBig', { level: 5 }, 'crisp', 0.7), aiVariant('partsBig', { level: 2 }, 'smooth', 0.7), aiVariant('partsBig', { level: 3 }, 'clean'), aiVariant('partsBig', { level: 4 }, 'smooth', 0.7),
  aiVariant('partsBig', { level: 2 }, 'raw', 0.7), aiVariant('partsBig', { level: -2 }, 'crisp', 0.7), aiVariant('partsBig', { level: -4 }, 'smooth'), aiVariant('partsBig', {}, 'xsmooth'),
  aiVariant('partsBig', { grow: -0.5 }, 'crisp', 0.7), aiVariant('partsBig', { grow: 0.5 }, 'crisp', 0.7), aiVariant('partsBig', { level: 3, grow: 0.5 }, 'crisp', 0.7), aiVariant('partsBig', { stump: 30 }, 'crisp'),
  aiVariant('partsBig', { stump: 0 }, 'crisp'), aiVariant('partsBig', { level: 2 }, 'crisp', 1.4),
  aiVariant('parts', {}, 'crisp', 0.7), aiVariant('parts', { level: 2 }, 'crisp', 0.7), aiVariant('parts', { level: 4 }, 'crisp', 0.7), aiVariant('parts', {}, 'smooth', 0.7),
  aiVariant('tissue', {}, 'crisp', 0.7), aiVariant('tissue', { level: 2 }, 'crisp', 0.7), aiVariant('tissue', {}, 'smooth', 0.7), aiVariant('tissue', { level: -2 }, 'clean'),
  aiVariant('tissueFast', {}, 'crisp'), aiVariant('tissueFast', { level: 2 }, 'crisp', 0.7), aiVariant('maskFast', {}, 'crisp'), aiVariant('maskFast', {}, 'smooth'),
  aiVariant('mask', {}, 'crisp', 0.7), aiVariant('mask', { level: 2 }, 'crisp', 0.7), aiVariant('mask', {}, 'smooth'),
  aiVariant('areas50', {}, 'crisp', 0.7), aiVariant('areas50', { level: 2 }, 'crisp', 0.7), aiVariant('areas104', {}, 'crisp', 0.7), aiVariant('areas104', { level: 2 }, 'crisp', 0.7), aiVariant('areas104', {}, 'smooth'),
];
/** AI versions with mixes not tried on this series yet. */
function freshAiVariants(stack, count) {
  const tried = stack.triedVariants || (stack.triedVariants = new Set());
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const out = [];
  for (let guard = 0; out.length < count && guard < 4000; guard++) {
    const ai = {}, level = pick([-3, -1, 0, 1, 2, 2, 3, 3, 4, 5]), grow = pick([0, 0, 0, 0, -1, -0.5, 0.5, 1]), stump = pick([8, 8, 8, 8, 0, 16, 30]);
    if (level) ai.level = level; if (grow) ai.grow = grow; if (stump !== AI_DEFAULT.stump) ai.stump = stump;
    const v = aiVariant(pick([...OWN_KEYS, ...OWN_KEYS, ...OWN_KEYS, 'partsBig', 'partsBig', 'partsBig', 'partsBig', 'parts', 'parts', 'tissue', 'tissue', 'mask', 'tissueFast', 'areas50', 'areas104']), ai, pick(['crisp', 'crisp', 'raw', 'clean', 'smooth', 'xsmooth']), pick([0, 0.7, 0.7, 0.7, 1.4]));
    const key = variantKey(v);
    if (tried.has(key)) continue;
    tried.add(key);
    out.push(v);
  }
  return out;
}
const variantKey = (v) => JSON.stringify([v.model || 'classic', v.ai || 0, Object.entries({ ...MR_DEFAULT, ...v.set, preset: '' }).sort(), v.finish || 'clean', v.voxel || 0]);
/** What a version changes, in plain words. */
function variantWhy(v) {
  const s = v.set, bits = [];
  if (v.model === 'parts') bits.push('the smaller neural network'); else if (v.model === 'tissue') bits.push('the network that only knows gray and white matter');
  else if (v.model === 'partsBig') bits.push('neural network on the graphics card');
  else if (!v.model && !Object.keys(s).length) bits.push('classic method: outline, and folds by brightness');
  if (studyModel(v.model)) bits.push('the model looks at up to three series of the study at once, lined up first');
  else if (v.ai && v.ai.study) bits.push('the model looked at every series of the study and its answers were merged');
  if (v.ai && v.ai.level) bits.push(v.ai.level > 0 ? 'it must be surer that a spot is brain, which opens the folds' : 'it may be less sure that a spot is brain, which fills the folds in');
  if (v.ai && v.ai.grow) bits.push(v.ai.grow > 0 ? `padded ${v.ai.grow} mm all round` : `shaved ${-v.ai.grow} mm all round`);
  if (v.ai && v.ai.stump !== undefined) bits.push(v.ai.stump >= 30 ? 'all of the brain stem the model found is kept' : `${v.ai.stump} mm of brain stem kept below the cerebellum`);
  if (s.reach > 0) bits.push('the outline reaches further out'); else if (s.reach < 0) bits.push('the outline is pulled in');
  if (s.stiff > 0) bits.push('a stiffer outline that cannot bulge'); else if (s.stiff < 0) bits.push('a looser outline that follows the lobes');
  if (s.grow > 0) bits.push(`padded ${s.grow} mm all round`); else if (s.grow < 0) bits.push(`shaved ${-s.grow} mm all round`);
  if (s.bottom && s.bottom !== MR_DEFAULT.bottom) bits.push(`cut off ${s.bottom} mm below the top`);
  if (s.folds <= -6) bits.push('no folds: everything inside the outline');
  else if (s.folds > 0) bits.push(`more counts as fluid, so the grooves are deeper (+${s.folds})`); else if (s.folds < 0) bits.push(`less counts as fluid, so the folds fill in (${s.folds})`);
  if (s.split === 0) bits.push('no extra cut between the two halves'); else if (s.split > 2) bits.push('a deeper cut between the two halves');
  if (s.hind === false) bits.push('the cerebellum and brain stem get folds like the rest');
  if (s.blend === 0) bits.push('slices not blended (sharper, may show ridges)'); else if (s.blend > 0) bits.push(`slices blended ${s.blend} mm`);
  if (v.voxel) bits.push(v.voxel < 1 ? `a finer ${v.voxel} mm grid (slower)` : `a coarser ${v.voxel} mm grid`);
  const f = CMP_FINISH[v.finish || 'clean'].text;
  if (f) bits.push(f);
  const text = bits.join('; ');
  return text ? text[0].toUpperCase() + text.slice(1) + '.' : 'What Viewscan picks by itself.';
}
/** Versions with settings not tried on this series yet, leaning toward more detail. */
function freshVariants(stack, count) {
  const tried = stack.triedVariants || (stack.triedVariants = new Set());
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const out = [];
  for (let guard = 0; out.length < count && guard < 4000; guard++) {
    const set = {};
    const put = (k, v) => { if (v !== MR_DEFAULT[k]) set[k] = v; };
    put('reach', pick([-2, -1, 0, 0, 0, 1, 1, 2, 3, 4]));
    put('stiff', pick([-2, -1, 0, 0, 0, 1, 2, 4]));
    put('grow', pick([-1, -0.5, 0, 0, 0, 0.5, 1, 1.5]));
    put('folds', pick([-4, -2, 0, 2, 3, 4, 5, 5]));
    put('blend', pick([-0.5, -0.5, 0, 0, 0.5, 1, 2]));
    put('bottom', pick([95, 95, 95, 95, 125, 150]));
    put('split', pick([0, 1, 2, 2, 2, 3, 4, 4]));
    put('hind', pick([true, true, true, true, false]));
    const v = { set, finish: pick(['crisp', 'crisp', 'raw', 'clean', 'smooth', 'smooth', 'xsmooth']), voxel: pick([0, 0, 0, 0, 0.7, 1.4]) };
    if (!v.voxel) delete v.voxel;
    const key = variantKey(v);
    if (tried.has(key)) continue;
    const tags = [];
    if (set.reach) tags.push(set.reach > 0 ? `fuller +${set.reach}` : `tighter ${set.reach}`);
    if (set.stiff) tags.push(set.stiff > 0 ? `stiffer +${set.stiff}` : `looser ${set.stiff}`);
    if (set.grow) tags.push(set.grow > 0 ? `padded ${set.grow} mm` : `shaved ${-set.grow} mm`);
    if (set.folds) tags.push(set.folds > 0 ? `folds +${set.folds}` : `folds ${set.folds}`);
    if (set.blend !== undefined) tags.push(set.blend ? `blend ${set.blend} mm` : 'no blending');
    if (set.bottom) tags.push(`cut at ${set.bottom} mm`);
    if (set.split !== undefined) tags.push(set.split ? `split ${set.split > 2 ? '+' + (set.split - 2) : 'slight'}` : 'no split');
    if (set.hind === false) tags.push('wrinkled cerebellum');
    if (v.voxel) tags.push(v.voxel < 1 ? 'fine grid' : 'coarse grid');
    tags.push(v.finish);
    const label = tags.join(' · ');
    v.label = label[0].toUpperCase() + label.slice(1);
    tried.add(key);
    out.push(v);
  }
  return out;
}
/** Where the settings of a kind of scan are kept, e.g. "mrdef.T1|se|false". */
const kindKey = (stack) => 'mrdef.' + (scanKind(stack.series)?.key || 'MR');
const kindName = (stack) => scanKind(stack.series)?.name || 'MRI';
function kindDefault(stack) {
  try { return JSON.parse(store.get(kindKey(stack), 'null')); } catch { return null; }
}
function cmpLook(dir) {
  const set = { A: [[1, 0, 0], [0, 0, -1]], P: [[-1, 0, 0], [0, 0, -1]], L: [[0, 1, 0], [0, 0, -1]], R: [[0, -1, 0], [0, 0, -1]], S: [[-1, 0, 0], [0, 1, 0]], I: [[1, 0, 0], [0, 1, 0]] }[dir];
  const c = cmp.cam ? cmp.cam.center : [...cmp.vol.center];
  cmp.cam = { center: c, r: set[0], d: set[1], f: vec.cross(set[0], set[1]) };
  cmp.fit = 1;
  drawCompare();
}
function drawCompare() {
  if ($('#compare').hidden || !cmp.cam) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), box = $('#cmp-grid').getBoundingClientRect();
  for (const t of cmp.tiles) {
    if (!t.item || !t.item.mesh) continue;
    const r = t.canvas.getBoundingClientRect();
    if (r.bottom < box.top - 200 || r.top > box.bottom + 200) { t.stale = true; continue; } // scrolled out of sight: drawn when it comes back
    t.stale = false;
    const cv = t.canvas, w = Math.max(50, Math.round(r.width * dpr)), hgt = Math.max(50, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
    const cam = { ...cmp.cam, zoom: (cmp.radius * 1.95) / Math.min(w, hgt) / cmp.fit };
    app.gl.drawMeshes(t.ctx, w, hgt, cam, [{ mesh: t.item.mesh, color: [0.96, 0.62, 0.68], opacity: 1 }], cmp.radius * 2, null);
  }
}
function closeCompare(keepTile) {
  cmp.run++; cmp.others = null; // anything still being built is ignored when it arrives
  for (const t of cmp.tiles) if (t !== keepTile && t.item && t.item.mesh) app.gl.freeMesh(t.item.mesh);
  cmp.tiles = []; cmp.queue = [];
  $('#compare').hidden = true;
  $('#cmp-grid').textContent = '';
}
function chooseCompare(tile, asDefault) {
  const vol = cmp.vol, stack = vol.stack, v = tile.variant;
  const preset = MR_PRESETS.find((p) => JSON.stringify(Object.entries(p.set).sort()) === JSON.stringify(Object.entries(v.set).sort()));
  const raw = { ...MR_DEFAULT, ...v.set, preset: preset ? preset.key : 'custom' };
  const how = v.model || 'classic';
  if (asDefault && how === 'classic') store.set(kindKey(stack), JSON.stringify(raw));
  // the finish and the grid are part of the look, so the panel takes them over too
  const fin = CMP_FINISH[v.finish || 'clean'];
  $('#seg-finish').value = fin.name;
  showFinish(fin.values);
  store.set('finish', JSON.stringify({ name: fin.name, values: fin.values }));
  if (v.voxel) $('#seg-detail').value = String(v.voxel);
  const prev = stack.models;
  if (prev) for (const it of prev.items) if (it.mesh) app.gl.freeMesh(it.mesh);
  const t = TARGETS.find((x) => x.key === 'brain');
  stack.models = { labels: tile.result.labels, items: [{ ...tile.item, name: t.name, color: [...t.color], opacity: t.opacity, visible: true, how: stack.unit === 'HU' ? null : foundBy(tile.result.used) }] };
  stack.mrUsed = tile.result.used || stack.mrUsed;
  stack.preview = null;
  closeCompare(tile);
  if (app.volume === vol) {
    setMethod(how, v.ai || AI_DEFAULT, asDefault);
    if (how === 'classic') applyMr(raw, false);
    renderModels();
    setR3('show', 'models');
  } else store.set('mr.' + stack.id, JSON.stringify(raw));
  toast(asDefault ? `Using “${v.label}” here, and from now on as the starting point for every ${kindName(stack)} scan.` : `Using “${v.label}” for this series.`);
}
/** Add versions to the grid and start building them. */
function addCompare(variants) {
  const vol = cmp.vol, stack = vol.stack, run = cmp.run, name = kindName(stack), grid = $('#cmp-grid');
  const tried = stack.triedVariants || (stack.triedVariants = new Set());
  let first = null;
  for (const variant of variants) {
    tried.add(variantKey(variant));
    const sec = cmp.sec[variant.model ? 'ai' : 'classic'];
    const canvas = h('canvas', {}), status = h('div', { class: 'cmp-status' }, 'Waiting…'), why = variantWhy(variant);
    const tile = { variant, canvas, ctx: canvas.getContext('2d'), status, item: null, result: null };
    const use = h('button', { class: 'btn primary', disabled: '', onclick: () => chooseCompare(tile, false) }, 'Use this one');
    const def = h('button', { class: 'btn', disabled: '', title: `Use it here, and start every ${name} scan with these settings from now on. “Back to automatic” in the fine-tuning panel undoes it for one series; “Forget my default” removes it.`, onclick: () => chooseCompare(tile, true) }, `Use, and make my default for ${name} scans`);
    tile.buttons = [use, def];
    tile.el = h('div', { class: 'cmp-tile' }, h('div', { class: 'cmp-view' }, canvas, status), h('div', { class: 'cmp-name', title: variant.label }, variant.label), h('div', { class: 'cmp-why', title: why }, why), h('div', { class: 'cmp-actions' }, use, def));
    sec.grid.append(tile.el);
    sec.count++;
    cmp.tiles.push(tile); cmp.queue.push(tile);
    first = first || tile;
  }
  $('#cmp-title').textContent = `${stack.title}: ${cmp.tiles.length} ways to build the brain`;
  for (const s of Object.values(cmp.sec)) s.head.querySelector('small').textContent = s.count ? `${s.count} versions` : s.none;
  // How many to build at once. The machine's cores are shared out: every build gets
  // a few threads of its own (a fine-grid build twice as many), and builds are
  // started while threads are free. Many small builds side by side finish sooner
  // than a few big ones, but one thread each is slow for the fine grids.
  // Memory is the other limit: a build needs a couple of dozen copies of its grid.
  // The browser does not say how much memory the machine has, so the budget goes by
  // the number of cores (big machines have both). A build that fails is tried once
  // more by itself, with all the threads.
  const cores = navigator.hardwareConcurrency || 4;
  const THREADS = Math.max(1, cores > 8 ? cores - 4 : cores - 1), PER = Math.min(THREADS, 4);
  const need = (v) => (v.solo ? THREADS : Math.min(THREADS, (v.voxel && v.voxel < 1 ? 2 : 1) * PER));
  const BUDGET = 8e9 * Math.max(1, Math.min(4, cores / 8));
  const mm3 = vol.nx * vol.ny * vol.nz * vol.spacing[0] * vol.spacing[1] * vol.spacing[2];
  const cost = (v) => (v.solo ? BUDGET : mm3 / (v.voxel || Number($('#seg-detail').value)) ** 3 * 4 * 28);
  const prog = () => {
    const n = cmp.tiles.length;
    $('#cmp-progress').textContent = cmp.done < n ? `${cmp.done} of ${n} ready…` : `All ${n} ready. Drag any picture to turn them all; scroll for more.`;
    $('#cmp-more').disabled = cmp.done < n;
  };
  const runOne = async (tile) => {
    const v = tile.variant;
    tile.status.textContent = 'Building…';
    try {
      const how = v.model === 'auto' ? autoModel(stack) : v.model || 'classic';
      const opts = buildOptions(stack, ['brain'], how === 'classic' ? { model: how, ...mrFromRaw({ ...MR_DEFAULT, ...v.set }) } : aiFromRaw(how, { ...AI_DEFAULT, ...(v.ai || {}) }));
      if (opts.mr.study) opts.others = await (cmp.others || (cmp.others = studyVolumes(stack)));
      opts.finish = { ...CMP_FINISH[v.finish || 'clean'].values };
      if (v.voxel) opts.voxel = v.voxel;
      // a build that never answers (its worker died without a word) must not hold up the rest
      const result = await Promise.race([
        buildModels(vol, { ...opts, alone: need(v) < 2, helpers: need(v) - 1 }, (p, text) => { if (run === cmp.run) tile.status.textContent = text; }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 300000)),
      ]);
      if (run !== cmp.run) return;
      tile.result = result; tile.item = result.items[0];
      if (!tile.item.mesh) tile.status.textContent = tile.item.note || 'Nothing found with these settings';
      else {
        tile.status.textContent = `${Math.round(tile.item.volumeMl)} mL · ${Math.round(tile.item.mesh.indices.length / 3000)}k triangles`;
        tile.status.classList.add('done');
        for (const b of tile.buttons) b.disabled = false;
      }
      if (tile.item.mesh && !cmp.cam) { // frame the first brain that arrives; the rest use the same view
        const p = tile.item.mesh.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < lo[c]) lo[c] = p[i + c]; if (p[i + c] > hi[c]) hi[c] = p[i + c]; }
        cmp.radius = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.8;
        cmp.cam = { center: [0, 1, 2].map((c) => (lo[c] + hi[c]) / 2) };
        cmpLook('L');
      }
    } catch (err) {
      console.warn(err);
      if (run !== cmp.run) return;
      // most likely the browser ran short of memory with several builds going: try once more, by itself
      if (!v.solo) { v.solo = true; tile.status.textContent = 'Waiting to try again…'; cmp.queue.push(tile); cmp.done--; }
      else tile.status.textContent = 'Could not build this one';
    }
  };
  // cmp.busy: builds running; cmp.used: threads they hold; cmp.load: memory they are counted for
  const pump = () => {
    if (run !== cmp.run) return;
    while (cmp.queue.length) {
      const v = cmp.queue[0].variant, c = cost(v), n = need(v);
      if (cmp.busy && (cmp.used + n > THREADS || cmp.load + c > BUDGET)) break;
      const tile = cmp.queue.shift();
      cmp.busy++; cmp.used += n; cmp.load += c;
      runOne(tile).then(() => {
        if (run !== cmp.run) return;
        cmp.busy--; cmp.used -= n; cmp.load -= c; cmp.done++;
        prog(); drawCompare();
        if (!cmp.busy && !cmp.queue.length) app.compareDone = true; else pump();
      });
    }
  };
  app.compareDone = false;
  prog();
  pump();
  return first;
}
function openCompare() {
  const vol = app.volume;
  if (!vol || app.building || vol.stack.unit === 'HU') return;
  cmp.run++; cmp.others = null;
  Object.assign(cmp, { vol, cam: null, fit: 1, tiles: [], queue: [], busy: 0, used: 0, load: 0, done: 0 });
  $('#compare').hidden = false;
  // two groups, each with its own heading: what the AI models make, and what the classic method makes
  const grid = $('#cmp-grid');
  grid.textContent = '';
  // each group folds away with a click on its heading
  const section = (title, none) => {
    const s = { head: h('summary', { title: 'Click to fold this group away or bring it back' }, title, h('small', {}, '')), grid: h('div', { class: 'cmp-sec' }), count: 0, none };
    const box = h('details', { class: 'cmp-group', open: '' }, s.head, s.grid);
    box.addEventListener('toggle', () => drawCompare());
    grid.append(box);
    return s;
  };
  cmp.sec = {
    ai: section('AI models', app.gpuOK ? '' : 'not available here: they need WebGPU (a current Chrome or Edge with a graphics card)'),
    classic: section('Classic method (outline and folds)', ''),
  };
  addCompare(app.gpuOK ? [...AI_VARIANTS, ...MR_VARIANTS] : MR_VARIANTS);
}
function initCompare() {
  $('#btn-compare').onclick = openCompare;
  $('#cmp-close').onclick = () => closeCompare();
  $('#cmp-more').onclick = () => {
    const more = app.gpuOK ? [...freshAiVariants(cmp.vol.stack, 15), ...freshVariants(cmp.vol.stack, 15)] : freshVariants(cmp.vol.stack, 30);
    for (const s of Object.values(cmp.sec)) s.grid.parentElement.open = true;
    if (!more.length) return toast('Every combination has been tried on this series.');
    const first = addCompare(more);
    if (first) first.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  for (const b of document.querySelectorAll('#cmp-look button')) b.onclick = () => cmpLook(b.dataset.v);
  const grid = $('#cmp-grid');
  let drag = null;
  grid.addEventListener('pointerdown', (e) => { if (e.target.tagName === 'CANVAS' && cmp.cam) { drag = [e.clientX, e.clientY]; e.target.setPointerCapture(e.pointerId); } });
  grid.addEventListener('pointermove', (e) => {
    if (!drag || !cmp.cam) return;
    const dx = e.clientX - drag[0], dy = e.clientY - drag[1], c = cmp.cam;
    drag = [e.clientX, e.clientY];
    const rot = (a, b, ang) => { const cs = Math.cos(ang), sn = Math.sin(ang); return [vec.add(vec.mul(a, cs), vec.mul(b, sn)), vec.sub(vec.mul(b, cs), vec.mul(a, sn))]; };
    [c.r, c.f] = rot(c.r, c.f, -dx * 0.008);
    [c.d, c.f] = rot(c.d, c.f, -dy * 0.008);
    c.r = vec.norm(c.r); c.d = vec.norm(vec.sub(c.d, vec.mul(c.r, vec.dot(c.d, c.r)))); c.f = vec.cross(c.r, c.d);
    drawCompare();
  });
  const end = () => { drag = null; };
  grid.addEventListener('pointerup', end); grid.addEventListener('pointercancel', end);
  // the wheel scrolls the list; hold Ctrl (or pinch) to zoom every picture
  grid.addEventListener('wheel', (e) => { if (!e.ctrlKey || e.target.tagName !== 'CANVAS') return; e.preventDefault(); cmp.fit = Math.max(0.4, Math.min(6, cmp.fit * (e.deltaY < 0 ? 1.1 : 0.9))); drawCompare(); }, { passive: false });
  grid.addEventListener('scroll', () => { if (cmp.tiles.some((t) => t.stale)) drawCompare(); });
  window.addEventListener('resize', drawCompare);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#compare').hidden) closeCompare(); });
}

/** The current model settings as a few lines of text, for pasting into a message or a note. */
function settingsText() {
  const stack = app.volume?.stack, lines = [];
  const sel = (id) => { const e = $(id); return e.options[e.selectedIndex]?.textContent.trim() || e.value; };
  const outOf = (id) => $(id).parentElement.querySelector("output").textContent.trim();
  if (stack) lines.push(`Series: ${stack.title} (${stack.unit === "HU" ? "CT" : "MRI"}, ${+app.volume.spacing[2].toFixed(1)} mm between slices)`);
  lines.push(`Detail: ${sel("#seg-detail")}`);
  const f = readFinish();
  lines.push(`Finish: ${sel("#seg-finish")} (smoothing ${f.smooth}, soften edges ${f.soften}, close gaps ${f.close}, remove thin bits ${f.open}, floating pieces: ${sel("#f-pieces")}, triangles: ${sel("#f-reduce")}, fill hollow spaces: ${f.fill ? "on" : "off"})`);
  if (stack && stack.unit === "HU") lines.push(`Bone starts at: ${$("#seg-bone").value} HU`);
  else {
    lines.push(`Brain finder: ${sel("#m-model")}`);
    if (chosenModel() !== "classic") {
      lines.push(`AI model: how sure it must be: ${outOf("#a-level")}; pad or shave: ${outOf("#a-grow")}; brain stem kept: ${outOf("#a-stump")}`);
      lines.push(`Raw: ${JSON.stringify({ voxel: Number($("#seg-detail").value), finish: f, model: chosenModel(), ai: readAiRaw() })}`);
      return lines.join(String.fromCharCode(10));
    }
    lines.push(`What looks wrong: ${sel("#m-preset")}`);
    lines.push(`Outline: ${outOf("#m-reach")}; stiffness: ${outOf("#m-stiff")}; pad or shave: ${outOf("#m-grow")}; cut off below: ${outOf("#m-bottom")}`);
    lines.push(`Fold depth: ${outOf("#m-folds")}; split the halves: ${outOf("#m-split")}; cerebellum and brain stem smooth: ${$("#m-hind").checked ? "on" : "off"}`);
    lines.push(`Blend slices: ${outOf("#m-blend")}; fluid looks: ${sel("#m-fluid")}; stop at bright fat: ${$("#m-fat").checked ? "on" : "off"}`);
    const u = stack && stack.mrUsed;
    if (u) lines.push(`Last build used: fold line ${u.level ? u.level.toFixed(2) : "-"}, cut ${u.bottom} mm below the top, outline tightened ${u.tightened}x, outline ${u.ml} mL`);
    lines.push(`Raw: ${JSON.stringify({ voxel: Number($("#seg-detail").value), finish: f, mr: readMrRaw() })}`);
  }
  return lines.join(String.fromCharCode(10));
}
async function copySettings() {
  const text = settingsText();
  try { await navigator.clipboard.writeText(text); }
  catch { // no clipboard access on plain http: fall back to the old way
    const t = h("textarea", { style: "position:fixed;opacity:0" }); t.value = text; document.body.append(t); t.select();
    try { document.execCommand("copy"); } finally { t.remove(); }
  }
  toast("Settings copied. Paste them wherever you like.");
}
/** Everything the model builder needs for this series, from the panel. */
function buildOptions(stack, keys, mr) {
  return {
    targets: keys, voxel: Number($('#seg-detail').value), boneHU: Number($('#seg-bone').value) || 300, finish: readFinish(),
    solid: Object.fromEntries([...document.querySelectorAll('#targets input[data-solid]')].map((i) => [i.dataset.solid, i.checked])),
    mr, mrInfo: { tr: stack.series.info.tr, te: stack.series.info.te, ti: stack.series.info.ti }, modality: stack.unit === 'HU' ? 'CT' : 'MR',
    contrastHint: /cta|angio|contrast| w\b|\+c/i.test(`${stack.study.desc} ${stack.series.desc}`),
  };
}
async function build() {
  const vol = app.volume; if (!vol || app.building) return;
  const keys = [...document.querySelectorAll('#targets input[data-target]:checked')].map((i) => i.dataset.target);
  if (!keys.length) return toast('Tick at least one part to create.');
  const btn = $('#btn-build'), prog = $('#seg-progress');
  app.building = true; btn.disabled = true; btn.textContent = 'Working…';
  prog.classList.add('on');
  const setProg = (p, text) => { prog.querySelector('i').style.width = `${Math.round(p * 100)}%`; prog.querySelector('span').textContent = text; };
  setProg(0, 'Preparing…');
  const stack = vol.stack;
  try {
    const opts = buildOptions(stack, keys, readMr());
    if (opts.mr.study && opts.mr.model !== 'classic') opts.others = await studyVolumes(stack, (text) => setProg(0, text));
    const fix = stack.fix && stack.fix.count ? stack.fix : null, fixVersion = fix ? fix.version : 0;
    if (fix && keys.includes('brain')) opts.fix = { data: fix.data };
    const result = await buildModels(vol, opts, setProg);
    if (stack.fix) stack.fix.built = stack.fix === fix ? fixVersion : stack.fix.version;
    const prev = stack.models;
    if (prev) for (const it of prev.items) if (it.mesh) app.gl.freeMesh(it.mesh);
    const old = new Map((prev?.items || []).map((i) => [i.key, i]));
    stack.models = {
      labels: result.labels,
      items: result.items.map((it) => {
        const t = TARGETS.find((x) => x.key === it.key), o = old.get(it.key);
        return { ...it, name: t.name, color: o ? o.color : [...t.color], opacity: o ? o.opacity : t.opacity, visible: true, how: it.key === 'brain' && opts.modality === 'MR' ? foundBy(result.used) : null };
      }),
    };
    stack.preview = null; preview.want = false; // the slices now show the finished models
    pvStatus('');
    app.lastUsed = result.used || null;
    if (result.used) { stack.mrUsed = result.used; if (app.volume && app.volume.stack === stack) showMr(readMrRaw()); }
    app.lastBuild = { seconds: result.seconds, fixed: result.fixed || 0, ...result.timing, parts: Object.fromEntries(result.items.map((i) => [i.key, i.seconds])) };
    setProg(1, `Done in ${result.seconds.toFixed(1)} s`);
    renderModels();
    showFix();
    setR3('show', 'models');
  } catch (err) {
    console.error(err);
    setProg(0, 'Could not create the models: ' + err.message);
  } finally {
    app.building = false; btn.disabled = false; btn.textContent = 'Create 3D models';
  }
}

// ------------------------------------------------------------ dialogs ------
function showDetails() {
  const s = currentStack();
  if (!s) return;
  const st = s.study, i = s.series.info, d = s.desc;
  const rows = (pairs) => `<table>${pairs.filter((p) => p[1] !== undefined && p[1] !== '' && p[1] !== null).map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`;
  const tsName = { '1.2.840.10008.1.2': 'Uncompressed', '1.2.840.10008.1.2.1': 'Uncompressed', '1.2.840.10008.1.2.2': 'Uncompressed', '1.2.840.10008.1.2.4.70': 'Lossless JPEG', '1.2.840.10008.1.2.4.57': 'Lossless JPEG', '1.2.840.10008.1.2.4.50': 'JPEG (lossy)', '1.2.840.10008.1.2.4.90': 'JPEG 2000 lossless', '1.2.840.10008.1.2.4.91': 'JPEG 2000', '1.2.840.10008.1.2.4.80': 'JPEG-LS lossless', '1.2.840.10008.1.2.5': 'RLE lossless' }[i.ts] || i.ts;
  $('#dialog-body').innerHTML = `<h2>${escapeHtml(s.title)}</h2><div class="cols"><div><h4>Study</h4>${rows([
    ['Patient', app.hideNames ? '(hidden)' : st.patient], ['Born', fmtDate(st.birth)], ['Sex', st.sex], ['Age at scan', st.age],
    ['Study', st.desc], ['Date', fmtDate(st.date)], ['Hospital', st.institution], ['Accession', st.accession]])}</div><div><h4>Series</h4>${rows([
    ['Type', i.modality], ['Series number', s.series.number], ['Body part', i.bodyPart], ['Protocol', i.protocol],
    ['Images', d.n], ['Image size', `${d.cols} × ${d.rows}`], ['Pixel size', d.ps ? `${d.ps[1].toFixed(3)} × ${d.ps[0].toFixed(3)} mm` : ''],
    ['Slice spacing', d.step ? `${d.step} mm` : ''], ['Slice thickness', d.thick ? `${d.thick} mm` : ''], ['Plane', d.plane ? PLANE_LABEL[d.plane] : ''],
    ['Stored as', tsName]])}</div><div><h4>Scanner</h4>${rows([
    ['Maker', i.manufacturer], ['Model', i.model], ['Tube voltage', i.kvp ? `${i.kvp} kV` : ''], ['Tube current', i.tubeCurrent ? `${i.tubeCurrent} mA` : ''],
    ['Reconstruction', i.kernel], ['Gantry tilt', i.tilt ? `${i.tilt}°` : ''], ['Field strength', i.field ? `${i.field} T` : ''], ['Sequence', i.sequence],
    ['TR / TE', i.tr ? `${i.tr} / ${i.te ?? '–'} ms` : ''], ['Flip angle', i.flip ? `${i.flip}°` : ''], ['Value range', Number.isFinite(s.min) ? `${Math.round(s.min)} … ${Math.round(s.max)} ${s.unit}` : '']])}</div></div>`;
  $('#dialog').showModal();
}
function showHelp() {
  $('#dialog-body').innerHTML = `<h2>How to use Viewscan</h2><div class="cols"><div>
  <h4>Looking around</h4><table>
  <tr><td>Mouse wheel</td><td>Move through the slices</td></tr><tr><td>Left drag</td><td>Whatever tool is lit up in the toolbar</td></tr>
  <tr><td>Right drag</td><td>Zoom</td></tr><tr><td>Middle drag</td><td>Move the picture</td></tr><tr><td>Ctrl + wheel</td><td>Zoom at the pointer</td></tr>
  <tr><td>Double-click</td><td>Make a panel fill the window (and back)</td></tr></table>
  <h4>Keys</h4><table>
  <tr><td><kbd>↑</kbd> <kbd>↓</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd></td><td>Previous / next slice</td></tr><tr><td><kbd>Home</kbd> <kbd>End</kbd></td><td>First / last slice</td></tr>
  <tr><td><kbd>Space</kbd></td><td>Play / pause</td></tr><tr><td><kbd>S</kbd> <kbd>W</kbd> <kbd>M</kbd> <kbd>Z</kbd> <kbd>C</kbd></td><td>Scroll, Contrast, Move, Zoom, Locate</td></tr>
  <tr><td><kbd>L</kbd> <kbd>A</kbd> <kbd>O</kbd></td><td>Length, Angle, Area</td></tr><tr><td><kbd>Del</kbd></td><td>Remove the selected measurement</td></tr>
  <tr><td><kbd>R</kbd> <kbd>I</kbd></td><td>Reset view, Invert</td></tr><tr><td><kbd>1</kbd>–<kbd>7</kbd></td><td>CT looks: Brain, Subdural, Stroke, Soft tissue, Angio, Bone, Lung</td></tr></table></div><div>
  <h4>2D images</h4><p>Shows the pictures exactly as the scanner stored them. Use 2 or 4 panels and drag series from the list to compare them.</p>
  <h4>3D &amp; models</h4><p>Rebuilds a series into a block you can slice in any of the three body planes, with a 3D view. “Locate” links the planes: click a spot in one and the others jump to it. “Slab” blends several millimeters together; the MIP setting makes contrast-filled blood vessels stand out.</p>
  <p>The <b>Colors</b> button (or the T key) hides and shows the colored tint on the slices, for when you want to see the scan itself.</p>
  <p><b>Create 3D models</b> finds bone, brain, skin and blood vessels automatically and turns each into a surface you can spin, make see-through, cut open, and save as STL or OBJ for printing or other 3D software. The parts are also tinted on the slices so you can check them.</p>
  <p>On MRI the brain is found by growing an outline from the middle of the brain until it meets the dark skull, then telling fluid from brain inside it. If something looks wrong, open <b>Fine-tune the MRI brain</b> and pick what you see under “What looks wrong?” (parts missing, skull or face stuck on, neck hanging underneath, folds filled in…). Each choice says what it changes, and the sliders are there for finer control. While the panel is open the slices are tinted live, pink for brain and blue for fluid inside the outline, so you can adjust before building the model. Scans with slices several millimeters apart give a rougher model. The two halves of the brain are split along the gap between them, and the cerebellum and brain stem are kept smooth (they are not wrinkled like the rest); “Split the halves” and “Keep the cerebellum and brain stem smooth” adjust that. Not sure which settings are best? <b>Try many versions and compare</b> builds the brain two dozen different ways and shows them side by side; pick the one that looks right, and optionally keep it as your default for that kind of scan. “Try 12 more” adds versions with settings that have not been tried yet. If the study has the same kind of scan in other planes, <b>Still blurry? Combine scans</b> appears underneath: it merges them into one scan that is sharp from every side. Try the single scan first.</p>
  <h4>Adding scans</h4><p>Put a folder of DICOM files inside the <code>viewscan</code> folder and reload, or use <b>Open folder…</b> / drag a folder onto the window. CT and MRI are supported. Files are read on this computer only; nothing is sent anywhere.</p>
  <p>A folder you open is remembered: this browser keeps its own copy, so it is still in the list next time. <b>Remove</b>, next to the project name, takes any project off the list; your own files are never touched. A folder you opened can simply be opened again, and a project from the <code>viewscan</code> folder comes back with “Bring back” at the bottom of the project list.</p>
  <p class="hint">Viewscan is for looking at your own scans. It is not a medical device and is not for diagnosis.</p></div></div>`;
  $('#dialog').showModal();
}

// --------------------------------------------------- local folders ---------
const SKIP = /\.(exe|dll|ocx|bat|txt|xml|html?|js|css|json|jpe?g|png|gif|bmp|tiff?|ico|cur|wav|pdf|ini|inf|db|sql|gz|zip|7z|md|log|stl|obj|lnk)$/i;
/** Read the headers of local files (a sparse list is fine). Shows progress on the splash. */
async function readHeaders(files) {
  const splash = $('#splash'); splash.classList.remove('hidden');
  const idx = Object.keys(files).map(Number);
  let done = 0;
  const summaries = await Promise.all(idx.map((i) => pool.run({ type: 'header', src: { file: files[i] } }, 4).then((m) => {
    $('#splash-text').textContent = `Reading scan files… ${++done} / ${idx.length}`;
    return m.summary ? { file: i, info: m.summary.info, frames: m.summary.frames } : null;
  }, () => null)));
  splash.classList.add('hidden');
  return summaries.filter(Boolean);
}
function addLocalSource(sid, name, folder, files, summaries, saved) {
  const studies = organize(summaries);
  if (!studies.length) return false;
  app.sources.set(sid, { type: 'local', files, name, folder, saved, summaries: saved ? null : summaries });
  app.studies = studies.map((st) => ({ ...st, source: sid, project: name })).concat(app.studies);
  return true;
}
/** Drop an opened folder from the list and from browser storage. */
function forgetLocal(sid) {
  app.sources.delete(sid);
  app.studies = app.studies.filter((st) => st.source !== sid);
  for (const [key, stack] of app.stacks) if (key.startsWith(sid + '|')) { pool.cancel((t) => t.stack === stack.uid); app.stacks.delete(key); }
  return removeFolder(sid).catch(() => {});
}
const sideStatus = (text) => { const el = $('#side-status'); el.textContent = text || ''; el.hidden = !text; };

async function addLocalFiles(files, name) {
  files = files.filter((f) => f.size > 132 && !SKIP.test(f.name) && f.name.toUpperCase() !== 'DICOMDIR');
  if (!files.length) return toast('No scan files found in that folder.');
  const summaries = await readHeaders(files);
  const folder = name || (files[0].webkitRelativePath || '').split('/')[0] || 'Opened folder';
  // opening the same folder again replaces the copy kept from last time
  for (const [id, src] of [...app.sources]) if (src.type === 'local' && src.folder === folder) await forgetLocal(id);
  const project = projects().includes(folder) || (app.removed || []).includes(folder) ? folder + ' (opened)' : folder; // a server project may share the name
  const sid = `local${Date.now()}`;
  if (!addLocalSource(sid, project, folder, files, summaries, false)) return toast('No DICOM images found in that folder.');
  setProject(project);
  keepFolder(sid);
}
/** Copy an opened folder into browser storage so it is still listed after a reload. */
async function keepFolder(sid) {
  const src = app.sources.get(sid);
  try {
    await saveFolder({ id: sid, name: src.name, folder: src.folder, summaries: src.summaries, files: src.files },
      (done, total) => sideStatus(`Saving a copy so this folder is still here next time… ${done} / ${total}`));
    if (app.sources.get(sid) !== src) return void removeFolder(sid).catch(() => {}); // replaced meanwhile
    src.saved = true; src.summaries = null;
    sideStatus('');
  } catch (err) {
    console.warn(err);
    sideStatus('');
    const full = err && err.name === 'QuotaExceededError';
    toast(full ? 'The browser has no room left to keep this folder, so it will need opening again after a reload. Removing an older opened folder frees space.'
      : 'This folder could not be kept for next time, so it will need opening again after a reload.');
  }
}
/** Bring back the folders kept from earlier visits. */
async function restoreFolders() {
  let folders = [];
  try { folders = await loadFolders(); } catch (err) { console.warn(err); return; }
  for (const f of folders) {
    let summaries = f.summaries;
    if (f.format !== SUMMARY_FORMAT) { // kept by an older version: read the headers again
      summaries = await readHeaders(f.files);
      updateSummaries(f.id, summaries).catch(() => {});
    }
    addLocalSource(f.id, f.name, f.folder || f.name, f.files, summaries, true);
  }
}
async function forgetCurrent() {
  const sid = currentStudies()[0]?.source, src = app.sources.get(sid);
  if (!src) return;
  if (src.type === 'local') {
    if (!confirm(`Remove “${src.name}” from Viewscan?\n\nOnly the copy saved in Viewscan is removed. The files on your disk are not touched.`)) return;
    await forgetLocal(sid);
  } else {
    if (!confirm(`Remove “${app.project}” from the list?\n\nThe scan files are not touched. To get it back, pick “Bring back” at the bottom of the project list.`)) return;
    store.set('hidden', JSON.stringify([...new Set([...hiddenProjects(), app.project])]));
  }
  location.reload(); // start clean: views and 3D models of the removed folder go with it
}
async function entriesToFiles(items) {
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of items) if (e) await walk(e);
  return out;
}

// --------------------------------------------------------------- wiring ----
function init() {
  buildViews(); buildToolbar(); initFix();
  for (const b of document.querySelectorAll('#mode-switch button')) b.onclick = () => setMode(b.dataset.mode);
  $('#btn-details').onclick = showDetails;
  $('#btn-help').onclick = showHelp;
  $('#btn-open').onclick = () => $('#folder-input').click();
  $('#folder-input').onchange = (e) => { addLocalFiles([...e.target.files]); e.target.value = ''; };
  $('#btn-build').onclick = build;
  $('#btn-forget').onclick = forgetCurrent;
  initFinish();
  initMr();
  initCompare();
  $("#btn-copy-settings").onclick = copySettings;
  $('#r3-iso').oninput = (e) => setIso(e.target.value);
  for (const key of ['show', 'mode']) for (const b of document.querySelectorAll(`#r3-${key} button`)) b.onclick = () => setR3(key, b.dataset.v);
  for (const b of document.querySelectorAll('#r3-look button')) b.onclick = () => app.views.find((v) => v.kind === '3d')?.look(b.dataset.v);
  app.cut.follow = store.get('cutfollow', '') === '1';
  const showFollow = () => { $('#cut-follow').checked = app.cut.follow; $('#cut-axis').disabled = $('#cut-pos').disabled = app.cut.follow; };
  showFollow();
  $('#cut-follow').onchange = (e) => {
    app.cut.follow = e.target.checked;
    store.set('cutfollow', app.cut.follow ? '1' : '');
    showFollow();
    if (app.cut.follow && app.r3d.show !== 'models' && app.meshItems().length) setR3('show', 'models');
    app.redrawAll();
  };
  $('#cut-axis').onchange = (e) => {
    app.cut.axis = e.target.value;
    if (app.cut.axis && app.r3d.show !== 'models' && app.meshItems().length) setR3('show', 'models');
    app.redrawAll();
  };
  $('#cut-pos').oninput = (e) => {
    app.cut.pos = e.target.value / 100;
    if (!app.cut.axis) { app.cut.axis = 'S'; $('#cut-axis').value = 'S'; } // moving the slider switches cut-away on
    if (app.r3d.show !== 'models' && app.meshItems().length) setR3('show', 'models');
    app.redrawAll();
  };
  display.leftOnLeft = store.get('leftonleft', '') === '1';
  updateToolbar();
  app.showOverlay = store.get('overlay', '1') === '1';
  $('#show-overlay').checked = app.showOverlay;
  $('#show-overlay').onchange = (e) => { if (e.target.checked !== app.showOverlay) toggleOverlay(); };

  // sidebar: project picker, sorting, width
  app.project = store.get('project', '');
  app.sort = store.get('sort', 'scan');
  app.only3d = store.get('only3d', '') === '1';
  $('#sort').value = app.sort;
  $('#only3d').checked = app.only3d;
  $('#project').onchange = (e) => {
    const v = e.target.value;
    if (!v.startsWith(BRING_BACK)) return setProject(v);
    const name = v.slice(BRING_BACK.length);
    store.set('hidden', JSON.stringify(hiddenProjects().filter((p) => p !== name)));
    store.set('project', name);
    location.reload();
  };
  $('#sort').onchange = (e) => { app.sort = e.target.value; store.set('sort', app.sort); renderLibrary(); };
  $('#only3d').onchange = (e) => { app.only3d = e.target.checked; store.set('only3d', app.only3d ? '1' : ''); renderLibrary(); };
  const setSide = (px) => {
    const w = Math.round(Math.max(190, Math.min(Math.min(720, window.innerWidth * 0.6), px)));
    $('#app').style.setProperty('--side', `${w}px`);
    for (const row of document.querySelectorAll('.series')) row.classList.toggle('wide', w >= 340);
    return w;
  };
  setSide(Number(store.get('side', 272)) || 272);
  const grip = $('#side-resize');
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
    const move = (ev) => store.set('side', setSide(ev.clientX));
    const up = () => { grip.classList.remove('drag'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    e.preventDefault();
  });
  grip.addEventListener('dblclick', () => store.set('side', setSide(272)));

  let dragDepth = 0;
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (isFiles(e)) { dragDepth++; $('#drop-hint').classList.add('on'); } });
  window.addEventListener('dragleave', (e) => { if (isFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-hint').classList.remove('on'); } });
  window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#drop-hint').classList.remove('on');
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.());
    const first = entries.find(Boolean);
    addLocalFiles(entries.some(Boolean) ? await entriesToFiles(entries) : [...e.dataTransfer.files], first && first.isDirectory ? first.name : undefined);
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && app.mode === '3d' && app.tool === 'fix' && !e.target.matches('input, select, textarea')) { fixUndo(); e.preventDefault(); return; }
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey || $('#dialog').open) return;
    const v = app.active;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const tools = { s: 'scroll', w: 'wl', m: 'pan', z: 'zoom', c: 'cross', l: 'length', a: 'angle', o: 'roi' };
    if (tools[k]) { if (k !== 'c' || app.mode === '3d') setTool(tools[k]); }
    else if (k === 'ArrowUp' || k === 'PageUp' || k === 'ArrowLeft') v?.scroll(-1);
    else if (k === 'ArrowDown' || k === 'PageDown' || k === 'ArrowRight') v?.scroll(1);
    else if (k === 'Home') v?.scroll(-1e6);
    else if (k === 'End') v?.scroll(1e6);
    else if (k === ' ') toggleCine();
    else if (k === 'r') resetView();
    else if (k === 'i') invert();
    else if (k === 't' && app.mode === '3d') toggleOverlay();
    else if (k === 'f' && app.mode === '3d') setTool('fix');
    else if ((k === '[' || k === ']') && app.tool === 'fix') fixSize(k === ']' ? 1 : -1);
    else if (k === 'Delete' || k === 'Backspace') {
      const s = currentStack();
      if (s && app.selected) { const i = s.annots.indexOf(app.selected); if (i >= 0) s.annots.splice(i, 1); app.selected = null; app.redrawAll(); }
    } else if (/^[1-7]$/.test(k) && currentStack()?.unit === 'HU') applyPreset(CT_PRESETS[Number(k) - 1][0]);
    else return;
    e.preventDefault();
  });
  // folders kept from earlier visits come back first, so the last project can reopen
  let loaded = false;
  const start = () => { if (!loaded) { loaded = true; loadLibrary(); } };
  restoreFolders().then(() => {
    if (app.libraryLoaded) { // storage answered late: show the folders now, and go back to the last project if it was one of them
      const want = store.get('project', '');
      if (want !== app.project && projects().includes(want)) setProject(want); else renderLibrary();
    }
    start();
  });
  setTimeout(start, 4000); // never wait long on browser storage
}
init();
