import { QuCrypto } from '@qu/core';
import { getPrivate, putPrivate } from './private-storage.js';

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
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(qu, identityEngine) {
    this.qu = qu;
    this.identity = identityEngine;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
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
    const path = starredPath(await this.#myActorPub(), namespace);
    const current = (await getPrivate(this.qu, this.identity, path)) ?? [];
    if (current.some((item) => item.id === itemId)) return current;
    const updated = [...current, { id: itemId, starredAt: Date.now(), ...data }];
    await putPrivate(this.qu, this.identity, path, updated);
    return updated;
  }

  /**
   * @param {string} namespace
   * @param {string} itemId
   * @returns {Promise<Array<object>>} The updated list.
   */
  async unstar(namespace, itemId) {
    const path = starredPath(await this.#myActorPub(), namespace);
    const current = (await getPrivate(this.qu, this.identity, path)) ?? [];
    const updated = current.filter((item) => item.id !== itemId);
    await putPrivate(this.qu, this.identity, path, updated);
    return updated;
  }

  /** @param {string} namespace @returns {Promise<Array<object>>} */
  async list(namespace) {
    const path = starredPath(await this.#myActorPub(), namespace);
    return (await getPrivate(this.qu, this.identity, path)) ?? [];
  }

  /** @param {string} namespace @param {string} itemId @returns {Promise<boolean>} */
  async isStarred(namespace, itemId) {
    return (await this.list(namespace)).some((item) => item.id === itemId);
  }
}
