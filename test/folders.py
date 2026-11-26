"""Checks that a folder opened with "Open folder…" is still there after a reload.

    python test/folders.py [folder]

Opens the folder (default: the public sample MRI), waits for the copy to be
saved, reloads, and checks the project, its series and its pixels come back
from browser storage. Then removes it again. Needs the server running.
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
URL = os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/")
FOLDER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "Sample MRI brain (T1)")
failed = 0


def ok(cond, msg):
    global failed
    print(("ok   " if cond else "FAIL ") + msg)
    failed += 0 if cond else 1


LOCAL = "viewscan.studies.filter(s => s.source !== 'server')"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("dialog", lambda d: d.accept())
    page.goto(URL)
    page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
    ok(page.evaluate(LOCAL + ".length") == 0, "starts with no opened folders")

    page.set_input_files("#folder-input", os.path.abspath(FOLDER))
    page.wait_for_function(LOCAL + ".length > 0", timeout=120000)
    name = page.evaluate(LOCAL + "[0].project")
    n_series = page.evaluate(LOCAL + ".reduce((n, s) => n + s.series.length, 0)")
    ok(page.evaluate("viewscan.project") == name, f"opened as project “{name}” with {n_series} series")
    t = time.time()
    page.wait_for_function("[...viewscan.sources.values()].some(s => s.type === 'local' && s.saved)", timeout=300000)
    print("     copy saved in %.1fs" % (time.time() - t))
    ok(page.is_visible("#btn-forget"), "Remove button shows for an opened folder")

    page.reload()
    page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
    ok(page.evaluate(LOCAL + ".length") > 0, "folder is back after a reload")
    ok(page.evaluate("viewscan.project") == name, "and it is the selected project again")
    ok(page.evaluate(LOCAL + ".reduce((n, s) => n + s.series.length, 0)") == n_series, "with the same series")
    page.wait_for_function("(() => { const s = viewscan.volume ? viewscan.volume.stack : viewscan.views[0] && viewscan.views[0].stack; return s && s.done; })()", timeout=180000)
    info = page.evaluate("(() => { const s = viewscan.volume ? viewscan.volume.stack : viewscan.views[0].stack; return { local: s.source.type === 'local', failed: s.failed, n: s.n, max: s.max }; })()")
    ok(info["local"] and info["failed"] == 0 and info["max"] > 0, f"its images decode from the saved copy ({info['n']} images)")
    time.sleep(0.5)
    page.screenshot(path=os.path.join(os.environ.get("VIEWSCAN_SHOTS", os.path.join(HERE, "shots")), "folders-restored.png"))

    # opening the same folder again replaces the copy instead of adding a second one
    first = page.evaluate("[...viewscan.sources.keys()].find(k => k !== 'server')")
    page.set_input_files("#folder-input", os.path.abspath(FOLDER))
    page.wait_for_function("([first]) => [...viewscan.sources].some(([k, s]) => s.type === 'local' && s.saved && k !== first)", arg=[first], timeout=300000)
    ok(page.evaluate("[...viewscan.sources.values()].filter(s => s.type === 'local').length") == 1, "opening it again replaces the earlier copy")

    with page.expect_navigation():
        page.click("#btn-forget")
    page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
    time.sleep(0.5)
    ok(page.evaluate(LOCAL + ".length") == 0, "Remove forgets the folder")

    # a project from the scans folder can be taken off the list and brought back
    SERVER = "[...new Set(viewscan.studies.filter(s => s.source === 'server').map(s => s.project))]"
    before = page.evaluate(SERVER)
    if before:
        gone = page.evaluate("viewscan.project")
        with page.expect_navigation():
            page.click("#btn-forget")
        page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
        ok(gone not in page.evaluate(SERVER), f"Remove takes “{gone}” off the list")
        page.reload()
        page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
        ok(gone not in page.evaluate(SERVER), "and it stays off after a reload")
        back = page.evaluate("[...document.querySelectorAll('#project option')].map(o => o.value).find(v => v.startsWith('::bring-back::'))")
        with page.expect_navigation():
            page.select_option("#project", back)
        page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
        ok(page.evaluate(SERVER) == before and page.evaluate("viewscan.project") == gone, "“Bring back” restores it")
    b.close()

print("errors:", errs[:8])
sys.exit(1 if failed or errs else 0)
