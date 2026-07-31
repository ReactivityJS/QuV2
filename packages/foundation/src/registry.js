/**
 * REGISTRY — the single place Engines, Services and Capabilities announce
 * themselves. This is what turns "a pile of loaded modules" into something
 * the DependencyResolver and other packages can look things up in by name,
 * instead of importing each other directly.
 *
 * Three kinds of registration:
 *   - Engine  - implements behaviour on top of Qu Core (e.g. "document-engine").
 *   - Service - a Data/Entity-API facade apps actually call (e.g. "document-service").
 *   - Capability - a named action contributed for a given entity kind (e.g.
 *     "reply" on "thread", "publish" on "document") - this is the "Action
 *     Engine" idea from the brainstorming: Apps never hardcode menus, they
 *     ask the Registry "what capabilities exist for this thing?" and build
 *     UI from the answer.
 *
 * The Registry does not instantiate anything itself - packages construct
 * their own Engine/Service instances (typically inside their manifest's
 * `register(qu, ctx)` export) and hand the finished object to
 * `registerEngine`/`registerService`. The Registry is purely a lookup table
 * plus a few invariants (no silent name collisions, clear errors on missing
 * lookups).
 */
export class Registry {
  /** @type {Map<string, {instance: object, manifest: object|null}>} */
  #engines = new Map();
  /** @type {Map<string, {instance: object, manifest: object|null}>} */
  #services = new Map();
  /** @type {Map<string, Array<{action: string, handler: Function}>>} */
  #capabilities = new Map();

  /**
   * @param {string} name - Unique engine name, e.g. "document-engine".
   * @param {object} instance
   * @param {object} [manifest] - The manifest that registered it, for diagnostics.
   */
  registerEngine(name, instance, manifest = null) {
    this.#assertFree(this.#engines, name, 'engine');
    this.#engines.set(name, { instance, manifest });
  }

  /**
   * @param {string} name - Unique service name, e.g. "document-service".
   * @param {object} instance
   * @param {object} [manifest]
   */
  registerService(name, instance, manifest = null) {
    this.#assertFree(this.#services, name, 'service');
    this.#services.set(name, { instance, manifest });
  }

  /**
   * Registers that `handler` implements the action `action` for entities of
   * kind `entityKind`. Multiple packages may contribute capabilities for the
   * same entity kind (e.g. both the core Document engine and a third-party
   * "translate" plugin can add capabilities to "document").
   *
   * @param {string} entityKind - e.g. "document", "thread", "asset".
   * @param {string} action - e.g. "publish", "reply", "pin".
   * @param {(entity: object, ...args: any[]) => any} handler
   */
  registerCapability(entityKind, action, handler) {
    const list = this.#capabilities.get(entityKind) ?? [];
    if (list.some((c) => c.action === action)) {
      throw new Error(`Registry: capability "${action}" already registered for "${entityKind}"`);
    }
    list.push({ action, handler });
    this.#capabilities.set(entityKind, list);
  }

  /**
   * @param {string} name
   * @returns {object} The registered engine instance.
   * @throws {Error} If not found - includes the list of known engines to help debugging.
   */
  getEngine(name) {
    return this.#get(this.#engines, name, 'engine');
  }

  /** @param {string} name @returns {object} */
  getService(name) {
    return this.#get(this.#services, name, 'service');
  }

  /** @param {string} name @returns {boolean} */
  hasEngine(name) {
    return this.#engines.has(name);
  }

  /** @param {string} name @returns {boolean} */
  hasService(name) {
    return this.#services.has(name);
  }

  /**
   * @param {string} name - Either an engine or a service name.
   * @returns {boolean} True if registered as either.
   */
  has(name) {
    return this.#engines.has(name) || this.#services.has(name);
  }

  /**
   * @param {string} entityKind
   * @returns {Array<{action: string, handler: Function}>} All capabilities
   *   registered for that entity kind (empty array if none).
   */
  capabilitiesFor(entityKind) {
    return [...(this.#capabilities.get(entityKind) ?? [])];
  }

  /** @returns {string[]} All registered engine names. */
  listEngines() {
    return Array.from(this.#engines.keys());
  }

  /** @returns {string[]} All registered service names. */
  listServices() {
    return Array.from(this.#services.keys());
  }

  #assertFree(map, name, kind) {
    if (map.has(name)) {
      throw new Error(`Registry: ${kind} "${name}" is already registered`);
    }
  }

  #get(map, name, kind) {
    const entry = map.get(name);
    if (!entry) {
      const known = Array.from(map.keys()).join(', ') || '(none)';
      throw new Error(`Registry: no ${kind} named "${name}" (known: ${known})`);
    }
    return entry.instance;
  }
}
