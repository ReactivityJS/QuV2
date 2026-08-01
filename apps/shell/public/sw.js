/**
 * QUNIVERSE SERVICE WORKER — makes the shell installable (Chromium
 * requires a registered service worker with a `fetch` handler - see
 * pwa.js) and handles incoming Web Push notifications. No offline caching
 * strategy on purpose: QUniverse's data is Qu itself (IndexedDB-backed,
 * synced over WebSocket, see @qu/runtime), not static assets worth
 * intercepting here.
 *
 * Push payloads are always the GENERIC template @qu/relay's push delivery
 * builds (title/body/appId/url - see relay.js's `#deliverThreadPush()`) -
 * NEVER decrypted message content, since the push service in between
 * (FCM, Mozilla's push service, ...) is untrusted; this worker has no way
 * to decrypt a Thread message even if it wanted to (that needs the
 * identity's X25519 key, which never leaves the page's own IndexedDB - see
 * @qu/identity). Clicking a notification just opens/focuses the shell at
 * the `url` the payload named.
 */

const SW_VERSION = 'v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let payload = { title: 'QUniverse', body: 'You have a new notification.', url: '#/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Malformed/empty push payload - fall back to the generic message above rather than showing nothing.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      data: { url: payload.url },
      tag: payload.appId, // a second push for the same app REPLACES the previous notification instead of stacking silently
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '#/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientsList.find((c) => 'focus' in c);
      if (existing) {
        existing.postMessage({ type: 'qu-notification-click', url });
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })()
  );
});
