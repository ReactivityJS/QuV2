import { QuCrypto } from '@qu/core';
import { documentPath } from './paths.js';

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
   */
  constructor(documentService, collectionService, identityEngine) {
    this.documents = documentService;
    this.collections = collectionService;
    this.identity = identityEngine;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
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
    if ((await this.collections.list(spaceId, SUBSCRIPTIONS_COLLECTION)) === null) {
      await this.collections.create(spaceId, SUBSCRIPTIONS_COLLECTION, []);
    }
    await this.collections.addItem(spaceId, SUBSCRIPTIONS_COLLECTION, documentPath(spaceId, id));
  }

  /** @param {string} endpoint @returns {Promise<void>} */
  async unsubscribe(endpoint) {
    const actorPub = await this.#myActorPub();
    const spaceId = spaceFor(actorPub);
    const id = await subscriptionId(endpoint);
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
