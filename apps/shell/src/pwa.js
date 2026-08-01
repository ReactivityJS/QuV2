/**
 * PWA — service worker registration + "install" handling for the shell's
 * app-context menu (see context-menu.js). Two install flows share one
 * `beforeinstallprompt` event, distinguished only by WHICH manifest is
 * active at the moment the browser's install prompt fires:
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

/** Registers the shell's service worker (required by Chromium for installability; also see @qu/push for its push/notificationclick handlers, added on top of this same file in a later phase). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('[shell] service worker registration failed (install/push features will be unavailable):', err);
  });
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
