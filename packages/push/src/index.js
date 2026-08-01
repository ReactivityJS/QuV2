/**
 * @QU/PUSH — public entry point. See vapid.js/encrypt.js/send.js for the
 * three pieces (auth, payload encryption, transport) and this package's
 * own package.json description for why they're hand-rolled rather than a
 * dependency.
 *
 * HONESTY NOTE, stated as plainly as this codebase states every other
 * known limitation: `encryptPayload()`/`signVapidJwt()` are implemented
 * strictly from the RFC 8291/8188/8292 text and round-trip-tested against
 * THIS package's own `decryptPayload()` (see scripts/smoke-test.mjs) - that
 * proves the ECDH/HKDF/AES-GCM chain is internally self-consistent, but it
 * has NOT been verified end-to-end against a real push service (FCM,
 * Mozilla's push service, ...) with a genuine browser subscription in this
 * environment (no outbound network path to one here). Before relying on
 * this in production, do one real subscribe-and-push test from an actual
 * deployment.
 */
export { generateVapidKeys, signVapidJwt } from './vapid.js';
export { encryptPayload, decryptPayload } from './encrypt.js';
export { sendWebPush } from './send.js';
export { toBase64Url, fromBase64Url } from './base64url.js';
