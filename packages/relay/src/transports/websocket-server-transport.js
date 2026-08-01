import { randomUUID } from 'node:crypto';
import { Transport } from '@qu/sync';

/**
 * WEBSOCKET SERVER TRANSPORT — the server side of @qu/sync's Transport
 * interface, built on the `ws` package. Assigns each connecting socket a
 * stable peerId (so SyncEngine's `sendTo(peerId, ...)` / subscriber
 * bookkeeping has something meaningful to key on - the original prototype's
 * server transport passed the raw `ws` connection object around instead,
 * which worked for "reply to whoever just asked" but couldn't address a
 * specific peer chosen earlier, e.g. for `fetch(path, targetPeerId)`).
 */
export class WebSocketServerTransport extends Transport {
  /**
   * @param {import('ws').WebSocketServer} wss - Already listening.
   * @param {{maxMessagesPerMinute?: number}} [options] - `maxMessagesPerMinute`:
   *   0 (default) means unlimited. A fixed-window-per-peer counter, not a
   *   sliding one - simple and cheap, and "roughly N/minute" is all a
   *   casual-abuse guard needs to be; see setRateLimit() for changing this
   *   live (e.g. from an admin settings change, see relay.js's `POST
   *   /admin/settings`) without dropping connections.
   */
  constructor(wss, { maxMessagesPerMinute = 0 } = {}) {
    super();
    this.wss = wss;
    this.#peerId = `relay-${randomUUID()}`;
    /** @type {Map<string, import('ws').WebSocket>} */
    this.#peers = new Map();
    this.#callbacks = [];
    this.#maxMessagesPerMinute = maxMessagesPerMinute;
    /** @type {Map<string, {count: number, windowStart: number}>} */
    this.#messageCounts = new Map();

    this.wss.on('connection', (ws) => {
      const peerId = `peer-${randomUUID()}`;
      this.#peers.set(peerId, ws);

      ws.on('message', (raw) => {
        if (this.#isRateLimited(peerId)) return; // silently dropped - a misbehaving/abusive peer gets no signal to adapt to, an honest one self-throttles from normal usage patterns anyway
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          console.warn(`[WebSocketServerTransport] dropping malformed message from ${peerId}`);
          return;
        }
        for (const cb of this.#callbacks) cb({ data, peerId });
      });

      ws.on('close', () => {
        this.#peers.delete(peerId);
        this.#messageCounts.delete(peerId);
      });
    });
  }

  #peerId;
  #peers;
  #callbacks;
  #maxMessagesPerMinute;
  #messageCounts;

  /** @param {number} maxMessagesPerMinute - 0 disables the limit. Takes effect for every peer's NEXT message, no reconnect needed. */
  setRateLimit(maxMessagesPerMinute) {
    this.#maxMessagesPerMinute = maxMessagesPerMinute;
  }

  /** @param {string} peerId @returns {boolean} */
  #isRateLimited(peerId) {
    if (!this.#maxMessagesPerMinute) return false;
    const now = Date.now();
    const entry = this.#messageCounts.get(peerId);
    if (!entry || now - entry.windowStart >= 60_000) {
      this.#messageCounts.set(peerId, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    return entry.count > this.#maxMessagesPerMinute;
  }

  getPeerId() {
    return this.#peerId;
  }

  async connect() {
    // The WebSocketServer is already listening by the time this transport
    // is constructed (see QuRelay.boot()) - nothing to do here.
  }

  /** Broadcasts to every currently connected peer. */
  send(data) {
    const message = JSON.stringify(data);
    for (const ws of this.#peers.values()) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }

  /** @param {string} peerId @param {object} data */
  sendTo(peerId, data) {
    const ws = this.#peers.get(peerId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(data));
  }

  onMessage(callback) {
    this.#callbacks.push(callback);
  }

  /**
   * Forcibly closes every currently connected peer socket. Node's
   * `http.Server.close()` only stops accepting NEW connections - it waits
   * indefinitely for existing ones (including open WebSocket upgrades) to
   * close on their own before its callback fires. Call this before closing
   * the HTTP server during shutdown, or `close()` will hang forever with a
   * single connected client still attached.
   */
  closeAllPeers() {
    for (const ws of this.#peers.values()) ws.terminate();
    this.#peers.clear();
  }
}
