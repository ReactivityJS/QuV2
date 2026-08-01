/**
 * QUNIVERSE SERVICE WORKER — currently exists ONLY to make the shell
 * installable (Chromium requires a registered service worker with a
 * `fetch` handler as one of its installability criteria - see pwa.js). No
 * offline caching strategy on purpose: QUniverse's data is Qu itself
 * (IndexedDB-backed, synced over WebSocket, see @qu/runtime), not static
 * assets worth intercepting here - a caching layer for the SHELL BUNDLE
 * itself would be a reasonable future addition, but isn't needed for
 * installability and would add its own cache-invalidation complexity this
 * file deliberately avoids for now.
 *
 * This is also where push notification handling (`push`/`notificationclick`
 * listeners) will be added once that feature lands - see the "Push
 * notifications" entry in README's roadmap. Kept as a plain passthrough
 * until then rather than shipping half-built push handling with nothing
 * yet publishing to it.
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
