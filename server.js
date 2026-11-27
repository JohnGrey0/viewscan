// Viewscan server — indexes DICOM folders and serves the viewer.
// No dependencies. Everything stays on this machine: it listens on 127.0.0.1
// unless HOST is set, and only ever serves files it found while indexing.
//
//   node server.js            → http://localhost:8127
//
// Settings (environment variables):
//   PORT           port to listen on (8127)
//   HOST           address to listen on (127.0.0.1; use 0.0.0.0 to serve the home network)
//   SCANS_DIR      folder whose sub-folders are the projects (default: this folder)
//   VIEWSCAN_DIRS  extra project folders, separated by ";"
//   CACHE_DIR      where the header index is kept (default: .cache here)
//   BASIC_AUTH     "user:password" to ask for a login (scans are medical data)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readDicom } from './public/js/dicom.js';
import { summarize, organize } from './public/js/series.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache');
const SCANS_DIR = path.resolve(process.env.SCANS_DIR || ROOT);
const BASIC_AUTH = process.env.BASIC_AUTH || '';
const CACHE_FILE = path.join(CACHE_DIR, 'index.json');
const FIX_DIR = path.join(CACHE_DIR, 'fixes'); // marks made by hand on the slices ("Fix brain"): one file per series, never in a scan folder
const PORT = Number(process.env.PORT || 8127);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_VERSION = 5;

// Folders in the project that are part of the app, not scan data.
const APP_DIRS = new Set(['public', 'test', 'node_modules', '.cache', '.git', 'docs', '.claude', 'models']);
// Extensions that are never DICOM; skipped without opening the file.
const SKIP_EXT = new Set(('.exe .dll .ocx .bat .cmd .txt .xml .htm .html .js .css .json .jpg .jpeg .png .gif .bmp .tif .tiff .ico .cur .wav ' +
  '.pdf .ini .inf .db .sql .gz .zip .7z .md .log .idx .blo .emd .fix .sif .bag .manifest .htc .site .base .ark .aar .dpf .dps .dpp .cls ' +
  '.tls .dct .mcwebhelp .mclog .flmsp .storagereg .lnk .stl .obj .glb .nii .mjs .cjs .map .svg .woff .woff2 .ttf .csv').split(' '));
const HEAD_BYTES = 65536;

function scanRoots() {
  const roots = [];
  let entries = [];
  try { entries = fs.readdirSync(SCANS_DIR, { withFileTypes: true }); } catch (err) { console.error(`Cannot read ${SCANS_DIR}: ${err.message}`); }
  for (const d of entries) {
    if (d.isDirectory() && !APP_DIRS.has(d.name) && !d.name.startsWith('.') && !d.name.startsWith('@')) roots.push(path.join(SCANS_DIR, d.name));
  }
  for (const extra of (process.env.VIEWSCAN_DIRS || '').split(';').map((s) => s.trim()).filter(Boolean)) roots.push(path.resolve(extra));
  return roots;
}

async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && !SKIP_EXT.has(path.extname(e.name).toLowerCase()) && e.name.toUpperCase() !== 'DICOMDIR') out.push(p);
  }
}

async function headerOf(file, size) {
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.min(size, HEAD_BYTES);
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, 0);
    const isDcm = /\.(dcm|dicom|ima)$/i.test(file);
    const magic = len >= 132 && buf.toString('latin1', 128, 132) === 'DICM';
    if (!magic && !isDcm) return null;
    let ds = await readDicom(new Uint8Array(buf.buffer, buf.byteOffset, len), { stopAtPixel: true, partial: true });
    if (ds._truncated && size > len) { // header longer than the head we read
      const all = await fsp.readFile(file);
      ds = await readDicom(new Uint8Array(all.buffer, all.byteOffset, all.length), { stopAtPixel: true });
    }
    return summarize(ds);
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

const state = { status: 'idle', scanned: 0, total: 0, studies: [], files: new Map(), error: null, promise: null, roots: [] };
const fileId = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);

