import { QuCrypto } from '@qu/core';
import { documentPath } from './paths.js';

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
   */
  constructor(documentService, collectionService, identityEngine) {
    this.documents = documentService;
    this.collections = collectionService;
    this.identity = identityEngine;
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

  /** @returns {Promise<Array<object>>} Every currently visible directory entry. */
  async listVisible() {
    return (await this.collections.list(DIRECTORY_SPACE, VISIBLE_COLLECTION)) ?? [];
  }

  /** @param {string} actorPub @returns {Promise<boolean>} */
  async isVisible(actorPub) {
    return (await this.listVisible()).some((entry) => entry.actorPub === actorPub);
  }
}
