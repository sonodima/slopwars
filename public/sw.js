/* SlopWars service worker — makes the app installable + fast/native-feeling.
 * Strategy:
 *   - navigation requests → network-first, fall back to cached shell (offline launch)
 *   - other same-origin GETs → stale-while-revalidate (instant repeat loads)
 * Cross-origin (PeerJS signalling, STUN/TURN, etc.) is left untouched.
 *
 * Cache busting on deploy: the cache name carries a per-build id (`__BUILD__`, stamped
 * into this file at build time — see swVersion() in vite.config.ts). Game assets
 * (models/textures/HDRI/audio) are served with STABLE, non-hashed URLs, so without a
 * versioned cache the stale-while-revalidate copy would win on the first load after a
 * deploy and the new asset would only appear on a *second* refresh (the "needs a force
 * refresh" bug, incl. iOS PWA). Bumping the cache name each build makes `activate` purge
 * every older cache, so the new SW starts empty and refetches changed assets fresh.
 */
const BUILD = "__BUILD__";
const CACHE = `slopwars-${BUILD}`;
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
      // drop every previous build's cache (any slopwars-* that isn't this build's), so a
      // redeployed asset at the same URL can't be served from a stale cache
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
