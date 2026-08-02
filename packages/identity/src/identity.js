/**
 * QU IDENTITY ENGINE — one BIP-39 seed, many identities.
 *
 * A user has exactly one master seed. Everything else is derived from it:
 *   - a "main" identity (signing + encryption keypair) they may reveal, and
 *   - any number of "space" identities - pseudonymous keypairs deterministically
 *     derived per context (a chat room, a forum, an app) that look, from the
 *     outside, like unrelated actors.
 *
 * A space identity can prove - privately, to chosen contacts only - that it
 * belongs to a given main identity, via an "attestation": a small signed
 * statement, individually encrypted per trusted contact, stored publicly
 * under the space identity's own actor path. Only someone the attestation
 * was encrypted for can ever learn the link; everyone else just sees an
 * opaque pseudonymous actor.
 *
 * -----------------------------------------------------------------------
 * What changed vs. the original prototype (see @qu/identity's CHANGELOG-worthy
 * fixes, kept here as comments since this is the code that had the bugs):
 * -----------------------------------------------------------------------
 *   - Every derived keypair used to include a *randomly generated* public
 *     key instead of the one that actually matches the derived private key
 *     (`crypto.getRandomValues(...) // Dummy-Key für Demonstration`). Every
 *     key here is now derived correctly via SLIP-10 + QuCrypto.keypairFromSeed,
 *     so signatures and ECDH actually verify/decrypt.
 *   - `getMainXKey()` returned a hardcoded `new Uint8Array(32) // Dummy`
 *     private key. Encryption keys are now derived exactly like signing
 *     keys - deterministically, from the same seed, at a dedicated path.
 *   - Attestation encryption called `QuCrypto.encrypt()` once PER recipient,
 *     each time re-encrypting the full payload. `QuCrypto.encrypt()` already
 *     supports multiple recipients per call (one ciphertext, N wrapped
 *     content keys) - this version encrypts once no matter how many trusted
 *     contacts there are.
 *   - `resolveMainUser()` required the caller to pass in a full keypair
 *     object where the JSDoc promised a private key, and matched a
 *     recipient's Ed25519 identity key against X25519 ECDH recipient
 *     entries (comparing the wrong key type - it could never match). It now
 *     uses the caller's own identity engine state and matches on the correct
 *     X25519 public key.
 *   - `setProfile`/`createAttestation` required the caller to pass in raw
 *     key material for keys the identity engine can derive itself; they now
 *     just take a `spaceId`.
 */

import { QuCrypto } from '@qu/core';
import { generateMnemonicPhrase, mnemonicToSeedBytes, isValidMnemonic } from './bip39.js';
import { deriveNodeFromPath } from './bip32.js';
import {
  mainSigningPath,
  mainEncryptionPath,
  spaceSigningPath,
  spaceEncryptionPath,
  ephemeralSigningPath,
} from './paths.js';

const SEED_PATH = '/store/secure/identity/seed';

// Both caches below are naturally bounded for a single identity's OWN keys
// (one process only ever derives so many space keypairs), but
// `_attestationCache` is keyed by OTHER actors' pubkeys - a long-running
// relay or a client resolving many distinct senders' attestations over time
// would otherwise grow it without bound. A simple insertion-order cap
// (Map preserves insertion order, so the first key is the oldest) is enough
// here; this isn't a hot enough path to warrant real LRU bookkeeping.
const MAX_CACHE_ENTRIES = 2000;

