/**
 * TRANSPORT — the interface SyncEngine needs from any network layer.
 *
 * Any transport (WebSocket, WebRTC data channel, HTTP long-polling, ...)
 * that implements these five members can back a SyncEngine. This keeps
 * SyncEngine's replication logic (subscriptions, request/response) entirely
 * independent of how bytes actually move between peers.
 */
export class Transport {
  /** @returns {Promise<void>} Resolves once the transport is ready to send/receive. */
  async connect() {
    throw new Error('Transport.connect() not implemented');
  }

  /** @param {object} data - Broadcast to every connected peer. */
  send(data) {
    throw new Error('Transport.send() not implemented');
  }

  /**
   * @param {string} peerId
   * @param {object} data
   */
  sendTo(peerId, data) {
    throw new Error('Transport.sendTo() not implemented');
  }

  /** @param {(msg: {data: object, peerId: string}) => void} callback */
  onMessage(callback) {
    throw new Error('Transport.onMessage() not implemented');
  }

  /** @returns {string} A stable identifier for this end of the transport. */
  getPeerId() {
    throw new Error('Transport.getPeerId() not implemented');
  }
}
