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
    const path = collectionPath(spaceId, collectionId);
    // Read the RAW (unresolved) list, not list()'s resolved items - we need
    // to append a path, not a resolved value, and must bypass
    // CollectionEngine's read-time resolution to get the original $list.
    const { adapter, rel } = this.qu.resolveMount(path);
    const raw = await adapter.get(rel);
    const currentPaths = raw?.val?.$list ?? [];
    if (currentPaths.includes(itemPath)) return; // already present, avoid duplicate entries
    await this.create(spaceId, collectionId, [...currentPaths, itemPath], options);
  }
}
