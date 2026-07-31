/**
 * SLIP-10 (Ed25519) — hierarchical deterministic key derivation from a
 * BIP-39 seed.
 *
 * This replaces the original prototype's derivation, which had two bugs
 * worth naming explicitly because they're easy to reintroduce by accident:
 *
 *   1. It used a `deriveKeyFromPath` path convention with NON-hardened
 *      segments (e.g. ".../0/0"). SLIP-10 only defines hardened derivation
 *      for Ed25519 - there is no Ed25519 equivalent of "derive a child
 *      PUBLIC key from a parent public key" (unlike secp256k1), so
 *      non-hardened Ed25519 derivation isn't a real, standardized
 *      operation. Every path segment here MUST be hardened (trailing `'`);
 *      `deriveKeyFromPath` throws if it isn't, instead of silently
 *      producing a key nothing else could reproduce or verify.
 *   2. It returned a *random* `publicKey` instead of the one that actually
 *      corresponds to the derived private key. This module only returns the
 *      raw private scalar + chain code - turning that into a real,
 *      usable keypair (with the correct public key) is QuCrypto.keypairFromSeed(),
 *      which every caller in this package uses.
 *
 * Reference: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 */

const subtle = globalThis.crypto.subtle;
const ED25519_SEED_KEY = new TextEncoder().encode('ed25519 seed');
const HARDENED_OFFSET = 0x80000000;

async function hmacSha512(keyBytes, dataBytes) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, dataBytes));
}

/**
 * @typedef {Object} Slip10Node
 * @property {Uint8Array} privateKey - 32-byte raw Ed25519 scalar (a seed for QuCrypto.keypairFromSeed).
 * @property {Uint8Array} chainCode - 32 bytes, used to derive further children.
 */

/**
 * Derives the SLIP-10 master node from a BIP-39 seed.
 * @param {Uint8Array} seed - 64-byte BIP-39 seed.
 * @returns {Promise<Slip10Node>}
 */
export async function deriveMasterNode(seed) {
  const I = await hmacSha512(ED25519_SEED_KEY, seed);
  return { privateKey: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

/**
 * Derives one hardened child node.
 * @param {Slip10Node} parent
 * @param {number} index - Unhardened index, 0 <= index < 2^31 (the hardened
 *   offset is applied internally).
 * @returns {Promise<Slip10Node>}
 */
export async function deriveChildNode(parent, index) {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new Error(`deriveChildNode: index must be an integer in [0, 2^31), got ${index}`);
  }
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parent.privateKey, 1);
  new DataView(data.buffer).setUint32(33, index + HARDENED_OFFSET, false);
  const I = await hmacSha512(parent.chainCode, data);
  return { privateKey: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

/**
 * Derives a node at an arbitrary hardened path, e.g. "m/44'/123'/0'/0'/0'".
 * @param {Uint8Array} seed
 * @param {string} path
 * @returns {Promise<Slip10Node>}
 */
export async function deriveNodeFromPath(seed, path) {
  const segments = path.replace(/^m\//, '').split('/').filter(Boolean);
  let node = await deriveMasterNode(seed);
  for (const segment of segments) {
    if (!segment.endsWith("'")) {
      throw new Error(
        `deriveNodeFromPath: segment "${segment}" in "${path}" is not hardened. ` +
          `SLIP-10 Ed25519 only supports hardened derivation - every segment must end with '.`
      );
    }
    const index = Number.parseInt(segment.slice(0, -1), 10);
    if (Number.isNaN(index)) {
      throw new Error(`deriveNodeFromPath: segment "${segment}" is not a valid integer index`);
    }
    node = await deriveChildNode(node, index);
  }
  return node;
}
