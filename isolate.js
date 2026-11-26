// isolate.js — makes fast model building possible on a plain web host.
// The helper threads share memory, which browsers only allow on a page served with
// two special headers. Viewscan's own server sends them; a static host such as
// GitHub Pages cannot. There, a service worker (sw.js) adds them to every file the
// page loads, and the page reloads once so the headers take effect. With Viewscan's
// own server the page is already isolated and nothing here runs.
(() => {
  if (self.crossOriginIsolated || !self.isSecureContext || !('serviceWorker' in navigator)) return;
  const reload = () => {
    try { if (sessionStorage.getItem('viewscan.isolating')) return; sessionStorage.setItem('viewscan.isolating', '1'); } catch { return; }
    location.reload();
  };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (navigator.serviceWorker.controller) return reload(); // in charge already, yet this load missed the headers
    const sw = reg.installing || reg.waiting || reg.active;
    if (!sw) return;
    if (sw.state === 'activated') return reload();
    sw.addEventListener('statechange', () => { if (sw.state === 'activated') reload(); });
  }).catch(() => { /* no service worker: models are still built, on one thread */ });
})();
