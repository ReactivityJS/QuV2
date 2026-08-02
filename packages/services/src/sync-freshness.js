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

/**
 * Sibling to `createFreshnessTracker()` above, for the OTHER half of every
 * Service's existing "local miss -> blocking syncFetch-once" backfill (see
 * e.g. CollectionService.listRawPaths()): that blocking fetch is correct
 * to attempt on a genuine first look (a shared link/thread opened for the
 * first time, or a per-message reactions collection this device has never
 * checked - CONFIRMING "nothing there" is itself useful information), but
 * with no gating at all it re-runs a full network round-trip on EVERY
 * single call for as long as the path stays locally empty - which, for
 * something like an unreacted-to chat message, is forever, every reload.
 * Concretely: a 40-message room with no reactions yet did 40 sequential
 * blocking fetches on every single re-render - invisible before Chat's
 * `reload()` rendered progressively (each fetch's wait was masked by the
 * previous rows already being on screen), but a hard, fully-blocking
 * multi-second stall once rendering became atomic (build everything, then
 * show it - see reload()'s own doc comment). `alreadyAttemptedMiss(path)`
 * gives callers a way to ask ONCE per generation and skip the repeat
 * round-trips for the rest of it, while still re-checking after every
 * reconnect - the same "local first, remote delta merged after" shape
 * `backgroundRefresh` already gives the "data exists but might be stale"
 * case, applied to the "confirmed absent so far" case instead.
 * @param {() => number} [getGeneration]
 * @returns {(path: string) => boolean} True if this exact path was already
 *   checked (successfully or not) since the last (re)connect - the caller
 *   should skip the blocking fetch and trust the current local (empty)
 *   read. Marks the path as attempted as a side effect, so call this
 *   right before deciding whether to fetch, not speculatively. Always
 *   false (never skips) when there's no generation concept at all (e.g. a
 *   relay-side QuCore with no single upstream peer) - matches the
 *   unconditional-attempt behavior every caller already had before this.
 */
export function createMissGate(getGeneration) {
  const attemptedAt = new Map(); // path -> generation last attempted (and still missing) in

  return function alreadyAttemptedMiss(path) {
    if (!getGeneration) return false;
    const currentGeneration = getGeneration();
    if (attemptedAt.get(path) === currentGeneration) return true;
    attemptedAt.set(path, currentGeneration);
    return false;
  };
}
