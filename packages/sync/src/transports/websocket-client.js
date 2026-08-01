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
 */
export class WebSocketClientTransport extends Transport {
  #ws = null;
  #callbacks = [];
  #peerId = `peer-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  /** @type {object[]} Messages sent before the socket reached OPEN, flushed once it does. */
  #sendQueue = [];

  /**
   * @param {string} url - e.g. "ws://localhost:8080".
   * @param {{WebSocketImpl?: typeof WebSocket}} [options]
   */
  constructor(url, { WebSocketImpl } = {}) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    if (!this.WebSocketImpl) {
      throw new Error('WebSocketClientTransport: no WebSocket implementation available - pass { WebSocketImpl }');
    }
  }

  getPeerId() {
    return this.#peerId;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.#ws = new this.WebSocketImpl(this.url);
      this.#ws.addEventListener('open', () => {
        this.#flushQueue();
        resolve();
      });
      this.#ws.addEventListener('error', (err) => reject(err));
      this.#ws.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
          for (const cb of this.#callbacks) cb({ data, peerId: 'relay' });
        } catch (err) {
          console.error('[WebSocketClientTransport] invalid message:', err);
        }
      });
    });
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

  /** Closes the underlying connection. Also drops anything still queued - a closed transport has nowhere left to flush to. */
  close() {
    this.#sendQueue = [];
    this.#ws?.close();
  }
}
