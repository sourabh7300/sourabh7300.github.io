/* AURA service worker — v3: OFFLINE APP SHELL + keep-warm.
   1. OFFLINE SHELL (owner order, 17 Oct 2026: "work krtee rahee offline bhi"):
      precaches aura.html + the offline overlay, serves cache-first for navigations
      and same-origin GETs, and warms noscript for refreshes — so AURA BOOTS FROM
      CACHE with zero network (flight mode, tunnel, backend down: everything).
   2. RUNTIME CACHE: successful same-origin GET responses are stored as they
      happen, so fonts/assets keep working on flaky connections.
   3. CROSS-ORIGIN (backend, fonts, CDNs): network-first with cache fallback —
      fresh when online, last-known-good when the uplink is dark.
   4. KEEP-WARM (unchanged): pings /v1/ping every 4 min so the backend never sleeps. */

const CACHE = 'aura-shell-v3';
const BRAIN = 'https://aura-backend-jomj.onrender.com';
const SHELL_ASSETS = ['./', './aura.html'];

/* precache on install — wait so the very first reload can already boot offline */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL_ASSETS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* sweep every cache that is not ours — old offline shells must not linger */
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isShell(req) { return req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html'); }

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;               // POSTs go to the network as-is
  const url = new URL(req.url);

  /* NAVIGATION — cache-first: offline boots instantly, and we refresh the copy in
     the background so the next online visit is current (stale-while-revalidate). */
  if (isShell(req)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match('aura.html', { ignoreSearch: true }) || await c.match('./', { ignoreSearch: true });
      if (hit && !url.origin.startsWith('chrome-extension')) {
        fetch('./aura.html', { cache: 'reload' }).then(r => { if (r && r.ok) return c.put(new Request('./aura.html'), r.clone()); }).catch(() => {});
        return hit;
      }
      try {
        const r = await fetch(req);
        if (r && r.ok) { const put = r.clone(); caches.open(CACHE).then(c2 => c2.put(new Request('./aura.html'), put)); }
        return r;
      } catch (err) {
        const last = await c.match('aura.html', { ignoreSearch: true });
        return last || new Response('<h1 style="font-family:monospace">AURA offline — shell not cached yet. Reconnect once and reload.</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  /* SAME-ORIGIN assets — cache-first, store every fresh copy as it arrives. */
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r && r.ok && r.type === 'basic') c.put(req, r.clone());
        return r;
      } catch (err) { return hit || Response.error(); }
    })());
    return;
  }

  /* CROSS-ORIGIN — network-first, cache fallback (fonts/backend GETs/CDNs). */
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(req);
      if (r && r.ok && (r.type === 'cors' || r.type === 'basic')) { const put = r.clone(); c.put(req, put); }
      return r;
    } catch (err) {
      const hit = await c.match(req);
      return hit || Response.error();
    }
  })());
});

/* keep-warm — the original job, kept verbatim */
function nap() { fetch(BRAIN + '/v1/ping', { mode: 'no-cors' }).catch(() => {}); }
setInterval(nap, 240000); nap();
self.addEventListener('message', e => { if (e.data === 'ping' || e.data === 'precache-now') { nap(); caches.open(CACHE).then(c => c.addAll(['./', './aura.html']).catch(() => {})); } });
