import { encryptPayload } from './encrypt.js';
import { signVapidJwt } from './vapid.js';

/**
 * Sends one Web Push message. Deliberately takes a PLAIN OBJECT payload
 * (JSON-serialised here) rather than raw bytes - see @qu/relay's push
 * delivery for what actually goes in it (always a generic
 * title/body/appId template, NEVER decrypted message content - the push
 * service in between is untrusted, encryption here protects it from HTTP
 * eavesdroppers, not from "should this specific relay operator's chosen
 * push provider be allowed to know what the message says").
 *
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
 *   A browser's `PushSubscription.toJSON()`.
 * @param {object} payload - JSON-serialisable.
 * @param {{publicKey: string, privateKey: string, subject: string}} vapid
 * @param {{ttlSeconds?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, expired: boolean}>}
 *   `expired: true` on a 404/410 - the push service is telling us this
 *   subscription is dead and should be removed, not retried.
 */
export async function sendWebPush(subscription, payload, vapid, { ttlSeconds = 4 * 3600 } = {}) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = signVapidJwt({ audience, subject: vapid.subject }, vapid.privateKey);
  const body = encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), subscription.keys);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      ttl: String(ttlSeconds),
      authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });

  return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
}
