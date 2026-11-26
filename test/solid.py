"""Checks "Solid inside": builds the brain with and without it and measures how
much hollow space is left inside the model, then saves cut-open pictures.

    python test/solid.py [CT|MR]
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

kind = sys.argv[1] if len(sys.argv) > 1 else "MR"
OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(OUT, exist_ok=True)
V3 = "viewscan.views.find(v => v.kind === '3d')"
PICK = """(m) => { for (const s of viewscan.studies) if (s.modalities.includes(m)) { let best = null;
  for (const se of s.series) for (const st of se.stacks) if (st.volume && (!best || st.n > best.st.n)) best = { se, st };
  viewscan.api.openStack(s, best.se, best.st); return; } }"""
# shells = separate closed surfaces; a hollow chamber sealed inside shows up as an extra shell,
# and the enclosed volume of the mesh tells how much material the print needs
STATS = """(key) => { const it = viewscan.models().items.find(i => i.key === key); const p = it.mesh.positions, idx = it.mesh.indices;
  let v6 = 0; for (let i = 0; i < idx.length; i += 3) { const a = idx[i]*3, b = idx[i+1]*3, c = idx[i+2]*3;
    v6 += p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1]) - p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c]) + p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]); }
  return { key, solid: it.solid, maskMl: Math.round(it.volumeMl), meshMl: Math.round(Math.abs(v6)/6000), triangles: idx.length/3 }; }"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1680, "height": 980})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(os.environ.get("VIEWSCAN_URL", "http://127.0.0.1:8127/"))
    page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
    if page.evaluate("viewscan.volume.stack.series.modality") != kind:
        page.evaluate(PICK, kind)
        page.wait_for_function("viewscan.volume && viewscan.volume.stack.series.modality === '%s' && viewscan.views.every(v => v.vol)" % kind, timeout=180000)
    parts = ["brain"] + (["bone"] if kind == "CT" else [])
    page.evaluate("(parts) => document.querySelectorAll('#targets input[data-target]').forEach(i => { i.checked = parts.includes(i.dataset.target); })", parts)
    for solid in (False, True):
        for part in parts:
            page.set_checked(f'#targets input[data-solid="{part}"]', solid)
        page.click("#btn-build")
        page.wait_for_function("!viewscan.building", timeout=900000)
        print("solid inside:", solid, "|", page.inner_text("#seg-progress"))
        for part in parts:
            print("   ", page.evaluate(STATS, part))
        # cut the model open from the left, half way, and look at the cut face
        page.select_option("#cut-axis", "L")
        page.evaluate("(() => { const s = document.querySelector('#cut-pos'); s.value = 50; s.dispatchEvent(new Event('input', { bubbles: true })); })()")
        page.evaluate(f"viewscan.toggleMax({V3})")
        page.click('#r3-look button[data-v="L"]')
        time.sleep(0.8)
        page.screenshot(path=os.path.join(OUT, f"solid-{kind}-{'on' if solid else 'off'}.png"))
        page.evaluate(f"viewscan.toggleMax({V3})")
        # and the tinted mask on the slices
        page.screenshot(path=os.path.join(OUT, f"solid-{kind}-{'on' if solid else 'off'}-slices.png"))
    b.close()
print("page errors:", errs[:5])
