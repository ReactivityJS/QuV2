/**
 * QUBIT — the single fundamental data unit in Qu.
 *
 * This file intentionally contains almost no code. That is the point: a QuBit
 * is *just* a plain, JSON-serialisable object with exactly five fields. Every
 * higher-level concept in QuV2 (documents, threads, collections, actors,
 * files, ...) is built *on top of* QuBits — nothing else is allowed to leak
 * into this shape, because QuStore, QuSync and every storage adapter only
 * ever have to understand this one structure.
 *
 * Shape:
 *   {
 *     path: string,            // the absolute Qu path this value lives at
 *     val:  any,                // the payload (plaintext or an encrypted envelope)
 *     ts:   number,              // milliseconds since epoch, set at write time
 *     pub:  string|null,        // base64 Ed25519 public key of the writer, if signed
 *     sig:  string|null,        // base64 Ed25519 signature over {path, val, ts, pub}
 *   }
 *
 * A QuBit answers exactly four questions and nothing more:
 *   - Key       -> path
 *   - Value     -> val
 *   - Timestamp -> ts
 *   - Signature -> sig (+ pub, to verify it)
 *
 * Anything that looks like "kind of document" or "kind of thread" is a
 * *convention* enforced by an Engine (see @qu/engines), never a property
 * QuStore itself inspects or branches on.
 */

/**
 * @typedef {Object} QuBit
 * @property {string} path - Absolute Qu path, e.g. "/store/actors/~abc123/profile".
 * @property {*} val - The stored value. May be plaintext or an encrypted envelope
 *   of the shape `{ iv, ct, to }` produced by QuCrypto.encrypt().
 * @property {number} ts - Write timestamp (Date.now() at write time).
 * @property {string|null} pub - Base64-encoded Ed25519 public key of the writer.
 * @property {string|null} sig - Base64-encoded Ed25519 signature over the sealed payload.
 */

/**
 * The complete, closed set of fields a QuBit is allowed to have. Used by
 * tooling (loader integrity checks, tests) to assert nothing has smuggled
 * extra top-level fields into a stored value.
 * @type {ReadonlyArray<string>}
 */
export const QUBIT_FIELDS = Object.freeze(['path', 'val', 'ts', 'pub', 'sig']);

/**
 * Structural check: does `value` look like a QuBit?
 * This is a shape check only - it does NOT verify the signature. Use
 * QuCrypto.verify() (or QuStore's built-in verification, once a public key
 * is known) for that.
 *
 * @param {*} value
 * @returns {value is QuBit}
 */
export function isQuBit(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.path === 'string' &&
    'val' in value &&
    typeof value.ts === 'number'
  );
}

/**
 * Creates a fresh, unsigned QuBit envelope for a value about to be written.
 * The actual signing/encryption happens later in QuStore's seal step - this
 * helper only establishes the canonical shape so every call site builds the
 * same object.
 *
 * @param {string} path
 * @param {*} val
 * @returns {QuBit}
 */
export function createQuBit(path, val) {
  return { path, val, ts: Date.now(), pub: null, sig: null };
}
