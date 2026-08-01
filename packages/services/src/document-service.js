import { documentPath } from './paths.js';
import { unwrap } from './unwrap.js';

/**
 * DOCUMENT SERVICE — the Entity API for documents.
 *
 * This is what an app actually calls (`Qu.documents.create(...)`, not
 * `qu.put('/store/.../docs/...', ...)`). It knows the document path
 * convention and unwraps QuBit envelopes; DocumentEngine (see @qu/engines)
 * still owns the actual `_id`/`_created` stamping behaviour - this class
 * doesn't duplicate that, it just gives it a friendly front door.
 */
export class DocumentService {
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills a document `get()` misses locally - see the doc comment on
   *   `get()` itself for why this matters. Without it (e.g. a server-side
   *   QuCore with no single upstream peer), a local miss is just returned
   *   as `null`, same as before.
   */
  constructor(qu, syncFetch = null) {
    this.qu = qu;
    this.syncFetch = syncFetch;
  }

  /**
   * @param {string|number} spaceId
   * @param {string} docId
   * @param {object} data
   * @param {object} [options] - Forwarded to QuStore.put (signWith, encryptWith, ...).
   * @returns {Promise<object>} The stored document (plain value, `_id`/`_created` included).
   */
  async create(spaceId, docId, data, options = {}) {
    const quBit = await this.qu.put(documentPath(spaceId, docId), data, options);
    return unwrap(quBit);
  }

  /**
   * Backfills via `syncFetch` (if provided) on a local miss before giving
   * up - the same "subscribe() only covers writes made from here on"
   * gap every other Service's syncFetch backfill closes (see
   * DirectoryService.listVisible() for the canonical shape). Found
   * missing by a real two-browser test: a peer opening a deep link to a
   * document (e.g. a Todo list) created by someone else, before this
   * session ever subscribed, saw a permanent "not found" instead of the
   * real content once it synced.
   * @param {string|number} spaceId
   * @param {string} docId
   * @returns {Promise<object|null>}
   */
  async get(spaceId, docId) {
    const path = documentPath(spaceId, docId);
    let quBit = await this.qu.get(path);
    if (!quBit && this.syncFetch) {
      await this.syncFetch(path).catch(() => {});
      quBit = await this.qu.get(path);
    }
    return quBit ? unwrap(quBit) : null;
  }

  /**
   * Merges `patch` into the existing document and writes the result. Throws
   * if the document doesn't exist yet - use create() for that.
   * @param {string|number} spaceId
   * @param {string} docId
   * @param {object} patch
   * @param {object} [options]
   * @returns {Promise<object>} The updated document.
   */
  async update(spaceId, docId, patch, options = {}) {
    const existing = await this.get(spaceId, docId);
    if (!existing) throw new Error(`DocumentService.update: no document at ${spaceId}/${docId}`);
    return this.create(spaceId, docId, { ...existing, ...patch }, options);
  }
}
