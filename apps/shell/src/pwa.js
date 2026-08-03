/**
 * PWA — service worker registration + "install" handling for the shell's
 * app-context menu (see context-menu.js), plus update detection. Two
 * install flows share one `beforeinstallprompt` event, distinguished only
 * by WHICH manifest is active at the moment the browser's install prompt
 * fires:
 *
 *   - "Install QUniverse (PWA)": the static manifest at /manifest.webmanifest,
 *     `start_url: "/"` - launches to the shell's home screen.
 *   - "Install this page as a shortcut": swaps the <link rel="manifest">'s
 *     href to a freshly built Blob URL - a full copy of the same manifest
 *     with `start_url` set to the CURRENT hash route - immediately before
 *     prompting, then restores the static one after. Chromium-based
 *     browsers read the manifest link at prompt time, so the installed
 *     icon's start_url ends up being this page's own deep link. This is a
 *     best-effort browser capability (not a formal spec guarantee, and
 *     Safari/iOS does not support programmatic install at all) - the
 *     fallback in both cases is `appMenu.installUnavailable` (see
 *     context-menu.js), never a broken/silent button.
 *
 * UPDATE DETECTION: `registerServiceWorker()` also wires up the standard
 * install/waiting/activate service worker lifecycle so the shell can offer
 * a controlled "update available" reload instead of a new version only
 * ever taking effect on some unrelated future navigation. `onUpdateAvailable()`
 * lets the shell UI (see main.js's header button) know when to show
 * itself; `applyUpdate()` is what that button calls. See sw.js's own doc
 * comment for the worker-side half of this.
 */

const MANIFEST_LINK_ID = 'qu-manifest-link';
const STATIC_MANIFEST_HREF = '/manifest.webmanifest';

/** @type {Event|null} The captured `beforeinstallprompt` event, consumed once per prompt() call. */
let deferredInstallEvent = null;
/** @type {string|null} Blob URL of the last per-page manifest built, revoked before building the next one. */
let lastShortcutManifestUrl = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault(); // suppress the browser's own mini-infobar; we trigger it from our own menu instead
  deferredInstallEvent = event;
});

/** @type {ServiceWorkerRegistration|null} */
let swRegistration = null;
/** @type {Array<() => void>} Fired once a new worker is installed and waiting - see onUpdateAvailable(). */
let updateListeners = [];
/** @type {boolean} So a listener registered AFTER the update was already detected still gets called - see onUpdateAvailable(). */
let updateAlreadyDetected = false;

function announceUpdateAvailable() {
  updateAlreadyDetected = true;
  for (const cb of updateListeners) cb();
}

/**
 * Registers the shell's service worker (required by Chromium for
 * installability; also see @qu/push for its push/notificationclick
 * handlers) and wires up update detection - see sw.js's own doc comment
 * for why v2 onward installs a new worker into the WAITING state instead
 * of activating immediately, and onUpdateAvailable()/applyUpdate() below
 * for the page-side half of that flow.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      swRegistration = registration;

      // Covers the case where an update finished installing in a PREVIOUS
      // session (tab closed before the user acted on it, or before any
      // onUpdateAvailable() listener had registered) - `waiting` is still
      // set on a fresh registration lookup, so this isn't a one-time-only signal.
      if (registration.waiting) announceUpdateAvailable();

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `state === 'installed'` fires for the very FIRST install too;
          // `navigator.serviceWorker.controller` is only non-null once a
          // PREVIOUS worker has already taken control of this page - so
          // this specifically distinguishes "a genuine update finished
          // installing" from "this is the first-ever installation".
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            announceUpdateAvailable();
          }
        });
      });
    })
    .catch((err) => {
      console.warn('[shell] service worker registration failed (install/push features will be unavailable):', err);
    });

  // Fires (at most once - see the `reloaded` guard) when the new worker
  // ACTUALLY takes over, whether triggered by applyUpdate() below or by
  // some other tab of the same origin updating first. A plain reload is
  // the standard, safe way to pick up whatever that worker now controls;
  // without the guard, a page that also has an open tab already showing
  // fresh content (or a race between two tabs) could reload in a loop.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

/**
 * @param {() => void} callback - Called once a new service worker has
 *   finished installing and is waiting to take over (i.e. `applyUpdate()`
 *   is now meaningful to call) - immediately, if that already happened
 *   before this was registered.
 * @returns {() => void} Unsubscribe function.
 */
export function onUpdateAvailable(callback) {
  updateListeners.push(callback);
  if (updateAlreadyDetected) callback();
  return () => {
    updateListeners = updateListeners.filter((cb) => cb !== callback);
  };
}

/**
 * Tells the waiting worker to activate - triggers `sw.js`'s 'message'
 * handler, which calls `skipWaiting()`, which fires 'controllerchange'
 * (see registerServiceWorker() above) and reloads the page onto the new
 * worker/bundle. A no-op if nothing is actually waiting (e.g. called
 * twice, or before an update was ever detected).
 */
export function applyUpdate() {
  swRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

/** @returns {boolean} Whether a captured install prompt is currently available to trigger. */
export function canInstall() {
  return !!deferredInstallEvent;
}

/**
 * @param {string} currentHash - e.g. "#/notes/inbox", from `location.hash`.
 * @returns {Promise<void>} Fetches the static manifest, rewrites `start_url`
 *   to `currentHash`, points the page's manifest link at a Blob copy, then
 *   restores the static one once the browser has read it (or the user
 *   dismissed the prompt) - the swap must not persist, or a later "Install
 *   QUniverse" from the same page session would install the wrong start_url.
 */
export async function installCurrentPageAsShortcut(currentHash) {
  const res = await fetch(STATIC_MANIFEST_HREF);
  const manifest = await res.json();
  manifest.start_url = currentHash || '/';
  manifest.name = `${manifest.name} — ${document.title || currentHash}`;

  if (lastShortcutManifestUrl) URL.revokeObjectURL(lastShortcutManifestUrl);
  lastShortcutManifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));

  const link = document.getElementById(MANIFEST_LINK_ID);
  link.href = lastShortcutManifestUrl;
  try {
    await promptInstall();
  } finally {
    link.href = STATIC_MANIFEST_HREF;
  }
}

/** Installs QUniverse itself (static manifest, already the page's default `<link rel="manifest">`). */
export async function installApp() {
  await promptInstall();
}

async function promptInstall() {
  if (!deferredInstallEvent) throw new Error('no install prompt available');
  const event = deferredInstallEvent;
  deferredInstallEvent = null; // an event can only be prompted once
  await event.prompt();
  await event.userChoice;
}
