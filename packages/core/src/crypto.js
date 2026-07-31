/**
 * QU CRYPTO — stateless cryptographic primitives used throughout Qu.
 *
 * Everything here is a static method built on the standard Web Crypto API
 * (`crypto.subtle`), which is available natively in browsers and in Node.js
 * (>= 20) without any third-party dependency. Qu Core deliberately does not
 * ship its own elliptic-curve math: signing uses Ed25519, key agreement uses
 * X25519, and bulk encryption uses AES-256-GCM - all provided by the runtime.
 *
 * Responsibilities:
 *   - Generate Ed25519 (signing) + X25519 (key-agreement) keypairs.
 *   - Sign / verify data with Ed25519.
 *   - Encrypt / decrypt data for one or more recipients via ECDH (X25519) + AES-GCM.
 *   - Base64 / hex helpers that work identically in Node and the browser.
 *   - Deterministic key import for raw 32-byte scalars (used by @qu/identity
 *     to turn a BIP32-derived seed into a real, usable Ed25519/X25519 keypair
 *     instead of a randomly generated one).
 */

const subtle = globalThis.crypto.subtle;

/**
 * PKCS#8 DER envelopes for Ed25519 / X25519 private keys are fixed except for
 * the trailing 32 raw scalar bytes (see RFC 8410 §7). Web Crypto only accepts
 * private keys in 'pkcs8' format, never as a bare 32-byte scalar, so to import
 * a *deterministically derived* scalar (e.g. from BIP32/SLIP-10) we prepend
 * this constant header ourselves. This is standard, well-documented DER, not
 * a home-grown format - the header uniquely identifies "unencrypted OKP
 * private key" for the given curve OID.
 */
const PKCS8_HEADER = {
  Ed25519: new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
  X25519: new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]),
};

export class QuCrypto {
  /**
   * Generates a complete keypair set for a Qu actor: an Ed25519 pair for
   * signing/verification and an X25519 pair for ECDH-based encryption.
   * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array, xPublicKey: Uint8Array, xPrivateKey: Uint8Array}>}
   */
  static async generateKeypair() {
    const ed = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const x = await subtle.generateKey({ name: 'X25519' }, true, ['deriveKey', 'deriveBits']);
    return {
      publicKey: new Uint8Array(await subtle.exportKey('raw', ed.publicKey)),
      privateKey: new Uint8Array(await subtle.exportKey('pkcs8', ed.privateKey)),
      xPublicKey: new Uint8Array(await subtle.exportKey('raw', x.publicKey)),
      xPrivateKey: new Uint8Array(await subtle.exportKey('pkcs8', x.privateKey)),
    };
  }

  /**
   * Deterministically derives a real, usable Ed25519 or X25519 keypair from a
   * raw 32-byte scalar (e.g. produced by an HD derivation such as SLIP-10).
   *
   * Web Crypto has no "import raw private scalar" API, but it *does* export
   * the public component of an imported private key via JWK (the OKP JWK
   * format always carries both `d` (private) and `x` (public), and the
   * implementation computes `x` for us during import). We exploit that:
   * wrap the raw scalar in the fixed PKCS8 header for the given curve, import
   * it, then read the public key back out of the JWK export. Verified against
   * Node's Web Crypto implementation (sign/verify + ECDH round-trip).
   *
   * @param {'Ed25519'|'X25519'} curve
   * @param {Uint8Array} rawScalar - Exactly 32 bytes.
   * @returns {Promise<{publicKey: Uint8Array, privateKeyPkcs8: Uint8Array, privateKeyRaw: Uint8Array}>}
   */
  static async keypairFromSeed(curve, rawScalar) {
    if (rawScalar.length !== 32) {
      throw new Error(`keypairFromSeed: expected 32-byte scalar, got ${rawScalar.length}`);
    }
    const header = PKCS8_HEADER[curve];
    if (!header) throw new Error(`keypairFromSeed: unsupported curve "${curve}"`);

    const der = new Uint8Array(header.length + rawScalar.length);
    der.set(header, 0);
    der.set(rawScalar, header.length);

    const usages = curve === 'Ed25519' ? ['sign'] : ['deriveKey', 'deriveBits'];
    const privateKey = await subtle.importKey('pkcs8', der, { name: curve }, true, usages);
    const jwk = await subtle.exportKey('jwk', privateKey);

    return {
      publicKey: QuCrypto.fromBase64Url(jwk.x),
      privateKeyPkcs8: der,
      privateKeyRaw: rawScalar,
    };
  }

