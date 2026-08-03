/**
 * HOOK BUS — the imperative counterpart to Registry's declarative
 * `registerCapability`/`capabilitiesFor` (see registry.js's own doc
 * comment): where a Capability answers "what actions exist for this
 * entity kind", a Hook answers "let registered code run/transform at this
 * specific moment", e.g. "a chat message is about to be posted - want to
 * parse @mentions out of it first?".
 *
 * Deliberately NOT a global singleton - exactly like every app creating
 * its OWN `createI18n()` (see @qu/i18n), every trust boundary creates its
 * OWN `HookBus` instance: one lives on the server-side `Registry` (see
 * registry.js), a separate one is created once by the shell and handed to
 * every mounted CLIENT app via its `mount(container, ctx)` context
 * (`ctx.hooks`). These two are never the same object and never share
 * state - a client-side Mentions feature hooking into `thread.
 * beforePostMessage` runs entirely in the browser, well before anything
 * reaches the relay; nothing here crosses that boundary.
 */
export class HookBus {
  /** @type {Map<string, Array<{handler: Function, order: number}>>} */
  #handlers = new Map();

  /**
   * @param {string} name - e.g. "thread.beforePostMessage".
   * @param {Function} handler
   * @param {{order?: number}} [options] - Lower runs first; ties keep
   *   registration order (stable sort).
   */
  on(name, handler, { order = 0 } = {}) {
    const list = this.#handlers.get(name) ?? [];
    list.push({ handler, order });
    list.sort((a, b) => a.order - b.order);
    this.#handlers.set(name, list);
  }

  /** @param {string} name @param {Function} handler */
  off(name, handler) {
    const list = this.#handlers.get(name);
    if (!list) return;
    const next = list.filter((entry) => entry.handler !== handler);
    if (next.length) this.#handlers.set(name, next);
    else this.#handlers.delete(name);
  }

  /**
   * Runs every handler registered for `name` IN ORDER, sequentially - each
   * handler receives the payload as most recently patched by the handler
   * before it, and may return an object whose fields get shallow-merged
   * into the running payload (returning `undefined`/nothing leaves it
   * unchanged). Use for transformations, where handler order and the
   * ability to see a previous handler's changes both matter.
   * @param {string} name @param {object} payload
   * @returns {Promise<object>} The final, merged payload.
   */
  async run(name, payload) {
    let current = payload;
    for (const { handler } of this.#handlers.get(name) ?? []) {
      const patch = await handler(current);
      if (patch !== undefined) current = { ...current, ...patch };
    }
    return current;
  }

  /**
   * Runs every handler registered for `name` IN PARALLEL, for side effects
   * only - return values are ignored, one handler throwing doesn't stop
   * the others (rejections are swallowed, since a side-effect hook is by
   * definition not something the caller is waiting on a result from).
   * @param {string} name @param {object} payload
   */
  async notify(name, payload) {
    await Promise.all(
      (this.#handlers.get(name) ?? []).map(({ handler }) => Promise.resolve(handler(payload)).catch(() => {}))
    );
  }
}
