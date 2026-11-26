"""Checks that the page works on a plain web host with no Viewscan server (GitHub Pages).

    python test/pages.py [folder]

Copies public/ into a sub-folder of a temporary site, serves it with Python's
plain file server (no special headers, no /api), and checks that the page
starts without a library, switches thread sharing on by itself, opens a folder
(default: the public sample MRI) and builds a model from it.
"""
import functools
import http.server
import os
import shutil
import sys
import tempfile
import threading
import time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "Sample MRI brain (T1)")
failed = 0


def ok(cond, msg):
    global failed
    print(("ok   " if cond else "FAIL ") + msg)
    failed += 0 if cond else 1


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


site = tempfile.mkdtemp(prefix="viewscan-pages-")
shutil.copytree(os.path.join(HERE, "..", "public"), os.path.join(site, "viewscan"))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=site))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/viewscan/" % srv.server_address[1]

try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 1500, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        # the missing library answers 404 once; that is how the page learns it has no server
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" and "404" not in m.text else None)
        page.goto(URL)
        # the page reloads itself once while the service worker takes over
        page.wait_for_function("self.crossOriginIsolated === true && window.viewscan && viewscan.libraryLoaded", timeout=60000)
        page.wait_for_selector("#splash.hidden", state="attached", timeout=60000)
        ok(page.evaluate("viewscan.hosted === true"), "starts without a server, in a sub-folder of the site")
        ok(page.evaluate("self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'"), "thread sharing is on without server headers")
        ok(page.evaluate("viewscan.studies.length") == 0, "no library, nothing listed")
        ok("Open folder" in page.inner_text("#views"), "says how to open a folder")

        page.set_input_files("#folder-input", os.path.abspath(FOLDER))
        page.wait_for_function("viewscan.studies.length > 0", timeout=120000)
        page.wait_for_function("window.viewscan && viewscan.volume && viewscan.views.every(v => v.vol)", timeout=180000)
        ok(True, "opens a folder from this computer: " + page.evaluate("viewscan.project"))
        t = time.time()
        page.click("#btn-build")
        page.wait_for_function("viewscan.building", timeout=30000)
        page.wait_for_function("!viewscan.building", timeout=900000)
        n = page.evaluate("(viewscan.models() || {items: []}).items.filter(i => i.mesh).length")
        ok(n > 0, "builds %d model(s) in %.1fs" % (n, time.time() - t))

        page.reload()
        page.wait_for_function("window.viewscan && viewscan.libraryLoaded", timeout=60000)
        ok(page.evaluate("self.crossOriginIsolated && viewscan.studies.length > 0"), "after a reload the folder is back and sharing is still on")
        ok(not errs, "no errors on the page" + ("" if not errs else ": " + " | ".join(errs[:4])))
        b.close()
finally:
    srv.shutdown()
    shutil.rmtree(site, ignore_errors=True)

print("FAILED" if failed else "all good")
sys.exit(1 if failed else 0)
