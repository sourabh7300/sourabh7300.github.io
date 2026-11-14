/* AURA service worker — makes the installed app open instantly, and open offline.
 *
 * Rules that matter here:
 *  - navigations are NETWORK FIRST. A cached HTML shell would fight the build stamp
 *    the page uses to auto-reload, so the network always wins when it is reachable and
 *    the cache is only the offline fallback.
 *  - static shell files are cache-first with a background refresh.
 *  - anything cross-origin (the chat backend) is never touched: no stale answers.
 *  - a new worker takes over immediately, so a fix ships with the next open.
 */
const VER = "aura-v1";
const SHELL = [
  "./",
  "./aura.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VER).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isDoc = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VER).then((c) => c.put("./aura.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./aura.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VER).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
