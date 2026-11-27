// sw.js — adds the headers that let the page share memory between threads (see isolate.js).
// It changes nothing else and stores nothing: every request still goes to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  // The app's own files are always checked against the site (a cheap "has it changed?"
  // request), so a visitor never runs a mix of old and new files after an update.
  const own = req.method === 'GET' && new URL(req.url).origin === self.location.origin;
  e.respondWith(fetch(own ? new Request(req, { cache: 'no-cache' }) : req).then((res) => {
    if (res.status === 0) return res; // opaque answer from another site: cannot be changed
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
