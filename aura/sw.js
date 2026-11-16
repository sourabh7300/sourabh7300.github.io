/* AURA service worker — v4: OFFLINE APP SHELL + keep-warm.
   v4 FIX (27 Oct 2026, owner order: "join changes live bhi jaane chahiye"):
      v3 served NAVIGATIONS cache-first, so every returning visitor kept getting the
      PREVIOUS build no matter how many times we deployed — invisible upgrades. The
      shell is now NETWORK-FIRST with the cache as the offline fallback: online you
      always get the build we just shipped, and with no network AURA still boots from
      cache exactly as before.
   1. OFFLINE SHELL (owner order, 17 Oct 2026: "work krtee rahee offline bhi"):
      precaches aura.html + the offline overlay, and warms noscript for refreshes —
      so AURA BOOTS FROM CACHE with zero network (flight mode, tunnel, backend down).
   2. RUNTIME CACHE: successful same-origin GET responses are stored as they
      happen, so fonts/assets keep working on flaky connections.
   3. CROSS-ORIGIN (backend, fonts, CDNs): network-first with cache fallback —
      fresh when online, last-known-good when the uplink is dark.
   4. KEEP-WARM (unchanged): pings /v1/ping every 4 min so the backend never sleeps. */

const CACHE = 'aura-shell-v4';
const BRAIN = 'https://aura-backend-jomj.onrender.com';
const SHELL_ASSETS = ['./', './aura.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

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

  /* NAVIGATION — NETWORK-FIRST (v4): the live build wins whenever we are online, and
     the cached shell takes over the moment the network is gone, so offline booting is
     untouched while a fresh deploy shows up on the very next load. */
  if (isShell(req)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const offline = async () => {
        const hit = await c.match('aura.html', { ignoreSearch: true }) || await c.match('./', { ignoreSearch: true });
        return hit || new Response('<h1 style="font-family:monospace">AURA offline — shell not cached yet. Reconnect once and reload.</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
      };
      if (url.origin.startsWith('chrome-extension')) return offline();
      try {
        const r = await fetch(req);
        if (r && r.ok) { c.put(new Request('./aura.html'), r.clone()).catch(() => {}); return r; }
        return await offline();
      } catch (err) {
        return await offline();
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

/* ---- WEB PUSH (16 Nov 2026) ----
   A locked phone freezes page timers, so a mesh order used to wait until the tab woke
   up (measured: one arrived 8s+ late, a poll gap of 26.8s). The platform's push
   service wakes THIS worker with the AURA tab closed — that is what makes a
   background order arrive instead of waiting. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { try { d = { body: e.data.text() }; } catch (e2) {} }
  const title = d.title || 'AURA mesh';
  const body = d.body || 'Order from the host';
  e.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, {
        body: body, tag: d.tag || 'aura-mesh', renotify: true,
        icon: './icon-192.png', badge: './icon-192.png',
        vibrate: [140, 60, 140],
        data: { url: './', cmd: d.cmd || '', arg: d.arg || '', code: d.code || '', at: Date.now() }
      });
    } catch (err) { /* permission revoked — nothing else this worker can do */ }
    /* an already-open AURA tab should show the order now, not at its next poll */
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      list.forEach(c => c.postMessage({ type: 'aura-push', body: body, cmd: d.cmd || '', arg: d.arg || '' }));
    } catch (err) {}
  })());
});
self.addEventListener('notificationclick', e => {
  try { e.notification.close(); } catch (err) {}
  const d = (e.notification && e.notification.data) || {};
  e.waitUntil((async () => {
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const hit = list.find(c => c.url && c.url.indexOf(self.location.origin) === 0);
      if (hit) {
        try { await hit.focus(); } catch (err) {}
        hit.postMessage({ type: 'aura-push-click', cmd: d.cmd || '', arg: d.arg || '', code: d.code || '' });
        return;
      }
      const w = await self.clients.openWindow(d.url || './');
      if (w) w.postMessage({ type: 'aura-push-click', cmd: d.cmd || '', arg: d.arg || '', code: d.code || '' });
    } catch (err) {}
  })());
});

/* keep-warm — the original job, kept verbatim */
function nap() { fetch(BRAIN + '/v1/ping', { mode: 'no-cors' }).catch(() => {}); }
setInterval(nap, 240000); nap();
self.addEventListener('message', e => { if (e.data === 'ping' || e.data === 'precache-now') { nap(); caches.open(CACHE).then(c => c.addAll(['./', './aura.html']).catch(() => {})); } });
