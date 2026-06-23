// Service worker — installability + Web Push.
//
// Why this exists at all:
//   - Chrome/Edge refuse the PWA install prompt without a registered SW.
//   - Web Push requires a SW to receive `push` events when the page is closed.
//
// What it does NOT do:
//   - Cache app assets. We ship updates frequently from Base44 and any cache
//     here risks shipping stale UI. If you ever want offline support, add a
//     Workbox-style precache and bump CACHE_NAME on every deploy.

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

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------
//
// The server (sendPushNotification Deno function) encrypts a JSON payload
// against the user's subscription keys and POSTs to the browser's push
// service. Chrome / Firefox / Safari then wake this SW and fire `push`.
//
// Expected payload shape (best-effort; we tolerate missing fields):
//   {
//     title: string,
//     body: string,
//     url?: string,           // path to open on click (e.g. "/Bookings#booking-123")
//     tag?: string,           // dedupe key — newer notifications with the
//                             // same tag replace older ones instead of stacking
//     icon?: string,          // optional override; defaults to /icon.svg
//     badge?: string,         // monochrome icon shown in status bar (Android)
//     data?: object,          // arbitrary extras forwarded to notificationclick
//   }
//
// If the server POSTs with no payload (some test pings do), we show a
// generic fallback so the user isn't startled by a silent push that they
// granted permission for.

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Treat as plain text body
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Urban Stays';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.svg',
    badge: payload.badge || '/icon.svg',
    tag: payload.tag,                  // undefined = no dedupe; OK
    data: {
      url: payload.url || '/',
      ...(payload.data || {}),
    },
    // Reasonable defaults — most users want sound + vibration on phones.
    vibrate: payload.vibrate || [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// When the user taps the notification: focus an existing tab on that URL if
// one is open; otherwise open a new tab. Best-effort match by URL prefix so
// "/Bookings" focuses any open Bookings tab even if the hash differs.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  // Resolve to an absolute URL against the SW scope so clients.openWindow gets
  // a fully-qualified path on every browser.
  const absoluteUrl = new URL(targetUrl, self.location.origin).href;

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (const client of clientsList) {
      // Match by origin + pathname prefix — hash / query may differ but the
      // page is "the same" for the user's purposes.
      try {
        const c = new URL(client.url);
        const t = new URL(absoluteUrl);
        if (c.origin === t.origin && c.pathname === t.pathname) {
          await client.focus();
          // Navigate to the precise URL (may include a deep link hash) so
          // the page actually scrolls / opens the right item.
          if (client.url !== absoluteUrl && 'navigate' in client) {
            try { await client.navigate(absoluteUrl); } catch { /* OK to ignore */ }
          }
          return;
        }
      } catch { /* malformed URL — ignore */ }
    }
    // No existing tab matched — open one.
    if (self.clients.openWindow) {
      await self.clients.openWindow(absoluteUrl);
    }
  })());
});

// Some browsers fire `pushsubscriptionchange` when they invalidate a
// subscription (e.g. user clears site data, key rotation). We can't talk to
// the server from here without a fetch — but firing one with the old
// subscription endpoint lets the server prune it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const oldEndpoint = event.oldSubscription?.endpoint;
      if (!oldEndpoint) return;
      await fetch('/api/functions/removePushSubscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: oldEndpoint, reason: 'subscriptionchange' }),
      });
    } catch (err) {
      // Best-effort — if the server is unreachable, server-side pruning
      // (404/410 detection in sendPushNotification) will catch it later.
      console.warn('pushsubscriptionchange cleanup failed', err);
    }
  })());
});
