"""Checks "Still blurry? Combine scans" (merging scans taken in different planes).

    python test/combine.py

On a series with nothing to combine with (the public sample) it only checks the
option stays hidden. Point VIEWSCAN_PROJECT / VIEWSCAN_SERIES at an MRI study
that has the same kind of scan in two or three planes to test the whole thing:
combine, open the result in 3D, build the brain from it.
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
URL = os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/")
OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(HERE, "shots"))
PROJECT = os.environ.get("VIEWSCAN_PROJECT", "")
SERIES = int(os.environ.get("VIEWSCAN_SERIES", "-1"))
os.makedirs(OUT, exist_ok=True)
failed = 0


def ok(cond, msg):
    global failed
    print(("ok   " if cond else "FAIL ") + msg)
    failed += 0 if cond else 1


PICK = """([proj, n]) => {
  for (const s of viewscan.studies) if (s.modalities.includes('MR') && (!proj || s.project === proj)) for (const se of s.series) if (se.modality === 'MR' && (n < 0 || se.number === n)) {
    const st = se.stacks.find(x => x.volume);
    if (st) { viewscan.api.openStack(s, se, st); return st.id; }
  }
  return null;
}"""
READY = "(id) => viewscan.volume && viewscan.volume.stack.id === id && viewscan.views.every(v => v.vol)"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1680, "height": 1100})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
    sid = page.evaluate(PICK, [PROJECT, SERIES])
    if not sid:
        print("no MRI volume in the library; nothing to test")
        sys.exit(0)
    page.wait_for_function(READY, arg=sid, timeout=180000)
    n = page.evaluate("document.querySelectorAll('#combine-list input').length")
    if not page.is_visible("#combine-more"):
        ok(n == 0, "a series with no matching scans in other planes shows no combine option")
    else:
        ok(n >= 2, f"the option lists {n} scans of the same kind in different planes")
        ok(not page.evaluate("document.querySelector('#combine-more').open"), "and stays folded away until asked for")
        before = page.evaluate("document.querySelectorAll('.series').length")
        page.evaluate("document.querySelector('#combine-more').open = true")
        t = time.time()
        page.click("#btn-combine")
        page.wait_for_function("viewscan.lastCombine && viewscan.volume && viewscan.volume.stack.id === viewscan.lastCombine.id && viewscan.views.every(v => v.vol)", timeout=600000)
        info = page.evaluate("viewscan.lastCombine")
        print("     combined in %.1fs:" % (time.time() - t), info["dims"], "at", round(info["spacing"], 2), "mm;",
              [(round(m["before"], 3), round(m["after"], 3), m["moved"]) for m in info["moves"][1:]])
        ok(page.evaluate("document.querySelectorAll('.series').length") == before + 1, "the combined scan is added to the list")
        ok(page.evaluate("document.querySelector('.series.active .badge.combined') !== null"), "and opened, marked “Combined”")
        ok(info["spacing"] <= 1.3 and min(info["dims"]) > 100, "it is fine-grained in every direction")
        ok(all(m["after"] >= m["before"] for m in info["moves"][1:]), "lining up never made the match worse")
        ok(not page.is_visible("#combine-more"), "a combined scan does not offer combining again")
        time.sleep(1.0)
        page.screenshot(path=os.path.join(OUT, "combine-slices.png"))
        page.evaluate("document.querySelectorAll('#targets input[data-target]').forEach(i => { i.checked = i.dataset.target === 'brain'; })")
        page.click("#btn-build")
        page.wait_for_function("!viewscan.building", timeout=900000)
        brain = page.evaluate("(() => { const b = viewscan.models().items.find(i => i.key === 'brain'); return { ml: Math.round(b.volumeMl), tris: b.mesh ? b.mesh.indices.length / 3 : 0 }; })()")
        print("     brain:", brain)
        ok(brain["tris"] > 10000 and 900 < brain["ml"] < 1700, f"a brain can be built from it ({brain['ml']} mL)")
        time.sleep(0.8)
        page.screenshot(path=os.path.join(OUT, "combine-model.png"))
        page.click(".mode-2d-button, #mode-switch button[data-mode='2d']")
        time.sleep(0.8)
        ok(page.evaluate("viewscan.views.some(v => v.stack && v.stack.desc.combined)"), "and it opens in 2D as well")
    b.close()

print("errors:", errs[:8])
sys.exit(1 if failed or errs else 0)
