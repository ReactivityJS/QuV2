/**
 * PATH CONVENTIONS — the fixed SLIP-10 derivation tree used by every Qu identity.
 *
 *   m / 44' / 123' / 0' / purpose' / index'
 *                          |          |
 *                          |          +-- 0' for the main identity, or a
 *                          |              space-derived index for a
 *                          |              pseudonymous ("space") identity.
 *                          +-- 0' = signing (Ed25519), 1' = encryption (X25519)
 *
 * 44'/123' follow the BIP-43/44 convention (44' = "this is a BIP-44-style
 * tree", 123' is Qu's arbitrary coin-type-like namespace so it can never
 * collide with an actual cryptocurrency's derivation tree if a seed is ever
 * reused). Signing and encryption keys are deliberately derived from
 * DIFFERENT indices (purpose 0' vs 1'), not the same 32-byte scalar reused
 * for two curves - reusing one private scalar as both an Ed25519 seed and a
 * raw X25519 scalar mixes two different key-derivation semantics for no
 * benefit, so we just derive two independent keys instead.
 *
 * A "space" is any pseudonymous context (a chat room, a forum, an app) the
 * user wants a distinct identity in. Space IDs are arbitrary strings, but
 * SLIP-10 indices must be 31-bit integers - `spaceIdToIndex` bridges the two
 * with a deterministic SHA-256-based hash, so the same spaceId always
 * derives the same index (and therefore the same keys) without requiring
 * spaceIds to be numeric. (The original prototype's path builder just
 * concatenated spaceId into the path string and `parseInt`'d it back out
 * later - it silently broke for any non-numeric spaceId, which was also
 * documented as the expected type.)
 */

const PURPOSE_SIGNING = 0;
const PURPOSE_ENCRYPTION = 1;
const MAIN_INDEX = 0;

/** @param {number} purpose @param {number} index @returns {string} */
function pathFor(purpose, index) {
  return `m/44'/123'/0'/${purpose}'/${index}'`;
}

/** @returns {string} Path of the main signing (Ed25519) identity. */
export function mainSigningPath() {
  return pathFor(PURPOSE_SIGNING, MAIN_INDEX);
}

/** @returns {string} Path of the main encryption (X25519) identity. */
export function mainEncryptionPath() {
  return pathFor(PURPOSE_ENCRYPTION, MAIN_INDEX);
}

/** @param {string|number} spaceId @returns {Promise<string>} Path of a space's signing identity. */
export async function spaceSigningPath(spaceId) {
  return pathFor(PURPOSE_SIGNING, await spaceIdToIndex(spaceId));
}

/** @param {string|number} spaceId @returns {Promise<string>} Path of a space's encryption identity. */
export async function spaceEncryptionPath(spaceId) {
  return pathFor(PURPOSE_ENCRYPTION, await spaceIdToIndex(spaceId));
}

/**
 * @param {string|number} spaceId
 * @param {number} ephemeralIndex
 * @returns {Promise<string>} Path of a throwaway, per-message identity within a space.
 */
export async function ephemeralSigningPath(spaceId, ephemeralIndex) {
  if (!Number.isInteger(ephemeralIndex) || ephemeralIndex < 0 || ephemeralIndex >= 0x80000000) {
    throw new Error(`ephemeralSigningPath: ephemeralIndex must be in [0, 2^31), got ${ephemeralIndex}`);
  }
  return `${await spaceSigningPath(spaceId)}/${ephemeralIndex}'`;
}

/**
 * Deterministically maps an arbitrary space identifier to a 31-bit SLIP-10
 * index via SHA-256 of its UTF-8 bytes, truncated to 31 bits. Collisions are
 * astronomically unlikely and inconsequential even if they happened (two
 * spaceIds would simply share one derived identity).
 * @param {string|number} spaceId
 * @returns {Promise<number>} An integer in [0, 2^31).
 */
export async function spaceIdToIndex(spaceId) {
  if (typeof spaceId === 'number') {
    if (!Number.isInteger(spaceId) || spaceId < 0 || spaceId >= 0x80000000) {
      throw new Error(`spaceIdToIndex: numeric spaceId must be an integer in [0, 2^31), got ${spaceId}`);
    }
    return spaceId;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(spaceId))));
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return view.getUint32(0, false) & 0x7fffffff; // clear the top bit -> stays < 2^31
}
