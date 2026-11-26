# Viewscan — notes for working on this project

Local CT/MRI DICOM viewer + automatic 3D-model builder. Zero dependencies: a
Node server (`server.js`) and vanilla ES modules in `public/`. No build step.

## Hard rules

- **Scan data is private medical data.** Never commit it, upload it, or put it in
  a request to an outside service. The server binds to 127.0.0.1 by default.
- Never modify the files under scan folders (`CT Brain Scan/` etc.); read only.
- Keep the UI plain-language (the owner and family use it, not radiologists).

## Layout

| File | Role |
|---|---|
| `server.js` | indexes scan folders (header cache in `.cache/`), serves `/api/library`, `/api/file/:id`, static files. Port 8127. |
| `public/js/dicom.js` | DICOM parser (shared by server, workers, tests) |
| `public/js/series.js` | headers → studies/series/stacks; splits series into volumes, joins overlapping passes |
| `public/js/pixels.js`, `codecs/` | frame decoding → modality values (HU) |
| `public/js/loader.js`, `worker.js` | worker pool, `Stack` (decoded frames in one buffer) |
| `public/js/volume.js` | affine index↔patient (LPS mm) geometry, MPR view frames |
| `public/js/glrender.js` | one shared WebGL2 context: slice/slab shader, ray-cast, mesh drawing |
| `public/js/views.js` | `StackView` (2D), `SliceView` (MPR), `View3D`, measurements |
| `public/js/segworker.js`, `segment.js` | segmentation + Surface Nets + Taubin + quadric simplify, STL/OBJ export. `segment.js` runs stage 1 (`segment`) in one worker, then one `part` worker per model |
| `public/js/seglines.js`, `seghelper.js` | EDT / blur line kernels and the helper threads that run them on SharedArrayBuffer (needs `crossOriginIsolated`; serial fallback otherwise) |
| `public/js/localstore.js` | IndexedDB copy of folders opened in the browser (`folders` + `files` stores), so they survive a reload |
| `public/js/main.js` | app shell and UI wiring; `window.viewscan` is the app object (used by tests) |

## Hosting

Workbench project (see `A:\projects\portal\README.md`): port 8127, host `scans`,
tile in `portal/site/apps.json`, listed in `portal/projects.txt`. `Dockerfile` +
`docker-compose.yml` here; the image holds only the app, scans are mounted
read-only from this folder, the header index lives in the `viewscan-cache`
volume. Docker is usually not running on the PC: test with
`PORT=… SCANS_DIR=… CACHE_DIR=… HOST=0.0.0.0 node server.js`; John rebuilds on the
Mac mini with `./up.sh viewscan`. Port 8130 belongs to the Manhwa Reader.

## Working on it

- `series.js` runs in the server too: restart `node server.js` after changing it,
  and bump `CACHE_VERSION` in `server.js` **and** `SUMMARY_FORMAT` in `localstore.js`
  if the summary format changes (saved folders then re-read their headers).
- Stop the server by port (8127), never by process name.
- Verify changes in a real browser: `python test/browser.py` saves screenshots
  (set `VIEWSCAN_SHOTS` to choose the folder). Headless Chromium needs
  `--use-angle=d3d11` for WebGL2, already set in the script.
- The first dataset (`CT Brain Scan/`) is a GE CTA head: series 5 "Axial w" holds
  two passes 46 s apart with different coverage, so the "2 passes joined" stack
  is the one that covers the whole head.

## Open items

- JPEG 2000 / JPEG-LS need a WebAssembly codec (`registerCodec` in `pixels.js` is
  the hook); vendoring third-party code needs the owner's OK first.
- Enhanced multi-frame files with per-frame positions are implemented but not
  yet tested on real data.
- Cleaned models are closed and single-shell, but Surface Nets leaves a few
  non-manifold edges (~0.1% on bone; `test/printcheck.py` counts them). Slicers
  repair these on import; a proper fix is dual contouring with several vertices
  per cell.
- CT brain shows only faint folds: CT cannot separate fluid from cortex well.
- Projects are top-level folders (server) or opened folders (browser; copied into
  IndexedDB by `localstore.js`, which works on plain http too). Prefs live in
  localStorage (`viewscan.*`): sidebar, last series per project (`last.<project>`),
  MRI fine-tuning per series (`mr.<stack id>`), server projects taken off the list
  with Remove (`hidden`, a JSON list; "Bring back" in the project list undoes it).
  Remove never deletes scan files.
