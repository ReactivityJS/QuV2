import { QuCrypto } from '@qu/core';
import { getPrivate, putPrivate } from './private-storage.js';
import { createFreshnessTracker } from './sync-freshness.js';

/** @param {string} actorPub @param {string} namespace */
function starredPath(actorPub, namespace) {
  return `/store/actors/~${actorPub}/private/starred/${namespace}`;
}

/**
 * STARRED SERVICE — a generic, per-identity "list of things I've marked",
 * private (self-encrypted, see private-storage.js) and namespaced.
 *
 * This is the one mechanism both Favorites (starred apps) and Contacts
 * (starred people) build on - directly mirroring the real Qu's own design,
 * where `modules/contacts.js` is documented as "a thin wrapper over
 * modules/starred.js's generic mechanism, the exact same shape favorited
 * apps need". See FavoritesService/ContactsService.
 *
 * CONCURRENCY NOTE: star()/unstar() do a read-modify-write on one JSON
 * document. That's correct and simple for the expected case (one identity,
 * usually one active device, editing their own list) but two truly
 * concurrent stars from the SAME identity (e.g. two open tabs) can race and
 * one could clobber the other. Acceptable for a low-stakes preference list;
 * worth revisiting if this pattern is reused for something where that
 * matters more.
 */
export class StarredService {
  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   `SyncEngine.fetch()` (see @qu/sync) - backfills a starred list this
   *   session has never seen locally (e.g. right after a cross-device
   *   identity import - see @qu/identity's importSeedCode() - starts with
   *   an empty local store even though this identity's real favorites/
   *   contacts/starred calendars are sitting on the relay under this exact
   *   actorPub) AND background-refreshes one that's already local but might
   *   be stale (see sync-freshness.js). Without this, EVERY app built on
   *   this Service (Favorites, Contacts, and every app's own "starred"
   *   namespace - Calendar/Todo/Geo Chase's "My X" lists) silently stayed
   *   empty forever on a freshly imported identity, no matter how long it
   *   waited - this was the exact gap behind "Favoriten werden nicht
   *   übertragen" (favorites don't transfer).
   * @param {() => number} [getGeneration] - `SyncEngine.getGeneration()`, see sync-freshness.js.
   */
  constructor(qu, identityEngine, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /** @param {string} namespace @returns {Promise<Array<object>>} */
  async #readList(namespace) {
    const path = starredPath(await this.#myActorPub(), namespace);
    const local = await this.qu.get(path);
    if (local) {
      this.#backgroundRefresh(path);
    } else if (this.syncFetch) {
      await this.syncFetch(path).catch(() => {});
    }
    return (await getPrivate(this.qu, this.identity, path)) ?? [];
  }

  /**
   * Stars an item (idempotent - starring an already-starred item just
   * returns the unchanged list).
   * @param {string} namespace - e.g. "apps", "contacts".
   * @param {string} itemId
   * @param {object} [data] - Extra fields to store alongside the item.
   * @returns {Promise<Array<{id: string, starredAt: number}>>} The updated list.
   */
  async star(namespace, itemId, data = {}) {
    const current = await this.#readList(namespace);
    if (current.some((item) => item.id === itemId)) return current;
    const updated = [...current, { id: itemId, starredAt: Date.now(), ...data }];
    await putPrivate(this.qu, this.identity, starredPath(await this.#myActorPub(), namespace), updated);
    return updated;
  }

  /**
   * @param {string} namespace
   * @param {string} itemId
   * @returns {Promise<Array<object>>} The updated list.
   */
  async unstar(namespace, itemId) {
    const current = await this.#readList(namespace);
    const updated = current.filter((item) => item.id !== itemId);
    await putPrivate(this.qu, this.identity, starredPath(await this.#myActorPub(), namespace), updated);
    return updated;
  }

  /** @param {string} namespace @returns {Promise<Array<object>>} */
  async list(namespace) {
    return this.#readList(namespace);
  }

  /** @param {string} namespace @param {string} itemId @returns {Promise<boolean>} */
  async isStarred(namespace, itemId) {
    return (await this.list(namespace)).some((item) => item.id === itemId);
  }
}
