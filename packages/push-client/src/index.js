/**
 * @QU/PUSH-CLIENT — the browser-side half of Web Push: subscribing/
 * unsubscribing via the Push API, and forwarding a service worker's
 * "notification was clicked" message into an in-page navigation (see
 * apps/shell/public/sw.js's `notificationclick` handler, which posts that
 * message back to an already-open tab instead of just `focus()`-ing it,
 * since focusing alone doesn't change the visible route).
 *
 * The actual notification PREFERENCES (which apps/events to be pushed for)
 * live server-side, enforced by the relay before it ever sends anything -
 * see @qu/services' NotificationPrefsService; this package is purely "is a
 * subscription set up at all", the on/off switch one layer up from those
 * granular settings. Deliberately its own small package (browser-only, no
 * Node built-ins) rather than living inside apps/shell, since both the
 * shell chrome (registers the click listener at boot) and any
 * notification-settings app (the subscribe/unsubscribe UI - see
 * apps/notifications) need it, and apps don't import each other's source.
 */

/**
 * @param {(url: string) => void} onClick - Called with the payload's `url`
 *   (see @qu/relay's push delivery for its shape) when a notification is clicked.
 */
export function listenForNotificationClicks(onClick) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'qu-notification-click' && event.data.url) onClick(event.data.url);
  });
}

/** @returns {Promise<boolean>} Whether this browser currently has an active push subscription. */
export async function isPushSubscribed() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const registration = await navigator.serviceWorker.ready;
  return !!(await registration.pushManager.getSubscription());
}

/**
 * Asks the browser for notification permission (if not already granted),
 * subscribes via the Push API using this relay's VAPID public key, and
 * registers the subscription with `services.pushSubscriptions`.
 * @param {import('@qu/services').PushSubscriptionService} pushSubscriptions
 * @returns {Promise<void>}
 */
export async function subscribeToPush(pushSubscriptions) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');

  const { publicKey } = await (await fetch('/push/vapid-public-key')).json();
  if (!publicKey) throw new Error('This relay has no VAPID key configured yet');

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await pushSubscriptions.subscribe(subscription.toJSON());
}

/**
 * @param {import('@qu/services').PushSubscriptionService} pushSubscriptions
 * @returns {Promise<void>}
 */
export async function unsubscribeFromPush(pushSubscriptions) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await pushSubscriptions.unsubscribe(subscription.endpoint);
  await subscription.unsubscribe();
}

/** The Push API wants a Uint8Array, not the base64url string the relay serves. */
function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
