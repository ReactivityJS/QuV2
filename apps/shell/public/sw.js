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

const SW_VERSION = 'v2';

// v1 called skipWaiting() unconditionally on install, so a new worker
// always took over immediately - no "update available" moment ever existed
// for the page to detect and offer a controlled reload for (see pwa.js's
// onUpdateAvailable()/applyUpdate()). v2 installs and then WAITS, same as
// any standard update-prompt PWA, until the page explicitly asks it to
// take over via the 'message' handler below - see that handler's own
// comment for why this is safe to do without breaking the very first
// install (which has no earlier controller to disrupt in the first place).
self.addEventListener('install', () => {
  // Intentionally no self.skipWaiting() here - see SW_VERSION's own comment.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Lets the page hand back control: apps/shell/src/pwa.js's applyUpdate()
// posts this once the user has agreed to reload for an update (or, for a
// silent/automatic upgrade path, whenever the page decides to). Scoped to
// exactly this one message type so nothing else can accidentally trigger
// an activation mid-session.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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
