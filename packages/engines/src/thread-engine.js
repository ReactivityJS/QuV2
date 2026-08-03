/**
 * THREAD ENGINE — the one primitive Forum, Chat, Mail-Inbox and
 * Notifications are all built from. A "mail inbox" is just a Thread that
 * happens to have one reader; a "forum board" is a Thread with public
 * readers/writers; a "chat room" is a Thread scoped to a fixed member list.
 * They differ only in CONFIG (writers/readers/formatting) and UI, never in
 * mechanism - exactly the layer the architecture discussion asked for,
 * sitting between Qu Core and any app that needs threaded messages.
 *
 * This Engine owns exactly two pipeline-level concerns for message writes
 * (`/store/<space>/threads/<threadId>/msgs/<messageId>`):
 *   1. Stamping `_id`/`createdAt` if the caller didn't set them (same
 *      pattern as DocumentEngine).
 *   2. Enforcing the thread's `writers` ACL by THROWING if the signer isn't
 *      allowed - this happens BEFORE the default seal/persist step, so an
 *      unauthorized write never reaches storage at all, regardless of which
 *      Service or app code called `qu.put()`.
 *
 * Composing content (formatting/mentions), encrypting for a `readers` list,
 * and reply-listing all live in @qu/services' ThreadService instead - this
 * Engine only concerns itself with the one thing that must hold no matter
 * who's calling `put()`, not the friendly API around it.
 *
 * HONEST LIMITATION: this check only runs for writes going through THIS
 * QuStore's `put()` - a QuBit arriving via @qu/sync's replication is
 * written directly to the adapter, bypassing the Engine pipeline entirely
 * (see @qu/sync/src/sync-engine.js's own doc on why: it must not re-seal
 * already-signed remote data). That means a compromised/malicious peer
 * could still push an unauthorized message straight into local storage over
 * the network today. Enforcing this ACL against SYNCED data too would need
 * an equivalent check in SyncEngine's incoming-write path - real, valuable
 * future work, not implemented here.
 *
 * RELATIONSHIP TO AccessEngine: write-ACL enforcement is no longer unique
 * to Threads - @qu/engines' AccessEngine (`segment: null, order: 0`) runs
 * BEFORE this Engine on every put(), recognizes this same message-path
 * shape, and reaches the identical allow/deny decision (falling back to
 * this same `meta` document when a thread predates the newer, generic
 * `acl/<kind>/<id>` convention ThreadService now also writes - see its own
 * doc comment). This Engine's own check below is therefore now a redundant
 * safety net, not the sole enforcement point - kept in place deliberately
 * (cheap: one extra read) rather than removed, so a latent bug in the newer
 * generic path can't silently open every thread. Its removal is real,
 * separate future work once the mirrored ACL data has had time to reach
 * effectively every peer, not bundled into this change.
 */
import { QuCrypto } from '@qu/core';

const MESSAGE_PATH_RE = /^\/store\/([^/]+)\/threads\/([^/]+)\/msgs\/([^/]+)$/;

export class ThreadEngine {
  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: 'threads',
      order: 5,
      put: (ctx) => this.#handlePut(ctx),
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }

  async #handlePut(ctx) {
    if (ctx.path.endsWith('/meta')) return; // thread config itself - not a message, no ACL check applies to creating/updating it here

    const match = ctx.path.match(MESSAGE_PATH_RE);
    if (!match) return; // not a recognized thread message path - leave it to the default pipeline
    const [, spaceId, threadId] = match;

    const configBit = await this.qu.get(`/store/${spaceId}/threads/${threadId}/meta`);
    const config = configBit?.val;
    if (config && config.writers !== '*') {
      const writerPub = ctx.options.writerPub;
      const writerPubB64Url = writerPub instanceof Uint8Array ? QuCrypto.toBase64Url(writerPub) : null;
      if (!writerPubB64Url || !config.writers.includes(writerPubB64Url)) {
        throw new Error(`ThreadEngine: writer not authorized to post in thread "${threadId}"`);
      }
    }

    const val = { ...ctx.val };
    if (!val._id) val._id = globalThis.crypto.randomUUID();
    if (!val.createdAt) val.createdAt = Date.now();
    return { value: val };
  }
}
