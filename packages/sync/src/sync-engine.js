import { QuCrypto } from '@qu/core';

/**
 * Any path under this prefix never leaves the local device via SyncEngine,
 * regardless of what any peer subscribed to (checked at broadcast AND at
 * incoming-write time - see the two checks below, not just one). This is
 * the one hard-coded safety rail in an otherwise fully generic replication
 * layer: @qu/identity's master seed lives at `/store/secure/identity/seed`
 * (see identity.js's SEED_PATH) written with NO signWith/encryptWith - by
 * design, since encrypting it with a Qu key derived FROM itself would be
 * circular. That makes it the one piece of data in this whole system that
 * must never be replicated anywhere, under any subscription - a client
 * broadly subscribing (or being subscribed to) for "everything under
 * /store" (see @qu/relay's per-connection auto-subscribe) must not be able
 * to accidentally leak or receive it. Any future local-only secret should
 * live under this same prefix to get this guarantee for free.
 */
const LOCAL_ONLY_PREFIX = '/store/secure/';

/**
 * @param {object} quBit
 * @returns {Promise<boolean>} Whether an author claim on this QuBit
 *   actually checks out. A QuBit with no `sig` makes no authorship claim at
 *   all (plenty of legitimate app data is written unsigned - see
 *   DocumentService/CollectionService, which don't require signing) and is
 *   accepted as-is: sync doesn't retroactively demand authenticity nothing
 *   ever promised. A QuBit WITH a `sig` (and/or `pub`) IS making a claim -
 *   "actor X wrote this exact value" - and that claim must cryptographically
 *   check out or the write is rejected outright, since accepting an
 *   unverified `pub`+`sig` pair from the wire would let any connected peer
 *   forge writes under someone else's identity (e.g. a fabricated Thread
 *   message attributed to a real, unrelated actor).
 */