async function buildIndex() {
  state.status = 'scanning'; state.scanned = 0; state.total = 0; state.error = null;
  const t0 = Date.now();
  let cache = {};
  try {
    const c = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'));
    if (c.version === CACHE_VERSION) cache = c.files;
  } catch { /* no cache yet */ }

  state.roots = scanRoots();
  const paths = [];
  const projectOf = new Map(); // file path -> project (the top-level folder it was found in)
  for (const r of state.roots) {
    const from = paths.length;
    await walk(r, paths);
    for (let i = from; i < paths.length; i++) projectOf.set(paths[i], path.basename(r));
  }
  state.total = paths.length;

  const fresh = {};
  const summaries = [];
  const files = new Map();
  let next = 0, reused = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      try {
        const st = await fsp.stat(p);
        const hit = cache[p];
        let entry;
        if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) { entry = hit; reused++; }
        else entry = { size: st.size, mtime: st.mtimeMs, s: await headerOf(p, st.size) };
        fresh[p] = entry;
        if (entry.s) {
          const id = fileId(p);
          files.set(id, { path: p, size: st.size, mtime: st.mtimeMs });
          summaries.push({ file: id, info: entry.s.info, frames: entry.s.frames, project: projectOf.get(p) });
        }
      } catch { /* unreadable file: ignore */ }
      state.scanned++;
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));

  // organize each project separately so the same study in two folders stays in both
  const byProject = new Map();
  for (const s of summaries) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  state.studies = [];
  for (const [project, list] of byProject) for (const st of organize(list)) state.studies.push({ ...st, project });
  state.files = files;
  state.status = 'ready';
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files: fresh }));
  const nSeries = state.studies.reduce((n, s) => n + s.series.length, 0);
  console.log(`Indexed ${files.size} DICOM files (${paths.length} checked, ${reused} from cache) → ${state.studies.length} studies, ${nSeries} series in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function startIndex() {
  if (state.status === 'scanning') return state.promise;
  state.promise = buildIndex().catch((err) => { state.status = 'error'; state.error = String(err.message || err); console.error(err); });
  return state.promise;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const savingFix = req.method === 'PUT' && p.startsWith('/api/fix/'); // the only thing the page may write
    if (req.method !== 'GET' && req.method !== 'HEAD' && !savingFix) return send(res, 405, 'Method not allowed');
    if (p === '/healthz') return send(res, 200, state.status === 'error' ? 'error' : 'ok', { 'Content-Type': 'text/plain' });
    if (BASIC_AUTH) {
      const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /i, ''), 'base64');
      const want = Buffer.from(BASIC_AUTH);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return send(res, 401, 'Login needed', { 'WWW-Authenticate': 'Basic realm="Viewscan", charset="UTF-8"' });
      }
    }

    if (p === '/api/library') {
      if (url.searchParams.has('rescan')) startIndex();
      const body = state.status === 'ready'
        ? { status: 'ready', studies: state.studies, roots: state.roots.map((r) => path.basename(r)) }
        : { status: state.status, scanned: state.scanned, total: state.total, error: state.error };
      return send(res, 200, JSON.stringify(body), { 'Content-Type': 'application/json' });
    }

    if (p.startsWith('/api/fix/')) {
      const id = p.slice(9);
      if (!/^[\w.-]{1,150}$/.test(id) || id.includes('..')) return send(res, 400, 'Bad name');
      const file = path.join(FIX_DIR, id + '.json');
      if (!savingFix) {
        const body = await fsp.readFile(file).catch(() => null);
        return send(res, 200, body || 'null', { 'Content-Type': 'application/json' }); // null: no marks saved for this series
      }
      // only this page may save: a request from another site carries that site's Origin
      const from = req.headers.origin;
      if (from && new URL(from).host !== req.headers.host) return send(res, 403, 'Forbidden');
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 64e6) return send(res, 413, 'Too large'); chunks.push(c); }
      const body = Buffer.concat(chunks);
      const marks = JSON.parse(body.toString('utf8'));
      if (!marks || !Array.isArray(marks.dims) || typeof marks.gz !== 'string') return send(res, 400, 'Not a set of marks');
      await fsp.mkdir(FIX_DIR, { recursive: true });
      await fsp.writeFile(file + '.tmp', body);
      await fsp.rename(file + '.tmp', file);
      return send(res, 200, 'saved', { 'Content-Type': 'text/plain' });
    }

    if (p.startsWith('/api/file/')) {
      const f = state.files.get(p.slice(10));
      if (!f) return send(res, 404, 'Unknown file');
      const etag = `"${f.size}-${Math.round(f.mtime)}"`;
      if (req.headers['if-none-match'] === etag) return send(res, 304, null, { ETag: etag, 'Cache-Control': 'private, max-age=86400' });
      res.writeHead(200, { 'Content-Type': 'application/dicom', 'Content-Length': f.size, ETag: etag, 'Cache-Control': 'private, max-age=86400' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
    }

    // static files
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache',
      // lets the page use SharedArrayBuffer / threads if a codec wants them
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 500, String(err.message || err));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Viewscan may already be running: http://localhost:${PORT}`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Viewscan → http://localhost:${PORT}  (scans: ${SCANS_DIR}${BASIC_AUTH ? ', login on' : ''})`);
  startIndex();
});
