const CACHE = "northstar-v1";
const SHELL = ["/", "/data/sf-events.json", "/manifest.webmanifest", "/maplibre/maplibre-gl-worker.mjs", "/maplibre/maplibre-gl-shared.mjs"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;
  const isTile = url.hostname.includes("cartocdn.com");
  const isStatic = url.origin === location.origin && (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/data/") || url.pathname.startsWith("/maplibre/"));
  if (isTile || isStatic) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  } else if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
  }
});
