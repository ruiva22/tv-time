// Minimal service worker — just enough to make the app installable and
// give it some offline resilience. No precache list to keep in sync with
// each build; it just remembers whatever's actually been fetched.
//
// Scope: same-origin GET requests only, and never /api/* (the TMDB proxy
// should always be live data, not a stale cached response). Everything
// else — POSTs, cross-origin requests (Firestore, Google auth) — passes
// straight through untouched.
const CACHE = "tv-time-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
