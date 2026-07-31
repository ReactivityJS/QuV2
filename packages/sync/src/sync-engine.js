/**
 * SYNC ENGINE — path-based pub/sub replication between Qu peers.
 *
 * Three things happen here:
 *   1. Local writes are broadcast to subscribers. SyncEngine listens on
 *      QuStore's notify bus (`qu.onStorageChange`, see @qu/core/store.js) -
 *      it is NOT part of the value-transform pipeline, so a network hiccup
 *      here can never affect what gets written locally.
 *   2. Incoming synced QuBits from peers are written straight to the mounted
 *      adapter, bypassing QuStore's seal step - a synced QuBit already
 *      carries its original signature/timestamp; re-signing it locally
 *      would forge a new signature from data we didn't actually write.
 *   3. `fetch(path)` lets a peer explicitly request a value it doesn't have
 *      yet (e.g. after subscribing, to backfill history).
 *
 * Compared to the original prototype, this version drops the defensive
 * "maybe pub/sig arrived as a Buffer, maybe as a plain object, let's guess"
 * conversion layer (`#ensureBase64`): @qu/core's QuStore now always
 * produces `pub`/`sig` as base64 strings (see store.js's `#seal`), so a
 * QuBit is always trivially JSON-safe. The only remaining validation is a
 * cheap shape check on incoming network data.
 */
