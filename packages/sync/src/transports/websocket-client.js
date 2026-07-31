import { Transport } from '../transport.js';

/**
 * WEBSOCKET CLIENT TRANSPORT — connects to a single remote peer (typically a
 * relay) over WebSocket. Works in browsers (native `WebSocket`) and in
 * Node.js 22+ (which now ships a global `WebSocket` too); for older Node
 * versions, pass a `WebSocketImpl` (e.g. the `ws` package's export).
 */
export class WebSocketClientTransport extends Transport {
  #ws = null;
  #callbacks = [];
  #peerId = `peer-${Math.random().toString(36).slice(2)}-${Date.now()}`;

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
      this.#ws.addEventListener('open', () => resolve());
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

  send(data) {
    this.#ws.send(JSON.stringify(data));
  }

  sendTo(_peerId, data) {
    // A single-connection client transport only ever has one peer (the relay
    // it connected to) - sendTo and send are equivalent here.
    this.send(data);
  }

  onMessage(callback) {
    this.#callbacks.push(callback);
  }

  /** Closes the underlying connection. */
  close() {
    this.#ws?.close();
  }
}
