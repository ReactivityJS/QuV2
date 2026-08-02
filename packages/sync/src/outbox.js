/**
 * SYNC OUTBOX — the persistence contract SyncEngine needs to survive a
 * reload while offline (see SyncEngine's own `outbox` constructor option).
 *
 * WHY THIS EXISTS: `WebSocketClientTransport`'s own `#sendQueue` already
 * buffers a write made while disconnected and flushes it on reconnect - but
 * that queue is a plain in-memory array. It survives a mid-session drop and
 * reconnect just fine, but a page reload (or the app being closed) while
 * still offline loses it completely, along with any writes made in that
 * window - the local data itself is safe (already durably in IndexedDB
 * before SyncEngine ever sees it, see QuStore.put()), but the RELAY never
 * learns about it unless something re-sends it later.
 *
 * An OutboxStore is where SyncEngine additionally records "I have sent (or
 * am about to send) this QuBit to my `publishAllTo` peer, but don't yet
 * know it arrived" - see SyncEngine's `onStorageChange` listener (where
 * entries are added) and its `sync-ack` handling (where they're removed).
 * On every (re)connect - including the very first `connect()` of a fresh
 * page load, which is exactly when a PREVIOUS session's unacked entries
 * would still be sitting here - SyncEngine replays everything still
 * pending. Two implementations ship here/alongside:
 *   - `MemoryOutboxStore` (this file) - no persistence, for Node/relay/tests
 *     where "survive a reload" isn't the scenario being covered.
 *   - `IndexedDBOutboxStore` (`@qu/runtime`, browser-only) - the one that
 *     actually closes the gap above; see its own doc comment.
 */

/**
 * @typedef {object} OutboxStore
 * @property {(path: string) => Promise<object|null>} get
 * @property {(path: string, quBit: object) => Promise<void>} set
 * @property {(path: string) => Promise<void>} delete
 * @property {() => Promise<Array<{path: string, quBit: object}>>} getAll
 */

/** @implements {OutboxStore} */
export class MemoryOutboxStore {
  #entries = new Map(); // path -> quBit

  async get(path) {
    return this.#entries.get(path) ?? null;
  }

  async set(path, quBit) {
    this.#entries.set(path, quBit);
  }

  async delete(path) {
    this.#entries.delete(path);
  }

  async getAll() {
    return [...this.#entries].map(([path, quBit]) => ({ path, quBit }));
  }
}
