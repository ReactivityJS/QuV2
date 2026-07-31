const NAMESPACE = 'contacts';

/**
 * CONTACTS SERVICE — "people I know", the exact same starred-list shape
 * FavoritesService uses, just namespaced for actor pubkeys instead of app
 * ids, with each entry resolved against its public profile for display.
 * Mirrors the real Qu's `modules/contacts.js`, documented there as "a thin
 * wrapper over starred.js's generic mechanism, the exact same shape
 * favorited apps need" - this is that same reuse, one layer up.
 */
export class ContactsService {
  /**
   * @param {import('./starred-service.js').StarredService} starredService
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(starredService, identityEngine) {
    this.starred = starredService;
    this.identity = identityEngine;
  }

  /**
   * @param {string} actorPub - base64url Ed25519 public key of the contact.
   * @param {object} [data] - Optional local-only metadata (e.g. a nickname).
   * @returns {Promise<Array<object>>}
   */
  async addContact(actorPub, data = {}) {
    return this.starred.star(NAMESPACE, actorPub, data);
  }

  /** @param {string} actorPub @returns {Promise<Array<object>>} */
  async removeContact(actorPub) {
    return this.starred.unstar(NAMESPACE, actorPub);
  }

  /**
   * @returns {Promise<Array<{actorPub: string, starredAt: number, profile: object|null}>>}
   *   Every contact, with their CURRENT public profile resolved (null if
   *   they haven't published one, or it no longer verifies).
   */
  async listContacts() {
    const starred = await this.starred.list(NAMESPACE);
    return Promise.all(
      starred.map(async ({ id, starredAt, ...data }) => ({
        actorPub: id,
        starredAt,
        ...data,
        profile: await this.identity.getProfile(id),
      }))
    );
  }

  /** @param {string} actorPub @returns {Promise<boolean>} */
  async isContact(actorPub) {
    return this.starred.isStarred(NAMESPACE, actorPub);
  }
}
