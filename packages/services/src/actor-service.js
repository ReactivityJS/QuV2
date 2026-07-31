/**
 * ACTOR SERVICE — the Entity API for identities.
 *
 * Thin, renamed front door over @qu/identity's QuIdentityEngine (which
 * already returns plain values, not QuBits, so there's little to unwrap
 * here). The point of this wrapper is vocabulary: apps think in terms of
 * "actors" and "spaces", not BIP-32 derivation paths or attestations.
 */
export class ActorService {
  /** @param {import('@qu/identity').QuIdentityEngine} identityEngine */
  constructor(identityEngine) {
    this.identity = identityEngine;
  }

  /** @returns {string} A fresh 24-word recovery phrase. */
  createRecoveryPhrase() {
    return this.identity.generateMnemonic();
  }

  /** @returns {Promise<string>} This identity's own main actor public key (base64url) - "who am I". */
  async whoAmI() {
    const { QuCrypto } = await import('@qu/core');
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * @param {string} mnemonic
   * @param {string} [passphrase]
   * @returns {Promise<void>}
   */
  async signIn(mnemonic, passphrase) {
    await this.identity.importMnemonic(mnemonic, passphrase);
  }

  /**
   * Publishes (or updates) this user's revealed, real-world-linkable profile.
   * @param {object} fields
   * @returns {Promise<string>} This actor's public key (base64url).
   */
  async publishMainProfile(fields) {
    return this.identity.publishMainProfile(fields);
  }

  /**
   * Publishes (or updates) a pseudonymous identity's public profile for the given space.
   * @param {string|number} spaceId
   * @param {object} fields
   * @returns {Promise<string>} The space actor's public key (base64url).
   */
  async createSpaceIdentity(spaceId, fields) {
    return this.identity.publishProfile(spaceId, fields);
  }

  /** @param {string} actorPub - base64url public key. @returns {Promise<object|null>} */
  async getProfile(actorPub) {
    return this.identity.getProfile(actorPub);
  }

  /**
   * Proves (privately, to the given trusted contacts) that a space identity belongs to this user.
   * @param {string|number} spaceId
   * @param {string[]} trustedContactPubs - base64url public keys of contacts who published a main profile.
   * @returns {Promise<void>}
   */
  async vouchForSpaceIdentity(spaceId, trustedContactPubs) {
    await this.identity.createAttestation(spaceId, trustedContactPubs);
  }

  /**
   * @param {string} actorPub - base64url public key of a space identity.
   * @returns {Promise<string|null>} The linked main identity's public key, if this user was trusted with it.
   */
  async resolveActor(actorPub) {
    return this.identity.resolveMainUser(actorPub);
  }
}
