import { Transport } from '../transport.js';

/**
 * WEBSOCKET CLIENT TRANSPORT — connects to a single remote peer (typically a
 * relay) over WebSocket. Works in browsers (native `WebSocket`) and in
 * Node.js 22+ (which now ships a global `WebSocket` too); for older Node
 * versions, pass a `WebSocketImpl` (e.g. the `ws` package's export).
 *
 * `send()`/`sendTo()` QUEUE outgoing messages if the socket isn't OPEN yet
 * (not connected, or still mid-handshake) instead of throwing - a raw
 * `WebSocket.send()` throws `InvalidStateError` when called before the
 * 'open' event, and a caller very often has a real reason to start sending
 * before `connect()`'s Promise has resolved: a SyncEngine constructed with
 * this transport (see @qu/sync/sync-engine.js's `publishAllTo` option)
 * starts observing local writes immediately, and the FIRST write of a
 * session can legitimately happen before the handshake finishes (e.g. a
 * brand-new identity publishing its own public profile the moment it's
 * created - see apps/shell's boot()). Queueing means a caller never has to
 * choose between "block everything on the network round-trip" and "risk a
 * crash/dropped write" - connect() can run fully in the background.
 *
 * AUTO-RECONNECT: an unexpected disconnect (network blip, the relay
 * restarting, ...) triggers automatic reconnection with exponential
 * backoff (1s, 2s, 4s, ... capped at `maxReconnectDelayMs`, each with up to
 * 50% jitter so many clients reconnecting to the same relay at once don't
 * all retry in lockstep). `close()` (a DELIBERATE disconnect) disables this -
 * it would be actively wrong for a caller that explicitly asked to
 * disconnect to find itself reconnected a moment later.
 *
 * A fresh reconnection is a BRAND NEW WebSocket connection, which the
 * relay's WebSocketServerTransport assigns a brand new peerId to - from the
 * relay's SyncEngine's point of view, this is a peer it has never seen
 * subscriptions from before, even though it's "the same" client as far as
 * the app is concerned. `onReconnect()` is the hook that lets SyncEngine
 * (see its constructor) notice this and RE-SEND its active subscriptions
 * over the new connection - without it, a reconnected client would sit
 * there with a healthy-looking socket that silently never receives another
 * live update for anything it had subscribed to before the drop.
 */
export class WebSocketClientTransport extends Transport {
  #ws = null;
  #callbacks = [];
  #reconnectCallbacks = [];
  #peerId = `peer-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  /** @type {object[]} Messages sent before the socket reached OPEN, flushed once it does. */
  #sendQueue = [];
  #manuallyClosed = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;

  /**
   * @param {string} url - e.g. "ws://localhost:8080".
   * @param {{WebSocketImpl?: typeof WebSocket, maxReconnectDelayMs?: number}} [options]
   *   `maxReconnectDelayMs` (default 30s) caps the exponential backoff -
   *   without a ceiling, a long outage would leave the delay between
   *   attempts growing forever, well past the point of being useful.
   */
  constructor(url, { WebSocketImpl, maxReconnectDelayMs = 30_000 } = {}) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    this.maxReconnectDelayMs = maxReconnectDelayMs;
    if (!this.WebSocketImpl) {
      throw new Error('WebSocketClientTransport: no WebSocket implementation available - pass { WebSocketImpl }');
    }
  }

  getPeerId() {
    return this.#peerId;
  }

  async connect() {
    this.#manuallyClosed = false;
    return this.#connectOnce();
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      this.#ws = ws;
      let settled = false;

      ws.addEventListener('open', () => {
        settled = true;
        this.#reconnectAttempt = 0;
        this.#flushQueue();
        for (const cb of this.#reconnectCallbacks) cb();
        resolve();
      });
      ws.addEventListener('error', (err) => {
        // Only the very first connection attempt's promise needs a
        // rejection - a failed RECONNECT attempt (settled=false here too,
        // since it never opened) is handled entirely by the 'close'
        // listener below scheduling the next retry, not by rejecting
        // anything (nothing is awaiting a reconnect attempt specifically).
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      ws.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
          for (const cb of this.#callbacks) cb({ data, peerId: 'relay' });
        } catch (err) {
          console.error('[WebSocketClientTransport] invalid message:', err);
        }
      });
      ws.addEventListener('close', () => {
        if (this.#manuallyClosed) return;
        this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    const base = Math.min(1000 * 2 ** this.#reconnectAttempt, this.maxReconnectDelayMs);
    const delay = base * (0.5 + Math.random() * 0.5); // 50-100% of base, so many clients don't retry in lockstep
    this.#reconnectAttempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#connectOnce().catch((err) => {
        // #connectOnce()'s promise only rejects via the 'error' listener
        // above, which itself only fires before any successful open - a
        // reconnect attempt that fails outright (not just drops later)
        // still triggers its OWN 'close' event and schedules the next
        // retry from there, so nothing is lost by not chaining further here.
        console.error('[WebSocketClientTransport] reconnect attempt failed:', err);
      });
    }, delay);
  }

  #flushQueue() {
    for (const data of this.#sendQueue) this.#ws.send(JSON.stringify(data));
    this.#sendQueue = [];
  }

  send(data) {
    if (this.#ws && this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(JSON.stringify(data));
    } else {
      this.#sendQueue.push(data);
    }
  }

  sendTo(_peerId, data) {
    // A single-connection client transport only ever has one peer (the relay
    // it connected to) - sendTo and send are equivalent here.
    this.send(data);
  }

  onMessage(callback) {
    this.#callbacks.push(callback);
  }

  /**
   * Registers a callback fired every time a connection is ESTABLISHED,
   * including the very first `connect()` - not just reconnects. A caller
   * that wants to replay per-connection state (SyncEngine's active
   * subscriptions) can do so unconditionally on every call without
   * special-casing "is this the first time", since there's nothing to
   * replay yet on the very first call anyway.
   * @param {() => void} callback
   */
  onReconnect(callback) {
    this.#reconnectCallbacks.push(callback);
  }

  /** Closes the underlying connection. Also drops anything still queued - a closed transport has nowhere left to flush to. Disables auto-reconnect - this is a DELIBERATE disconnect. */
  close() {
    this.#manuallyClosed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#sendQueue = [];
    this.#ws?.close();
  }
}
