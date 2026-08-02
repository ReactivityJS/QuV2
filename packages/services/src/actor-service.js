import { isEncryptedEnvelope, decryptEnvelope } from './crypto-envelope.js';

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

  /**
   * Signs an arbitrary JSON-serializable payload with this identity's main
   * key - what a caller needs to prove "I, this actor, endorse this exact
   * value" to a party that only needs to verify AUTHORSHIP, not read
   * anything private (e.g. @qu/relay's `POST /admin/settings`, checked
   * against its own `adminPubs` list - see apps/relay-admin/client.js).
   * Same sign-over-`JSON.stringify()` shape
   * @qu/services/notification-prefs-service.js's own `savePrefs()` already
   * uses for its own signed-but-public documents.
   * @param {*} payload
   * @returns {Promise<{actorPub: string, signature: string}>}
   */
  async signPayload(payload) {
    const { QuCrypto } = await import('@qu/core');
    const mainKey = await this.identity.getMainKey();
    const signature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify(payload)), mainKey.privateKeyPkcs8);
    return { actorPub: QuCrypto.toBase64Url(mainKey.publicKey), signature: QuCrypto.toBase64Url(signature) };
  }

  /**
   * Attempts to decrypt an arbitrary QuBit's `val` FOR THIS identity -
   * "is one of this envelope's listed recipients me, and if so here's the
   * plaintext" (see crypto-envelope.js's `decryptEnvelope()`), without the
   * caller needing to know which Service/Thread produced it. Built for
   * Relay Admin's Data Explorer (see apps/relay-admin/client.js), which
   * pulls raw QuBits straight off disk and has no thread/document context
   * to decrypt through the normal Service layer.
   * @param {{val: *, pub: string|null}} quBit - Only `val`/`pub` are read.
   * @param {(actorPub: string) => Promise<object|null>} getProfile -
   *   Resolves the SENDER's profile (for their X key) - pass e.g.
   *   `services.profile.getPublicProfile` for syncFetch-backed resolution.
   *   Accepts either that method's app-facing shape (`{epub}`) or
   *   `@qu/identity`'s raw shape (`{xPublicKey}`, what `decryptEnvelope()`
   *   itself expects) - normalized below so a caller doesn't need to know
   *   which one it's holding.
   * @returns {Promise<{encrypted: boolean, value: *}>} `encrypted: false`
   *   means `val` was already plaintext (returned as-is); `encrypted: true`
   *   with `value: null` means this identity isn't a listed recipient (or
   *   the sender's key couldn't be resolved) - genuinely undecryptable
   *   here, not an error.
   */
  async decryptForMe(quBit, getProfile) {
    if (!isEncryptedEnvelope(quBit?.val)) return { encrypted: false, value: quBit?.val };
    const normalizedGetProfile = async (actorPub) => {
      const profile = await getProfile(actorPub);
      if (!profile) return null;
      return { ...profile, xPublicKey: profile.xPublicKey ?? profile.epub };
    };
    const value = await decryptEnvelope(quBit, this.identity, normalizedGetProfile);
    return { encrypted: true, value };
  }
}
