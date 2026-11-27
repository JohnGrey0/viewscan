// views.js — the interactive panels: StackView (original 2-D images),
// SliceView (a reformatted plane through a volume) and View3D.

import { vec, orientLetters, display } from './volume.js';

const { add, sub, mul, dot, cross, norm } = vec;
export const PLANE_COLOR = { AX: '#ff6b6b', COR: '#4ade80', SAG: '#fbbf24' };
const PLANE_TITLE = { AX: 'Axial', COR: 'Coronal', SAG: 'Sagittal' };
const MEASURE_TOOLS = new Set(['length', 'angle', 'roi']);
const ANNOT_COLOR = { length: '#facc15', angle: '#67e8f9', roi: '#86efac' };

const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
export function fmtDate(d) { return d && d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d || ''); }

// ------------------------------------------------------------------ base ----
export class ViewBase {
  constructor(app, host) {
    this.app = app;
    this.el = el('div', 'view', host);
    this.canvas = el('canvas', '', this.el);
    this.ctx = this.canvas.getContext('2d');
    this.ov = {};
    for (const k of ['tl', 'tr', 'bl', 'br']) this.ov[k] = el('div', `ov ov-${k}`, this.el);
    this.or = {};
    for (const k of ['top', 'bottom', 'left', 'right']) this.or[k] = el('div', `orient orient-${k}`, this.el);
    this.msg = el('div', 'view-msg', this.el);
    this.w = this.h = 1; this.dpr = 1;
    this.drag = null; this.pendingAngle = null; this.probe = '';
    this.raf = 0;
    const c = this.el;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => { this.probe = ''; this.updateProbe(); if (this.brushAt) { this.brushAt = null; this.invalidate(); } });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => app.toggleMax(this));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }
  destroy() { this.ro.disconnect(); cancelAnimationFrame(this.raf); this.el.remove(); this.detach?.(); }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.el.clientWidth * dpr)), h = Math.max(1, Math.round(this.el.clientHeight * dpr));
    if (w === this.w && h === this.h && this.canvas.width === w) return;
    const first = this.w <= 1;
    const old = [this.w, this.h];
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = w; this.canvas.height = h;
    this.onResize(first, old);
    this.draw();
  }
  onResize() {}
  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }
  pos(e) { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; }
  setMsg(t) { this.msg.textContent = t || ''; this.msg.style.display = t ? '' : 'none'; }
  updateProbe() { this.ov.br.textContent = this.probe; }

  // ---- pointer handling ----
  actionFor(e) {
    if (e.button === 1) return 'pan';
    if (e.button === 2) return 'zoom';
    if (e.shiftKey) return 'pan';
    if (e.ctrlKey) return 'zoom';
    return this.leftTool();
  }
  leftTool() { return this.app.tool; }
  onDown(e) {
    this.app.activate(this);
    if (e.pointerType === 'mouse' && e.button > 2) return;
    this.el.setPointerCapture(e.pointerId);
    const [x, y] = this.pos(e);
    const action = this.actionFor(e);
    this.drag = { action, x, y, x0: x, y0: y, moved: 0 };
    if (MEASURE_TOOLS.has(action) && this.canMeasure()) this.annotDown(action, x, y);
    else if (action === 'cross') this.setCross(x, y);
    else if (action === 'fix') this.fixStroke?.(x, y, true);
    e.preventDefault();
  }
  onMove(e) {
    const [x, y] = this.pos(e);
    const d = this.drag;
    if (!d) { this.hover(x, y); return; }
    const dx = x - d.x, dy = y - d.y;
    d.x = x; d.y = y; d.moved += Math.abs(dx) + Math.abs(dy);
    switch (d.action) {
      case 'pan': this.pan(dx, dy); break;
      case 'zoom': this.zoomAt(Math.exp(-dy * 0.006 / this.dpr), d.x0, d.y0); break;
      case 'wl': this.windowDrag(dx / this.dpr, dy / this.dpr); break;
      case 'scroll': d.acc = (d.acc || 0) + dy / this.dpr; { const n = Math.trunc(d.acc / 6); if (n) { d.acc -= n * 6; this.scroll(n); } } break;
      case 'cross': this.setCross(x, y); break;
      case 'fix': this.fixStroke?.(x, y, false); break;
      case 'rotate': this.rotate(dx / this.dpr, dy / this.dpr); break;
      default: if (d.annot) this.annotMove(x, y);
    }
    this.hover(x, y);
  }
  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.annot) this.annotUp(d);
    if (d.action === 'fix') this.fixDone?.();
    this.dragEnd?.(d);
  }
  onWheel(e) {
    e.preventDefault();
    this.app.activate(this);
    const [x, y] = this.pos(e);
    if (e.ctrlKey || this.wheelZooms) this.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
    else this.scroll(e.deltaY > 0 ? 1 : -1);
  }
  hover() {}
  pan() {} zoomAt() {} scroll() {} setCross() {} rotate() {}
  canMeasure() { return false; }

  windowDrag(dx, dy) {
    const d = this.displayState();
    if (!d) return;
    const k = Math.max(d.ww, 16) / 260;
    d.ww = Math.max(1, d.ww + dx * k);
    d.wc += dy * k;
    d.provisional = false;
    this.app.displayChanged();
  }
  displayState() { return null; }

  // ---- measurements (stored in "plane" coordinates of the owning view kind) ----
  annots() { return []; }
  visibleAnnots() { const key = this.sliceKey(); return this.annots().filter((a) => a.space === this.space && a.key === key); }
  hitHandle(x, y) {
    const r = 9 * this.dpr;
    for (const a of this.visibleAnnots()) {
      for (let i = 0; i < a.pts.length; i++) {
        const [sx, sy] = this.planeToScreen(a.pts[i][0], a.pts[i][1]);
        if (Math.hypot(sx - x, sy - y) < r) return { a, i };
      }
    }
    return null;
  }
  annotDown(type, x, y) {
    const d = this.drag, p = this.screenToPlane(x, y);
    const hit = this.hitHandle(x, y);
    if (hit) { d.annot = hit.a; d.idx = hit.i; this.app.selected = hit.a; return; }
    if (this.pendingAngle && this.annots().includes(this.pendingAngle)) {
      d.annot = this.pendingAngle; d.idx = 2; d.annot.pts[2] = p; this.pendingAngle = null;
      this.annotChanged(d.annot); return;
    }
    const a = { type, space: this.space, key: this.sliceKey(), pts: type === 'angle' ? [p, [...p], [...p]] : [p, [...p]], text: '' };
    this.annots().push(a);
    d.annot = a; d.idx = 1; d.fresh = true;
    this.app.selected = a;
  }
  annotMove(x, y) {
    const d = this.drag, a = d.annot;
    a.pts[d.idx] = this.screenToPlane(x, y);
    if (a.type === 'angle' && d.fresh) a.pts[2] = [...a.pts[1]];
    this.annotChanged(a);
  }
  annotUp(d) {
    const a = d.annot;
    if (d.fresh && d.moved < 4 * this.dpr) { // a click, not a drag: discard
      const list = this.annots(); list.splice(list.indexOf(a), 1);
    } else if (d.fresh && a.type === 'angle') this.pendingAngle = a;
    this.annotChanged(a);
  }
  annotChanged(a) {
    const s = this.planeScale(); // mm per plane unit, or null
    const unit = s ? 'mm' : 'px';
    const sc = s || [1, 1];
    const dist = (p, q) => Math.hypot((p[0] - q[0]) * sc[0], (p[1] - q[1]) * sc[1]);
    if (a.type === 'length') {
      a.text = `${fmt(dist(a.pts[0], a.pts[1]), 1)} ${unit}`;
    } else if (a.type === 'angle') {
      const v1 = [(a.pts[0][0] - a.pts[1][0]) * sc[0], (a.pts[0][1] - a.pts[1][1]) * sc[1]];
      const v2 = [(a.pts[2][0] - a.pts[1][0]) * sc[0], (a.pts[2][1] - a.pts[1][1]) * sc[1]];
      const l = Math.hypot(...v1) * Math.hypot(...v2);
      a.text = l > 0 ? `${fmt(Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / l))) * 180 / Math.PI, 1)}°` : '';
    } else if (a.type === 'roi') {
      const cx = (a.pts[0][0] + a.pts[1][0]) / 2, cy = (a.pts[0][1] + a.pts[1][1]) / 2;
      const rx = Math.abs(a.pts[1][0] - a.pts[0][0]) / 2, ry = Math.abs(a.pts[1][1] - a.pts[0][1]) / 2;
      let n = 0, sum = 0, sq = 0, lo = Infinity, hi = -Infinity;
      if (rx > 0 && ry > 0) {
        const step = Math.max(this.roiStep(), Math.sqrt((4 * rx * ry) / 40000));
        for (let y = cy - ry; y <= cy + ry; y += step) {
          for (let x = cx - rx; x <= cx + rx; x += step) {
            if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
            const v = this.valueAt(x, y);
            if (!Number.isFinite(v)) continue;
            n++; sum += v; sq += v * v; if (v < lo) lo = v; if (v > hi) hi = v;
          }
        }
      }
      if (n) {
        const mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
        const u = this.unit() ? ' ' + this.unit() : '';
        const area = Math.PI * rx * sc[0] * ry * sc[1];
        a.text = `mean ${fmt(mean)}${u} ± ${fmt(sd)}\nmin ${fmt(lo, 0)} max ${fmt(hi, 0)}\n${s ? fmt(area / 100, 2) + ' cm²' : fmt(area, 0) + ' px²'}`;
      } else a.text = '';
    }
    this.app.redrawAll();
  }
  drawAnnots() {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `600 ${13 * dpr}px system-ui, sans-serif`;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const a of this.visibleAnnots()) {
      const P = a.pts.map((p) => this.planeToScreen(p[0], p[1]));
      const col = ANNOT_COLOR[a.type];
      const stroke = (path) => {
        ctx.lineWidth = 4 * dpr; ctx.strokeStyle = 'rgba(0,0,0,.55)'; path(); ctx.stroke();
        ctx.lineWidth = (a === this.app.selected ? 2.2 : 1.5) * dpr; ctx.strokeStyle = col; path(); ctx.stroke();
      };
      let lx, ly;
      if (a.type === 'roi') {
        const cx = (P[0][0] + P[1][0]) / 2, cy = (P[0][1] + P[1][1]) / 2;
        const rx = Math.abs(P[1][0] - P[0][0]) / 2, ry = Math.abs(P[1][1] - P[0][1]) / 2;
        stroke(() => { ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2); });
        lx = cx + rx + 8 * dpr; ly = cy - ry;
      } else {
        stroke(() => { ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]); });
        const q = a.type === 'angle' ? P[1] : P[P.length - 1];
        lx = q[0] + 10 * dpr; ly = q[1] - 10 * dpr;
      }
      for (const p of P) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 3.2 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = dpr; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke();
      }
      if (a.text) {
        const lines = a.text.split('\n');
        const wd = Math.max(...lines.map((l) => ctx.measureText(l).width));
        lx = Math.min(lx, this.w - wd - 8 * dpr); ly = Math.max(ly, 16 * dpr);
        ctx.fillStyle = 'rgba(8,12,20,.72)';
        ctx.fillRect(lx - 4 * dpr, ly - 13 * dpr, wd + 8 * dpr, lines.length * 16 * dpr + 3 * dpr);
        ctx.fillStyle = col;
        lines.forEach((l, i) => ctx.fillText(l, lx, ly + i * 16 * dpr));
      }
    }
  }
  drawScaleBar(pxPerMm) {
    if (!pxPerMm) return;
    const ctx = this.ctx, dpr = this.dpr;
    const target = this.h * 0.3 / pxPerMm; // mm that would fill 30% of the height
    const nice = [1, 2, 5, 10, 20, 50, 100, 200].reduce((b, v) => (v <= target ? v : b), 1);
    const len = nice * pxPerMm, x = this.w - 14 * dpr, y0 = (this.h - len) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + len);
    const ticks = nice >= 10 ? nice / (nice % 20 === 0 || nice === 10 ? 10 : 5) : nice;
    const n = Math.round(nice / ticks);
    for (let i = 0; i <= n; i++) { const y = y0 + (len * i) / n; ctx.moveTo(x, y); ctx.lineTo(x - (i % 5 === 0 || i === n ? 8 : 4) * dpr, y); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = `${11 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'right';
    ctx.fillText(nice >= 10 ? `${nice / 10} cm` : `${nice} mm`, x, y0 - 6 * dpr); ctx.textAlign = 'left';
  }
  setOrient(right, down) {
    const set = (k, v) => { this.or[k].textContent = v ? orientLetters(v) : ''; };
    set('right', right); set('left', right && mul(right, -1)); set('bottom', down); set('top', down && mul(down, -1));
  }
}

// ----------------------------------------------------------------- stack ----
export class StackView extends ViewBase {
  constructor(app, host) {
    super(app, host);
    this.kind = 'stack'; this.space = 'img';
    this.stack = null; this.index = 0;
    this.zoom = 1; this.panX = 0; this.panY = 0; this.rot = 0; this.flip = false; this.fitted = false;
    this.off = document.createElement('canvas'); this.offKey = '';
    this.el.classList.add('view-stack');
  }
  detach() { this.unsub?.(); }
  setStack(stack) {
    this.unsub?.();
    this.stack = stack;
    this.offKey = ''; this.fitted = false; this.rot = 0; this.flip = false;
    if (stack) {
      this.index = stack.n >> 1;
      this.unsub = stack.on((kind, i) => {
        if (kind === 'done' || i === this.index || this.shown !== this.index) this.invalidate();
        else this.updateLoadMsg();
      });
      stack.load(this.index, 0);
    }
    this.fit();
    this.invalidate();
  }
  spacing() { const f = this.stack && this.stack.frames[this.index]; return (f && f.ps) || (this.stack && this.stack.desc.ps) || null; }
  fit() {
    const s = this.stack;
    if (!s) return;
    const ps = this.spacing() || [1, 1];
    const wmm = s.cols * ps[1], hmm = s.rows * ps[0];
    const [a, b] = this.rot % 2 ? [hmm, wmm] : [wmm, hmm];
    this.zoom = Math.min(this.w / a, this.h / b) * 0.98;
    this.fitZoom = this.zoom; this.panX = 0; this.panY = 0; this.fitted = true;
  }
  onResize(first, old) {
    if (!this.stack) return;
    if (first || Math.abs(this.zoom - this.fitZoom) < 1e-6) this.fit();
    else { const k = Math.min(this.w / old[0], this.h / old[1]); this.zoom *= k; this.panX *= k; this.panY *= k; this.fitZoom = null; }
  }
  reset() { this.rot = 0; this.flip = false; this.fit(); this.invalidate(); }
  /** Mirrored? The Flip button, or "left on left" for a picture whose columns run toward the patient's left. */
  flipped() {
    const f = this.stack && this.stack.frames[this.index], iop = (f && f.iop) || (this.stack && this.stack.desc.iop);
    const auto = !!(display.leftOnLeft && iop && iop[0] > 0.7);
    return this.flip !== auto;
  }
  matrix() {
    const s = this.stack, ps = this.spacing() || [1, 1];
    return new DOMMatrix()
      .translate(this.w / 2 + this.panX, this.h / 2 + this.panY)
      .scale(this.zoom).rotate(this.rot * 90).scale(this.flipped() ? -1 : 1, 1)
      .scale(ps[1], ps[0]).translate(-s.cols / 2, -s.rows / 2);
  }
  screenToPlane(x, y) { const p = this.matrix().inverse().transformPoint({ x, y }); return [p.x, p.y]; }
  planeToScreen(a, b) { const p = this.matrix().transformPoint({ x: a, y: b }); return [p.x, p.y]; }
  planeScale() { const ps = this.spacing(); return ps ? [ps[1], ps[0]] : null; }
  roiStep() { return 1; }
  sliceKey() { return this.index; }
  unit() { return this.stack ? this.stack.unit : ''; }
  annots() { return this.stack ? this.stack.annots : []; }
  canMeasure() { return !!this.stack; }
  displayState() { return this.stack && !this.stack.color ? this.stack.display : null; }
  leftTool() { return this.app.tool === 'cross' ? 'probe' : this.app.tool; }
  valueAt(a, b) {
    const s = this.stack, f = s && s.frames[this.index];
    if (!f || !f.data || f.color) return NaN;
    const i = Math.floor(a), j = Math.floor(b);
    if (i < 0 || j < 0 || i >= s.cols || j >= s.rows) return NaN;
    return f.data[j * s.cols + i];
  }
  hover(x, y) {
    if (!this.stack) return;
    const [a, b] = this.screenToPlane(x, y);
    const v = this.valueAt(a, b);
    this.probe = Number.isFinite(v) ? `${fmt(v, Number.isInteger(v) ? 0 : 1)} ${this.unit()}  ·  x ${Math.floor(a)}  y ${Math.floor(b)}` : '';
    this.updateProbe();
  }
  pan(dx, dy) { this.panX += dx; this.panY += dy; this.fitZoom = null; this.invalidate(); }
  zoomAt(f, x, y) {
    const nz = Math.min(200, Math.max(0.02, this.zoom * f)); f = nz / this.zoom;
    const cx = this.w / 2 + this.panX, cy = this.h / 2 + this.panY;
    this.panX += (x - cx) * (1 - f); this.panY += (y - cy) * (1 - f);
    this.zoom = nz; this.fitZoom = null; this.invalidate();
  }
  scroll(n, wrap = false) {
    if (!this.stack) return;
    let i = this.index + n;
    i = wrap ? ((i % this.stack.n) + this.stack.n) % this.stack.n : Math.max(0, Math.min(this.stack.n - 1, i));
    if (i !== this.index) { this.index = i; this.invalidate(); this.app.sliceChanged(this); }
  }
  setIndex(i) { this.scroll(i - this.index); }
  updateLoadMsg() {
    const s = this.stack;
    if (!s) return this.setMsg('');
    const f = s.frames[this.index];
    if (f && f.error) return this.setMsg(f.error);
    this.setMsg(s.loaded < s.n ? `Loading ${s.loaded} / ${s.n}` : '');
  }
  renderFrame(f) {
    const s = this.stack, d = s.display, off = this.off;
    const key = f.color ? `c${this.shown}` : `${this.shown}|${d.wc}|${d.ww}|${d.invert}|${s.buffer.constructor.name}`;
    if (key === this.offKey) return;
    this.offKey = key;
    if (off.width !== s.cols || off.height !== s.rows) { off.width = s.cols; off.height = s.rows; }
    const octx = off.getContext('2d');
    const img = this.img && this.img.width === s.cols && this.img.height === s.rows ? this.img : (this.img = octx.createImageData(s.cols, s.rows));
    if (f.color) { img.data.set(f.data); octx.putImageData(img, 0, 0); return; }
    const out = new Uint32Array(img.data.buffer);
    const lo = d.wc - d.ww / 2, k = 255 / Math.max(d.ww, 1e-6), data = f.data, n = data.length;
    if (data instanceof Int16Array) {
      const mn = Math.floor(f.min), size = Math.floor(f.max) - mn + 1;
      const lut = new Uint32Array(size);
      for (let i = 0; i < size; i++) {
        let g = (i + mn - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        if (d.invert) g = 255 - g;
        lut[i] = 0xff000000 | (g << 16) | (g << 8) | g;
      }
      for (let i = 0; i < n; i++) out[i] = lut[data[i] - mn];
    } else {
      for (let i = 0; i < n; i++) {
        let g = (data[i] - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        if (d.invert) g = 255 - g;
        out[i] = 0xff000000 | (g << 16) | (g << 8) | g;
      }
    }
    octx.putImageData(img, 0, 0);
  }
  draw() {
    const ctx = this.ctx, s = this.stack;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.w, this.h);
    if (!s) { this.setMsg(this.app.emptyText()); for (const k in this.ov) this.ov[k].textContent = ''; this.setOrient(null, null); return; }
    const shown = s.nearestLoaded(this.index);
    this.shown = shown;
    this.updateLoadMsg();
    const f = shown >= 0 ? s.frames[shown] : null;
    if (f && (f.color || s.display)) {
      this.renderFrame(f);
      const m = this.matrix();
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.imageSmoothingEnabled = this.app.smooth; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.off, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.drawAnnots();
    const ps = this.spacing();
    this.drawScaleBar(ps ? this.zoom : 0);
    // overlays
    const st = s.study, d = s.display, fr = s.frames[this.index];
    this.ov.tl.innerHTML = `<b>${esc(this.app.hideNames ? 'Patient' : st.patient || 'Unknown patient')}</b>\n${esc(fmtDate(st.date))}  ${esc(st.desc)}`;
    this.ov.tr.innerHTML = `<b>${esc(s.title)}</b>\n${esc(s.series.modality)} · ${s.cols}×${s.rows}${s.series.info.lossy ? ' · lossy' : ''}`;
    const loc = fr && fr.ipp && s.desc.iop ? dot(fr.ipp, cross(s.desc.iop.slice(0, 3), s.desc.iop.slice(3))) : null;
    const bl = [`Image ${this.index + 1} / ${s.n}`];
    if (loc !== null) bl.push(`Position ${fmt(loc)} mm${fr.thick ? ` · ${fmt(fr.thick, 2).replace(/\.?0+$/, '')} mm thick` : ''}`);
    if (d && !s.color) bl.push(`W ${fmt(d.ww, 0)}  L ${fmt(d.wc, 0)}${s.unit ? ' ' + s.unit : ''}`);
    bl.push(`Zoom ${fmt(this.zoom / (this.fitZoomRef() || this.zoom) * 100, 0)}%`);
    this.ov.bl.textContent = bl.join('\n');
    // orientation letters
    const iop = (fr && fr.iop) || s.desc.iop;
    if (iop) {
      const ex = iop.slice(0, 3), ey = iop.slice(3, 6);
      const inv = new DOMMatrix().rotate(this.rot * 90).scale(this.flipped() ? -1 : 1, 1).inverse();
      const r = inv.transformPoint({ x: 1, y: 0 }), dn = inv.transformPoint({ x: 0, y: 1 });
      this.setOrient(add(mul(ex, r.x), mul(ey, r.y)), add(mul(ex, dn.x), mul(ey, dn.y)));
    } else this.setOrient(null, null);
  }
  fitZoomRef() {
    const s = this.stack, ps = this.spacing() || [1, 1];
    const wmm = s.cols * ps[1], hmm = s.rows * ps[0];
    const [a, b] = this.rot % 2 ? [hmm, wmm] : [wmm, hmm];
    return Math.min(this.w / a, this.h / b) * 0.98;
  }
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------- MPR slice ----
export class SliceView extends ViewBase {
  constructor(app, host, plane) {
    super(app, host);
    this.kind = 'slice'; this.plane = plane; this.space = plane;
    this.vol = null; this.zoom = 1; this.panA = 0; this.panB = 0; this.fitZoom = 1;
    this.el.classList.add('view-slice');
    this.el.style.setProperty('--plane', PLANE_COLOR[plane]);
    this.badge = el('div', 'plane-badge', this.el);
    this.badge.textContent = PLANE_TITLE[plane];
  }
  setVolume(vol) { this.vol = vol; this.g = vol ? vol.views[this.plane] : null; this.fit(); this.invalidate(); }
  fit() {
    if (!this.g) return;
    this.zoom = Math.max(this.g.extentU / this.w, this.g.extentV / this.h) * 1.03;
    this.fitZoom = this.zoom; this.panA = 0; this.panB = 0;
  }
  onResize(first, old) {
    if (!this.g) return;
    if (first || this.zoom === this.fitZoom) this.fit();
    else this.zoom *= Math.max(old[0] / this.w, old[1] / this.h);
  }
  reset() { this.fit(); this.invalidate(); }
  dn() { return dot(sub(this.app.mpr.focus, this.vol.center), this.g.n); }
  count() { return Math.max(1, Math.round(this.g.extent / this.g.step)); }
  sliceIndex() { return Math.round(this.dn() / this.g.step + (this.count() - 1) / 2); }
  planeToWorld(a, b) { const { u, v, n } = this.g; return add(add(add(this.vol.center, mul(u, a)), mul(v, b)), mul(n, this.dn())); }
  screenToPlane(x, y) { return [this.panA + (x - this.w / 2) * this.zoom, this.panB + (y - this.h / 2) * this.zoom]; }
  planeToScreen(a, b) { return [(a - this.panA) / this.zoom + this.w / 2, (b - this.panB) / this.zoom + this.h / 2]; }
  planeScale() { return [1, 1]; }
  roiStep() { return Math.min(...this.vol.spacing); }
  sliceKey() { return this.sliceIndex(); }
  unit() { return this.vol.stack.unit; }
  annots() { return this.vol ? this.vol.stack.annots : []; }
  canMeasure() { return !!this.vol; }
  displayState() { return this.vol ? this.vol.stack.display : null; }
  valueAt(a, b) { return this.vol.sample(this.planeToWorld(a, b)); }
  hover(x, y) {
    if (!this.vol) return;
    const [a, b] = this.screenToPlane(x, y);
    const v = this.valueAt(a, b);
    this.probe = Number.isFinite(v) ? `${fmt(v, 0)} ${this.unit()}` : '';
    this.updateProbe();
    if (this.app.tool === 'fix') { this.brushAt = [x, y]; this.invalidate(); } else this.brushAt = null;
  }
  // ---- marks made by hand (the "Fix brain" tool; see fixes.js) ----
  fixStroke(x, y, first) {
    if (!this.vol) return;
    const [a, b] = this.screenToPlane(x, y), w = this.planeToWorld(a, b);
    this.app.fixPaint(this, first ? null : this.fixLast, w, first);
    this.fixLast = w;
  }
  fixDone() { this.fixLast = null; this.app.fixEnd(this); }
  drawFixTool() {
    const st = this.app.fixState, ctx = this.ctx;
    if (this.app.tool !== 'fix' || !st) return;
    const color = st.mode === 1 ? '#4ade80' : st.mode === 2 ? '#fb923c' : '#e5e7eb';
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * this.dpr;
    if (st.path && st.view === this) {
      const { u, v } = this.g;
      ctx.beginPath();
      st.path.forEach((w, i) => { const q = sub(w, this.vol.center), [x, y] = this.planeToScreen(dot(q, u), dot(q, v)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath(); ctx.globalAlpha = 0.2; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    } else if (this.brushAt && st.shape === 'brush') {
      ctx.beginPath(); ctx.arc(this.brushAt[0], this.brushAt[1], Math.max(2 * this.dpr, st.size / 2 / this.zoom), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  pan(dx, dy) { this.panA -= dx * this.zoom; this.panB -= dy * this.zoom; this.invalidate(); }
  zoomAt(f, x, y) {
    const [a, b] = this.screenToPlane(x, y);
    this.zoom = Math.min(this.fitZoom * 4, Math.max(this.fitZoom / 60, this.zoom / f));
    this.panA = a - (x - this.w / 2) * this.zoom; this.panB = b - (y - this.h / 2) * this.zoom;
    this.invalidate();
  }
  scroll(k) {
    if (!this.vol) return;
    const N = this.count();
    const idx = Math.max(0, Math.min(N - 1, this.sliceIndex() + k));
    const target = (idx - (N - 1) / 2) * this.g.step;
    this.app.cut.plane = this.plane; // "cut away follows the slice" cuts along the plane scrolled last
    this.app.setFocus(add(this.app.mpr.focus, mul(this.g.n, target - this.dn())));
  }
  setCross(x, y) {
    if (!this.vol) return;
    const [a, b] = this.screenToPlane(x, y);
    this.app.setFocus(this.planeToWorld(a, b));
  }
  draw() {
    const ctx = this.ctx, vol = this.vol;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!vol) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.w, this.h); return; }
    const { u, v, n } = this.g, d = vol.stack.display, m = this.app.mpr;
    const center = this.planeToWorld(this.panA, this.panB);
    this.app.gl.setVolume(vol);
    this.app.gl.setLabels(this.app.labels());
    this.app.gl.setFix(this.app.fixShown());
    this.app.gl.drawSlice(ctx, this.w, this.h, {
      center, u: mul(u, this.zoom), v: mul(v, this.zoom), n,
      wc: d.wc, ww: d.ww, invert: d.invert, slab: m.slab, slabMode: m.slabMode, labelColors: this.app.labelColors(),
    });
    // crosshair: where the other two planes cut this one
    if (this.app.showCross) {
      const f = sub(m.focus, vol.center);
      const [fx, fy] = this.planeToScreen(dot(f, u), dot(f, v));
      const others = Object.entries(vol.views).filter(([k]) => k !== this.plane);
      const colFor = (dir) => PLANE_COLOR[others.reduce((b, o) => (Math.abs(dot(o[1].n, dir)) > Math.abs(dot(b[1].n, dir)) ? o : b))[0]];
      const gap = 14 * this.dpr;
      ctx.lineWidth = this.dpr; ctx.globalAlpha = 0.8;
      ctx.strokeStyle = colFor(u); ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, fy - gap); ctx.moveTo(fx, fy + gap); ctx.lineTo(fx, this.h); ctx.stroke();
      ctx.strokeStyle = colFor(v); ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(fx - gap, fy); ctx.moveTo(fx + gap, fy); ctx.lineTo(this.w, fy); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this.drawAnnots();
    this.drawFixTool();
    this.drawScaleBar(1 / this.zoom);
    this.setOrient(u, v);
    const N = this.count();
    const bl = [`${this.sliceIndex() + 1} / ${N}`];
    if (m.slab > 0) bl.push(`${['Average', 'MIP', 'MinIP'][m.slabMode]} ${fmt(m.slab, 0)} mm`);
    bl.push(`W ${fmt(d.ww, 0)}  L ${fmt(d.wc, 0)}${vol.stack.unit ? ' ' + vol.stack.unit : ''}`);
    this.ov.bl.textContent = bl.join('\n');
  }
}

// -------------------------------------------------------------------- 3D ----
export class View3D extends ViewBase {
  constructor(app, host) {
    super(app, host);
    this.kind = '3d'; this.vol = null; this.wheelZooms = true;
    this.cam = null; this.quality = 1; this.idle = 0;
    this.el.classList.add('view-3d');
    this.badge = el('div', 'plane-badge', this.el);
    this.badge.textContent = '3D';
    this.el.style.setProperty('--plane', '#a78bfa');
  }
  leftTool() { return 'rotate'; }
  setVolume(vol) {
    this.vol = vol;
    if (vol) this.look('A');
    this.invalidate();
  }
  /** Standard views: A(nterior) P L R S I */
  look(dir, keepAngle = false) {
    const v = this.vol; if (!v) return;
    if (keepAngle && this.cam) { // only refit the zoom
      this.cam.zoom = this.fitZoom = (v.radius * 2 * 0.64) / Math.min(this.w, this.h);
      return;
    }
    this.dir = dir;
    const set = { A: [[1, 0, 0], [0, 0, -1]], P: [[-1, 0, 0], [0, 0, -1]], L: [[0, 1, 0], [0, 0, -1]], R: [[0, -1, 0], [0, 0, -1]], S: [[-1, 0, 0], [0, 1, 0]], I: [[1, 0, 0], [0, 1, 0]] }[dir];
    const [r, d] = set;
    this.cam = { center: [...v.center], r, d, f: cross(r, d), zoom: (v.radius * 2 * 0.64) / Math.min(this.w, this.h) };
    this.fitZoom = this.cam.zoom;
    this.invalidate();
  }
  onResize(first, old) {
    if (!this.cam) return;
    if (first || this.cam.zoom === this.fitZoom) this.look(this.dir || 'A', true);
    else this.cam.zoom *= Math.min(old[0], old[1]) / Math.min(this.w, this.h);
  }
  reset() { this.look('A'); }
  interacting() {
    this.quality = 0.5;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.quality = 1; this.invalidate(); }, 160);
  }
  rotate(dx, dy) {
    const c = this.cam; if (!c) return;
    const rot = (a, b, ang) => { const cs = Math.cos(ang), sn = Math.sin(ang); return [add(mul(a, cs), mul(b, sn)), sub(mul(b, cs), mul(a, sn))]; };
    [c.r, c.f] = rot(c.r, c.f, -dx * 0.008);
    [c.d, c.f] = rot(c.d, c.f, -dy * 0.008);
    c.r = norm(c.r); c.d = norm(sub(c.d, mul(c.r, dot(c.d, c.r)))); c.f = cross(c.r, c.d);
    this.interacting(); this.invalidate();
  }
  pan(dx, dy) { const c = this.cam; if (!c) return; c.center = sub(sub(c.center, mul(c.r, dx * c.zoom)), mul(c.d, dy * c.zoom)); this.interacting(); this.invalidate(); }
  zoomAt(f) { const c = this.cam; if (!c) return; c.zoom = Math.min(this.fitZoom * 3, Math.max(this.fitZoom / 40, c.zoom / f)); this.interacting(); this.invalidate(); }
  scroll(n) { this.zoomAt(n > 0 ? 0.9 : 1.1); }
  draw() {
    const ctx = this.ctx, vol = this.vol;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!vol || !this.cam) { ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, this.w, this.h); return; }
    const app = this.app, r3 = app.r3d;
    const items = app.meshItems();
    if (r3.show === 'models' && items.length) {
      app.gl.drawMeshes(ctx, this.w, this.h, this.cam, items, vol.radius, app.clipPlane(this.cam));
      const tris = items.reduce((n, it) => n + it.mesh.indices.length / 3, 0);
      this.ov.bl.textContent = `${items.length} model${items.length > 1 ? 's' : ''} · ${(tris / 1000).toFixed(0)}k triangles`;
    } else {
      const d = vol.stack.display;
      app.gl.setVolume(vol);
      app.gl.drawRaycast(ctx, this.w, this.h, this.cam, { mode: r3.mode, iso: r3.iso, wc: d.wc, ww: d.ww, color: r3.color, quality: this.quality });
      this.ov.bl.textContent = r3.mode === 'mip' ? 'Maximum intensity' : `Surface at ${fmt(r3.iso, 0)} ${vol.stack.unit}`;
    }
    this.drawGizmo();
  }
  drawGizmo() {
    const ctx = this.ctx, dpr = this.dpr, c = this.cam;
    const ox = 44 * dpr, oy = this.h - 78 * dpr, L = 26 * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `700 ${12 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const axes = [[[1, 0, 0], 'L', '#fbbf24'], [[0, 1, 0], 'P', '#4ade80'], [[0, 0, 1], 'S', '#ff6b6b']];
    axes.sort((a, b) => dot(b[0], c.f) - dot(a[0], c.f));
    for (const [v, name, col] of axes) {
      const x = ox + dot(v, c.r) * L, y = oy + dot(v, c.d) * L;
      ctx.strokeStyle = col; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = col; ctx.fillText(name, ox + dot(v, c.r) * (L + 9 * dpr), oy + dot(v, c.d) * (L + 9 * dpr));
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}
