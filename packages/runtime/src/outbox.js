/**
 * INDEXEDDB OUTBOX STORE — the persistent half of @qu/sync's `OutboxStore`
 * contract (see that package's outbox.js for the full picture). Backs a
 * SEPARATE small IndexedDB database from `IndexedDBAdapter`'s own
 * (`<dbName>-outbox` vs. `<dbName>`) rather than a second object store in
 * the same one - keeps this module fully independent (no coupling to
 * IndexedDBAdapter's private `#open()`/schema version) for what is a small,
 * simple key-value need.
 */
export class IndexedDBOutboxStore {
  #dbPromise = null;

  /** @param {string} [dbName='qu-store-outbox'] */
  constructor(dbName = 'qu-store-outbox') {
    this.dbName = dbName;
  }

  #open() {
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.#dbPromise;
  }

  /** @param {string} path @returns {Promise<object|null>} */
  async get(path) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const request = tx.objectStore('outbox').get(path);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /** @param {string} path @param {object} quBit @returns {Promise<void>} */
  async set(path, quBit) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put(quBit, path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** @param {string} path @returns {Promise<void>} */
  async delete(path) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').delete(path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** @returns {Promise<Array<{path: string, quBit: object}>>} Every still-unacknowledged entry. */
  async getAll() {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const store = tx.objectStore('outbox');
      const out = [];
      const keysRequest = store.openCursor();
      keysRequest.onsuccess = () => {
        const cursor = keysRequest.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push({ path: cursor.key, quBit: cursor.value });
        cursor.continue();
      };
      keysRequest.onerror = () => reject(keysRequest.error);
    });
  }
}
