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
}
