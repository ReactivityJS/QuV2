import { collectionPath } from './paths.js';
import { unwrap, unwrapAll } from './unwrap.js';

const MAX_MUTATE_RETRIES = 5;

/**
 * COLLECTION SERVICE — the Entity API for ordered lists of references.
 *
 * A collection is a `{ $list: [path, path, ...] }` value; CollectionEngine
 * (see @qu/engines) resolves it into the referenced items on read. This
 * class hides that shape and the path convention behind plain methods
 * returning plain arrays of unwrapped values.
 *
 * `addItem()`/`removeItem()` are read-modify-write: read the current list,
 * compute the new one, `create()` (an unconditional overwrite) the result.
 * Two calls for the SAME collection that overlap - from the same process
 * (e.g. two rapid UI actions) or, worse, from two DIFFERENT peers writing
 * near-simultaneously - can each read the list BEFORE the other's write
 * lands, both compute a "new" list missing the other's change, and
 * whichever writes last simply overwrites the first's addition/removal
 * out of existence. Found by a real adversarial multi-peer test (10
 * concurrent same-process addItem() calls left only 1 of 10 items; two
 * peers concurrently adding different items each ended up with only their
 * own). Mitigated two ways below, neither requiring a server-side
 * transaction (QuStore has none):
 *   - `#locks` serializes calls for the SAME collection from THIS process
 *     - fully eliminates the same-process case, and reduces (but cannot
 *       eliminate) cross-peer contention.
 *   - `#mutateOnce()` re-reads after writing and retries (recomputing from
 *     the fresh state) if this call's OWN intended change didn't survive -
 *     converges correctly even when a genuinely concurrent peer's write
 *     raced and won, since each retry starts from the latest known state
 *     rather than the stale one that caused the conflict.
 */
export class CollectionService {
  #locks = new Map(); // "spaceId:collectionId" -> tail of the promise chain serializing addItem()/removeItem() for that collection

  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
  }

  /**
   * @param {string|number} spaceId
   * @param {string} collectionId
   * @param {string[]} itemPaths - Qu paths of the items to include, e.g. from documentPath().
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async create(spaceId, collectionId, itemPaths, options = {}) {
    await this.qu.put(collectionPath(spaceId, collectionId), { $list: [...itemPaths] }, options);
  }

  /**
   * @param {string|number} spaceId
   * @param {string} collectionId
   * @returns {Promise<Array<*>|null>} The resolved, unwrapped items, or null if the collection doesn't exist.
   */
  async list(spaceId, collectionId) {
    const quBit = await this.qu.get(collectionPath(spaceId, collectionId));
    if (!quBit) return null;
    return unwrapAll(quBit.val);
  }

  /**
   * Appends an item path to an existing collection.
   * @param {string|number} spaceId
   * @param {string} collectionId
   * @param {string} itemPath
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async addItem(spaceId, collectionId, itemPath, options = {}) {
    return this.#mutate(spaceId, collectionId, itemPath, true, options);
  }

  /**
   * Removes an item path from an existing collection (a no-op if it wasn't
   * present, or the collection doesn't exist yet).
   * @param {string|number} spaceId
   * @param {string} collectionId
   * @param {string} itemPath
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async removeItem(spaceId, collectionId, itemPath, options = {}) {
    return this.#mutate(spaceId, collectionId, itemPath, false, options);
  }

  /** Serializes same-process calls for `spaceId:collectionId` - see class doc comment. */
  #mutate(spaceId, collectionId, itemPath, isAdd, options) {
    const key = `${spaceId}:${collectionId}`;
    const previousTail = this.#locks.get(key) ?? Promise.resolve();
    const thisRun = previousTail.then(
      () => this.#mutateOnce(spaceId, collectionId, itemPath, isAdd, options),
      () => this.#mutateOnce(spaceId, collectionId, itemPath, isAdd, options)
    );
    this.#locks.set(key, thisRun);
    thisRun.finally(() => {
      if (this.#locks.get(key) === thisRun) this.#locks.delete(key);
    });
    return thisRun;
  }

  async #mutateOnce(spaceId, collectionId, itemPath, isAdd, options, attempt = 0) {
    const current = await this.listRawPaths(spaceId, collectionId);
    const alreadyDesired = isAdd ? current.includes(itemPath) : !current.includes(itemPath);
    if (alreadyDesired) return;

    const next = isAdd ? [...current, itemPath] : current.filter((p) => p !== itemPath);
    await this.create(spaceId, collectionId, next, options);

    if (attempt >= MAX_MUTATE_RETRIES) return; // give up - a pathologically hot collection stays best-effort past this many rounds
    const after = await this.listRawPaths(spaceId, collectionId);
    const survived = isAdd ? after.includes(itemPath) : !after.includes(itemPath);
    if (!survived) {
      // A concurrent writer's put() (from another peer, or another
      // process entirely) landed after ours and didn't include our
      // change - retry from the FRESH state rather than the stale read
      // that caused the conflict, so this call's own intent still lands.
      return this.#mutateOnce(spaceId, collectionId, itemPath, isAdd, options, attempt + 1);
    }
  }

  /**
   * Reads the RAW (unresolved) list of item paths, bypassing
   * CollectionEngine's read-time $ref/$list resolution - addItem()/
   * removeItem() need the original paths to rewrite the list, not the
   * resolved values list() returns. Also PUBLIC (unlike the old
   * `#rawPaths` this replaces) for callers that need to correlate a
   * `list()` result containing `null` gaps (an item whose own document
   * hasn't synced to this device yet - see @qu/engines' CollectionEngine)
   * back to the individual path that's missing, e.g. to `syncFetch()` just
   * that one path - see DirectoryService.listVisible() for a concrete use.
   * @param {string|number} spaceId
   * @param {string} collectionId
   * @returns {Promise<string[]>}
   */
  async listRawPaths(spaceId, collectionId) {
    const { adapter, rel } = this.qu.resolveMount(collectionPath(spaceId, collectionId));
    const raw = await adapter.get(rel);
    return raw?.val?.$list ?? [];
  }
}
