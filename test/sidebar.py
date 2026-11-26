"""Checks the sidebar: projects, sorting, 3D-only filter, drag-to-resize.

    python test/sidebar.py
"""
import os
import time
from playwright.sync_api import sync_playwright

OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(OUT, exist_ok=True)
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


ROWS = "[...document.querySelectorAll('#library .series')].map(r => ({t: r.querySelector('.t').textContent, vol: !!r.querySelector('.badge.vol')}))"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1680, "height": 980})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/"))
    page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
    opts = page.evaluate("[...document.querySelectorAll('#project option')].map(o => o.value)")
    print("projects:", opts)
    check(len(opts) >= 2, "one project per scan folder")
    cur = page.evaluate("viewscan.project")
    rows = page.evaluate(ROWS)
    studies_shown = page.evaluate("document.querySelectorAll('#library .study-head').length")
    check(studies_shown == 1 and len(rows) > 0, f"only the current project is listed ({cur}: {len(rows)} series)")

    other = [o for o in opts if o != cur][0]
    page.select_option("#project", other)
    page.wait_for_function("viewscan.volume && viewscan.volume.stack.study.project === %r && viewscan.views.every(v => v.vol)" % other, timeout=180000)
    check(page.evaluate("document.querySelectorAll('#library .series').length") >= 1, f"switching to '{other}' lists and opens its scan")
    page.reload()
    page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
    check(page.evaluate("viewscan.project") == other, "the chosen project is remembered after a reload")

    ct = [o for o in opts if "CT" in o][0]
    page.select_option("#project", ct)
    page.wait_for_function("viewscan.volume && viewscan.volume.stack.study.project === %r && viewscan.views.every(v => v.vol)" % ct, timeout=180000)
    page.select_option("#sort", "3d")
    rows = page.evaluate(ROWS)
    vols = [r["vol"] for r in rows]
    check(vols == sorted(vols, reverse=True) and vols[0] and not vols[-1], "'3D-ready first' puts every 3D series before the rest")
    page.select_option("#sort", "name")
    names = [r["t"] for r in page.evaluate(ROWS)]
    check(names == sorted(names, key=str.lower), "'Name' sorts alphabetically")
    page.check("#only3d")
    rows3 = page.evaluate(ROWS)
    check(all(r["vol"] for r in rows3) and 0 < len(rows3) < len(rows), f"'3D only' hides the others ({len(rows3)} of {len(rows)})")
    page.uncheck("#only3d")
    page.select_option("#sort", "3d")

    # drag the divider from its current place to x=470
    w0 = page.evaluate("document.querySelector('#sidebar').getBoundingClientRect().width")
    page.mouse.move(w0, 400)
    page.mouse.down()
    page.mouse.move(470, 420, steps=6)
    page.mouse.up()
    w1 = page.evaluate("document.querySelector('#sidebar').getBoundingClientRect().width")
    check(abs(w1 - 470) < 4, f"dragging the divider resizes the list ({w0:.0f} -> {w1:.0f} px)")
    cut = page.evaluate("[...document.querySelectorAll('#library .series .t, #library .series .m')].filter(e => e.scrollWidth > e.clientWidth + 1).length")
    check(cut == 0, "no text is cut off at the wider size")
    time.sleep(0.6)
    page.screenshot(path=os.path.join(OUT, "sidebar-wide.png"))
    page.reload()
    page.wait_for_function("window.viewscan && viewscan.volume", timeout=180000)
    check(abs(page.evaluate("document.querySelector('#sidebar').getBoundingClientRect().width") - w1) < 2, "width and sort order are remembered")
    # leave the browser profile as it started (headless profile is throw-away anyway)
    b.close()
print("page errors:", errs[:8])
print("FAILED" if fails or errs else "all sidebar checks passed")
