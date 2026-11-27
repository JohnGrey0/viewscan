"""Checks the "Fix brain" tool: paint on a slice, rebuild, save, reload, undo.

    python test/fix.py

Uses the public MRI sample and the classic brain finder. Run it against a server
with its own CACHE_DIR (VIEWSCAN_URL), so the marks it saves are thrown away.
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(OUT, exist_ok=True)
URL = os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/")
PICK = """() => {
  for (const s of viewscan.studies) if (s.modalities.includes('MR') && /sample/i.test(s.project)) {
    let best = null;
    for (const se of s.series) for (const st of se.stacks) if (st.volume && (!best || st.n > best.st.n)) best = { se, st };
    if (viewscan.mode !== '3d') viewscan.api.setMode('3d');
    viewscan.api.openStack(s, best.se, best.st);
    return best.st.id;
  }
}"""
READY = "window.viewscan && viewscan.volume && viewscan.volume.stack.id === %r && viewscan.views.every(v => v.vol)"
bad = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        bad.append(what)


def drag(page, points):
    page.mouse.move(*points[0])
    page.mouse.down()
    for q in points[1:]:
        page.mouse.move(*q, steps=4)
    page.mouse.up()


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1680, "height": 980})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_function("window.viewscan && viewscan.studies.length", timeout=180000)
    sid = page.evaluate(PICK)
    page.wait_for_function(READY % sid, timeout=180000)
    page.select_option("#m-model", "classic")
    page.evaluate("document.querySelectorAll('#targets input[data-target]').forEach(i => { i.checked = i.dataset.target === 'brain'; })")
    page.select_option("#seg-detail", "1")
    page.click("#btn-build")
    page.wait_for_function("!viewscan.building && viewscan.models()", timeout=900000)
    ml0 = page.evaluate("viewscan.models().items[0].volumeMl")
    check(ml0 > 900, "a brain was built first (%d mL)" % ml0)

    page.keyboard.press("f")
    check(page.is_visible("#fix-panel") and page.evaluate("viewscan.tool") == "fix", "F opens the Fix brain tool and its panel")
    box = page.evaluate("(() => { const r = viewscan.views[0].el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
    page.click('#fix-mode button[data-v="2"]')
    page.evaluate("document.querySelector('#fix-size').value = 24; document.querySelector('#fix-size').dispatchEvent(new Event('input'))")
    drag(page, [(cx - 60, cy), (cx + 60, cy), (cx + 60, cy + 40)])
    n1 = page.evaluate("viewscan.volume.stack.fix.count")
    check(n1 > 200, "painting 'Not brain' marks voxels (%d)" % n1)
    check("latest marks" in page.inner_text("#fix-status"), "the panel says the 3D model does not have the marks yet")
    page.screenshot(path=os.path.join(OUT, "fix-painted.png"))

    page.click('#fix-mode button[data-v="1"]')
    page.click('#fix-shape button[data-v="lasso"]')
    drag(page, [(cx - 30, cy - 90), (cx + 30, cy - 90), (cx + 30, cy - 60), (cx - 30, cy - 60), (cx - 30, cy - 88)])
    n2 = page.evaluate("viewscan.volume.stack.fix.count")
    ones = page.evaluate("viewscan.volume.stack.fix.data.reduce((n, v) => n + (v === 1), 0)")
    check(n2 > n1 and ones > 50, "drawing around an area marks what is inside it as brain (%d voxels)" % ones)

    page.click("#fix-build")
    page.wait_for_function("!viewscan.building", timeout=900000)
    ml1 = page.evaluate("viewscan.models().items[0].volumeMl")
    fixed = page.evaluate("viewscan.lastBuild.fixed")
    check(fixed > 200 and ml1 < ml0 - 1, "the rebuilt brain follows the marks (%d -> %d mL, %d grid voxels set)" % (ml0, ml1, fixed))
    check("in the 3D model" in page.inner_text("#fix-status"), "the panel says the marks are in the 3D model")
    page.wait_for_function("viewscan.volume.stack.fix.saved", timeout=20000)
    check("saved" in page.inner_text("#fix-status"), "the marks are saved (%s)" % page.inner_text("#fix-status"))
    page.screenshot(path=os.path.join(OUT, "fix-rebuilt.png"))

    page.reload()
    page.wait_for_function("window.viewscan && viewscan.studies.length", timeout=180000)
    page.evaluate(PICK)
    page.wait_for_function(READY % sid, timeout=180000)
    page.wait_for_function("viewscan.volume.stack.fix && viewscan.volume.stack.fix.count > 0", timeout=20000)
    check(page.evaluate("viewscan.volume.stack.fix.count") == n2, "after a reload the marks come back")

    page.keyboard.press("f")
    drag(page, [(cx - 100, cy + 100), (cx - 60, cy + 100)])
    n3 = page.evaluate("viewscan.volume.stack.fix.count")
    page.keyboard.press("Control+z")
    check(n3 > n2 and page.evaluate("viewscan.volume.stack.fix.count") == n2, "Ctrl+Z takes back the last stroke")
    page.click("#fix-clear")
    check(page.evaluate("viewscan.volume.stack.fix.count") == 0, "Remove all marks clears them")
    page.wait_for_function("viewscan.volume.stack.fix.saved", timeout=20000)
    b.close()

print("page errors:", errs[:6])
print("all good" if not bad and not errs else "%d problem(s)" % (len(bad) + (1 if errs else 0)))
sys.exit(1 if bad or errs else 0)
