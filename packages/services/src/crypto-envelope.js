/**
 * CRYPTO ENVELOPE HELPERS — the "encrypt for a reader list" / "decrypt for
 * myself" logic every Service that writes reader-restricted data needs.
 * Originally private to ThreadService (message bodies); factored out here
 * once AssetService needed the exact same thing for attachment bytes
 * (chat/forum/inbox attachments are otherwise the one part of an
 * end-to-end-encrypted thread a relay operator could still read - see
 * AssetService's own doc comment). Both callers supply their own
 * `getProfile` (each already has its own syncFetch-backfilled resolver),
 * so this stays storage-agnostic.
 */
import { QuCrypto, isEncryptedEnvelope } from '@qu/core';

export { isEncryptedEnvelope };

/**
 * @param {string[]} readerPubs - base64url Ed25519 actor pubkeys.
 * @param {(actorPub: string) => Promise<object|null>} getProfile
 * @returns {Promise<Array<Uint8Array>>} Their raw X25519 public keys.
 * @throws {Error} If any reader has no published profile/X key - fails
 *   closed rather than encrypting for a partial recipient list.
 */
export async function resolveReaderXKeys(readerPubs, getProfile) {
  const keys = [];
  for (const pub of readerPubs) {
    const profile = await getProfile(pub);
    if (!profile?.xPublicKey) {
      throw new Error(`resolveReaderXKeys: reader "${pub}" has no published profile - cannot encrypt for them`);
    }
    keys.push(QuCrypto.fromBase64Url(profile.xPublicKey));
  }
  return keys;
}

/**
 * Decrypts a QuStore-encrypted QuBit's `val` for the CURRENT identity.
 * @param {{val: object, pub: string|null}} quBit - `val` already confirmed via `isEncryptedEnvelope()`.
 * @param {import('@qu/identity').QuIdentityEngine} identity
 * @param {(actorPub: string) => Promise<object|null>} getProfile - Resolves the SENDER's profile (for their X key).
 * @returns {Promise<*>} The decrypted, JSON-parsed value, or null if undecryptable
 *   (not a listed reader, or the sender's profile/key is unresolvable).
 */
export async function decryptEnvelope(quBit, identity, getProfile) {
  const val = quBit.val;
  if (!quBit.pub) return null; // no signer identity to resolve the sender's X key from

  const myXKey = await identity.getMainXKey();
  const myXPubB64 = QuCrypto.toBase64(myXKey.publicKey);
  const entry = val.to.find((e) => e.pub === myXPubB64);
  if (!entry) return null;

  const senderActorPub = QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub));
  const senderProfile = await getProfile(senderActorPub);
  if (!senderProfile?.xPublicKey) return null;

  try {
    const plaintext = await QuCrypto.decrypt(
      QuCrypto.fromBase64(val.iv),
      QuCrypto.fromBase64(val.ct),
      QuCrypto.fromBase64(entry.key),
      QuCrypto.fromBase64Url(senderProfile.xPublicKey),
      myXKey.privateKeyPkcs8
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}
