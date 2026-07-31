import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * FS ADAPTER — Node.js filesystem persistence. Stores each QuBit as one
 * JSON file, mirroring the path structure on disk (`/a/b/c` -> `<base>/a/b/c.json`).
 * Simple, human-inspectable, good enough for a single relay's local data;
 * swap for a real database adapter if you outgrow it - QuStore never knows
 * the difference.
 */
export class FsAdapter {
  /** @param {string} [basePath='./qu-store'] */
  constructor(basePath = './qu-store') {
    this.basePath = basePath;
  }

  #filePath(rel) {
    return join(this.basePath, rel.replace(/^\//, '')) + '.json';
  }

  async #ensureDir(filePath) {
    await fs.mkdir(dirname(filePath), { recursive: true });
  }

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>}
   */
  async put(rel, quBit) {
    const filePath = this.#filePath(rel);
    await this.#ensureDir(filePath);
    await fs.writeFile(filePath, JSON.stringify(quBit), 'utf8');
    return quBit;
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    try {
      return JSON.parse(await fs.readFile(this.#filePath(rel), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
}
