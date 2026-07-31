/**
 * QU RUNTIME — convenience bootstrap for a QuCore with default mounts.
 *
 * QuRuntime is *not* a required layer - any app can build a QuCore and mount
 * adapters manually. It exists purely to remove boilerplate for the common
 * case: a store mount (memory by default, swap for FsAdapter/IndexedDB) plus
 * the two ephemeral event mounts every other layer (sync, reactivity)
 * expects to exist.
 */
import { QuCore, VolatileAdapter } from '@qu/core';
import { MemoryAdapter } from './memory.js';

export class QuRuntime {
  /**
   * @param {{storeAdapter?: object}} [options] - Pass a custom `store`
   *   adapter (e.g. FsAdapter for Node, IndexedDBAdapter for the browser).
   *   Defaults to an in-memory adapter.
   */
  constructor({ storeAdapter } = {}) {
    this.core = new QuCore();
    this.core.mount('store', storeAdapter ?? new MemoryAdapter());
    this.core.mount('event', new VolatileAdapter());
    this.core.mount('net', new VolatileAdapter());
  }
}

export { MemoryAdapter } from './memory.js';
export { IndexedDBAdapter } from './indexeddb.js';