export class SyncEngine {
  #qu;
  #transport;
  #subscriptions = new Map(); // path/prefix -> Set<peerId>
  #pendingRequests = new Map(); // requestId -> {resolve, reject, timeout}
  #requestCounter = 0;
  #unsubscribeLocalWrites;

  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('./transport.js').Transport} transport
   */
  constructor(qu, transport) {
    this.#qu = qu;
    this.#transport = transport;

    this.#unsubscribeLocalWrites = this.#qu.onStorageChange(({ path, quBit }) => {
      this.#broadcastToSubscribers(path, { type: 'sync', path, quBit });
    });

    this.#transport.onMessage(({ data, peerId }) => {
      if (!isPlainObject(data) || typeof data.type !== 'string') {
        console.warn('[SyncEngine] ignoring malformed message');
        return;
      }
      this.#handleIncoming(data, peerId);
    });
  }

  /** Stops listening to local writes. Call when tearing down this SyncEngine. */
  close() {
    this.#unsubscribeLocalWrites();
  }

  /**
   * Asks `targetPeerId` to start pushing future writes under `pathPrefix` to
   * us (matched by string prefix; a trailing '*' is accepted for
   * readability but not required). This sends a 'subscribe' message over
   * the transport - the actual bookkeeping happens on the REMOTE peer's
   * SyncEngine, in its own `#subscriptions` map, since it's the one
   * deciding who to notify when it writes locally. Subscribing only
   * affects FUTURE writes; use `fetch()` for data that already exists.
   *
   * The remote side registers the subscriber under the peerId ITS OWN
   * transport assigned to the connection the message arrived on - never a
   * self-reported ID inside the message. If it did trust a client-supplied
   * ID, any peer could claim to "be" a different peerId and hijack their
   * subscription (or receive pushes meant for someone else); a server-side
   * transport is the only thing that can truthfully say which live
   * connection a message came from.
   *
   * @param {string} pathPrefix
   * @param {string} [targetPeerId] - Required for transports with multiple
   *   simultaneous peers (e.g. a relay's server transport). Single-peer
   *   client transports (e.g. WebSocketClientTransport, which only ever
   *   talks to the one relay it connected to) ignore this and it may be omitted.
   */
  subscribe(pathPrefix, targetPeerId = null) {
    const prefix = pathPrefix.replace(/\*$/, '');
    this.#transport.sendTo(targetPeerId, { type: 'subscribe', path: prefix });
  }

  /** @param {string} pathPrefix @param {string} [targetPeerId] */
  unsubscribe(pathPrefix, targetPeerId = null) {
    const prefix = pathPrefix.replace(/\*$/, '');
    this.#transport.sendTo(targetPeerId, { type: 'unsubscribe', path: prefix });
  }

  /** @param {string} prefix @param {string} peerId */
  #addSubscriber(prefix, peerId) {
    const set = this.#subscriptions.get(prefix) ?? new Set();
    set.add(peerId);
    this.#subscriptions.set(prefix, set);
  }

  /** @param {string} prefix @param {string} peerId */
  #removeSubscriber(prefix, peerId) {
    const set = this.#subscriptions.get(prefix);
    if (!set) return;
    set.delete(peerId);
    if (set.size === 0) this.#subscriptions.delete(prefix);
  }

  /**
   * Requests a value from a specific peer (or broadcasts the request if
   * `targetPeerId` is omitted) and waits for a response.
   * @param {string} path
   * @param {string|null} [targetPeerId]
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<object|null>} The QuBit, or null if the peer doesn't have it.
   */
  async fetch(path, targetPeerId = null, timeoutMs = 10000) {
    const requestId = `${Date.now()}-${this.#requestCounter++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        reject(new Error(`SyncEngine.fetch: timed out waiting for "${path}"`));
      }, timeoutMs);
      this.#pendingRequests.set(requestId, { resolve, reject, timeout });

      const message = { type: 'request', requestId, path, requester: this.#transport.getPeerId() };
      if (targetPeerId) this.#transport.sendTo(targetPeerId, message);
      else this.#transport.send(message);
    });
  }

  #broadcastToSubscribers(path, message) {
    for (const [prefix, peers] of this.#subscriptions) {
      if (!path.startsWith(prefix)) continue;
      for (const peerId of peers) {
        if (peerId !== this.#transport.getPeerId()) this.#transport.sendTo(peerId, message);
      }
    }
  }

  #handleIncoming(message, peerId) {
    switch (message.type) {
      case 'sync':
        return this.#handleSync(message);
      case 'request':
        return this.#handleRequest(message, peerId);
      case 'response':
        return this.#handleResponse(message);
      case 'subscribe':
        return this.#addSubscriber(message.path, peerId);
      case 'unsubscribe':
        return this.#removeSubscriber(message.path, peerId);
      default:
        console.warn(`[SyncEngine] unknown message type "${message.type}"`);
    }
  }

  async #handleSync({ path, quBit }) {
    if (!isValidQuBit(quBit)) {
      console.warn(`[SyncEngine] ignoring invalid synced QuBit for "${path}"`);
      return;
    }
    await this.#persistDirectly(path, quBit);
  }

  async #handleRequest({ requestId, path }, peerId) {
    try {
      const { adapter, rel } = this.#qu.resolveMount(path);
      const quBit = await adapter.get(rel);
      this.#transport.sendTo(peerId, { type: 'response', requestId, path, quBit: quBit ?? null });
    } catch (err) {
      console.error(`[SyncEngine] error handling request for "${path}":`, err);
      this.#transport.sendTo(peerId, { type: 'response', requestId, path, quBit: null });
    }
  }

  async #handleResponse({ requestId, path, quBit }) {
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) return; // late or duplicate response - ignore
    clearTimeout(pending.timeout);
    this.#pendingRequests.delete(requestId);

    if (quBit && !isValidQuBit(quBit)) {
      pending.reject(new Error(`SyncEngine.fetch: peer returned an invalid QuBit for "${path}"`));
      return;
    }
    if (quBit) await this.#persistDirectly(path, quBit);
    pending.resolve(quBit ?? null);
  }

  /** Writes an already-sealed QuBit straight to the adapter, bypassing QuStore's seal step. */
  async #persistDirectly(path, quBit) {
    try {
      const { adapter, rel } = this.#qu.resolveMount(path);
      if (!adapter.put) return;
      await adapter.put(rel, quBit);
    } catch (err) {
      console.error(`[SyncEngine] failed to persist synced QuBit for "${path}":`, err);
    }
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidQuBit(quBit) {
  return isPlainObject(quBit) && typeof quBit.path === 'string' && typeof quBit.ts === 'number';
}
