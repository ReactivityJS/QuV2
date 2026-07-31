/**
 * QU EVENTS — a small, ordered, fault-isolated pub/sub bus.
 *
 * This is the "Reactive / Observer" building block from the Qu Core layer.
 * It is used in two places:
 *
 *   1. Internally by QuStore, as the *notification* channel that fires after
 *      a value has been persisted (see store.js). This is intentionally
 *      separate from the *value transform* pipeline (QuStore's engine
 *      registry) - notifications are fire-and-forget fan-out to any number
 *      of independent listeners (SyncEngine, UI reactivity, caches, ...),
 *      whereas the transform pipeline computes the one value that gets
 *      written and must stay small and deterministic.
 *
 *   2. As the backing implementation of VolatileAdapter, for the ephemeral
 *      `/event` and `/net` mounts.
 *
 * Design choices worth calling out:
 *   - Listeners run in registration order, or explicit `order` if given
 *     (lower runs first) - useful when a small number of listeners must
 *     run in a guaranteed sequence (e.g. logging before side effects).
 *   - A throwing listener is caught and reported, but never aborts the
 *     other listeners or the emit() call itself. In the original design a
 *     single misbehaving plugin could reject an entire `put()`; here a
 *     notification listener can never take storage down with it.
 *   - emit() still supports the "chained transform" pattern (each handler
 *     receives the previous handler's return value) for the cases that
 *     genuinely need it, but callers that just want fan-out can ignore the
 *     return value entirely.
 */
export class QuEvents {
  /** @type {Map<string, Array<{handler: Function, order: number}>>} */
  #listeners = new Map();

  /**
   * Registers a listener for a topic/path.
   * @param {string} topic
   * @param {(payload: *, ctx: object) => *} handler
   * @param {{order?: number}} [options] - Lower order runs first. Default 50.
   * @returns {() => void} Unsubscribe function.
   */
  on(topic, handler, { order = 50 } = {}) {
    const list = this.#listeners.get(topic) ?? [];
    const entry = { handler, order };
    list.push(entry);
    list.sort((a, b) => a.order - b.order);
    this.#listeners.set(topic, list);
    return () => {
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.#listeners.delete(topic);
    };
  }

  /**
   * Registers a listener that fires once, then unsubscribes itself.
   * @param {string} topic
   * @param {(payload: *, ctx: object) => *} handler
   * @param {{order?: number}} [options]
   * @returns {() => void} Unsubscribe function (in case you need to cancel early).
   */
  once(topic, handler, options) {
    const off = this.on(
      topic,
      (payload, ctx) => {
        off();
        return handler(payload, ctx);
      },
      options
    );
    return off;
  }

  /**
   * Fires a topic, running every listener in order. Each listener's return
   * value becomes the input to the next (chained transform), and the final
   * value is returned. Listener errors are caught and surfaced via
   * `ctx.errors` rather than rejecting the whole emit.
   *
   * @param {string} topic
   * @param {*} payload
   * @param {object} [ctx] - Shared context object passed to every listener.
   * @returns {Promise<object>} ctx, with `ctx.result` set to the final value.
   */
  async emit(topic, payload, ctx = {}) {
    const list = this.#listeners.get(topic) ?? [];
    let result = payload;
    ctx.errors = ctx.errors ?? [];
    for (const { handler } of list) {
      try {
        result = await handler(result, ctx);
      } catch (err) {
        ctx.errors.push({ topic, error: err });
        // A single bad listener must never break notification fan-out for
        // the rest, and must never break the write that triggered it.
        // eslint-disable-next-line no-console
        console.error(`[QuEvents] listener for "${topic}" threw:`, err);
      }
    }
    ctx.result = result;
    return ctx;
  }

  /** @returns {number} How many listeners are currently registered for a topic. */
  listenerCount(topic) {
    return this.#listeners.get(topic)?.length ?? 0;
  }
}
