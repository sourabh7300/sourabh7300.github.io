/* AURA keep-warm worker — keeps the brain endpoint cozy so answers stay fast.
   Same-origin with aura.html (required for service workers) and pings /v1/ping
   every 4 minutes so the Render backend never sleeps. */
const BRAIN = 'https://aura-backend-jomj.onrender.com';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
function nap() { fetch(BRAIN + '/v1/ping', { mode: 'no-cors' }).catch(() => {}); }
setInterval(nap, 240000); nap();
self.addEventListener('message', e => { if (e.data === 'ping') nap(); });
