import { QuCrypto } from '@qu/core';
import { flagPath, flagCollectionId } from './paths.js';
import { createFreshnessTracker } from './sync-freshness.js';

/**
 * Namespace overrides for the two flag/entity combos that predate this
 * Service (`FavoritesService`'s `'apps'` namespace, `ContactsService`'s
 * `'contacts'` namespace - both already just `StarredService` under a
 * fixed namespace, see those files). Routing them through here instead of
 * the `${flagType}:${entityKind}` default keeps every EXISTING user's
 * already-stored favorites/contacts readable at their unchanged storage
 * path - this is a compatibility mapping, not a naming preference.
 */
const LEGACY_NAMESPACES = { 'favorite:app': 'apps', 'favorite:user': 'contacts' };

function privateNamespace(flagType, entityKind) {
  const key = `${flagType}:${entityKind}`;
  return LEGACY_NAMESPACES[key] ?? key;
}

/**
 * FLAG SERVICE — the universal "mark this thing" mechanism (Drupal calls
 * this a "Flag": Like, Bookmark, Favorite, ... each a configurable TYPE
 * that can apply to more than one kind of entity). Two independent modes,
 * chosen per call rather than per flagType, since the same conceptual
 * "flag" can legitimately want either shape depending on what's flagging
 * what:
 *
 *   - PRIVATE (`setPrivate`/`listPrivate`/`hasPrivate`): "my own list of
 *     things I've flagged" - self-encrypted, only I can read it. Thin
 *     wrapper over the already-fully-generic `StarredService`
 *     (`namespace = flagType + ':' + entityKind`, `itemId = entityRef`).
 *     This is what `FavoritesService` (apps) and `ContactsService` (users)
 *     both are today, and what a new "Bookmark a forum thread" or
 *     "Bookmark a user profile" feature uses too.
 *   - PUBLIC (`setPublic`/`getPublicFlags`/`hasPublicFlag`): a visible,
 *     shared count (Like) - generalizes ThreadService's own
 *     `setReaction()`/`getReactions()` pattern (see that file's own doc
 *     comment) beyond thread messages: each actor writes their OWN signed
 *     slot under `paths.flagPath()`, enumerable by anyone via a
 *     CollectionService index. Trust comes ONLY from each QuBit's own
 *     verified `pub` (never from the path segment) - identical reasoning
 *     to ThreadService's reactions, see `#actorPubOf()` below.
 *
 * `entityRef` is always a flat, caller-defined string id (no structure
 * assumed) - same convention `StarredService`'s `itemId` already uses.
 */
export class FlagService {
  static PUBLIC_SPACE = 'public';

  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./starred-service.js').StarredService} starredService
   * @param {import('./collection-service.js').CollectionService} collectionService
   * @param {(path: string) => Promise<object|null>} [syncFetch]
   * @param {() => number} [getGeneration]
   */
  constructor(qu, identityEngine, starredService, collectionService, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.starred = starredService;
    this.collections = collectionService;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  // ===== private mode ======================================================

  /**
   * @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @param {boolean} on @param {object} [data] - Extra fields to store alongside (e.g. a nickname).
   * @returns {Promise<Array<object>>} The updated list.
   */
  async setPrivate(flagType, entityKind, entityRef, on, data = {}) {
    const namespace = privateNamespace(flagType, entityKind);
    return on ? this.starred.star(namespace, entityRef, data) : this.starred.unstar(namespace, entityRef);
  }

  /** @param {string} flagType @param {string} entityKind @returns {Promise<Array<object>>} */
  async listPrivate(flagType, entityKind) {
    return this.starred.list(privateNamespace(flagType, entityKind));
  }

  /** @param {string} flagType @param {string} entityKind @param {string} entityRef @returns {Promise<boolean>} */
  async hasPrivate(flagType, entityKind, entityRef) {
    return this.starred.isStarred(privateNamespace(flagType, entityKind), entityRef);
  }

  // ===== public mode ========================================================

  /** @param {object} quBit @returns {string|null} base64url actor pubkey, or null if unsigned. */
  #actorPubOf(quBit) {
    return quBit?.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
  }

  /**
   * Sets (or clears) THIS identity's own public flag on an entity.
   * @param {string|number} spaceId - The entity's own space if it has one
   *   (e.g. a forum thread's space), or `FlagService.PUBLIC_SPACE` for
   *   entity kinds with no natural space of their own (e.g. `user`, `app`).
   * @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @param {boolean} on
   */
  async setPublic(spaceId, flagType, entityKind, entityRef, on) {
    const mainKey = await this.identity.getMainKey();
    const actorPub = QuCrypto.toBase64Url(mainKey.publicKey);
    const path = flagPath(spaceId, flagType, entityKind, entityRef, actorPub);
    const putOptions = { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey };
    await this.qu.put(path, on ? { flaggedAt: Date.now() } : null, putOptions);
    const collectionId = flagCollectionId(flagType, entityKind, entityRef);
    if (on) await this.collections.addItem(spaceId, collectionId, path, putOptions);
    else await this.collections.removeItem(spaceId, collectionId, path, putOptions);
  }

  /**
   * @param {string|number} spaceId @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @returns {Promise<{count: number, actorPubs: string[]}>}
   */
  async getPublicFlags(spaceId, flagType, entityKind, entityRef) {
    const collectionId = flagCollectionId(flagType, entityKind, entityRef);
    // listRawPaths() already backfills on a genuine local miss (blocking
    // syncFetch) or background-refreshes a gated once-per-generation check
    // on a local hit - see CollectionService.listRawPaths()'s own doc
    // comment, and ThreadService.getReactions()'s identical reliance on it.
    const paths = await this.collections.listRawPaths(spaceId, collectionId);
    const actorPubs = [];
    await Promise.all(paths.map(async (path) => {
      let quBit = await this.qu.get(path);
      if (quBit) {
        this.#backgroundRefresh(path);
      } else if (this.syncFetch) {
        await this.syncFetch(path).catch(() => {});
        quBit = await this.qu.get(path);
      }
      const actorPub = this.#actorPubOf(quBit);
      if (actorPub && quBit.val) actorPubs.push(actorPub);
    }));
    return { count: actorPubs.length, actorPubs };
  }

  /**
   * @param {string|number} spaceId @param {string} flagType @param {string} entityKind
   * @param {string} entityRef @param {string} actorPub
   * @returns {Promise<boolean>}
   */
  async hasPublicFlag(spaceId, flagType, entityKind, entityRef, actorPub) {
    const path = flagPath(spaceId, flagType, entityKind, entityRef, actorPub);
    let quBit = await this.qu.get(path);
    if (quBit) {
      this.#backgroundRefresh(path);
    } else if (this.syncFetch) {
      await this.syncFetch(path).catch(() => {});
      quBit = await this.qu.get(path);
    }
    return !!(quBit && this.#actorPubOf(quBit) === actorPub && quBit.val);
  }
}
