/**
 * WAKE LOCK — thin wrapper over the Screen Wake Lock API, pulled out as its
 * own package because "keep the display on while an active session is
 * running" isn't Geo Chase-specific (see apps/geochase/client.js, the
 * first app that needed it - a hunt can run for a while, and the phone
 * dimming/locking mid-chase defeats the point) - any app with a similarly
 * bounded "the screen must stay alive for this" window (a live map, a
 * timer, a call) can reuse the same `maintainWakeLock()` instead of each
 * hand-rolling its own visibilitychange dance.
 */

/** @returns {boolean} Whether this browser supports the Wake Lock API at all. */
export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/**
 * @returns {Promise<WakeLockSentinel|null>} The sentinel, or null if
 *   unsupported, or if the request failed (e.g. the document isn't
 *   visible right now, or the user/browser denied it) - never throws, a
 *   dimmed screen is a degraded experience, not a fatal one.
 */
export async function acquireWakeLock() {
  if (!isWakeLockSupported()) return null;
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}

/**
 * Keeps a wake lock held for as long as `isActive()` keeps returning true,
 * re-acquiring automatically when the page regains visibility - the OS
 * unconditionally releases any held wake lock the instant a tab is hidden
 * (switching tabs, locking the phone, backgrounding the browser), so
 * simply acquiring once at the start of a session would silently stop
 * protecting it the first time the user glances away and back.
 *
 * @param {() => boolean} isActive - Checked on every visibility change and
 *   right away; the caller decides what "active" means (e.g. Geo Chase:
 *   "this game is still running").
 * @returns {() => void} stop function - releases the lock and stops
 *   watching visibility. Call this when the session ends (unmount, game
 *   over, ...), not just when the lock happens to already be held.
 */
export function maintainWakeLock(isActive) {
  let sentinel = null;
  let stopped = false;

  async function ensure() {
    if (stopped || sentinel || !isActive() || document.visibilityState !== 'visible') return;
    sentinel = await acquireWakeLock();
  }

  async function release() {
    const current = sentinel;
    sentinel = null;
    try {
      await current?.release();
    } catch {
      // already released (e.g. the OS beat us to it on visibility change) - nothing to clean up
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') ensure();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  ensure();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    release();
  };
}
