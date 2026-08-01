/** Base64url helpers (Node's Buffer already understands the 'base64url' encoding directly). */

/** @param {Buffer|Uint8Array|string} data @returns {string} */
export function toBase64Url(data) {
  return Buffer.from(data).toString('base64url');
}

/** @param {string} str @returns {Buffer} */
export function fromBase64Url(str) {
  return Buffer.from(str, 'base64url');
}
