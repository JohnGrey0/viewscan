"""Checks "Try many versions and compare" and the Colors on/off switch (MRI).

    python test/compare.py

Builds the two dozen versions of the brain, checks each tile gets a model, asks
for twelve more with untried settings, picks one
as the default for that kind of scan, and checks the settings and the default
are used and can be forgotten again. Needs the server running with an MRI
series in the library (the public sample is enough).
VIEWSCAN_PROJECT / VIEWSCAN_SERIES pick another one.
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
    page = b.new_page(viewport={"width": 1900, "height": 1100})
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
    page.evaluate("for (const k of Object.keys(localStorage)) if (k.startsWith('viewscan.mr')) localStorage.removeItem(k)")
    page.evaluate("localStorage.setItem('viewscan.overlay', '1')")
    page.reload()
    page.wait_for_function(READY, arg=sid, timeout=180000)

    t = time.time()
    page.click("#btn-compare")
    page.wait_for_function("viewscan.compareDone === true", timeout=1200000)
    secs = time.time() - t
    tiles = page.evaluate("[...document.querySelectorAll('.cmp-tile')].map(t => ({ name: t.querySelector('.cmp-name').textContent, status: t.querySelector('.cmp-status').textContent, ready: !t.querySelector('button').disabled }))")
    print("     %d versions in %.0fs (%s threads): %s" % (len(tiles), secs, page.evaluate("navigator.hardwareConcurrency"), ", ".join(t["status"] for t in tiles)))
    ok(len(tiles) == 28 and all(t["ready"] for t in tiles), "all 28 versions are built and can be picked")
    ok(len(set(t["status"] for t in tiles)) >= 16, "and they differ from each other")
    time.sleep(0.6)
    page.screenshot(path=os.path.join(OUT, "compare-grid.png"))
    page.click("#cmp-look button[data-v='S']")
    time.sleep(0.4)
    page.screenshot(path=os.path.join(OUT, "compare-grid-top.png"))

    t = time.time()
    page.click("#cmp-more")
    page.wait_for_function("viewscan.compareDone === true && document.querySelectorAll('.cmp-tile').length === 40", timeout=1200000)
    names = page.evaluate("[...document.querySelectorAll('.cmp-name')].map(n => n.textContent)")
    built = page.evaluate("[...document.querySelectorAll('.cmp-tile')].filter(t => !t.querySelector('button').disabled).length")
    print("     12 more in %.0fs: %s" % (time.time() - t, "; ".join(names[28:31])))
    ok(len(set(names)) == 40, "“Try 12 more” adds twelve versions that were not there before")
    ok(built >= 37, f"and they are built too ({built} of 40 gave a model)")
    page.evaluate("document.querySelector('#cmp-grid').scrollTop = 0")

    index = page.evaluate("[...document.querySelectorAll('.cmp-name')].findIndex(n => n.textContent === 'Smooth, deep folds')")
    deep = page.locator(".cmp-tile").nth(index)
    want = deep.locator(".cmp-status").inner_text().split(" · ")[0]
    deep.locator("button").nth(1).click()
    ok(not page.is_visible("#compare"), "picking one closes the grid")
    got = page.evaluate("(() => { const m = viewscan.models(); return m && m.items[0].mesh ? Math.round(m.items[0].volumeMl) + ' mL' : ''; })()")
    ok(got == want, f"its model becomes the model of the series ({got})")
    ok(page.evaluate("Number(document.querySelector('#m-folds').value)") == 3, "and its settings are on the panel")
    ok(page.evaluate("Object.keys(localStorage).some(k => k.startsWith('viewscan.mrdef.'))"), "it is kept as the default for this kind of scan")

    # the colors switch
    ok(page.evaluate("viewscan.labels() !== null"), "the model is tinted on the slices")
    page.click("#btn-tint")
    ok(page.evaluate("viewscan.labels() === null") and "off" in page.inner_text("#btn-tint"), "“Colors” switches the tint off")
    page.keyboard.press("t")
    ok(page.evaluate("viewscan.labels() !== null"), "and the T key switches it back on")

    # the default applies to a series with no settings of its own
    page.evaluate("localStorage.removeItem('viewscan.mr.' + viewscan.volume.stack.id)")
    page.reload()
    page.wait_for_function(READY, arg=sid, timeout=180000)
    ok(page.evaluate("Number(document.querySelector('#m-folds').value)") == 3 and page.is_visible("#m-default"), "after a reload the default is what the panel starts from")
    page.click("#m-undefault")
    ok(not page.evaluate("Object.keys(localStorage).some(k => k.startsWith('viewscan.mrdef.'))"), "“Forget my default” removes it")
    page.evaluate("localStorage.removeItem('viewscan.mr.' + viewscan.volume.stack.id)")
    b.close()

print("errors:", errs[:8])
sys.exit(1 if failed or errs else 0)
