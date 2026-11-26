"""Drives the running app in Chromium and saves screenshots.

    python test/browser.py [step ...]      steps: 2d, 3d, models (default: all)

Needs the server running (node server.js) and `pip install playwright`.
Screenshots go to the folder given by VIEWSCAN_SHOTS (default: test/shots).
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/")
OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
steps = sys.argv[1:] or ["2d", "3d", "models"]
os.makedirs(OUT, exist_ok=True)
errors = []


def shot(page, name):
    path = os.path.join(OUT, name + ".png")
    page.screenshot(path=path)
    print("saved", path)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1680, "height": 980})
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.goto(URL)
    page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
    # the app starts in "3D & models"; the 2D steps switch back first
    page.wait_for_function("window.viewscan && (viewscan.volume || (viewscan.views[0] && viewscan.views[0].stack && viewscan.views[0].stack.done))", timeout=180000)
    print("starts in:", page.evaluate("viewscan.mode"))
    if page.evaluate("viewscan.mode") == "3d":
        page.click('#mode-switch button[data-mode="2d"]')
    page.wait_for_function("viewscan.views[0].stack && viewscan.views[0].stack.done", timeout=180000)
    pick = os.environ.get("VIEWSCAN_PICK")  # e.g. MR: open the largest series of the first study of that type
    if pick:
        page.evaluate("""(m) => { for (const s of viewscan.studies) if (s.modalities.includes(m)) { let best = null; for (const se of s.series) for (const st of se.stacks) if (!best || st.n > best.n) best = st;
            for (const row of document.querySelectorAll('.series')) if (row.dataset.key === s.source + '|' + best.id) row.click(); return; } }""", pick)
        page.wait_for_function("viewscan.views[0].stack && viewscan.views[0].stack.done && viewscan.views[0].stack.series.modality === '%s'" % pick, timeout=180000)
    time.sleep(1.0)
    print("library:", page.evaluate("viewscan.studies.map(s => s.desc + ' / ' + s.series.length + ' series')"))
    print("opened:", page.evaluate("viewscan.views[0].stack.title + ' n=' + viewscan.views[0].stack.n"))

    if "2d" in steps:
        shot(page, "01-2d")
        # measure + contrast preset + scroll
        box = page.locator("#views .view").first.bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.keyboard.press("l")
        page.mouse.move(cx - 120, cy - 40); page.mouse.down(); page.mouse.move(cx + 110, cy + 30, steps=5); page.mouse.up()
        page.keyboard.press("o")
        page.mouse.move(cx - 40, cy + 60); page.mouse.down(); page.mouse.move(cx + 40, cy + 120, steps=5); page.mouse.up()
        page.keyboard.press("1")
        time.sleep(0.4)
        shot(page, "02-2d-measure-brain-window")
        page.keyboard.press("s")
        for _ in range(15):
            page.mouse.wheel(0, 100)
        time.sleep(0.4)
        shot(page, "03-2d-scrolled")

    if "3d" in steps or "models" in steps:
        page.click('#mode-switch button[data-mode="3d"]')
        page.wait_for_function("viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
        time.sleep(1.5)
        print("volume:", page.evaluate("JSON.stringify({n:[viewscan.volume.nx,viewscan.volume.ny,viewscan.volume.nz], sp:viewscan.volume.spacing, views:Object.fromEntries(Object.entries(viewscan.volume.views).map(([k,v])=>[k,{step:v.step,native:v.native,ext:Math.round(v.extent)}]))})"))
        shot(page, "04-3d")
        if "3d" in steps:
            page.select_option("#toolbar select >> nth=1", "20")
            page.keyboard.press("5")
            time.sleep(0.8)
            shot(page, "05-3d-slab-mip")
            page.select_option("#toolbar select >> nth=1", "0")
            page.click('#r3-mode button[data-v="mip"]')
            time.sleep(0.8)
            shot(page, "06-3d-mip")
            page.click('#r3-mode button[data-v="surface"]')

    if "models" in steps:
        t = time.time()
        page.click("#btn-build")
        page.wait_for_function("!viewscan.building", timeout=600000)
        print("models built in %.1fs:" % (time.time() - t), page.evaluate("JSON.stringify((viewscan.models()||{items:[]}).items.map(i => ({k:i.key, ml:Math.round(i.volumeMl), tris:i.mesh?i.mesh.indices.length/3:0, note:i.note})))"))
        print("progress text:", page.inner_text("#seg-progress"))
        time.sleep(1.0)
        shot(page, "07-models")
        page.select_option("#cut-axis", "S")
        time.sleep(0.6)
        shot(page, "08-models-cut")
        page.select_option("#cut-axis", "")
        # big 3D panel: brain + vessels through a see-through skull, from the left
        page.evaluate("(() => { const v = viewscan.views.find(v => v.kind === '3d'); viewscan.toggleMax(v); const b = viewscan.models().items.find(i => i.key === 'bone'); if (b) b.opacity = 0.22; })()")
        time.sleep(0.5)
        page.click('#r3-look button[data-v="L"]')
        time.sleep(0.8)
        shot(page, "09-models-left-glass-skull")
        page.evaluate("(() => { for (const i of viewscan.models().items) i.visible = i.key === 'brain'; viewscan.redrawAll(); })()")
        page.click('#r3-look button[data-v="S"]')
        time.sleep(0.8)
        shot(page, "10-brain-top")
        page.evaluate("(() => { for (const i of viewscan.models().items) { i.visible = i.key === 'bone'; i.opacity = 1; } viewscan.redrawAll(); })()")
        page.click('#r3-look button[data-v="L"]')
        time.sleep(0.8)
        shot(page, "11-bone-left")
        page.evaluate("(() => { for (const i of viewscan.models().items) { i.visible = i.key !== 'bone'; i.opacity = i.key === 'brain' ? 0.25 : 1; } viewscan.redrawAll(); })()")
        page.click('#r3-look button[data-v="A"]')
        time.sleep(0.8)
        shot(page, "12-vessels-front")

    browser.close()

print("\nconsole problems:" if errors else "\nno console errors")
for e in errors[:40]:
    print("  ", e)
