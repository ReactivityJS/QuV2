import { QuCrypto } from '@qu/core';
import { documentPath, collectionPath } from './paths.js';

const SUBSCRIPTIONS_COLLECTION = 'subscriptions';

/** @param {string} actorPub @returns {string} A per-identity space, mirroring inbox-<actorPub>/todo-<listId>'s "own namespace per owner" convention. */
function spaceFor(actorPub) {
  return `push-${actorPub}`;
}

/** @param {string} endpoint @returns {Promise<string>} A short, stable, path-safe id for one subscription. */
async function subscriptionId(endpoint) {
  const hash = await QuCrypto.sha256(new TextEncoder().encode(endpoint));
  return QuCrypto.toBase64Url(hash).slice(0, 24);
}

/**
 * PUSH SUBSCRIPTION SERVICE — stores a browser's `PushSubscription` (the
 * endpoint + keys `PushManager.subscribe()` returns) so @qu/relay's push
 * delivery knows where and how to reach this identity. Supports multiple
 * subscriptions per identity (one per device/browser), each independently
 * add/removable.
 *
 * PUBLIC, signed, not encrypted - same reasoning as
 * NotificationPrefsService's own doc comment (the relay, which has no way
 * to decrypt private data, is the reader that matters here). An
 * endpoint+keys pair is already shared with the push service vendor by
 * design; this isn't a new exposure, just a second party (this relay)
 * holding the same information the browser already gave to Google/Mozilla/etc.
 */
export class PushSubscriptionService {
  /**
   * @param {import('./document-service.js').DocumentService} documentService
   * @param {import('./collection-service.js').CollectionService} collectionService
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills this identity's subscriptions collection before
   *   subscribe()/unsubscribe() modify it. Without this, a SECOND device
   *   subscribing to push (a local store that never independently synced
   *   `/store/push-<pub>/...`) would see no local collection, and
   *   addItem() would create a brand new one containing only ITS OWN
   *   subscription - silently discarding every other device's, since the
   *   write it produces unconditionally overwrites whatever's on the
   *   relay. Confirmed by a real adversarial test: device A subscribes,
   *   device B (fresh local store, same identity) subscribes next -
   *   without backfill, the relay ends up with ONLY device B's
   *   subscription.
   */
  constructor(documentService, collectionService, identityEngine, syncFetch = null) {
    this.documents = documentService;
    this.collections = collectionService;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /** Backfills the subscriptions collection via syncFetch (if provided) on a local miss - see constructor doc comment. */
  async #backfillCollection(spaceId) {
    if (!this.syncFetch) return;
    if ((await this.collections.list(spaceId, SUBSCRIPTIONS_COLLECTION)) !== null) return;
    await this.syncFetch(collectionPath(spaceId, SUBSCRIPTIONS_COLLECTION)).catch(() => {});
  }

  /**
   * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
   *   A browser's `PushSubscription.toJSON()`.
   * @returns {Promise<void>}
   */
  async subscribe(subscription) {
    const actorPub = await this.#myActorPub();
    const spaceId = spaceFor(actorPub);
    const id = await subscriptionId(subscription.endpoint);
    const mainKey = await this.identity.getMainKey();

    await this.documents.create(
      spaceId, id,
      { endpoint: subscription.endpoint, keys: subscription.keys },
      { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey }
    );
    await this.#backfillCollection(spaceId);
    // No manual "if the collection doesn't exist yet, create it empty"
    // step here on purpose - CollectionService.addItem() already handles
    // a genuinely-new collection correctly (creates it with just this one
    // item) AND, after the backfill above, has the real current list to
    // read rather than mistaking "not synced to THIS device yet" for
    // "doesn't exist" and clobbering it.
    await this.collections.addItem(spaceId, SUBSCRIPTIONS_COLLECTION, documentPath(spaceId, id));
  }

  /** @param {string} endpoint @returns {Promise<void>} */
  async unsubscribe(endpoint) {
    const actorPub = await this.#myActorPub();
    const spaceId = spaceFor(actorPub);
    const id = await subscriptionId(endpoint);
    await this.#backfillCollection(spaceId);
    await this.collections.removeItem(spaceId, SUBSCRIPTIONS_COLLECTION, documentPath(spaceId, id));
  }

  /** @returns {Promise<Array<{endpoint: string, keys: object}>>} This identity's own subscriptions (e.g. for a "manage devices" UI). */
  async listOwnSubscriptions() {
    return this.listSubscriptionsFor(await this.#myActorPub());
  }

  /**
   * What @qu/relay's push delivery calls - every currently active
   * subscription for a GIVEN recipient, not just "my own".
   * @param {string} actorPub
   * @returns {Promise<Array<{endpoint: string, keys: object}>>}
   */
  async listSubscriptionsFor(actorPub) {
    return (await this.collections.list(spaceFor(actorPub), SUBSCRIPTIONS_COLLECTION)) ?? [];
  }
}
