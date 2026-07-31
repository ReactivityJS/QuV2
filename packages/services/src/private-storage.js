/**
 * PRIVATE STORAGE — read/write a value only the owning identity can decrypt.
 *
 * QuStore's `put()` can encrypt for a recipient (`options.encryptWith`), but
 * there's no matching "decrypt on read" - `get()` just hands back whatever
 * the adapter stored, encrypted or not (by design: QuStore stays dumb, see
 * @qu/core/store.js). Several Services need "store this so only I can read
 * it back" (StarredService's favorites/contacts list today, more later) -
 * this module is the one place that pattern is implemented, rather than
 * each Service re-deriving its own encrypt/decrypt dance.
 *
 * The identity SELF-encrypts: sender and recipient are the same X25519
 * keypair. That's not a workaround, it's exactly what "only I can read
 * this" means cryptographically - QuCrypto.encrypt()'s envelope-encryption
 * scheme (see @qu/core/crypto.js) supports any recipient list, and a
 * single-element list containing your own key is a completely ordinary use
 * of it.
 */
import { QuCrypto } from '@qu/core';

function isEncryptedEnvelope(value) {
  return !!value && typeof value === 'object' && typeof value.iv === 'string' && typeof value.ct === 'string' && Array.isArray(value.to);
}

/**
 * Writes `value` at `path`, signed and self-encrypted with the identity's
 * main keys.
 * @param {import('@qu/core').QuCore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identityEngine
 * @param {string} path
 * @param {*} value - Must be JSON-serialisable.
 * @returns {Promise<object>} The stored QuBit (still encrypted - use getPrivate() to read it back).
 */
export async function putPrivate(qu, identityEngine, path, value) {
  const mainKey = await identityEngine.getMainKey();
  const xKey = await identityEngine.getMainXKey();
  return qu.put(path, value, {
    signWith: mainKey.privateKeyPkcs8,
    writerPub: mainKey.publicKey,
    encryptWith: xKey.publicKey,
    senderXPrivateKey: xKey.privateKeyPkcs8,
  });
}

/**
 * Reads and decrypts a value written by putPrivate(). Returns `null` if
 * nothing is stored, or if the stored value isn't decryptable by this
 * identity (wrong owner, or genuinely not encrypted for us).
 * @param {import('@qu/core').QuCore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identityEngine
 * @param {string} path
 * @returns {Promise<*|null>}
 */
export async function getPrivate(qu, identityEngine, path) {
  const quBit = await qu.get(path);
  if (!quBit) return null;
  if (!isEncryptedEnvelope(quBit.val)) return quBit.val; // tolerate plaintext, e.g. during local dev without keys

  const xKey = await identityEngine.getMainXKey();
  const myXPubB64 = QuCrypto.toBase64(xKey.publicKey);
  const entry = quBit.val.to.find((e) => e.pub === myXPubB64);
  if (!entry) return null;

  const plaintext = await QuCrypto.decrypt(
    QuCrypto.fromBase64(quBit.val.iv),
    QuCrypto.fromBase64(quBit.val.ct),
    QuCrypto.fromBase64(entry.key),
    xKey.publicKey,
    xKey.privateKeyPkcs8
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
