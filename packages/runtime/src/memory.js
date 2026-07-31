/**
 * MEMORY ADAPTER — a plain in-process Map, no persistence.
 * Ideal for tests, server-side scratch state, or the first run of a new
 * environment before a real adapter (FsAdapter, IndexedDBAdapter, ...) is
 * mounted. Data is lost on process restart.
 */
export class MemoryAdapter {
  #store = new Map();

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>}
   */
  async put(rel, quBit) {
    this.#store.set(rel, quBit);
    return quBit;
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    return this.#store.get(rel) ?? null;
  }

  /** @returns {number} Number of stored entries - handy for tests/metrics. */
  size() {
    return this.#store.size;
  }
}
