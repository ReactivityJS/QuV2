/**
 * QU MOUNT — resolves an absolute Qu path to a registered adapter.
 *
 * A "mount" is a named endpoint (the first path segment) backed by an
 * adapter object implementing whatever subset of {put, get, on, emit} it
 * supports. QuMount itself has zero knowledge of what an adapter does with
 * the data - it only knows how to split a path into "which adapter" + "the
 * rest of the path".
 *
 * Example:
 *   const mount = new QuMount();
 *   mount.mount('store', new FsAdapter());
 *   mount.resolve('/store/actors/~alice/profile');
 *   // -> { adapter: <FsAdapter>, rel: '/actors/~alice/profile' }
 */
export class QuMount {
  /** @type {Map<string, object>} */
  #adapters = new Map();

  /**
   * Registers a new mount.
   * @param {string} name - e.g. 'store', 'event', 'net'.
   * @param {object} adapter
   * @returns {QuMount} this, for chaining.
   * @throws {Error} If the mount name is already taken.
   */
  mount(name, adapter) {
    if (this.#adapters.has(name)) {
      throw new Error(`Mount "${name}" already exists`);
    }
    this.#adapters.set(name, adapter);
    return this;
  }

  /**
   * Removes a mount. Mostly useful for tests and hot-reloading adapters.
   * @param {string} name
   */
  unmount(name) {
    this.#adapters.delete(name);
  }

  /**
   * Splits an absolute path into its mount adapter and the remaining
   * relative path.
   * @param {string} path - Must start with '/', e.g. '/store/...'.
   * @returns {{adapter: object, rel: string, mountName: string}}
   * @throws {Error} If the path is empty or the mount doesn't exist.
   */
  resolve(path) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) throw new Error('QuMount.resolve: path is empty');
    for (const segment of segments) {
      // Every adapter downstream of this single chokepoint (FsAdapter, IndexedDBAdapter, ...)
      // turns `rel` into a storage key/file path - a '.', '..' or NUL segment must never reach
      // that far, or a caller could escape the adapter's own storage root (path traversal).
      if (segment === '.' || segment === '..' || segment.includes('\0')) {
        throw new Error(`QuMount.resolve: unsafe path segment "${segment}"`);
      }
    }
    const [mountName, ...rest] = segments;
    const adapter = this.#adapters.get(mountName);
    if (!adapter) throw new Error(`QuMount.resolve: mount "${mountName}" not found`);
    return { adapter, rel: '/' + rest.join('/'), mountName };
  }

  /** @returns {string[]} The names of all currently registered mounts. */
  names() {
    return Array.from(this.#adapters.keys());
  }

  /** @returns {object|undefined} The raw adapter instance for a mount name. */
  get(name) {
    return this.#adapters.get(name);
  }
}
