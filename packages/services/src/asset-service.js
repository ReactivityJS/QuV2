import { assetPath } from './paths.js';
import { unwrap } from './unwrap.js';

/**
 * ASSET SERVICE — the Entity API for binary files.
 *
 * Chunking/reassembly is AssetEngine's job (see @qu/engines); this class
 * just gives it the same friendly, path-hiding front door as the other
 * Services.
 */
export class AssetService {
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/engines').AssetEngine} assetEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   forwarded to `assetEngine.getAsset()` to backfill a meta document or
   *   chunk this session hasn't synced yet - see @qu/engines' AssetEngine
   *   doc comment on `getAsset()` for why this is needed even when the
   *   `/blob/<space>` prefix is already subscribed.
   */
  constructor(qu, assetEngine, syncFetch = null) {
    this.qu = qu;
    this.assetEngine = assetEngine;
    this.syncFetch = syncFetch;
  }

  /**
   * @param {string|number} spaceId
   * @param {string} assetId
   * @param {Blob|Uint8Array|ArrayBuffer|{name: string, mime: string, data: *}} file
   * @param {object} [options]
   * @returns {Promise<{name: string, mime: string, size: number}>} The stored metadata.
   */
  async upload(spaceId, assetId, file, options = {}) {
    const quBit = await this.qu.put(assetPath(spaceId, assetId), file, options);
    return unwrap(quBit);
  }

  /**
   * @param {string|number} spaceId
   * @param {string} assetId
   * @returns {Promise<{meta: object, data: Uint8Array}|null>}
   */
  async download(spaceId, assetId) {
    return this.assetEngine.getAsset(assetPath(spaceId, assetId), this.syncFetch);
  }
}
