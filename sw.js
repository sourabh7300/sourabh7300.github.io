const CACHE="sourabh-portfolio-v14";
const ASSETS=["./","./index.html","./portfolio.html","./aura.html","./foodora.html","./foodora-live.html","./lucid.html","./manifest.json","./icon-192.png","./icon-512.png","./favicon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  if(e.request.url.includes("api.groq.com")||e.request.url.includes("ntfy.sh")||e.request.url.includes("wikipedia")||e.request.url.includes("generativelanguage"))return;
  e.respondWith(
    fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c)).catch(()=>{});return r})
    .catch(()=>caches.match(e.request).then(m=>m||caches.match("./index.html")))
  );
});
