"""Checks the AI brain model (a neural network run on the graphics card with WebGPU).

    python test/ai.py [folder]

Needs the server running and an installed Chrome (the test browser that comes with
Playwright cannot open a WebGPU device on Windows). Opens the folder (default: the
public sample MRI), builds the brain with the AI model and with the classic method,
and checks both give a sensible brain.
"""
import json
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


SET = """(o) => { for (const [id, v] of Object.entries(o)) { const e = document.getElementById(id);
  e.value = String(v); e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); } }"""


# How closely the finished mesh follows what the network found: every mesh point is
# looked up in the network's own answer (how sure it is that a spot is brain, 0 to 1).
# On the network's surface that value is one half; one voxel inside or outside it is 1 or 0.
FIDELITY = """async (key) => {
  const ai = await viewscan.volume.ai.get(key), p = viewscan.models().items[0].mesh.positions, S = 256, P = ai.prob;
  const at = (d, h, w) => P[(d * S + h) * S + w] / 255;
  let n = 0, near = 0, sum = 0;
  for (let i = 0; i < p.length; i += 3) {
    const v = [p[i] - ai.c0[0], p[i + 1] - ai.c0[1], p[i + 2] - ai.c0[2]];
    const q = ai.axes.map((a) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2]);
    if (q.some((x) => x < 0 || x > S - 1.001)) continue;
    const d = q[0] | 0, h = q[1] | 0, w = q[2] | 0, td = q[0] - d, th = q[1] - h, tw = q[2] - w;
    const c = (dd) => (at(dd, h, w) * (1 - tw) + at(dd, h, w + 1) * tw) * (1 - th) + (at(dd, h + 1, w) * (1 - tw) + at(dd, h + 1, w + 1) * tw) * th;
    const val = c(d) * (1 - td) + c(d + 1) * td;
    n++; sum += Math.abs(val - 0.5); if (val > 0.1 && val < 0.9) near++;
  }
  let vox = 0; for (let i = 0; i < P.length; i++) if (P[i] > 127) vox++;
  return { points: n, onSurface: near / n, meanOff: sum / n, modelMl: vox / 1000 };
}"""