async function isAuthentic(quBit) {
  if (!quBit.sig) return true;
  if (!quBit.pub) return false; // a signature with no claimed signer can never verify
  try {
    const payload = JSON.stringify({ path: quBit.path, val: quBit.val, ts: quBit.ts, pub: quBit.pub });
    return await QuCrypto.verify(
      new TextEncoder().encode(payload),
      QuCrypto.fromBase64(quBit.sig),
      QuCrypto.fromBase64(quBit.pub)
    );
  } catch {
    return false; // malformed base64, wrong-length key, etc. - treat exactly like "did not verify"
  }
}

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
 *      would forge a new signature from data we didn't actually write. They
 *      ARE checked for authenticity first (see isAuthentic() above) and
 *      then re-broadcast to this peer's OWN subscribers (excluding whoever
 *      just sent it), so a relay acts as a genuine hub - not just a
 *      dead-end recipient - for however many clients are subscribed to it.
 *   3. `fetch(path)` lets a peer explicitly request a value it doesn't have
 *      yet (e.g. after subscribing, to backfill history).
 *
 * SECURITY NOTE - what step 2's verification does NOT cover: it proves the
 * claimed author really did sign this exact value, but it does NOT re-check
 * an Engine-level ACL (e.g. "is this pub actually a writer on THIS
 * Thread?" - see @qu/engines/thread-engine.js). That check only runs
 * inside QuStore.put()'s TRANSFORM step on the ORIGINATING peer, which a
 * synced write never goes through here (see point 2's own explanation of
 * why re-running seal/transform on already-sealed data would be wrong).
 * A correctly-signed-but-unauthorized write can therefore still end up
 * PERSISTED via sync, though for an encrypted (non-'*') Thread it will not
 * be READABLE by real readers (see ThreadService's own encryption, which a
 * bypassing writer has no way to satisfy without a real reader's key) -
 * closing that remaining gap for good would mean giving synced writes a
 * restricted, replay-safe path back through the relevant Engine's own
 * checks, which is real future work, not something papered over here.
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
  #publishAllTo;
  #subscriptions = new Map(); // path/prefix -> Set<peerId> (subscribers TO us)
  #mySubscriptions = new Map(); // path/prefix -> targetPeerId (subscriptions WE made, see subscribe() below)
  #pendingRequests = new Map(); // requestId -> {resolve, reject, timeout}
  #requestCounter = 0;
  #unsubscribeLocalWrites;

  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('./transport.js').Transport} transport
   * @param {{publishAllTo?: string}} [options] - `publishAllTo`: ALWAYS
   *   forward every local write (except LOCAL_ONLY_PREFIX) to this one
   *   peerId, unconditionally - no subscription round-trip required. This
   *   is what a star-topology CLIENT (a browser shell talking to its one
   *   relay, see apps/shell's connect()) should set: `subscribe()` only
   *   ever covers what the REMOTE side later decides to tell you about
   *   (and requires that round-trip to complete first), which creates an
   *   unavoidable race for anything the CLIENT itself writes very early
   *   (e.g. a brand-new identity's own public profile, published the
   *   moment it's created - see apps/shell's boot()) - if that write
   *   happens before the relay's own subscribe-back message has arrived,
   *   subscription-based broadcasting would silently drop it. Unconditional
   *   publish to a known, single upstream peer has no such race: it works
   *   the instant the transport is connected. Left unset (the default) for
   *   relay-to-relay peering, where publishing EVERYTHING unconditionally
   *   to whoever merely connected would be too permissive - that direction
   *   stays exactly as explicit/subscription-based as before.
   */
  constructor(qu, transport, { publishAllTo = null } = {}) {
    this.#qu = qu;
    this.#transport = transport;
    this.#publishAllTo = publishAllTo;

    this.#unsubscribeLocalWrites = this.#qu.onStorageChange(({ path, quBit, origin }) => {
      // `origin === 'sync'` means this notify came from QuStore.putSealed()
      // (see its own doc comment) - i.e. THIS SyncEngine (or another one
      // sharing this qu instance) just persisted a write that arrived FROM
      // a peer, not a genuinely new local write. #handleSync already does
      // its own, correctly origin-EXCLUDED re-broadcast for that case right
      // after persisting - broadcasting it AGAIN here, with no origin to
      // exclude, would bounce the write straight back to whoever sent it,
      // which bounces it back again, forever.
      if (origin === 'sync') return;
      if (path.startsWith(LOCAL_ONLY_PREFIX)) return; // see LOCAL_ONLY_PREFIX doc comment above
      const message = { type: 'sync', path, quBit };
      if (this.#publishAllTo) this.#transport.sendTo(this.#publishAllTo, message);
      this.#broadcastToSubscribers(path, message, this.#publishAllTo); // publishAllTo already got it above - never send it twice
    });

    this.#transport.onMessage(({ data, peerId }) => {
      if (!isPlainObject(data) || typeof data.type !== 'string') {
        console.warn('[SyncEngine] ignoring malformed message');
        return;
      }
      this.#handleIncoming(data, peerId);
    });

    // A reconnected transport is a BRAND NEW connection as far as the
    // remote side is concerned (see WebSocketClientTransport's own doc
    // comment on `onReconnect()` for why) - it has no memory of what we'd
    // previously asked it to subscribe us to. Only client-style transports
    // that can actually drop and reconnect implement this hook (duck-typed
    // check - a relay's WebSocketServerTransport, which only ever accepts
    // connections rather than initiating/losing one of its own, doesn't).
    if (typeof this.#transport.onReconnect === 'function') {
      this.#transport.onReconnect(() => {
        for (const { prefix, targetPeerId } of this.#mySubscriptions.values()) {
          this.#transport.sendTo(targetPeerId, { type: 'subscribe', path: prefix });
        }
      });
    }
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
    // Remembered so a reconnected transport (see the constructor's
    // onReconnect() hook above) can replay it - the remote side's own
    // bookkeeping for this subscription lives entirely on a connection
    // that no longer exists once a reconnect happens.
    this.#mySubscriptions.set(`${targetPeerId ?? ''}:${prefix}`, { prefix, targetPeerId });
    this.#transport.sendTo(targetPeerId, { type: 'subscribe', path: prefix });
  }

  /** @param {string} pathPrefix @param {string} [targetPeerId] */
  unsubscribe(pathPrefix, targetPeerId = null) {
    const prefix = pathPrefix.replace(/\*$/, '');
    this.#mySubscriptions.delete(`${targetPeerId ?? ''}:${prefix}`);
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

  /**
   * @param {string} path
   * @param {object} message
   * @param {string|null} [excludePeerId] - Never re-send to whoever this
   *   message originated from (relevant only for hub re-broadcast, see
   *   #handleSync - a peer already has the write it just sent us).
   */
  #broadcastToSubscribers(path, message, excludePeerId = null) {
    for (const [prefix, peers] of this.#subscriptions) {
      if (!path.startsWith(prefix)) continue;
      for (const peerId of peers) {
        if (peerId === excludePeerId) continue;
        if (peerId !== this.#transport.getPeerId()) this.#transport.sendTo(peerId, message);
      }
    }
  }

  #handleIncoming(message, peerId) {
    switch (message.type) {
      case 'sync':
        return this.#handleSync(message, peerId);
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

  /**
   * @param {{path: string, quBit: object}} message
   * @param {string} originPeerId - Whoever sent this over the transport - a
   *   relay re-broadcasting this to ITS OWN subscribers must never echo it
   *   straight back to them.
   */
  async #handleSync({ path, quBit }, originPeerId) {
    if (path.startsWith(LOCAL_ONLY_PREFIX)) {
      console.warn(`[SyncEngine] refusing synced write for local-only path "${path}"`);
      return;
    }
    if (!isValidQuBit(quBit)) {
      console.warn(`[SyncEngine] ignoring malformed synced QuBit for "${path}"`);
      return;
    }
    if (!(await isAuthentic(quBit))) {
      console.warn(`[SyncEngine] rejecting synced QuBit for "${path}": signature does not verify`);
      return;
    }
    await this.#persistDirectly(path, quBit);
    // Hub re-broadcast: a relay with N subscribed clients must forward what
    // ONE of them just sent to the OTHER N-1, not just persist it locally -
    // otherwise only writes the relay itself originates would ever reach a
    // second client, which defeats the entire point of a shared relay (see
    // the class doc comment's security note for what this re-broadcast does
    // and does not guarantee).
    this.#broadcastToSubscribers(path, { type: 'sync', path, quBit }, originPeerId);
  }

  async #handleRequest({ requestId, path }, peerId) {
    if (path.startsWith(LOCAL_ONLY_PREFIX)) {
      console.warn(`[SyncEngine] refusing to serve fetch() request for local-only path "${path}"`);
      this.#transport.sendTo(peerId, { type: 'response', requestId, path, quBit: null });
      return;
    }
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

  /**
   * Writes an already-sealed QuBit straight to its mount and notifies
   * local storage-change listeners (see QuStore.putSealed() for why this
   * must notify, not just persist - @qu/reactive's `watch()`, and
   * everything built on it, would otherwise never react to anything
   * arriving from another peer).
   */
  async #persistDirectly(path, quBit) {
    try {
      await this.#qu.putSealed(path, quBit);
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
