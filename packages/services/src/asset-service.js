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
   */
  constructor(qu, assetEngine) {
    this.qu = qu;
    this.assetEngine = assetEngine;
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
    return this.assetEngine.getAsset(assetPath(spaceId, assetId));
  }
}
