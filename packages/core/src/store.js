/**
 * QU STORE — the storage kernel. This is the class that makes QuStore "dumb"
 * on purpose: it knows how to route a path to a mount, how to build and seal
 * a QuBit, and how to let registered Engines participate in that process. It
 * does NOT know what a "document", "thread" or "collection" is.
 *
 * -----------------------------------------------------------------------
 * Why this is not an onion-style middleware pipeline (`(ctx, next) => ...`)
 * -----------------------------------------------------------------------
 * The original prototype used a classic Koa/Express-style middleware chain
 * for both `put` and `get`, where every registered handler ran on every
 * single call and decided for itself (via `path.includes(...)`) whether it
 * was responsible. Two problems with that, both fixed here:
 *
 *   1. Correctness got tangled with performance: the *only* reason the chain
 *      needed onion/`next()` semantics was so the "seal" step (sign +
 *      encrypt) could run strictly after every Engine's transformation, and
 *      so an Engine like AssetEngine could occasionally skip sealing
 *      entirely (it persists chunks itself). That's a two-phase process
 *      ("let engines transform the value, then seal it"), not something
 *      that actually needs recursive continuation-passing.
 *   2. Every `put`/`get` scanned *every* registered Engine and ran a string
 *      match against the path, even for Engines that could never apply.
 *      That's O(total engines) per call, forever, regardless of how many of
 *      them are actually relevant.
 *
 * This version replaces both with a linear, three-step sequence:
 *
 *   put(path, val):
 *     1. TRANSFORM  - run only the Engines whose registered `segment`
 *                      appears in `path` (indexed lookup, not a scan), each
 *                      of which may rewrite `val` or declare "I handled
 *                      storage myself, here is the final result".
 *     2. SEAL        - build the QuBit, sign it, and (optionally) encrypt it.
 *                      This step is fixed and cannot be skipped by an Engine
 *                      transform, only bypassed entirely by a `handled` result.
 *     3. PERSIST      - hand the sealed QuBit to the mounted adapter.
 *     4. NOTIFY (async, fault-isolated) - fire a `storage:put` event on the
 *                      internal QuEvents bus for anything that wants to react
 *                      (SyncEngine, reactive UI, caches, ...). This is plain
 *                      fan-out, not a value transform, and a broken listener
 *                      can never fail the write that triggered it.
 *
 *   get(path):
 *     1. FETCH        - ask the mounted adapter for the raw QuBit/value.
 *     2. TRANSFORM     - run only the matching Engines, each of which may
 *                      rewrite the result (e.g. CollectionEngine resolving
 *                      `$ref`/`$list` pointers).
 *
 * The Engine *indexing* (see `#index`) is what makes step 1 cheap as the
 * number of registered Engines grows: instead of testing every Engine
 * against every path, each Engine declares the one path *segment* it cares
 * about (e.g. "docs", "files") at registration time. Dispatch splits the
 * path into segments once and does O(1) Map lookups per segment, collecting
 * only the Engines that could possibly match - real candidates, not a full
 * scan. Engines that care about every path (like CollectionEngine's generic
 * `$ref` resolution) register with `segment: null` and live in a small
 * "global" bucket that always runs, exactly as before, but explicitly opted
 * into rather than re-deriving that from a wildcard string match.
 */

import { QuMount } from './mount.js';
import { QuCrypto } from './crypto.js';
import { QuEvents } from './events.js';
import { createQuBit } from './qubit.js';

/**
 * @typedef {Object} EngineRegistration
 * @property {string|null} segment - Path segment this Engine reacts to, or
 *   `null` to run on every path (use sparingly - global engines run on
 *   every single get/put).
 * @property {number} [order=50] - Lower runs first among matching Engines.
 * @property {(ctx: PutCtx) => Promise<PutOutcome|void>} [put]
 * @property {(ctx: GetCtx) => Promise<*>} [get]
 */

/**
 * @typedef {Object} PutCtx
 * @property {string} path
 * @property {*} val - Mutate-free: engines return a new value, they don't mutate this.
 * @property {object} options
 */

/**
 * @typedef {Object} PutOutcome
 * @property {*} [value] - Replaces ctx.val for the remaining pipeline.
 * @property {boolean} [handled] - If true, the engine persisted the data
 *   itself; QuStore skips sealing/persisting and returns `result` as-is.
 * @property {*} [result] - Required when `handled` is true.
 */