function capCache(map, maxEntries = MAX_CACHE_ENTRIES) {
  while (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

/**
 * The one place that knows how an actor's public documents map to storage
 * paths (profile, attestation, ...) - exported (see index.js) so apps that
 * need to e.g. `watch()` a specific identity's profile path directly (the
 * shell's header alias, the Profile app - see apps/shell/src/main.js and
 * apps/profile/client.js) don't hand-roll the same string template in
 * three places. Unrelated to this package's OTHER `paths` export (BIP32
 * key-derivation paths, see paths.js) - same word, two different kinds of
 * "path", kept apart by export name (`actorPath` vs the `paths` namespace).
 * @param {string} actorPub - base64url actor public key.
 * @param {string} kind
 */
export function actorPath(actorPub, kind) {
  return `/store/actors/~${actorPub}/${kind}`;
}

/** Constant-time-ish byte comparison (length differs -> false fast; used for local safety checks, not a public API). */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class QuIdentityEngine {
  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
    /** @type {Map<string, {privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>} */
    this._keyCache = new Map();
    /** @type {Map<string, string|null>} actorPub -> resolved main pub, or null (not resolvable by us) */
    this._attestationCache = new Map();
  }

  // =====================================================================
  // 1. MASTER SEED
  // =====================================================================

  /** @returns {string} A fresh 24-word BIP-39 mnemonic. Caller is responsible for safe display/backup. */
  generateMnemonic() {
    return generateMnemonicPhrase(256);
  }

  /**
   * Derives the master seed from a mnemonic and stores it.
   *
   * SECURITY NOTE: the master seed is the root of every identity this
   * engine can ever derive. This method stores it as-is at `SEED_PATH` -
   * protecting it at rest is the responsibility of the mounted `store`
   * adapter (e.g. an OS keychain-backed adapter, or a platform secure
   * enclave), not this engine: encrypting it with a Qu key derived FROM this
   * same seed would be circular (you'd need the seed to decrypt the seed).
   *
   * A QuCore/store is expected to hold AT MOST ONE identity's seed - this is
   * the local root of trust for one user, the same way a browser profile or
   * an SSH agent holds one set of keys. Calling this a second time with a
   * DIFFERENT mnemonic against a store that already has a seed throws
   * instead of silently overwriting it (every previously derived key would
   * otherwise change or collide underneath already-published profiles).
   * Pass `{ overwrite: true }` if replacing the identity is genuinely intended.
   *
   * @param {string} mnemonic
   * @param {string} [passphrase='']
   * @param {{overwrite?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async importMnemonic(mnemonic, passphrase = '', { overwrite = false } = {}) {
    if (!isValidMnemonic(mnemonic)) {
      throw new Error('QuIdentityEngine.importMnemonic: invalid mnemonic (bad word or checksum).');
    }
    const seed = await mnemonicToSeedBytes(mnemonic, passphrase);
    await this.#storeSeed(seed, overwrite);
  }

  /** Shared by importMnemonic() and importSeedCode() - see either's own doc comment for the overwrite guard's reasoning. */
  async #storeSeed(seed, overwrite) {
    if (!overwrite) {
      const existing = await this.qu.get(SEED_PATH);
      const existingSeed = existing?.val ?? existing;
      if (existingSeed && !bytesEqual(new Uint8Array(existingSeed), seed)) {
        throw new Error(
          'QuIdentityEngine: this store already holds a different identity seed. ' +
            'A QuCore holds one identity at a time - use a separate store per identity, or pass ' +
            '{ overwrite: true } if you intend to replace it.'
        );
      }
    }
    await this.qu.put(SEED_PATH, Array.from(seed)); // plain array -> safe to JSON-serialise across adapters
    this._keyCache.clear();
  }

  /**
   * Exports the master seed as an opaque, base64url-encoded backup code -
   * the cross-device transfer/backup mechanism (see apps/profile/client.js's
   * "Identity backup" section, and @qu/qr for the QR-code presentation of
   * this same string). This is deliberately NOT the original 24-word
   * mnemonic: `importMnemonic()` only ever stores the SEED derived from it
   * (BIP-39's mnemonic -> seed step is one-way PBKDF2 - see bip39.js's own
   * doc comment), so the words themselves are gone the moment
   * `generateMnemonic()`'s return value is - a backup code taken later can
   * only ever be the seed itself.
   *
   * SECURITY: this code IS the private key material for every identity
   * (main + every space) this engine can ever derive - treat it exactly
   * like a private key. Never log it, never transmit it anywhere but a
   * channel the user controls end-to-end (their own second device's
   * camera/clipboard), and never call this without the caller having
   * already gotten the user's explicit, informed confirmation.
   * @returns {Promise<string>} base64url-encoded seed bytes.
   */
  async exportSeedCode() {
    const seed = await this._getMasterSeed();
    return QuCrypto.toBase64Url(seed);
  }

  /**
   * The restore/transfer counterpart to exportSeedCode() - imports a
   * previously exported backup code directly (skipping BIP-39 derivation
   * entirely, since a backup code already IS the derived seed, not a
   * mnemonic - see exportSeedCode()'s own doc comment). Same
   * one-seed-per-store overwrite guard as importMnemonic().
   * @param {string} code - As returned by exportSeedCode().
   * @param {{overwrite?: boolean}} [options]
   * @returns {Promise<void>}
   * @throws {Error} If `code` isn't valid base64url, or doesn't decode to a 64-byte seed.
   */
  async importSeedCode(code, { overwrite = false } = {}) {
    let seed;
    try {
      seed = QuCrypto.fromBase64Url(String(code).trim());
    } catch {
      seed = null;
    }
    if (!seed || seed.length !== 64) {
      throw new Error('QuIdentityEngine.importSeedCode: not a valid backup code');
    }
    await this.#storeSeed(seed, overwrite);
  }

  /**
   * @returns {Promise<boolean>} Whether this store already holds an identity
   *   seed - use this before deciding to generate+import a fresh one (e.g.
   *   on a service's first boot vs. a restart), so restarts don't try to
   *   import a brand-new random mnemonic over an existing identity.
   */
  async hasIdentity() {
    const existing = await this.qu.get(SEED_PATH);
    return !!(existing?.val ?? existing);
  }

  /** @returns {Promise<Uint8Array>} @throws {Error} If no seed has been imported yet. */
  async _getMasterSeed() {
    const stored = await this.qu.get(SEED_PATH);
    if (!stored) throw new Error('QuIdentityEngine: no master seed found. Call importMnemonic() first.');
    return new Uint8Array(stored.val ?? stored);
  }

  // =====================================================================
  // 2. KEY DERIVATION
  // =====================================================================

  /**
   * @param {'Ed25519'|'X25519'} curve
   * @param {string} cacheKey
   * @param {string} path
   * @returns {Promise<{privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>}
   */
  async #deriveAndCache(curve, cacheKey, path) {
    if (this._keyCache.has(cacheKey)) return this._keyCache.get(cacheKey);
    const seed = await this._getMasterSeed();
    const node = await deriveNodeFromPath(seed, path);
    const { privateKeyPkcs8, publicKey } = await QuCrypto.keypairFromSeed(curve, node.privateKey);
    const keypair = { privateKeyPkcs8, publicKey };
    this._keyCache.set(cacheKey, keypair);
    capCache(this._keyCache);
    return keypair;
  }

  /** @returns {Promise<{privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>} The main Ed25519 (signing) identity. */
  async getMainKey() {
    return this.#deriveAndCache('Ed25519', 'main:sign', mainSigningPath());
  }

  /** @returns {Promise<{privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>} The main X25519 (encryption) identity. */
  async getMainXKey() {
    return this.#deriveAndCache('X25519', 'main:enc', mainEncryptionPath());
  }

  /** @param {string|number} spaceId @returns {Promise<{privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>} */
  async getSpaceKey(spaceId) {
    return this.#deriveAndCache('Ed25519', `space:sign:${spaceId}`, await spaceSigningPath(spaceId));
  }

  /** @param {string|number} spaceId @returns {Promise<{privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>} */
  async getSpaceXKey(spaceId) {
    return this.#deriveAndCache('X25519', `space:enc:${spaceId}`, await spaceEncryptionPath(spaceId));
  }

  /**
   * Derives a throwaway signing identity within a space - e.g. a fresh key
   * per message, for maximum unlinkability. Not cached (by design: callers
   * asking for a new ephemeral index expect a fresh, independent key).
   * @param {string|number} spaceId
   * @param {number} index
   * @returns {Promise<{privateKeyPkcs8: Uint8Array, publicKey: Uint8Array}>}
   */
  async getEphemeralKey(spaceId, index) {
    const seed = await this._getMasterSeed();
    const path = await ephemeralSigningPath(spaceId, index);
    const node = await deriveNodeFromPath(seed, path);
    return QuCrypto.keypairFromSeed('Ed25519', node.privateKey);
  }

  // =====================================================================
  // 3. PUBLIC PROFILES
  // =====================================================================

  /**
   * Publishes (or updates) the public profile for the MAIN identity - the
   * one this user may reveal to trusted contacts. Contacts need this
   * profile (specifically its X25519 key) to be able to send this identity
   * encrypted attestations.
   * @param {object} fields - Arbitrary public fields (name, avatar, bio, ...).
   * @returns {Promise<string>} The main identity's public key (base64url).
   */
  async publishMainProfile(fields) {
    return this.#publishProfileWithKeys(fields, await this.getMainKey(), await this.getMainXKey());
  }

  /**
   * Publishes (or updates) the public profile for a space (pseudonymous)
   * identity, signed by that identity's own key. Automatically includes the
   * space's X25519 public key so others can send it encrypted attestations.
   *
   * @param {string|number} spaceId
   * @param {object} fields - Arbitrary public fields (name, avatar, bio, ...).
   * @returns {Promise<string>} The actor's public key (base64url) - share this so others can find the profile.
   */
  async publishProfile(spaceId, fields) {
    return this.#publishProfileWithKeys(fields, await this.getSpaceKey(spaceId), await this.getSpaceXKey(spaceId));
  }

  async #publishProfileWithKeys(fields, signKey, xKey) {
    const actorPub = QuCrypto.toBase64Url(signKey.publicKey);

    const profile = { ...fields, xPublicKey: QuCrypto.toBase64Url(xKey.publicKey) };
    const profileBytes = new TextEncoder().encode(JSON.stringify(profile));
    const signature = await QuCrypto.sign(profileBytes, signKey.privateKeyPkcs8);

    await this.qu.put(actorPath(actorPub, 'profile'), {
      profile,
      signature: QuCrypto.toBase64Url(signature),
    });
    return actorPub;
  }

  /**
   * Fetches and verifies a public profile.
   * @param {string} actorPub - base64url Ed25519 public key.
   * @returns {Promise<object|null>} The profile fields, or null if absent/invalid.
   */
  async getProfile(actorPub) {
    const stored = await this.qu.get(actorPath(actorPub, 'profile'));
    const record = stored?.val ?? stored;
    if (!record) return null;
    const { profile, signature } = record;
    const profileBytes = new TextEncoder().encode(JSON.stringify(profile));
    const isValid = await QuCrypto.verify(profileBytes, QuCrypto.fromBase64Url(signature), QuCrypto.fromBase64Url(actorPub));
    return isValid ? profile : null;
  }

  // =====================================================================
  // 4. ATTESTATIONS (space -> main linkage, private to trusted contacts)
  // =====================================================================

  /**
   * Creates (or replaces) the attestation that proves `spaceId`'s identity
   * belongs to this engine's main identity, individually encrypted for each
   * trusted contact. Requires the space's profile (with its X25519 public
   * key) to already be published via publishProfile().
   *
   * @param {string|number} spaceId
   * @param {string[]} trustedRecipientPubs - base64url Ed25519 public keys of contacts allowed to resolve this.
   * @returns {Promise<void>}
   */
  async createAttestation(spaceId, trustedRecipientPubs) {
    const mainKey = await this.getMainKey();
    const spaceKey = await this.getSpaceKey(spaceId);
    const spaceXKey = await this.getSpaceXKey(spaceId);
    const actorPub = QuCrypto.toBase64Url(spaceKey.publicKey);

    const payload = {
      main_pubkey: QuCrypto.toBase64Url(mainKey.publicKey),
      space_pubkey: actorPub,
      timestamp: Date.now(),
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signature = await QuCrypto.sign(payloadBytes, mainKey.privateKeyPkcs8);
    const signedBytes = new TextEncoder().encode(JSON.stringify({ payload, signature: QuCrypto.toBase64Url(signature) }));

    // Resolve every recipient's X25519 public key from their published profile.
    const recipientXPubs = [];
    for (const recipientPub of trustedRecipientPubs) {
      const recipientProfile = await this.getProfile(recipientPub);
      if (!recipientProfile?.xPublicKey) {
        console.warn(`[QuIdentityEngine] Skipping attestation recipient "${recipientPub}": no published X25519 key`);
        continue;
      }
      recipientXPubs.push(QuCrypto.fromBase64Url(recipientProfile.xPublicKey));
    }

    // Encrypt ONCE for all recipients (envelope encryption), not once per recipient.
    const encrypted = await QuCrypto.encrypt(signedBytes, recipientXPubs, spaceXKey.privateKeyPkcs8);

    await this.qu.put(actorPath(actorPub, 'attestation'), {
      iv: QuCrypto.toBase64Url(encrypted.iv),
      ct: QuCrypto.toBase64Url(encrypted.ct),
      to: encrypted.to.map((entry) => ({
        pub: QuCrypto.toBase64Url(entry.pub),
        key: QuCrypto.toBase64Url(entry.key),
      })),
    });
  }

  /**
   * Attempts to resolve the main identity behind a space's actor key, using
   * THIS engine's own main identity as the (would-be) trusted recipient.
   * Returns null if this identity was never granted access to the attestation.
   *
   * @param {string} actorPub - base64url Ed25519 public key of the space identity to resolve.
   * @returns {Promise<string|null>} The main identity's base64url public key, or null.
   */
  async resolveMainUser(actorPub) {
    if (this._attestationCache.has(actorPub)) return this._attestationCache.get(actorPub);

    const stored = await this.qu.get(actorPath(actorPub, 'attestation'));
    const record = stored?.val ?? stored;
    if (!record) return this.#cacheAndReturn(actorPub, null);

    const senderProfile = await this.getProfile(actorPub);
    if (!senderProfile?.xPublicKey) return this.#cacheAndReturn(actorPub, null);
    const senderXPub = QuCrypto.fromBase64Url(senderProfile.xPublicKey);

    const myXKey = await this.getMainXKey();
    const myXPub = QuCrypto.toBase64Url(myXKey.publicKey);
    const recipientEntry = record.to.find((entry) => entry.pub === myXPub);
    if (!recipientEntry) return this.#cacheAndReturn(actorPub, null);

    let signedData;
    try {
      const decrypted = await QuCrypto.decrypt(
        QuCrypto.fromBase64Url(record.iv),
        QuCrypto.fromBase64Url(record.ct),
        QuCrypto.fromBase64Url(recipientEntry.key),
        senderXPub,
        myXKey.privateKeyPkcs8
      );
      signedData = JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
      return this.#cacheAndReturn(actorPub, null);
    }

    const { payload, signature } = signedData;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const isValid = await QuCrypto.verify(
      payloadBytes,
      QuCrypto.fromBase64Url(signature),
      QuCrypto.fromBase64Url(payload.main_pubkey)
    );
    return this.#cacheAndReturn(actorPub, isValid ? payload.main_pubkey : null);
  }

  #cacheAndReturn(actorPub, value) {
    this._attestationCache.set(actorPub, value);
    capCache(this._attestationCache);
    return value;
  }
}