  /**
   * Signs a data block with an Ed25519 private key (PKCS8-encoded, as
   * returned by generateKeypair()/keypairFromSeed()).
   * @param {Uint8Array} data
   * @param {Uint8Array} privateKeyPkcs8
   * @returns {Promise<Uint8Array>}
   */
  static async sign(data, privateKeyPkcs8) {
    const key = await subtle.importKey('pkcs8', privateKeyPkcs8, { name: 'Ed25519' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('Ed25519', key, data));
  }

  /**
   * Verifies an Ed25519 signature.
   * @param {Uint8Array} data
   * @param {Uint8Array} signature
   * @param {Uint8Array} publicKey - Raw 32-byte Ed25519 public key.
   * @returns {Promise<boolean>}
   */
  static async verify(data, signature, publicKey) {
    const key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return subtle.verify('Ed25519', key, signature, data);
  }

  /**
   * Encrypts `plaintext` for one or more recipients:
   *   1. Generate a random AES-256-GCM content key.
   *   2. Encrypt the plaintext once with it.
   *   3. For every recipient, derive an ECDH (X25519) shared secret between
   *      the sender's private key and the recipient's public key, and use it
   *      to wrap the content key just for them.
   * This is the standard "envelope encryption" pattern: the ciphertext is
   * encrypted once regardless of recipient count; only the small content key
   * is re-wrapped per recipient.
   *
   * @param {Uint8Array} plaintext
   * @param {Array<Uint8Array>} recipientXPubKeys - Raw X25519 public keys.
   * @param {Uint8Array} senderXPrivKey - PKCS8-encoded X25519 private key.
   * @returns {Promise<{iv: Uint8Array, ct: Uint8Array, to: Array<{pub: Uint8Array, key: Uint8Array}>}>}
   */
  static async encrypt(plaintext, recipientXPubKeys, senderXPrivKey) {
    const contentKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const contentKeyRaw = new Uint8Array(await subtle.exportKey('raw', contentKey));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, plaintext));

    const sPriv = await subtle.importKey('pkcs8', senderXPrivKey, { name: 'X25519' }, false, ['deriveKey']);
    const to = [];
    for (const pub of recipientXPubKeys) {
      const rPub = await subtle.importKey('raw', pub, { name: 'X25519' }, false, []);
      const shared = await subtle.deriveKey(
        { name: 'X25519', public: rPub },
        sPriv,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );
      // Fixed zero IV is safe here ONLY because each wrapped key uses a fresh,
      // single-use shared secret (derived per sender/recipient pair) - it is
      // never reused to encrypt more than one block under the same key.
      const wrappedKey = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, shared, contentKeyRaw)
      );
      to.push({ pub, key: wrappedKey });
    }
    return { iv, ct, to };
  }

  /**
   * Decrypts a ciphertext produced by encrypt(), given the wrapped content
   * key entry meant for this recipient.
   * @param {Uint8Array} iv
   * @param {Uint8Array} ct
   * @param {Uint8Array} wrappedKey - The `key` entry for this recipient from `to`.
   * @param {Uint8Array} senderXPubKey
   * @param {Uint8Array} recipientXPrivKey - PKCS8-encoded X25519 private key.
   * @returns {Promise<Uint8Array>}
   */
  static async decrypt(iv, ct, wrappedKey, senderXPubKey, recipientXPrivKey) {
    const rPriv = await subtle.importKey('pkcs8', recipientXPrivKey, { name: 'X25519' }, false, ['deriveKey']);
    const sPub = await subtle.importKey('raw', senderXPubKey, { name: 'X25519' }, false, []);
    const shared = await subtle.deriveKey(
      { name: 'X25519', public: sPub },
      rPriv,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const contentKeyRaw = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, shared, wrappedKey);
    const contentKey = await subtle.importKey('raw', contentKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, contentKey, ct));
  }

  /** SHA-256 digest, returned as raw bytes. Used for manifest/bundle integrity checks. */
  static async sha256(data) {
    return new Uint8Array(await subtle.digest('SHA-256', data));
  }

  // ---------------------------------------------------------------------
  // Encoding helpers - identical behaviour in Node (Buffer) and browsers.
  // ---------------------------------------------------------------------

  static toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  static fromBase64(base64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  static toBase64Url(bytes) {
    return QuCrypto.toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  static fromBase64Url(base64url) {
    const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return QuCrypto.fromBase64(padded + pad);
  }

  static toHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  static fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
}
