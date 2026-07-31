import { QuEvents } from '../events.js';

/**
 * VOLATILE ADAPTER — an in-memory, non-persistent mount backed by QuEvents.
 *
 * Used for the `/event` mount (purely local pub/sub) and the `/net` mount
 * (network-facing pub/sub, typically wrapped further by @qu/sync). It stores
 * nothing: `put`-like semantics don't apply here, only `on`/`emit`. Once
 * emitted, a payload is not retained anywhere and is free to be
 * garbage-collected immediately after listeners have run.
 */
export class VolatileAdapter {
  #bus = new QuEvents();

  /**
   * @param {string} path
   * @param {Function} handler
   * @param {{order?: number}} [options]
   * @returns {() => void} Unsubscribe function.
   */
  on(path, handler, options) {
    return this.#bus.on(path, handler, options);
  }

  /**
   * @param {string} path
   * @param {*} payload
   * @returns {Promise<void>}
   */
  async emit(path, payload) {
    await this.#bus.emit(path, payload);
  }
}