/**
 * @typedef {Object} GetCtx
 * @property {string} path
 * @property {*} result - The current value; engines return the (possibly
 *   transformed) replacement.
 */

export class QuStore {
  #mount = new QuMount();
  #notify = new QuEvents();

  /**
   * Index of registered Engines, keyed by the path segment they're
   * interested in. `null` is reserved for Engines that must see every path.
   * @type {Map<string|null, EngineRegistration[]>}
   */
  #index = new Map([[null, []]]);

  /**
   * Registers an Engine's participation in the put/get pipeline. Returns an
   * unregister function.
   *
   * @param {EngineRegistration} registration
   * @returns {() => void}
   */
  registerEngine({ segment = null, order = 50, put, get }) {
    if (!put && !get) {
      throw new Error('registerEngine: must provide at least one of put/get');
    }
    const entry = { segment, order, put, get };
    const bucket = this.#index.get(segment) ?? [];
    bucket.push(entry);
    bucket.sort((a, b) => a.order - b.order);
    this.#index.set(segment, bucket);

    return () => {
      const list = this.#index.get(segment);
      if (!list) return;
      const idx = list.indexOf(entry);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  /**
   * Finds every Engine registration relevant to `path`, in execution order:
   * global engines first, then segment-matched engines, merged and
   * re-sorted by `order`. This is the "index lookup, not a scan" step
   * described above.
   *
   * @param {string} path
   * @param {'put'|'get'} type
   * @returns {EngineRegistration[]}
   */
  #resolveEngines(path, type) {
    const segments = path.split('/').filter(Boolean);
    const seen = new Set();
    const candidates = [];

    for (const entry of this.#index.get(null)) {
      if (entry[type] && !seen.has(entry)) {
        seen.add(entry);
        candidates.push(entry);
      }
    }
    for (const segment of segments) {
      const bucket = this.#index.get(segment);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry[type] && !seen.has(entry)) {
          seen.add(entry);
          candidates.push(entry);
        }
      }
    }
    candidates.sort((a, b) => a.order - b.order);
    return candidates;
  }

  /**
   * Mounts an adapter under a name. See QuMount for details.
   * @param {string} name
   * @param {object} adapter
   * @returns {QuStore} this
   */
  mount(name, adapter) {
    this.#mount.mount(name, adapter);
    return this;
  }

  /** @returns {{adapter: object, rel: string, mountName: string}} */
  resolveMount(path) {
    return this.#mount.resolve(path);
  }

  /** @returns {string[]} */
  getMounts() {
    return this.#mount.names();
  }

  // -------------------------------------------------------------------
  // put / get
  // -------------------------------------------------------------------

  /**
   * Writes a value at `path`.
   *
   * Options:
   *   - `signWith: Uint8Array` - PKCS8 Ed25519 private key. If given, the
   *     sealed QuBit is signed and `writerPub` is required so `pub` can be set.
   *   - `writerPub: Uint8Array` - Raw Ed25519 public key of the signer.
   *   - `encryptWith: Uint8Array` - Raw X25519 public key of a recipient.
   *     May also be an array of recipients.
   *   - `senderXPrivateKey: Uint8Array` - PKCS8 X25519 private key, required
   *     when `encryptWith` is set.
   *
   * @param {string} path
   * @param {*} val
   * @param {object} [options]
   * @returns {Promise<import('./qubit.js').QuBit>}
   */
  async put(path, val, options = {}) {
    const { adapter, rel } = this.#mount.resolve(path);
    if (!adapter.put) throw new Error(`QuStore.put: mount for "${path}" has no put()`);

    // 1. TRANSFORM - only engines whose segment appears in the path run.
    const ctx = { path, val, options };
    for (const engine of this.#resolveEngines(path, 'put')) {
      const outcome = await engine.put(ctx);
      if (!outcome) continue;
      if (outcome.handled) {
        await this.#notify.emit('storage:put', { path, quBit: outcome.result });
        return outcome.result;
      }
      if ('value' in outcome) ctx.val = outcome.value;
    }

    // 2. SEAL - build, sign, (optionally) encrypt. Fixed, not overridable.
    const quBit = await this.#seal(path, ctx.val, options);

    // 3. PERSIST
    await adapter.put(rel, quBit);

    // 4. NOTIFY - fire-and-forget-safe fan-out, never fails the write.
    await this.#notify.emit('storage:put', { path, quBit });

    return quBit;
  }

  /**
   * Reads a value at `path`.
   * @param {string} path
   * @returns {Promise<*>}
   */
  async get(path) {
    const { adapter, rel } = this.#mount.resolve(path);
    if (!adapter.get) throw new Error(`QuStore.get: mount for "${path}" has no get()`);

    let result = await adapter.get(rel);

    // TRANSFORM - engines may post-process the fetched value (e.g. resolve
    // $ref/$list pointers). They receive `null` too, in case an engine wants
    // to synthesize a default.
    for (const engine of this.#resolveEngines(path, 'get')) {
      result = await engine.get({ path, result });
    }
    return result;
  }

  /**
   * Builds and seals a QuBit: sets pub (if signing), encrypts `val` (if
   * requested), then signs the final payload. Order matters - we always sign
   * over the *ciphertext*, never the plaintext, so a signature never leaks
   * information about whether/how a value was encrypted beyond what the
   * envelope itself already reveals.
   * @param {string} path
   * @param {*} val
   * @param {object} options
   * @returns {Promise<import('./qubit.js').QuBit>}
   */
  async #seal(path, val, options) {
    const quBit = createQuBit(path, val);

    if (options.writerPub) {
      quBit.pub = QuCrypto.toBase64(toBytes(options.writerPub, 'writerPub'));
    }

    let finalVal = quBit.val;
    if (options.encryptWith) {
      const recipients = Array.isArray(options.encryptWith) ? options.encryptWith : [options.encryptWith];
      if (!options.senderXPrivateKey) {
        throw new Error('QuStore.put: senderXPrivateKey is required when encryptWith is set');
      }
      const plaintext = new TextEncoder().encode(JSON.stringify(quBit.val));
      const encrypted = await QuCrypto.encrypt(
        plaintext,
        recipients.map((r) => toBytes(r, 'encryptWith')),
        toBytes(options.senderXPrivateKey, 'senderXPrivateKey')
      );
      finalVal = {
        iv: QuCrypto.toBase64(encrypted.iv),
        ct: QuCrypto.toBase64(encrypted.ct),
        to: encrypted.to.map((entry) => ({
          pub: QuCrypto.toBase64(entry.pub),
          key: QuCrypto.toBase64(entry.key),
        })),
      };
    }
    quBit.val = finalVal;

    if (options.signWith) {
      const payload = JSON.stringify({ path: quBit.path, val: quBit.val, ts: quBit.ts, pub: quBit.pub });
      const sigBytes = await QuCrypto.sign(new TextEncoder().encode(payload), toBytes(options.signWith, 'signWith'));
      quBit.sig = QuCrypto.toBase64(sigBytes);
    }

    return quBit;
  }

  // -------------------------------------------------------------------
  // Event mounts (/event, /net, ...) - unchanged pass-through to the adapter.
  // -------------------------------------------------------------------

  on(path, handler, options = {}) {
    const { adapter, rel } = this.#mount.resolve(path);
    if (!adapter.on) throw new Error(`QuStore.on: mount "${path.split('/')[1]}" has no on()`);
    return adapter.on(rel, handler, options);
  }

  emit(path, payload, options = {}) {
    const { adapter, rel } = this.#mount.resolve(path);
    if (!adapter.emit) throw new Error(`QuStore.emit: mount "${path.split('/')[1]}" has no emit()`);
    return adapter.emit(rel, payload, options);
  }

  /**
   * Subscribes to the internal storage notification bus. This is how
   * @qu/sync learns about local writes without being part of the value
   * pipeline. Topic is always 'storage:put' for now.
   * @param {(payload: {path: string, quBit: object}) => void} handler
   * @returns {() => void}
   */
  onStorageChange(handler) {
    return this.#notify.on('storage:put', handler);
  }
}

/** Accepts Uint8Array or a plain {0:.., 1:..} object (e.g. after JSON round-trip) and normalises to Uint8Array. */
function toBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === 'object') return new Uint8Array(Object.values(value));
  throw new Error(`QuStore: "${label}" must be a Uint8Array or byte-indexed object`);
}
