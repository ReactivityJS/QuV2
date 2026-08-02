/**
 * WATCH — turns QuStore's write notifications into a "subscribe to one
 * path's current value" primitive, the thing every reactive UI actually
 * needs. This is deliberately the ONLY function in this package: Qu Core's
 * `onStorageChange()` (see @qu/core/store.js) already gives us a
 * fault-isolated notify bus for every write in the whole store - all that's
 * missing for UI purposes is "only tell me about ONE path, and tell me the
 * current value immediately, not just future changes". That's `watch()`.
 *
 * This intentionally does NOT try to be a query/index/prefix-watching
 * system. A collection (see @qu/services' CollectionService) is stored as
 * ONE document whose value happens to be a list - watching that one
 * document's path is already enough to react to the list changing, add/
 * remove included. There is no second, broader "watch everything under a
 * prefix" primitive to build or maintain.
 *
 * Every delivery - initial AND live - goes through `qu.get(path)`, never
 * the raw QuBit off the notify event. That's deliberate, not just "the
 * simplest option": `qu.get()` runs QuStore's full GET pipeline (see
 * @qu/core/store.js), which is where things like CollectionEngine's
 * `$list` resolution happen. The notify event only carries the value as it
 * was WRITTEN (pre-resolution) - using it directly would mean a
 * <qu-list>-style live view showing correctly RESOLVED items on first
 * render, then snapping to raw, unresolved `{$list: [...]}` data on the
 * very next change. Treating the notify event as nothing more than a
 * "something changed, go re-read" trigger avoids that inconsistency
 * entirely, at the cost of one extra read per relevant write - cheap
 * against every adapter this repo ships.
 */

/**
 * Calls `callback(value)` once with the current value at `path` (or `null`
 * if nothing is stored there yet), then again every time something writes
 * to that exact path.
 *
 * @param {import('@qu/core').QuCore} qu
 * @param {string} path
 * @param {(value: *) => void} callback
 * @param {{initial?: boolean, syncFetch?: (path: string) => Promise<object|null>}} [options] -
 *   `initial: false` skips the immediate current-value call, delivering
 *   only future changes. `syncFetch` (typically `(path) => sync.fetch(path)`,
 *   see @qu/sync): if given, fired once when `watch()` is first attached to
 *   ask a peer for this path's CURRENT value, not just the initial LOCAL
 *   one above. Without this, watching a path only ever shows what's already
 *   on disk plus whatever a broad `subscribe()` happens to push AFTER this
 *   moment (see SyncEngine's own doc comment: subscribing only delivers
 *   FUTURE writes) - a value a peer wrote before this session subscribed,
 *   or while this session was offline/hadn't opened this exact view yet,
 *   would otherwise sit unnoticed until something UNRELATED happens to
 *   trigger a re-read of the same path. No second code path needed to
 *   apply the result: whatever `syncFetch` finds is written through the
 *   normal sync pipeline (`SyncEngine.fetch()` -> `qu.putSealed()`, see
 *   sync-engine.js), which fires the SAME `onStorageChange` notify this
 *   function already listens to below - a fresher value simply triggers
 *   the ordinary refetch. Fire-and-forget: a slow/failing peer request
 *   must never delay or break the local `initial` delivery above.
 * @returns {() => void} Unsubscribe function.
 */
export function watch(qu, path, callback, { initial = true, syncFetch = null } = {}) {
  // `qu.get(path)` races the next write to the same path by design - two
  // overlapping re-fetches can resolve in EITHER order. Tracking the
  // highest `ts` delivered so far and dropping anything older prevents
  // that race from ever showing a stale value AFTER a fresher one already
  // rendered.
  let latestTs = -Infinity;

  async function refetch() {
    const quBit = await qu.get(path);
    const ts = quBit?.ts ?? 0;
    if (ts < latestTs) return;
    latestTs = ts;
    callback(quBit?.val ?? null);
  }

  const off = qu.onStorageChange(({ path: writtenPath }) => {
    if (writtenPath === path) refetch();
  });

  if (initial) refetch();
  if (syncFetch) syncFetch(path).catch(() => {});

  return off;
}
