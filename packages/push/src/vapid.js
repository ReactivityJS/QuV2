/**
 * VAPID (RFC 8292) — proves to a push service which application server is
 * sending a message, via a short-lived, self-signed JWT + the same P-256
 * keypair's public half (`applicationServerKey`) the browser used when
 * subscribing. No dependency on a JOSE/JWT library: the token shape here
 * is fixed (one specific header, one specific claim set, ES256 only), so
 * hand-writing it is a handful of lines, not a general-purpose parser.
 */
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { toBase64Url, fromBase64Url } from './base64url.js';

/**
 * @returns {{publicKey: string, privateKey: string}} `publicKey` is the
 *   base64url-encoded 65-byte uncompressed EC point - this is what a
 *   browser's `PushManager.subscribe({applicationServerKey: ...})` needs,
 *   and what `/push/vapid-public-key` serves (see @qu/relay). `privateKey`
 *   is an OPAQUE base64url-encoded JWK blob - never parsed by anything
 *   except `signVapidJwt()` in this same file; treat it as a secret string,
 *   e.g. `QU_VAPID_PRIVATE_KEY`.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const rawPublic = Buffer.concat([Buffer.from([0x04]), fromBase64Url(pubJwk.x), fromBase64Url(pubJwk.y)]);
  return {
    publicKey: toBase64Url(rawPublic),
    privateKey: toBase64Url(Buffer.from(JSON.stringify(privJwk))),
  };
}

/**
 * @param {{audience: string, subject: string}} claims - `audience` is the
 *   push endpoint's origin (e.g. "https://fcm.googleapis.com"); `subject`
 *   is a "mailto:" or "https:" URI identifying the sending application,
 *   per RFC 8292 - required by every push service so they have someone to
 *   contact about abuse.
 * @param {string} privateKey - As returned by `generateVapidKeys()`.
 * @returns {string} A signed ES256 JWT, valid for 12 hours.
 */
export function signVapidJwt({ audience, subject }, privateKey) {
  const jwk = JSON.parse(fromBase64Url(privateKey).toString('utf8'));
  const keyObject = createPrivateKey({ key: jwk, format: 'jwk' });

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;

  // ES256 (JOSE) signatures are raw r||s (64 bytes) - NOT the ASN.1/DER
  // encoding node:crypto produces by default for EC signatures, hence
  // `dsaEncoding: 'ieee-p1363'`.
  const signature = sign('sha256', Buffer.from(signingInput), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${toBase64Url(signature)}`;
}
