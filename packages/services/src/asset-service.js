import { assetPath } from './paths.js';
import { resolveReaderXKeys, decryptEnvelope } from './crypto-envelope.js';

/**
 * Reads just `{name, mime, size}` off a file input WITHOUT materializing its
 * bytes (unlike @qu/engines' AssetEngine's own `normalizeFileInput()`,
 * which needs the full byte array and is a private implementation detail
 * of chunking). `upload()` needs this because `qu.put()`'s return value is
 * the SEALED QuBit - for an encrypted upload, `.val` is the ciphertext
 * envelope `{iv, ct, to}`, not the meta object, so unwrapping it directly
 * would hand the caller `{name: undefined, mime: undefined, size: undefined}`
 * instead of the metadata they asked for.
 * @param {Blob|Uint8Array|ArrayBuffer|{name: string, mime: string, data: *, size?: number}} input
 * @returns {{name: string, mime: string, size: number}}
 */
function describeFile(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return { name: input.name ?? 'unnamed', mime: input.type || 'application/octet-stream', size: input.size };
  }
  if (input instanceof Uint8Array) return { name: 'unnamed', mime: 'application/octet-stream', size: input.length };
  if (input instanceof ArrayBuffer) return { name: 'unnamed', mime: 'application/octet-stream', size: input.byteLength };
  if (input && typeof input === 'object' && input.name && input.mime) {
    const data = input.data;
    const size = input.size ?? data?.length ?? data?.byteLength ?? data?.size ?? 0;
    return { name: input.name, mime: input.mime, size };
  }
  throw new Error('AssetService: unrecognised file input - expected Blob, Uint8Array, ArrayBuffer or {name, mime, data}');
}

/**
 * ASSET SERVICE — the Entity API for binary files.
 *
 * Chunking/reassembly is AssetEngine's job (see @qu/engines); this class
 * just gives it the same friendly, path-hiding front door as the other
 * Services - AND the same `readers`-list encryption ThreadService gives
 * message text (see `crypto-envelope.js`, shared by both). Before this,
 * an attachment was the one part of an otherwise end-to-end-encrypted
 * Chat/Forum/Inbox thread a relay operator (or anyone syncing the space)
 * could still read in the clear - `upload({ readerPubs })` closes that
 * gap the same way `ThreadService.postMessage()` already closes it for
 * the message body sitting right next to the attachment.
 */
export class AssetService {
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/engines').AssetEngine} assetEngine
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   forwarded to `assetEngine.getAsset()` to backfill a meta document or
   *   chunk this session hasn't synced yet - see @qu/engines' AssetEngine
   *   doc comment on `getAsset()` for why this is needed even when the
   *   `/blob/<space>` prefix is already subscribed. Also used to backfill
   *   a reader's/sender's profile when resolving their X25519 key.
   */
  constructor(qu, assetEngine, identityEngine, syncFetch = null) {
    this.qu = qu;
    this.assetEngine = assetEngine;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
  }

  /**
   * @param {string} actorPub
   * @returns {Promise<object|null>} Same as `identity.getProfile()`, but
   *   backfills via `syncFetch` (if provided) on a local miss - see
   *   ThreadService's identical helper for why.
   */
  async #getProfile(actorPub) {
    const local = await this.identity.getProfile(actorPub);
    if (local || !this.syncFetch) return local;
    try {
      await this.syncFetch(`/store/actors/~${actorPub}/profile`);
    } catch {
      return null;
    }
    return this.identity.getProfile(actorPub);
  }

  /**
   * @param {string|number} spaceId
   * @param {string} assetId
   * @param {Blob|Uint8Array|ArrayBuffer|{name: string, mime: string, data: *}} file
   * @param {{readerPubs?: string[], asSpaceId?: string|number}} [options]
   *   `readerPubs` - base64url actor pubkeys to encrypt for (same shape as
   *   a thread's `config.readers`); omitted/empty means unencrypted,
   *   readable by anyone syncing the space - the caller (e.g. Chat) decides
   *   this per-upload from the thread it's attaching to, same as
   *   `postMessage()` decides per-message from `config.readers`.
   * @returns {Promise<{name: string, mime: string, size: number}>} The stored metadata.
   */
  async upload(spaceId, assetId, file, { readerPubs = null, asSpaceId = null } = {}) {
    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };

    if (readerPubs && readerPubs.length > 0) {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await resolveReaderXKeys(readerPubs, (pub) => this.#getProfile(pub));
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }

    const description = describeFile(file);
    await this.qu.put(assetPath(spaceId, assetId), file, putOptions);
    return description;
  }

  /**
   * @param {string|number} spaceId
   * @param {string} assetId
   * @returns {Promise<{meta: object, data: Uint8Array}|null>} `null` if the
   *   asset can't be found (even after backfill), or - for an encrypted
   *   one - if this identity isn't among its readers.
   */
  async download(spaceId, assetId) {
    const decrypt = (quBit) => decryptEnvelope(quBit, this.identity, (pub) => this.#getProfile(pub));
    return this.assetEngine.getAsset(assetPath(spaceId, assetId), this.syncFetch, decrypt);
  }
}
