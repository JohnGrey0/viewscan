"""Builds the brain model for one study and saves brain-only pictures.

    python test/brain.py CT|MR [detail-mm]
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

kind = sys.argv[1] if len(sys.argv) > 1 else "MR"
detail = sys.argv[2] if len(sys.argv) > 2 else "1"
OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(OUT, exist_ok=True)
PICK = """(m) => {
  for (const s of viewscan.studies) if (s.modalities.includes(m)) {
    let best = null;
    for (const se of s.series) for (const st of se.stacks) if (st.volume && (!best || st.n > best.st.n)) best = { se, st };
    viewscan.api.openStack(s, best.se, best.st);
    return;
  }
}"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1680, "height": 980})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/"))
    page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
    if page.evaluate("viewscan.volume.stack.series.modality") != kind:
        page.evaluate(PICK, kind)
        page.wait_for_function("viewscan.volume && viewscan.volume.stack.series.modality === '%s' && viewscan.views.every(v => v.vol)" % kind, timeout=180000)
    page.evaluate("document.querySelectorAll('#targets input').forEach(i => { i.checked = i.dataset.target === 'brain'; })")
    page.select_option("#seg-detail", detail)
    t = time.time()
    page.click("#btn-build")
    page.wait_for_function("!viewscan.building", timeout=900000)
    print("%s detail %s: %.1fs" % (kind, detail, time.time() - t),
          page.evaluate("JSON.stringify(viewscan.models().items.map(i => ({k:i.key, ml:Math.round(i.volumeMl), tris:i.mesh ? i.mesh.indices.length/3 : 0, note:i.note})))"),
          page.inner_text("#seg-progress"))
    time.sleep(0.8)
    page.screenshot(path=os.path.join(OUT, f"brain-{kind}-{detail}-slices.png"))
    page.evaluate("viewscan.toggleMax(viewscan.views.find(v => v.kind === '3d'))")
    for name, d in (("left", "L"), ("top", "S"), ("front", "A")):
        page.click(f'#r3-look button[data-v="{d}"]')
        time.sleep(0.7)
        page.screenshot(path=os.path.join(OUT, f"brain-{kind}-{detail}-{name}.png"))
    b.close()
print("errors:", errs[:8])
