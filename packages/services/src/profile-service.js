import { QuCrypto } from '@qu/core';
import { putPrivate, getPrivate } from './private-storage.js';

/** @param {string} actorPub @returns {string} */
function privateExtraPath(actorPub) {
  return `/store/actors/~${actorPub}/private/profile-extra`;
}

/**
 * PROFILE SERVICE — the Entity API for "my editable profile", built on top
 * of @qu/identity's already-existing public profile (publishMainProfile/
 * getProfile) plus private-storage.js's self-encryption, the same
 * mechanism StarredService uses for favorites/contacts.
 *
 * The split this adds beyond what QuIdentityEngine already does: a profile
 * here is `alias` + `avatar` (always public - Contacts/User List need them
 * to show anyone at all) plus an arbitrary, owner-defined list of custom
 * `fields`, each individually flagged `'public'` or `'private'`:
 *   - `'public'` fields are merged into the same signed, unencrypted
 *     document `getProfile()` already publishes - visible to anyone, no
 *     different from `alias`/`avatar`.
 *   - `'private'` fields are self-encrypted (see private-storage.js) at a
 *     SEPARATE path - visible only to this identity itself when it calls
 *     `getOwnProfile()` again. This is NOT "visible to trusted contacts
 *     only" (that's what @qu/identity's attestation mechanism is for, a
 *     different sharing model) - a private field here means "I keep this
 *     in my own profile as a personal note/reminder, nobody else ever
 *     sees it", the simplest possible reading of "private toggle".
 */
export class ProfileService {
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
   * Publishes (or replaces) this identity's whole profile - both the public
   * document and the private extra-fields document. Replaces wholesale
   * (like CollectionService.create()) rather than patching, so removing a
   * field is just not including it in `fields` - see getOwnProfile() for
   * the read shape this mirrors.
   *
   * @param {{alias?: string, avatar?: string, fields?: Array<{key: string, value: string, visibility: 'public'|'private'}>}} profile
   * @returns {Promise<string>} This identity's actor pubkey (base64url).
   */
  async saveProfile({ alias = '', avatar = '', fields = [] }) {
    const publicExtra = {};
    const privateExtra = {};
    for (const { key, value, visibility } of fields) {
      if (!key) continue;
      if (visibility === 'private') privateExtra[key] = value;
      else publicExtra[key] = value;
    }

    const actorPub = await this.identity.publishMainProfile({ alias, avatar, ...publicExtra });
    await putPrivate(this.qu, this.identity, privateExtraPath(actorPub), privateExtra);
    return actorPub;
  }

  /**
   * This identity's OWN full profile, public and private fields both
   * resolved and merged back into one `fields` list (each tagged with
   * where it came from) - the shape the editor UI round-trips through
   * saveProfile(). Nobody but this identity can ever call this
   * meaningfully for itself; there is no "get someone else's private
   * fields" - see getPublicProfile() for what a THIRD PARTY sees instead.
   *
   * @returns {Promise<{alias: string, avatar: string, fields: Array<{key: string, value: string, visibility: 'public'|'private'}>}>}
   */
  async getOwnProfile() {
    const actorPub = await this.#myActorPub();
    const { alias = '', avatar = '', xPublicKey, ...publicExtra } = (await this.identity.getProfile(actorPub)) ?? {};
    const privateExtra = (await getPrivate(this.qu, this.identity, privateExtraPath(actorPub))) ?? {};

    const fields = [
      ...Object.entries(publicExtra).map(([key, value]) => ({ key, value, visibility: 'public' })),
      ...Object.entries(privateExtra).map(([key, value]) => ({ key, value, visibility: 'private' })),
    ];
    return { alias, avatar, fields };
  }

  /**
   * What ANYONE (not just the owner) sees for a given identity - exactly
   * the signed public document, with the internal `xPublicKey` bookkeeping
   * field (see @qu/identity) hidden since it's not a profile field a UI
   * should render.
   * @param {string} actorPub
   * @returns {Promise<{alias: string, avatar: string, [key: string]: string}|null>}
   */
  async getPublicProfile(actorPub) {
    const profile = await this.identity.getProfile(actorPub);
    if (!profile) return null;
    const { xPublicKey, ...rest } = profile;
    return rest;
  }
}