- MRI brain (`segmentMR` in `segworker.js`) is tuned on two data sets: the public
  3-D T1 sample and a clinical 1.5 T study with 5 mm slices 6 mm apart (T1, T2,
  FLAIR, GRE, post-contrast; axial, coronal, sagittal). Auto should give an
  outline of about 1.35–1.6 L on all of them, with the top of the brain and the
  cortex included; re-check both kinds after changing anything. Do not go back to
  a global brightness cut-off plus shrink-and-regrow: it lost the top slices and
  the gray matter on the thick-slice T1s (the owner called it an overcorrection).
  `node test/mrlab.mjs <folder> <series> <tag>` runs the finder in node in a few
  seconds and saves a montage with the brain (pink) and outline (green) drawn on
  the slices; that is the way to iterate. `viewscan.mrTune = {…}` in the console
  bypasses the panel. Weakest: post-contrast coronal and sagittal (the outline
  runs toward the face and is tightened automatically), and scans with no timing
  information (fluid dark/bright is then guessed from shape).
- The live MRI preview is the same `segmentMR` on a 2 mm grid in one long-lived
  worker (`type: 'preview'`); steps are memoized on `grid.memo`, so keep each
  step's inputs in its memo key when adding settings.
- Compare grid (`openCompare`, `MR_VARIANTS`, `freshVariants` in `main.js`): 28
  brain builds side by side, plus "Try 12 more" with untried mixes, drawn with the
  shared GL renderer into one canvas per tile. The owner wants detail, not blobs:
  keep the list weighted toward crisp finishes and deeper folds. A chosen version
  can become the default for its kind of scan (`mrdef.<kind key>` in localStorage;
  a series' own `mr.<stack id>` wins over it). Grid builds use `opts.alone` (no
  helper threads) and a memory budget: with helpers, shared memory lingered after
  each build and the tab ran out after about a dozen ("Array buffer allocation
  failed"). Do not run them all at once.
- Region-aware folds (step 4b of `segmentMR`): deeper cut on the plane between the
  halves, smooth cerebellum and brain stem, surface groove between cerebellum and
  cerebrum. The cerebellum boundary is looked up in the scan (the fluid-like gap of
  the tentorium, per vertical column, median-filtered, mirrored left-right and
  smoothed); a fixed height put the line too high on a private clinical scan. Heights
  scale with the brain's front-to-back length (0.8 x length), never fixed
  millimeters. One printable piece matters.
- Fold cut-off (dark fluid) is set per scan from the outer 1.5 to 7 mm shell of the
  outline (35th percentile, between 0.6 or 0.72 and 0.95). Many clinical scans show
  almost no fluid in the folds; a fixed cut-off gave a blob on a private clinical scan;
  the owner had found "fold depth +5" by hand. Bright-fluid (T2) folds use the same
  local-brightness ratio, cut at 1.3.
- Tuning data: the public 3-D T1 sample, and a private clinical study in the owner's Downloads
  folder (private; 5 mm slices 6 mm apart plus a 1.6 mm isotropic scout, which
  gives the best 3-D brain of that study). It is enhanced multi-frame DICOM: timing
  (TR/TE/TI) lives in the frame groups (`summarize` reads it). The owner's liked
  look: fine grid, smooth finish, slightly tight outline, deepest folds.
- Auto fold tuning (owner, 2026-11-25: the first adaptive version made "a TON of folds",
  too aggressive, and left pits at the back): the fold field is blurred 1.1 mm before
  the cut, the shell share is 27%, and openings with a small footprint in the outer
  3.5 mm of the brain (under 400 mm3) are filled back in. His favorite on his own
  scout: fine grid, Crisp finish (no smoothing, soften 0.6, main piece only), outline
  -2, stiffness +2, folds normal, split +2. It is the second tile of the compare grid.
- "Copy these settings" (`settingsText`) puts every model setting on the clipboard as
  text, so the owner can paste what he used instead of typing it.
- Each build starts and ends its own helper threads (`startHelpers`). A shared
  long-lived pool kept shared memory alive and the tab ran out after about a dozen
  builds ("Array buffer allocation failed"). Do not bring the shared pool back.
- CT: the owner says bone isolation is already very good and does not want it to
  go backwards. Do not change the CT method for small gains.
- US spelling everywhere (the owner asked).
- Helper threads: up to 28 (cores minus 4 on big machines). The owner wants the
  machine used fully; heavy passes are memory-bound, so measure before adding more.
- Combining must never lay a blurred scan over a sharp one (the owner noticed it
  with the first version, a plain average sharpened by back-projection). The
  Fourier weighting in `fuseVolumes` is the fix; `test/fuselab.mjs` prints fine
  detail per direction for base / plain average / combined to check it.
- Combining planes (`fuse.js`, `fuseworker.js`, `scanKind`/`combineScans` in
  `main.js`) is opt-in by the owner's wish ("a last resort"): never combine
  automatically. Only the same kind of scan is combined (weighting from TE/TR/TI,
  sequence family, contrast from the description). The result is a synthetic
  series (`st.combined`, a pinned `Stack` in `app.stacks`) that lives in memory
  only. `node test/fuselab.mjs` shows base / plain average / combined side by side.
