# Viewscan

View your own CT and MRI scans in the browser, and turn them into 3D models.
Everything runs on this computer; no scan data is sent anywhere.

## Start

Double-click `start.bat` (or run `node server.js`) and open <http://localhost:8127>.
Needs Node 20+ and a current Chrome/Edge. No install step, no dependencies.

## On the home server (Workbench)

Viewscan is a Workbench project: port **8127**, tile "Viewscan", name
`scans.glab.server`. On the Mac mini:

```sh
cd /path/to/projects/portal
./up.sh viewscan      # build and start this app
./up.sh portal        # rebuild the front page so the tile appears
```

The container serves the whole home network and reads scans straight from this
folder (read-only). Settings go in a `.env` file next to `docker-compose.yml`:

| Setting | Meaning |
|---|---|
| `VIEWSCAN_PORT` | port on the host (8127) |
| `VIEWSCAN_SCANS` | folder whose sub-folders are the projects (default: this folder) |
| `VIEWSCAN_AUTH` | `user:password` to ask for a login — scans are medical data, so set this if anyone else can reach the machine |

The heavy work (decoding, 3D, building models) happens in the browser of whoever
is viewing, so the Mac mini only hands out files. Without Docker, `./start.sh`
(or `HOST=0.0.0.0 node server.js`) does the same job.

## On a plain web host (GitHub Pages)

The `pages` branch also runs with no server at all: `public/` is the whole site.
The live site is the `gh-pages` branch, which holds only the contents of
`public/`. To publish a new version: `git subtree push --prefix public origin gh-pages`
from the `pages` branch.

- There is no built-in library there. Scans are opened with **Open folder…**; the
  files are read by the browser on that computer and are never uploaded.
- Fast model building needs two headers a static host cannot send. A small
  service worker (`public/sw.js`, started by `public/isolate.js`) adds them, and
  the page reloads itself once on the first visit.
- `python test/pages.py` checks all of this against a plain file server.

## Adding scans

- Put a folder of DICOM files anywhere inside this folder and reload the page, or
- click **Open folder…** / drag a folder onto the window. The browser keeps its own
  copy, so the folder is still listed after a reload; **Remove** next to the project
  name forgets it (your files are never touched), or
- **Remove** also works on a project from the scans folder: it is left off the list
  in that browser (files untouched) until you pick "Bring back" in the project list, or
- list extra folders in the `VIEWSCAN_DIRS` environment variable (separated by `;`).

Each folder of scans is a **project**. Pick the project at the top of the list on
the left; the list can be sorted (scan order, 3D-ready first, most images, name,
plane), filtered to 3D-capable series, and made wider by dragging its right edge.

The discs hospitals hand out work as they are: viewer programs and other files
on them are ignored, and duplicate copies of the same images are folded together.

## What it does

**2D images** — the pictures as the scanner stored them: scroll, zoom, move,
brightness/contrast with CT presets (brain, bone, stroke…), length / angle / area
measurements with Hounsfield statistics, 1/2/4 panels for comparing series,
play as a film, save a panel as PNG.

**3D & models** — rebuilds a series as a volume:

- axial, coronal and sagittal planes, linked by the *Locate* tool
- thick slabs (MIP / average / darkest) for following blood vessels
- a 3D view (surface at any level, or X-ray style MIP)
- **Create 3D models**: automatically finds bone, brain, blood vessels and skin,
  shows them as surfaces, tints them on the slices so you can check them, and
  saves each as STL or OBJ (millimeters, the scan's own patient coordinates).

## Supported data

| | |
|---|---|
| Scan types | CT, MRI, and other grayscale or color DICOM images |
| File layouts | one file per slice, and multi-frame files (enhanced CT/MR) |
| Compression | uncompressed, lossless JPEG, RLE, deflate, 8-bit JPEG |
| Not yet | JPEG 2000, JPEG-LS, 12-bit lossy JPEG (reported per image, nothing crashes) |
| Geometry | tilted-gantry CT, uneven slice spacing, several passes or echoes in one series |

## How the models are made

The approach follows what 3D Slicer, InVesalius and the CT_BET skull-stripping
recipe do, implemented from scratch in `public/js/segworker.js`:

1. Resample the scan onto an even grid (1 mm by default).
2. **CT**: head = everything denser than −300 HU, largest piece, holes filled.
   Bone = above the bone level (300 HU by default). With contrast dye in the
   scan, "bone" must also be within 3.5 mm of unmistakably dense bone (700 HU),
   which keeps bright arteries out of the skull. The inside of the skull is found
   by sealing gaps in the bone and filling each cross-section; the brain is the
   soft tissue in there, separated from everything else by a 4 mm
   shrink-and-regrow. Vessels are the dye-bright voxels in and around the brain
   that are not next to bone.
3. **MRI** (no fixed brightness scale): everything is measured against the scan
   itself. The head is found by brightness percentiles. The brain outline is a
   closed surface grown from the middle of the brain until it meets the dark
   skull (the method of FSL's Brain Extraction Tool, Smith 2002, written out in
   `growSurface`): each point looks a short way inward and moves out while it
   sees brain-bright tissue. It judges brightness against what is nearby, so dim
   parts of a scan (often the top slices) are kept, and it resists sharp bends,
   so it does not leak along a nerve. If the outline comes out bigger than a
   brain (over 1.65 L, or much hanging below 135 mm from the top) it is grown
   again more carefully. Inside the outline, fluid is told from brain against the
   local tissue brightness (dark fluid: T1, FLAIR) or by brightness classes
   (bright fluid: T2); which one applies is read from the scan timing. Slices
   2.5 mm or more apart are joined with a smooth curve and blended a little.
   The parts of the brain are then treated the way they are: the folds are cut
   deeper along the plane between the two halves; in the lower back, where the
   cerebellum and brain stem sit, only real fluid gaps are cut (no fine
   wrinkles), with a shallow groove where the cerebellum meets the cerebrum so
   the model shows them apart and still prints as one piece. The boundary of the
   cerebellum is looked up in the scan (the thin fluid-like gap above it) and
   made the same on both sides; the brain stem's place is estimated from the
   brain's size. The line between fluid and brain is set per scan from the outer
   few millimeters of the brain, so scans that barely show fluid in the folds
   still get folds. Heights (such as where to cut off underneath) scale with the
   brain's own length. Before the cut the picture is blurred
   a little, and small pits (openings with a small footprint on the surface) are
   filled back in, so faint folds give a smooth patch, not a row of holes.
   **Fine-tune the MRI brain** has presets named after what looks wrong ("Parts
   of the brain are missing", "Skull, eyes or face are stuck on"…), sliders for
   each step, and a live preview that tints the slices (pink brain, blue fluid
   inside the outline) without building the model. Settings are remembered per
   series. This is approximate — check it on the slices.
4. **Combining scans** (optional, MRI): a thick-slice scan is sharp only in the
   plane it was taken in. When a study has the same kind of scan in two or three
   planes, "Still blurry? Combine scans" in the 3D panel merges them into one
   volume that is sharp all round (`fuse.js`): the extra scans are lined up with
   the open one (rigid shift and turn, by correlation) and leveled in brightness.
   Then every piece of detail is taken from the scans that are sharp in its
   direction and from no others (a weighted mix in the Fourier domain: a scan's
   weight for a wave falls off with how far the wave runs through its slices),
   so a blurry copy is never laid over a crisp one; only coarse shapes, which
   every scan carries, are averaged. The result is added to the list as a
   "Combined" series, in memory only, until the page is reloaded. It is never
   done automatically.
5. **Try many versions and compare** (MRI): builds the brain about 70 ways and
   shows them in a scrolling grid that turns together, in two groups that fold
   away with a click on their heading: **AI models** (every network, with mixes
   of how sure it must be, padding, brain stem, finish and grid) and **Classic
   method** (finish from raw to smooth, fold depth, slice blending, outline
   fuller or tighter, and so on). "Try 30 more" adds mixes of settings not tried
   on that series yet, half of them AI. Picking one uses its model and settings,
   and can make them the starting point for every scan of the same kind. Several
   are built at a time, sharing the processor cores; the networks run one at a
   time on the graphics card and each answer is reused.

The **Colors** button in the 3D toolbar (or the T key) hides and shows the
tint on the slices.
4. Inside the brain hull, fluid is separated from tissue (fixed HU level on CT;
   on MRI three brightness classes, with the fluid side taken from step 3), so the folds of the cortex are kept instead of a smooth blob.
5. Each part becomes a closed surface (Surface Nets), smoothed without shrinking
   (Taubin). Bone and brain follow the scan's own values for sub-voxel accuracy.
6. **Finish** decides how much the model is tidied afterwards:

   | Preset | What it does |
   |---|---|
   | Raw | nothing: exactly as found |
   | Clean (default) | one solid, closed piece per part: specks and thin flakes dropped, pinholes sealed, enclosed hollows filled, light smoothing |
   | Smooth | stronger smoothing and edge softening, 1.5 mm gap closing, half the triangles |
   | Extra smooth | strongest smoothing, 2 mm gap closing, 30% of the triangles |

   "Fine-tune the finish" exposes each step: smoothing passes, edge softening
   (anti-aliasing), close gaps (mm), remove thin bits (mm, soft parts only),
   what to do with floating pieces, triangle reduction (quadric edge collapse),
   and filling hollow spaces. The choice is remembered.

7. **Solid inside** (a switch on the Brain and Bone rows) fills the inside of a
   part so it prints as one solid body, without touching its outer surface. For
   the brain that is everything deeper than 8 mm under its outer envelope: the
   fluid chambers and the bottoms of the deepest folds. For bone it is the
   space the skull encloses, so leave it off to keep the empty cavity. On by
   default for the brain, off for bone.

### Speed

Finding the parts runs in one background worker; cleaning and meshing then run
one worker per part. The heavy passes inside both (distance transforms, blurs)
are split across helper threads that share memory, up to 13 threads. That needs
an "isolated" page: it works on `localhost` and over `https`; over plain `http`
to another machine the builder falls back to one core per part (about twice as
slow). Display (slices, 3D view, models) is drawn by the graphics card.

## AI brain models (MRI)

For MRI, **Brain finder** (above "Detail") chooses how the brain is found:

- **AI models**: small neural networks that run on this computer's graphics card
  through WebGPU (a current Chrome or Edge). They are the "MeshNet" models of
  [brainchop](https://github.com/neuroneural/brainchop) as shipped with
  [brain2print](https://github.com/niivue/brain2print) (MIT license, see
  `public/models/LICENSE-brain2print.txt`), run by Viewscan's own WebGPU code in
  `public/js/brainnet.js`; no library is loaded and nothing leaves the computer.
  The list mirrors brain2print's: Subcortical + GWM (18 parts; the best one, and
  what **Auto** uses), Tissue GWM, Brain mask, Aparc+Aseg 50 and 104.
  They were trained on T1-weighted scans; Auto uses the classic method for T2 and
  proton-density scans, and anywhere WebGPU is missing.
- **Your own models**: models trained on this computer with the separate
  `viewscan-train` project appear in their own group at the top of the list. They
  learn from sharp public brains made rough on purpose (6 mm slices, other kinds
  of contrast), so they hold up better on an ordinary hospital study, and they
  tell the two halves, the cerebellum, the brain stem and the fluid in the folds
  apart. They live in `public/models/own/`, which is not part of the repository.
- **Classic**: the outline-and-folds method described below. Works on any scan.

With a model of your own, **Use every series of this study** (off at the start)
runs the model on each series of the study and averages the answers. The overall
shape gets steadier; folds get softer, because the head moves a little between
series.

A **study model** (also trained with `viewscan-train`) goes further: it looks at up to
three series of the study at once, one for each direction the slices can be stacked in.
Viewscan picks them, lines them up with the scan in view (heads move a degree or two
between series) and gives them to the model together. It takes about four times as long as
one series, and the folds come out clearly better on 6 mm studies.

Each has its own fine-tune panel, and the settings of one are not used by the
other. With a panel open, the slices are tinted with what was found. The mesh
follows the network's answer closely: in `test/ai.py` 99.7% of the mesh points lie
on the surface the network found. A network takes about 3 to 8 seconds on a
recent graphics card, once per series; other settings then reuse its answer.

## Wrapped-around parts

On some MRI scans (often a quick overview scan) a part that stuck out of the measured box,
such as the tip of the nose, is drawn on the opposite side, floating behind the head. In
"3D & models" Viewscan moves it back where it belongs and says so under **Put wrapped-around
parts back in place**. Untick that if a scan looks wrong with it. The "2D images" always show
the scan as it was made.

## Left and right on the pictures

Hospitals draw top-down and front pictures as if facing the patient, so the patient's left
is on the right of the screen (the L and R letters at the edges say which side is which).
**Left on left** in the toolbar mirrors those pictures, so left is on the left.

## Cut the model open while scrolling

Under the list of 3D models, tick **Cut the model open at the slice I scroll to**. The 3D
model is then cut at the slice you are looking at: scroll through the top-down, front or
side pictures and the cut moves along with you. Untick it to scroll without cutting.

## Fix the brain by hand

When a brain model has a filled-in fold, a bit of skull or membrane stuck to it, or a piece
missing, you can correct it yourself. In "3D & models", click **Fix brain** (or press F) and
paint on any of the three slice pictures:

- **This is brain** (green) where brain is missing, **Not brain** (orange) where something
  else was colored in, **Rub out** to take your own marks away.
- **Brush** paints with a round brush (keys [ and ] change its size); **Draw around** marks
  everything inside a line you draw.
- The mouse wheel moves through the slices, **T** turns the colors off and on so you can see
  the scan underneath, Ctrl+Z takes back the last stroke.
- **Update the 3D model** builds the models again with your marks, whichever brain finder
  is chosen.

Marks are saved on this computer next to the app's index (never in the scan folder) and
come back when you open the series again.

## Tests

```
node test/verify-real.mjs      # lossless-JPEG decoder vs the uncompressed copies of the CT in this folder
node test/run.mjs               # decoders vs public sample files in test/fixtures (from pydicom-data)
python test/browser.py         # drives the running app in Chromium and saves screenshots (pip install playwright)
python test/sidebar.py         # projects, sorting, 3D-only filter, resizable list
python test/folders.py         # an opened folder survives a reload, can be replaced and removed
python test/mrtune.py          # MRI brain: live preview, presets, Auto build, settings remembered
node test/mrlab.mjs <folder> <series> <tag>   # MRI brain finder in node, with a picture to check
python test/combine.py         # combining scans from different planes (needs a study that has them)
python test/compare.py         # "Try 10 versions and compare", defaults per kind of scan, Colors on/off
node test/fuselab.mjs <folder> <n,n,n> <tag>  # the combining step in node, with a before/after picture
python test/brain.py MR        # brain-only model pictures for the CT or MR project
python test/printcheck.py CT   # are the models closed, single-shell, manifold? + cut-away slider
python test/solid.py MR        # "Solid inside" on/off: volumes and cut-open pictures
```

Viewscan is for looking at your own scans. It is not a medical device and must
not be used for diagnosis.
