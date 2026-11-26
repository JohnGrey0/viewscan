"""Checks the "Fine-tune the MRI brain" panel on an MRI series.

    python test/mrtune.py

Opens the panel and checks the live preview tints the slices, that a preset
changes it, that a build on Auto gives a brain-sized model, that a preset is
used by the build, and that the settings are still there after a reload. Needs
the server running with an MRI series in the library (the public sample is
enough). VIEWSCAN_PROJECT / VIEWSCAN_SERIES pick another one.
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
BRAIN = "(() => { const b = viewscan.models().items.find(i => i.key === 'brain'); return { ml: Math.round(b.volumeMl), tris: b.mesh ? b.mesh.indices.length / 3 : 0, note: b.note }; })()"
PINK = "(() => { const p = viewscan.volume.stack.preview; if (!p) return 0; let n = 0; for (const v of p.labels.data) if (v === 1) n++; return n; })()"


def build(page):
    page.evaluate("document.querySelectorAll('#targets input[data-target]').forEach(i => { i.checked = i.dataset.target === 'brain'; })")
    page.click("#btn-build")
    page.wait_for_function("!viewscan.building", timeout=900000)
    return page.evaluate(BRAIN), page.evaluate("viewscan.lastUsed")


def preview(page, action):
    n = page.evaluate("viewscan.previewCount || 0")
    t = time.time()
    action()
    page.wait_for_function("(n) => (viewscan.previewCount || 0) > n", arg=n, timeout=120000)
    return page.evaluate(PINK), time.time() - t


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
    page.evaluate("localStorage.removeItem('viewscan.mr.' + viewscan.volume.stack.id)")
    ok(page.is_visible("#mr-more"), "the MRI panel shows for an MRI series")

    pink, secs = preview(page, lambda: page.evaluate("document.querySelector('#mr-more').open = true"))
    print("     first preview %.1fs, %d voxels" % (secs, pink))
    ok(pink > 50000, "opening the panel tints the brain on the slices")
    ok("Brain: about" in page.inner_text("#m-status"), "and says how big it is")
    time.sleep(0.5)
    page.screenshot(path=os.path.join(OUT, "mrtune-preview.png"))
    cast, secs = preview(page, lambda: page.select_option("#m-preset", "cast"))
    print("     preset preview %.1fs, %d voxels" % (secs, cast))
    ok(cast > pink, "“I just want the overall shape” fills the folds in the preview")
    ok(len(page.inner_text("#m-preset-why")) > 20, "and explains itself")
    back, secs = preview(page, lambda: page.click("#m-reset"))
    ok(back == pink, "“Back to automatic” brings the first preview back (%.1fs)" % secs)

    auto, used = build(page)
    print("     auto:", auto, used)
    ok(auto["tris"] > 10000 and 900 < auto["ml"] < 1700, f"Auto builds a brain-sized model ({auto['ml']} mL)")
    ok(used and used["ml"] > 0, "the build reports what it used")
    ok(page.evaluate("viewscan.volume.stack.preview") is None, "the slices then show the finished model")
    time.sleep(0.6)
    page.screenshot(path=os.path.join(OUT, "mrtune-auto.png"))

    preview(page, lambda: page.select_option("#m-preset", "filled"))
    tuned, used2 = build(page)
    print("     tuned:", tuned, used2)
    ok(tuned["ml"] < auto["ml"], "“The folds look filled in” cuts the folds deeper in the model")
    time.sleep(0.6)
    page.screenshot(path=os.path.join(OUT, "mrtune-tuned.png"))

    page.click("#btn-copy-settings")
    page.wait_for_selector("#toast")
    ok("copied" in page.inner_text("#toast"), "“Copy these settings” copies the settings as text")

    page.reload()
    page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
    ok(page.evaluate("viewscan.volume.stack.id") == sid, "a reload reopens the same series")
    ok(page.evaluate("document.querySelector('#m-preset').value") == "filled" and page.evaluate("Number(document.querySelector('#m-folds').value)") == 3, "with its fine-tuning remembered")
    ok(page.evaluate("document.querySelector('#mr-more').open"), "and the panel open")
    page.click("#m-reset")
    ok(page.evaluate("Number(document.querySelector('#m-folds').value)") == 0, "“Back to automatic” resets it")
    b.close()

print("errors:", errs[:8])
sys.exit(1 if failed or errs else 0)
