/**
 * COLLECTION ENGINE — resolves `$ref` and `$list` pointers on read.
 *
 * A value stored anywhere may contain:
 *   - `{ $ref: "/store/other/path" }` - resolved to the full QuBit at that path.
 *   - `{ $list: ["/store/a", "/store/b", ...] }` - resolved to an array of
 *     the full QuBits at those paths (fetched concurrently).
 *
 * This is what turns Qu into something that can represent "a collection of
 * things" without QuStore itself ever knowing what a collection is -
 * `$ref`/`$list` are just a value shape, interpreted here, one layer up.
 *
 * Registered with `segment: null` (global) because a reference can appear
 * under any path, not just ones containing a specific keyword - unlike
 * DocumentEngine/AssetEngine, there's no fixed segment to index on. The
 * check itself is a couple of property lookups, cheap enough to run on
 * every read.
 *
 * BUG FIX vs. the original prototype: the original `QuStore.get()` ran
 * this Engine's logic but then returned the raw adapter value directly
 * instead of the (potentially $ref/$list-resolved) pipeline result - so
 * reference resolution was silently a no-op. This version's `QuStore.get()`
 * (see @qu/core/store.js) always threads the Engine chain's return value
 * through, so resolution actually takes effect.
 */
export class CollectionEngine {
  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: null,
      order: 20,
      get: async ({ result }) => {
        if (!result || typeof result !== 'object' || !result.val || typeof result.val !== 'object') {
          return result;
        }
        const value = result.val;

        if (typeof value.$ref === 'string') {
          return this.qu.get(value.$ref);
        }
        if (Array.isArray(value.$list)) {
          const items = await Promise.all(value.$list.map((path) => this.qu.get(path)));
          return { ...result, val: items };
        }
        return result;
      },
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }
}
