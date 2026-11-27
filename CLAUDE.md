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
| `public/js/fixes.js` | marks made by hand on the slices ("Fix brain"): brush, draw-around, undo, saving |
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
- Compare grid (`openCompare`, `MR_VARIANTS`, `freshVariants` in `main.js`): about 70
  brain builds in two foldable groups (`AI_VARIANTS`, then the classic `MR_VARIANTS`;
  the owner asked for 50 to 100, kept apart), plus "Try 30 more" with untried mixes, drawn with the
  shared GL renderer into one canvas per tile. The owner wants detail, not blobs:
  keep the list weighted toward crisp finishes and deeper folds. A chosen version
  can become the default for its kind of scan (`mrdef.<kind key>` in localStorage;
  a series' own `mr.<stack id>` wins over it). Grid builds share the cores: 4 threads
  each (`opts.helpers`), 8 for a fine grid, within a memory budget that grows with
  the core count. Measured on the owner's 32-thread desktop, 28 versions: 4 threads
  each 75 s, 7 each 97 s, 2 each 135 s, 1 each (24 at once) 184 s. A failed build
  is retried by itself. Each build ends its own helper threads (see below).
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
  3.5 mm of the brain (under 400 mm3) are filled back in. The owner's favorite on a private
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
- AI brain models (`brainnet.js`, `aiworker.js`, `brainModel` in `segment.js`,
  `brainFromModel` in `segworker.js`, models in `public/models/`): the owner asked
  for brain2print's models after the classic fold work hit its limit. They are
  brainchop MeshNets (MIT), run with our own WebGPU compute shaders: conform to a
  256 cube at 1 mm (axes: left, down, front), scale brightness the way each model
  was trained (`MODELS` holds brain2print's per-model settings), crop, run the
  layers in 16-plane slabs, read back label + "how sure it is brain". The answer is
  kept on the volume (`vol.ai`), so tweaks and the compare grid do not rerun it.
  `brainFromModel` puts it on the working grid; the surface is the 0.5 level of
  "how sure", cleaned of the neck below the cerebellum (18-part models only).
  Auto = `partsBig` when a WebGPU device really opens (`gpuReady`) and the scan is
  not T2/PD. Found on a private clinical study: Auto with a stricter level
  looks right; the fast mask model is rough. Model choice and AI settings are
  stored apart from the classic settings (`model.<stack id>`, `ai.<stack id>`) and
  have their own panel (`#ai-more`); the owner does not want them mixed.
  Playwright's bundled Chromium cannot open a WebGPU device on Windows: `test/ai.py`
  uses installed Chrome; every other test therefore runs the classic method.
- Home-trained models: `../viewscan-train` (Python + PyTorch, its own repo) trains
  MeshNets of the same shape and installs them into `public/models/own/<name>/`
  with an entry in `public/models/own/index.json` (git-ignored: they are trained
  with private scans' labels). `ownModels()` in `segment.js` reads the index;
  `main.js` adds the "Your own models" group and their compare-grid versions (at
  the front of `AI_VARIANTS`; `test/ai.py` allows for them). An entry carries
  `notBrain` (how many leading classes are not brain: 2 for the trainer's label
  set of background, fold fluid, left, right, cerebellum, brain stem), `cerebellum`
  (class numbers for the neck cut) and `ver` (cache bust). The trainer's
  `conform.py` mirrors `conform()`/`runModel()` here; change one, change the other
  (`viewscan-train/tools/browser_parity.py` checks voxel by voxel).
- "Use every series of this study" (`#a-study`, `brainAnswer` in `segment.js`,
  `mergeAnswers` in `brainnet.js`): the model runs on every usable series, answers
  are shifted to the base series' cube and averaged. Off by default: on a real
  study the head had turned up to 2 degrees between series and the average blurred
  the folds.
- Study models (`inputs: 3` in the index entry; `runStudy`, `alignProb`, `movedCube` in
  `brainnet.js`): one input per slice direction (0 side to side, 1 top to bottom, 2 front
  to back; `stackAxis`). `brainModel` passes the other series' volumes to the worker;
  `runStudy` keeps one partner per free direction (finest in-plane, then thinnest), runs
  the model on each series alone, lines the partner's "how sure" cube up with the base's
  (Gauss-Newton turn + shift, 8/4/2 mm), re-conforms the partner in the moved cube and
  runs all inputs together. Lining up is not optional: measured in the trainer, 1 degree
  off loses the whole gain and 2 degrees is worse than one series. A partner that will
  not fit (overlap under 0.6, over 20 degrees or 40 mm) is left out. `main.js` forces
  `study` on for these models (`studyModel`) and hides the "every series" checkbox.
  `forward()` is the plain graphics-card run shared with one-input models.
- An experiment that cut deeper folds as thin slits and found the gap between the
  halves as a curved sheet was dropped at the owner's request in favor of the
  models (the sheet-based split was clean; the slits came out ragged).
- Networks run one at a time (`aiLine` in `segment.js`): several WebGPU devices at
  once would each hold over a gigabyte on one card. Without WebGPU the compare grid
  shows the classic group only.
- "Locate" is the default mouse tool in 3D (the owner asked); 2D falls back to Scroll.
- Static hosting (`pages` branch, GitHub Pages): the page asks for `api/library`
  with a relative address; an answer that is not the Viewscan server sets
  `app.hosted` and the page runs on opened folders only. `isolate.js` + `sw.js` add
  the COOP/COEP headers so helper threads work. Keep every address in `public/`
  relative (the site lives in a sub-folder). Never publish scan data or a sample
  scan with it. Test: `test/pages.py`.
  Publish: `git subtree push --prefix public origin gh-pages` from `pages` (GitHub
  Pages serves the `gh-pages` branch; no workflow).
- "Fix brain" (`fixes.js`, tool `fix` in 3D mode, `#fix-panel`, `fixPaint`/`fixEnd` on the app,
  `applyFix` in `segworker.js`, `test/fix.py`): the owner paints "this is brain" / "not brain"
  on the three slice views where a model is wrong and rebuilds. Marks live on the scan's own
  grid (one byte per scan voxel: 0 none, 1 brain, 2 not brain), so a mark on a thick slice
  covers that slice; the slice shader draws them from a third texture (`setFix`), green and
  orange. In a build they win over any brain finder: `applyFix` writes them into the brain
  mask and into the field the surface is traced from, after the finder and before cleaning
  (a painted blob that is not attached to the brain is still dropped by "main piece only").
  The live MRI preview ignores them. Saving: `PUT /api/fix/<stack id>` writes
  `CACHE_DIR/fixes/<id>.json` (the grid's origin and steps plus the marks, gzip in base64, no
  names); it is the only thing the server writes on the page's behalf, and never into a scan
  folder. Without a server the marks stay in localStorage (`viewscan.fix.<id>`). The trainer
  can read these files as hand-checked labels. `T` hides marks and colors together.
- "Cut the model open at the slice I scroll to" (`#cut-follow`, `app.cut.follow`, pref
  `cutfollow`; the owner asked): `clipPlane()` then returns the plane of the slice view
  scrolled last (`app.cut.plane`, set in `SliceView.scroll`) at the current focus, and
  the "Cut away" list and slider are switched off. Unticked, scrolling does not cut.
- "Left on left" (`#btn-lol`, `display.leftOnLeft` in `volume.js`, pref `leftonleft`; the owner
  found the hospital layout confusing: patient's left on the right of the screen). Off by
  default. On, `assignViews` mirrors the axial and coronal planes, and `StackView.flipped()`
  mirrors 2D pictures whose columns run toward the patient's left; the letters follow by
  themselves. Measurements made in the 3D slice views are mirrored with the picture.
- Auto and home-trained models (`autoModel`, `scanShape` in `main.js`): an index entry may carry
  `auto` ("study", "scout" or "single"; set by the trainer's `tools/install.py name "Name" kind`).
  Auto then picks by the scan's shape: thick slices (3 mm or more apart, 2.5x coarser than in the
  slice) get the first "study" model when the study has other series, else the first "single";
  a low-detail scan (1.2 mm or coarser all round, such as a head scout) gets "scout", else
  "single"; a sharp scan stays with `partsBig`; T2/PD stay classic. The owner's verdicts
  (2026-11-27): generation 3 is the best on his study's head scout, the study model on its
  6 mm series. A new model is listed without `auto` until he has judged it.
- Compare window, 2026-11-27 (this replaces "about 70 builds at once" above; the owner asked): it
  opens with the best versions only (`bestVariants`: about 15: the model Auto picks for the scan
  with six settings, the other home-trained models that have a job, any model installed after
  them, the 18-part model, and three classic ones). "Show all the standard versions" (`#cmp-all`)
  adds the rest of `AI_VARIANTS` + `MR_VARIANTS`; "Try 30 more" adds random untried mixes.
  Never put "whole study" averaging in the best set: it blurred the folds on his scout.
  `test/ai.py` was updated for this but not re-run that day (the graphics card was training).
- Wrap-around repair (`Volume.unwrap` in `volume.js`, `display.unwrap`, `#unwrap`, pref `unwrap`,
  on by default; `node test/unwrap.mjs`): on the owner's head scout the tip of the nose was
  drawn behind the head (the measured box was too short front to back). MRI only. Per direction:
  tissue must reach both ends (a blank plane or two at the edge allowed), there must be an empty
  gap inside, and a small piece (under 25% of the tissue) on one side of it. Then a copy of the
  data is rotated so the cut falls in the gap, and the origin moves so the head stays put. It
  triggered on that scout only (34 mm) out of 24 series of two clinical studies and the sample.
  The 2D pictures are not changed. Every consumer of a `Volume` (slice views, models, AI models,
  study partners) sees the repaired scan; the trainer does not do this. Hand-made marks are tied
  to one layout: `loadFix` drops marks whose saved origin differs.
- The owner's good result on the scout (2026-11-27): scout model, fine grid, crisp, padded 1 mm.
