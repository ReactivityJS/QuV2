import { collectionPath } from './paths.js';
import { unwrap, unwrapAll } from './unwrap.js';

/**
 * COLLECTION SERVICE — the Entity API for ordered lists of references.
 *
 * A collection is a `{ $list: [path, path, ...] }` value; CollectionEngine
 * (see @qu/engines) resolves it into the referenced items on read. This
 * class hides that shape and the path convention behind plain methods
 * returning plain arrays of unwrapped values.
 */
export class CollectionService {
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
    const currentPaths = await this.#rawPaths(spaceId, collectionId);
    if (currentPaths.includes(itemPath)) return; // already present, avoid duplicate entries
    await this.create(spaceId, collectionId, [...currentPaths, itemPath], options);
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
    const currentPaths = await this.#rawPaths(spaceId, collectionId);
    if (!currentPaths.includes(itemPath)) return;
    await this.create(spaceId, collectionId, currentPaths.filter((p) => p !== itemPath), options);
  }

  /**
   * Reads the RAW (unresolved) list of item paths, bypassing
   * CollectionEngine's read-time $ref/$list resolution - addItem()/
   * removeItem() need the original paths to rewrite the list, not the
   * resolved values list() returns.
   */
  async #rawPaths(spaceId, collectionId) {
    const { adapter, rel } = this.qu.resolveMount(collectionPath(spaceId, collectionId));
    const raw = await adapter.get(rel);
    return raw?.val?.$list ?? [];
  }
}
