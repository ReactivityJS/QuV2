/**
 * SYNC FRESHNESS — the one place every Service's "local data might be
 * stale" gap gets closed, for every app built on top of these Services
 * (Chat, Calendar, Geo Chase, Forum, Todo, ... - not a per-app concern).
 *
 * THE PROBLEM: `SyncEngine.subscribe()` only ever delivers writes made
 * AFTER a live connection exists (see @qu/sync's own doc comment) - it has
 * no concept of "catch me up on what I missed". Every Service's existing
 * `syncFetch` backfill (see DocumentService.get(), ThreadService.getConfig()
 * etc.) only fires when local data is COMPLETELY ABSENT - which correctly
 * handles "I've never seen this before" (e.g. a shared link opened for the
 * first time), but NOT "I've seen this before, but was offline/closed while
 * a peer changed it" - a returning session with SOME locally cached data
 * for a path never re-checks it, no matter how stale it's become, because
 * the `!local` gate is never true again. That's the concrete bug behind
 * "a chat message from while I was offline never shows up even after
 * reconnecting" - the room's messages collection already exists locally
 * (from before), so the backfill-on-miss code never runs again.
 *
 * THE FIX: refresh once per "generation" instead of once ever. A
 * generation (see SyncEngine.getGeneration()) bumps every time the
 * connection to the relay is (re-)established - the exact moments
 * staleness can actually have accumulated, no more. `backgroundRefresh(path)`
 * is fire-and-forget (never awaited by the caller, never blocks a read) -
 * any correction it turns up arrives through the SAME reactive pipeline a
 * live sync write already uses (`qu.onStorageChange` -> `watch()`), so
 * every app already watching the path it just read gets the correction for
 * free, without this layer knowing anything about UI. Errors (offline,
 * timeout) are swallowed - a failed background refresh must never surface
 * as a caller-visible failure; the local value already returned/rendered
 * is still the best available answer until (if ever) the refresh lands.
 */

/**
 * @param {(path: string) => Promise<object|null>} [syncFetch]
 * @param {() => number} [getGeneration]
 * @returns {(path: string) => void} `backgroundRefresh` - call after
 *   returning a value read from LOCAL storage (never before a blocking
 *   syncFetch-on-miss, which already IS a full refresh). A no-op if either
 *   dependency is missing (e.g. a server-side/relay QuCore with no single
 *   upstream peer - same fallback every other Service's `syncFetch` already
 *   has).
 */
export function createFreshnessTracker(syncFetch, getGeneration) {
  const refreshedAt = new Map(); // path -> generation it was last background-refreshed in

  return function backgroundRefresh(path) {
    if (!syncFetch || !getGeneration) return;
    const currentGeneration = getGeneration();
    if (refreshedAt.get(path) === currentGeneration) return; // already refreshed since the last (re)connect - nothing new to check yet
    refreshedAt.set(path, currentGeneration);
    syncFetch(path).catch(() => {});
  };
}
