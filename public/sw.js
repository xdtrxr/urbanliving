// Minimal service worker — exists so the browser meets PWA installability
// requirements (Chrome/Edge refuse the install prompt without one). It does
// NOT cache app assets: the app is hosted on Base44 and we ship updates
// frequently, so any caching here would risk shipping stale UI to users.
//
// If you want offline support later, add a Workbox-style precache here and
// bump the CACHE_NAME on every deploy.

self.addEventListener('install', () => {
  // Activate immediately on first install so future loads pick up the SW.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of any open tabs without requiring a reload.
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch — never serve from cache. App stays live.
self.addEventListener('fetch', () => {
  // Intentionally no-op. The browser handles the request as if no SW exists.
});
