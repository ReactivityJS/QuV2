/**
 * INDEXEDDB ADAPTER — persistent storage for browser environments.
 * Stores each QuBit as a value in a single object store, keyed by its
 * relative path. Lazily opens the database on first use.
 */
export class IndexedDBAdapter {
  #dbPromise = null;

  /** @param {string} [dbName='qu-store'] */
  constructor(dbName = 'qu-store') {
    this.dbName = dbName;
  }

  #open() {
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('qubits')) {
          db.createObjectStore('qubits');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.#dbPromise;
  }

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>}
   */
  async put(rel, quBit) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('qubits', 'readwrite');
      tx.objectStore('qubits').put(quBit, rel);
      tx.oncomplete = () => resolve(quBit);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('qubits', 'readonly');
      const request = tx.objectStore('qubits').get(rel);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Lists every stored QuBit whose key starts with `relPrefix`, via an
   * IDBKeyRange bound rather than a full-store scan+filter - see
   * FsAdapter.getAll()'s doc comment for what this enables (reciprocal
   * sync catch-up, outbox replay). `'￿'` is a standard idiom for a
   * string-prefix upper bound: it sorts after any realistic single-codepoint
   * suffix a real path segment would have.
   * @param {string} relPrefix
   * @returns {Promise<Array<{rel: string, quBit: object}>>}
   */
  async getAll(relPrefix) {
    const db = await this.#open();
    const range = IDBKeyRange.bound(relPrefix, relPrefix + '￿', false, false);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('qubits', 'readonly');
      const store = tx.objectStore('qubits');
      const out = [];
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push({ rel: cursor.key, quBit: cursor.value });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
   /* 
   * Permanently deletes this adapter's ENTIRE underlying IndexedDB database -
   * every QuBit ever stored under it, gone, unrecoverable. There is no
   * finer-grained delete anywhere in this stack (QuStore itself has no
   * delete() at all - every other method here is put/get only), so this is
   * a deliberate all-or-nothing operation. Used for "forget this identity"
   * (see apps/shell/src/main.js's `_wipeIdentity()`) - a browser profile's
   * `quniverse-store`/`quniverse-blob` databases hold exactly one
   * identity's worth of data (see @qu/identity's own "one seed per store"
   * doc comment), so wiping them IS wiping the identity.
   * @returns {Promise<void>}
   */
  async destroy() {
    // Close our own open connection first - deleteDatabase() blocks (fires
    // onblocked, never onsuccess) while ANY connection to it is still open,
    // including this adapter's own.
    if (this.#dbPromise) {
      const db = await this.#dbPromise;
      db.close();
      this.#dbPromise = null;
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // Some OTHER tab/connection still has it open - the browser completes
      // the delete once that closes on its own; not worth blocking the
      // caller (typically about to reload the page) on that.
      request.onblocked = () => resolve();
    });
  }
}
