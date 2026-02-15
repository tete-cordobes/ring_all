// Vibe Deck Remote — Service Worker
const CACHE_NAME = 'vibe-deck-remote-v1';
const STATIC_ASSETS = [
  '/mobile/',
  '/mobile/index.html',
  '/mobile/app.js',
  '/mobile/style.css',
  '/mobile/manifest.json',
];

// Install: pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for API/ws
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and WebSocket upgrade requests
  if (request.method !== 'GET') return;

  // Static assets: cache-first
  if (url.pathname.startsWith('/mobile/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else: network-first with offline fallback
  event.respondWith(
    fetch(request).catch(() =>
      caches.match(request).then(
        (cached) =>
          cached ||
          new Response('Offline — please reconnect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
      )
    )
  );
});
