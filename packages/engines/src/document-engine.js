/**
 * DOCUMENT ENGINE — the "docs" convention.
 *
 * Registers against the `docs` path segment only (see QuStore's Engine
 * index in @qu/core/store.js) - it never runs for paths that don't contain
 * a "docs" segment, unlike the original prototype which tested every write
 * with `path.includes('/docs/')`.
 *
 * Behaviour: every document gets a stable `_id` (a real UUID, not
 * `Date.now().toString(36)` - the original scheme collided for any two
 * documents created within the same millisecond, which is common under
 * concurrent writes) and a `_created` timestamp on first write, without
 * overwriting either if the caller already supplied them (so updates don't
 * reset creation metadata).
 *
 * This Engine does NOT expose createDoc/getDoc-style convenience methods -
 * that's @qu/services' DocumentService's job (the Entity API apps actually
 * call). This class only owns the pipeline behaviour.
 */
export class DocumentEngine {
  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: 'docs',
      order: 5,
      put: async (ctx) => {
        const val = { ...ctx.val };
        if (!val._id) val._id = globalThis.crypto.randomUUID();
        if (!val._created) val._created = Date.now();
        return { value: val };
      },
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }
}
