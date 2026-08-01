import { QuCrypto } from '@qu/core';
import { documentPath, collectionPath } from './paths.js';

const DIRECTORY_SPACE = 'directory';
const VISIBLE_COLLECTION = 'visible';

/**
 * DIRECTORY SERVICE — an opt-in, public "who's browsable" list, the thing
 * a people-search/userlist UI needs beyond direct Contacts (which only
 * covers people you've already starred). Mirrors the real Qu's
 * `qu-directory` space: publishing here is a deliberate, reversible choice
 * ("listed"), completely independent of ContactsService's private starred
 * list ("known to me").
 *
 * Two pieces per identity, both public/unencrypted by design (the whole
 * point is to be findable):
 *   - A directory entry document (name/whatever `extra` fields the caller
 *     supplies) at a fixed, well-known path.
 *   - Membership in the `visible` collection, which is what listVisible()
 *     actually enumerates - the entry document alone isn't enough, since
 *     nothing in this store lets you list "every document under this
 *     prefix" (no wildcard/prefix query - see @qu/core's deliberately
 *     minimal QuStore). Going invisible again removes the collection
 *     membership; the entry document itself is left in place (so
 *     `qu.get(documentPath(...))` still resolves for anyone who already has
 *     the id, e.g. a Contact), it's just no longer DISCOVERABLE.
 */
export class DirectoryService {
  /**
   * @param {import('./document-service.js').DocumentService} documentService
   * @param {import('./collection-service.js').CollectionService} collectionService
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   `SyncEngine.fetch()` (see @qu/sync), for backfilling directory data
   *   this identity doesn't have LOCALLY yet - same reasoning as
   *   ThreadService's own constructor doc comment. Without it, a directory
   *   entry (or the visible-collection document itself) published before
   *   this session subscribed would never show up in listVisible(), no
   *   matter how long it waits (`subscribe()` only ever covers FUTURE
   *   writes - see SyncEngine's own doc comment).
   */
  constructor(documentService, collectionService, identityEngine, syncFetch = null) {
    this.documents = documentService;
    this.collections = collectionService;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
  }

  /**
   * @returns {Promise<string>} This identity's base64url actor pubkey (the directory entry id).
   */
  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * Publishes (or updates) this identity's directory entry and adds/removes
   * it from the visible collection.
   * @param {boolean} visible
   * @param {object} [extra] - Public fields to show (name, bio, ...).
   * @returns {Promise<void>}
   */
  async setVisible(visible, extra = {}) {
    const actorPub = await this.#myActorPub();
    const mainKey = await this.identity.getMainKey();
    await this.documents.create(
      DIRECTORY_SPACE,
      actorPub,
      { actorPub, ...extra },
      { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey }
    );
    const entryPath = documentPath(DIRECTORY_SPACE, actorPub);
    if (visible) await this.collections.addItem(DIRECTORY_SPACE, VISIBLE_COLLECTION, entryPath);
    else await this.collections.removeItem(DIRECTORY_SPACE, VISIBLE_COLLECTION, entryPath);
  }

  /**
   * @returns {Promise<Array<object>>} Every currently visible directory
   *   entry - backfilled via `syncFetch` (if provided) on a local miss
   *   before giving up, both for the visible-collection document itself
   *   AND for any individual entry it references that hasn't synced yet
   *   (resolves to `null` otherwise - see @qu/engines' CollectionEngine -
   *   which this always filters out, so a caller never has to null-check).
   */
  async listVisible() {
    let items = await this.collections.list(DIRECTORY_SPACE, VISIBLE_COLLECTION);

    if (items === null && this.syncFetch) {
      try {
        await this.syncFetch(collectionPath(DIRECTORY_SPACE, VISIBLE_COLLECTION));
      } catch {
        return []; // peer unreachable, or genuinely nobody's listed - either way, nothing more to try
      }
      items = await this.collections.list(DIRECTORY_SPACE, VISIBLE_COLLECTION);
    }
    if (!items) return [];

    if (this.syncFetch && items.some((item) => item === null)) {
      const rawPaths = await this.collections.listRawPaths(DIRECTORY_SPACE, VISIBLE_COLLECTION);
      await Promise.all(items.map((item, i) => (item === null ? this.syncFetch(rawPaths[i]).catch(() => {}) : null)));
      items = (await this.collections.list(DIRECTORY_SPACE, VISIBLE_COLLECTION)) ?? [];
    }

    return items.filter(Boolean);
  }

  /** @param {string} actorPub @returns {Promise<boolean>} */
  async isVisible(actorPub) {
    return (await this.listVisible()).some((entry) => entry.actorPub === actorPub);
  }
}
