/**
 * RFC 8291 (Message Encryption for Web Push) + RFC 8188 (the generic
 * "aes128gcm" content-coding it's built on) — encrypts a push payload so
 * only the subscribing BROWSER can read it, never the push service in
 * between (Google's FCM, Mozilla's push service, ...) or this relay once
 * it's sent. `encryptPayload()` is what @qu/relay's push delivery actually
 * calls; `decryptPayload()` exists only so this module can round-trip-test
 * itself (see the "self-consistency" note in this package's README/doc) -
 * it is never used by a browser (browsers decrypt with their OWN private
 * key, which nothing server-side ever has).
 *
 * HKDF here is always single-block (RFC 8291 never needs more than 32
 * output bytes from any one derivation), so `hkdfExpand()` below is
 * intentionally NOT a general-purpose HKDF-Expand - just the one-iteration
 * case the spec actually uses.
 */
import { createECDH, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fromBase64Url } from './base64url.js';

const CURVE = 'prime256v1';
const TAG_LENGTH = 16;
const PADDING_DELIMITER = 0x02;

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** @param {Buffer} prk @param {Buffer} info @param {number} length @returns {Buffer} */
function hkdfExpand(prk, info, length) {
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);
}

/**
 * Derives the shared CEK/nonce both this function and a receiving browser
 * arrive at independently - the browser from its own (ua) private key and
 * OUR public key; us from our (as) private key and the browser's public
 * key - textbook ECDH, salted and separated per RFC 8291 §3.3-3.4.
 */
function deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  return { cek, nonce };
}

/**
 * @param {Uint8Array|Buffer} plaintext
 * @param {{p256dh: string, auth: string}} clientKeys - base64url, straight
 *   from the browser's `PushSubscription.toJSON().keys`.
 * @returns {Buffer} The complete `aes128gcm` content-coded body - POST
 *   this as-is (with `Content-Encoding: aes128gcm`) to the push endpoint.
 */
export function encryptPayload(plaintext, clientKeys) {
  const uaPublic = fromBase64Url(clientKeys.p256dh);
  const authSecret = fromBase64Url(clientKeys.auth);

  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const salt = randomBytes(16);
  const { cek, nonce } = deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt });

  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([PADDING_DELIMITER])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(padded.length, 0); // rs = plaintext-fed-to-AEAD length, NOT including the 16-byte tag (RFC 8188 §2.1)

  const header = Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext]);
}

/**
 * The inverse of `encryptPayload()`, given the RECEIVER's private key
 * material - only useful for testing this module against itself (a real
 * browser is the only party that ever has `uaPrivate`/`authSecret` for a
 * genuine subscription). Throws if the AEAD tag doesn't verify.
 * @param {Buffer} body - As produced by `encryptPayload()`.
 * @param {{uaPrivateJwk: object, authSecret: Buffer}} receiverKeys
 * @returns {Buffer} The original plaintext.
 */
export function decryptPayload(body, { uaPrivateD, authSecret }) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(uaPrivateD);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);

  const { cek, nonce } = deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt });

  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const encrypted = ciphertext.subarray(0, ciphertext.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  // Strip the single 0x02 padding delimiter (and any zero padding after it, unused here since encryptPayload() never adds any).
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  return padded.subarray(0, end - 1);
}
