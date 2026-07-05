/* SlopWars service worker — makes the app installable + fast/native-feeling.
 * Strategy:
 *   - navigation requests → network-first, fall back to cached shell (offline launch)
 *   - other same-origin GETs → stale-while-revalidate (instant repeat loads)
 * Cross-origin (PeerJS signalling, STUN/TURN, etc.) is left untouched.
 */
const CACHE = "slopwars-v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./logo.png"];

// Precache the app shell + the build's JS/CSS (from precache.json) so the game
// boots with no network. Game assets (models/HDRI/audio) are cached at runtime
// the first time they're fetched (see the fetch handler below).
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let list = SHELL.slice();
    try {
      const res = await fetch("./precache.json", { cache: "no-cache" });
      if (res.ok) list = list.concat(await res.json());
    } catch { /* offline install / no manifest → shell only */ }
    // cache individually so one failure doesn't abort the whole install
    await Promise.allSettled([...new Set(list)].map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch signalling / CDNs

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
