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
  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
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
   * @param {string|number} spaceId
   * @param {string} docId
   * @returns {Promise<object|null>}
   */
  async get(spaceId, docId) {
    const quBit = await this.qu.get(documentPath(spaceId, docId));
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
