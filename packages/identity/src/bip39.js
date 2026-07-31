/**
 * BIP-39 — mnemonic <-> entropy <-> seed conversion.
 *
 * This is a thin, documented wrapper around `@scure/bip39` rather than a
 * hand-rolled implementation. That is a deliberate correctness decision: the
 * original prototype shipped its own BIP-39 with a *truncated* word list
 * (only a couple dozen of the required 2048 words, silently returning
 * `undefined` for almost every generated mnemonic) and skipped the checksum
 * step entirely. Getting a word list and checksum bit-packing exactly right
 * is exactly the kind of "easy to get subtly wrong, hard to notice" code
 * that belongs in an audited, widely-used library instead of being
 * reimplemented per project. `@scure/bip39` (by the same author as
 * `@noble/curves`/`@noble/hashes`, zero surprise dependencies, small and
 * audited) is the standard choice here - Qu Core itself stays
 * dependency-free; this dependency is scoped to @qu/identity only.
 */
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * Generates a new random BIP-39 mnemonic.
 * @param {128|160|192|224|256} [strengthBits=256] - Entropy size. 256 bits -> 24 words.
 * @returns {string} Space-separated mnemonic phrase.
 */
export function generateMnemonicPhrase(strengthBits = 256) {
  return generateMnemonic(wordlist, strengthBits);
}

/**
 * @param {string} mnemonic
 * @returns {boolean} Whether the mnemonic's word list membership and checksum are valid.
 */
export function isValidMnemonic(mnemonic) {
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Derives the 64-byte BIP-39 seed from a mnemonic (PBKDF2-HMAC-SHA512, 2048 rounds).
 * @param {string} mnemonic
 * @param {string} [passphrase='']
 * @returns {Promise<Uint8Array>}
 */
export async function mnemonicToSeedBytes(mnemonic, passphrase = '') {
  return mnemonicToSeed(mnemonic, passphrase);
}