def build(page):
    t = time.time()
    page.click("#btn-build")
    page.wait_for_function("viewscan.building", timeout=30000)
    page.wait_for_function("!viewscan.building", timeout=900000)
    r = json.loads(page.evaluate("JSON.stringify({ item: viewscan.models().items.map(i => ({ ml: Math.round(i.volumeMl), tris: i.mesh ? i.mesh.indices.length / 3 : 0, note: i.note }))[0], used: viewscan.lastUsed })"))
    r["secs"] = time.time() - t
    return r


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--enable-features=WebGPU"])
    page = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_selector("#splash.hidden", state="attached", timeout=120000)
    page.set_input_files("#folder-input", os.path.abspath(FOLDER))
    page.wait_for_function("viewscan.studies.some(s => s.source !== 'server')", timeout=300000)
    page.wait_for_function("viewscan.volume && viewscan.volume.stack.source.type === 'local' && viewscan.views.every(v => v.vol) && viewscan.volume.stack.done", timeout=300000)
    page.wait_for_function("viewscan.gpuOK !== undefined", timeout=30000)
    ok(page.evaluate("viewscan.gpuOK === true"), "this browser can run the brain models (WebGPU)")
    page.evaluate("document.querySelectorAll('#targets input[data-target]').forEach(i => { i.checked = i.dataset.target === 'brain'; })")
    page.evaluate(SET, {"m-model": "auto"})
    ok("AI model" in page.evaluate("document.getElementById('m-model').options[0].textContent"), "Auto picks the AI model for this scan")

    ok(page.is_visible("#ai-more") and not page.is_visible("#mr-more"), "the AI model has its own fine-tune panel; the classic one is put away")
    page.evaluate("document.getElementById('ai-more').open = true")
    page.wait_for_function("viewscan.volume.stack.preview && document.getElementById('a-status').textContent.startsWith('Brain: about')", timeout=120000)
    ok(True, "the slices are tinted with what the model found: " + page.inner_text("#a-status"))
    ok(page.evaluate("viewscan.tool") == "cross", "Locate is the mouse tool to start with in 3D")

    r = build(page)
    ok(r["used"] and r["used"].get("model") == "partsBig", "the brain was found by the AI model (%.1fs)" % r["secs"])
    ok(1100 < r["item"]["ml"] < 1900 and r["item"]["tris"] > 50000, "it is a whole brain: %d mL, %dk triangles" % (r["item"]["ml"], r["item"]["tris"] / 1000))
    ok(not r["item"]["note"], "with no warning")
    for finish in ("raw", "crisp", "clean"):
        page.evaluate(SET, {"seg-finish": finish})
        rf = build(page)
        fid = page.evaluate(FIDELITY, "partsBig")
        print("     finish %-5s: %.1f%% of %dk mesh points lie on the surface the network found; mesh %d mL, network %d mL" % (finish, 100 * fid["onSurface"], fid["points"] / 1000, rf["item"]["ml"], fid["modelMl"]))
        if finish == "raw":
            ok(fid["onSurface"] > 0.93, "the raw mesh follows the network's surface (no detail lost on the way to a 3D model)")
    r2 = build(page)
    ok(r2["secs"] < 6, "a build reuses the answer the network already gave (%.1fs)" % r2["secs"])

    page.evaluate(SET, {"m-model": "parts"})
    r3 = build(page)
    ok(r3["used"].get("model") == "parts" and abs(r3["item"]["ml"] - r["item"]["ml"]) < 150, "the quicker network agrees: %d mL" % r3["item"]["ml"])

    page.evaluate(SET, {"m-model": "classic"})
    r4 = build(page)
    ok(not r4["used"].get("model") and 900 < r4["item"]["ml"] < 1900, "Classic still works: %d mL" % r4["item"]["ml"])
    ok(page.is_visible("#mr-more") and not page.is_visible("#ai-more"), "and shows its own panel")
    for key in ("maskFast", "mask", "tissue", "tissueFast", "areas50", "areas104"):
        page.evaluate(SET, {"m-model": key})
        rk = build(page)
        ok(rk["used"].get("model") == key and 800 < rk["item"]["ml"] < 1900 and not errs, "%s: %d mL in %.1fs" % (key, rk["item"]["ml"], rk["secs"]))
    # the compare grid: AI versions and classic versions, each under its own heading
    t = time.time()
    page.evaluate("document.getElementById('btn-compare').click()")
    page.wait_for_function("viewscan.compareDone === true", timeout=1500000)
    heads = page.evaluate("[...document.querySelectorAll('.cmp-group > summary')].map(h => h.textContent)")
    n_ai = page.evaluate("document.querySelectorAll('.cmp-sec')[0].querySelectorAll('.cmp-tile').length")
    n_cl = page.evaluate("document.querySelectorAll('.cmp-sec')[1].querySelectorAll('.cmp-tile').length")
    built = page.evaluate("[...document.querySelectorAll('.cmp-tile')].filter(t => !t.querySelector('button').disabled).length")
    print("     %d versions in %.0fs: %s" % (n_ai + n_cl, time.time() - t, " | ".join(heads)))
    ok(len(heads) == 2 and 6 <= n_ai <= 20 and n_cl == 3, "the grid opens with the best versions only: %d AI and %d classic, apart" % (n_ai, n_cl))
    ok(built == n_ai + n_cl, "all of them gave a model (%d of %d)" % (built, n_ai + n_cl))
    page.click("#cmp-all")
    page.wait_for_function("viewscan.compareDone === true && document.querySelectorAll('.cmp-tile').length >= 60", timeout=1500000)
    n_ai = page.evaluate("document.querySelectorAll('.cmp-sec')[0].querySelectorAll('.cmp-tile').length")
    n_cl = page.evaluate("document.querySelectorAll('.cmp-sec')[1].querySelectorAll('.cmp-tile').length")
    built = page.evaluate("[...document.querySelectorAll('.cmp-tile')].filter(t => !t.querySelector('button').disabled).length")
    ok(n_ai >= 40 and n_cl == 28 and built == n_ai + n_cl, "“Show all the standard versions” adds the rest: %d AI and %d classic, all built" % (n_ai, n_cl))
    page.locator(".cmp-group > summary").nth(1).click()
    ok(not page.locator(".cmp-sec").nth(1).is_visible() and page.locator(".cmp-sec").nth(0).is_visible(), "a group folds away with a click on its heading")
    page.click("#cmp-more")
    page.wait_for_function("viewscan.compareDone === true && document.querySelectorAll('.cmp-tile').length === %d" % (n_ai + n_cl + 30), timeout=1500000)
    ok(page.evaluate("document.querySelectorAll('.cmp-sec')[0].querySelectorAll('.cmp-tile').length") == n_ai + 15, "“Try 30 more” adds fifteen AI mixes and fifteen classic ones")
    page.locator(".cmp-sec").nth(0).locator(".cmp-tile", has_text="18 parts (best) · stricter +2 · fine grid · crisp").first.locator("button").first.click()
    time.sleep(1)
    ok(page.evaluate("document.getElementById('compare').hidden && document.getElementById('m-model').value === 'partsBig' && Number(document.getElementById('a-level').value) === 2"), "picking an AI version puts its model and settings on the panel")
    ok(not errs, "no errors on the page" + ("" if not errs else ": " + " | ".join(errs[:4])))
    b.close()

print("FAILED" if failed else "all good")
sys.exit(1 if failed else 0)
