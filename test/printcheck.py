"""Builds the models and checks they are printable: one closed shell, every edge
shared by exactly two triangles. Also checks the cut-away slider.

    python test/printcheck.py [CT|MR]
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

kind = sys.argv[1] if len(sys.argv) > 1 else "CT"
OUT = os.environ.get("VIEWSCAN_SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(OUT, exist_ok=True)
MESH_STATS = """() => viewscan.models().items.filter(i => i.mesh).map(it => {
  const idx = it.mesh.indices, nv = it.mesh.positions.length / 3;
  const edges = new Map();
  const parent = new Uint32Array(nv).map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < idx.length; i += 3) {
    const t = [idx[i], idx[i + 1], idx[i + 2]];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      edges.set(key, (edges.get(key) || 0) + 1);
      parent[find(a)] = find(b);
    }
  }
  let open = 0, multi = 0;
  for (const n of edges.values()) { if (n === 1) open++; else if (n > 2) multi++; }
  const shells = new Set();
  for (let i = 0; i < idx.length; i += 3) shells.add(find(idx[i]));
  return { key: it.key, triangles: idx.length / 3, shells: shells.size, openEdges: open, sharedByMoreThan2: multi, edges: edges.size };
})"""
V3 = "viewscan.views.find(v => v.kind === '3d')"
PICK = """(m) => { for (const s of viewscan.studies) if (s.modalities.includes(m)) { let best = null;
  for (const se of s.series) for (const st of se.stacks) if (st.volume && (!best || st.n > best.st.n)) best = { se, st };
  viewscan.api.openStack(s, best.se, best.st); return; } }"""
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
    for finish in (sys.argv[2:] or ["clean", "smooth", "xsmooth", "raw"]):
        page.select_option("#seg-finish", finish)
        page.click("#btn-build")
        page.wait_for_function("!viewscan.building", timeout=900000)
        print("finish:", finish, "|", page.inner_text("#seg-progress"))
        for row in page.evaluate(MESH_STATS):
            print("   ", row)
        page.evaluate(f"viewscan.toggleMax({V3})")
        page.click('#r3-look button[data-v="L"]')
        time.sleep(0.8)
        page.screenshot(path=os.path.join(OUT, f"finish-{kind}-{finish}.png"))
        page.evaluate(f"viewscan.toggleMax({V3})")
    # cut-away: with the dropdown still on Off, moving the slider must change the picture
    v3 = V3
    grab = f"(() => {{ const v = {v3}; v.draw(); const d = v.ctx.getImageData(0, 0, v.w, v.h).data; let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i]; return s; }})()"
    before = page.evaluate(grab)
    page.evaluate("(() => { const s = document.querySelector('#cut-pos'); s.value = 35; s.dispatchEvent(new Event('input', { bubbles: true })); })()")
    time.sleep(0.5)
    after = page.evaluate(grab)
    print("cut-away: dropdown now", repr(page.evaluate("document.querySelector('#cut-axis').value")), "| picture changed:", before != after)
    page.evaluate(f"viewscan.toggleMax({v3})")
    time.sleep(0.6)
    page.screenshot(path=os.path.join(OUT, f"cut-{kind}.png"))
    b.close()
print("page errors:", errs[:5])
