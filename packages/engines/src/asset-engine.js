/**
 * ASSET ENGINE — chunked binary blob storage.
 *
 * Registered against the `assets` path segment. A `put()` to a path like
 * `/store/gallery/assets/photo1` is intercepted BEFORE the default
 * seal+persist step (via the `{ handled: true }` outcome, see
 * @qu/core/store.js) and instead:
 *
 *   1. Splits the payload into fixed-size chunks.
 *   2. Writes each chunk as its own small QuBit under a dedicated `blob`
 *      MOUNT (not the `store` mount) - separating "small, signed metadata"
 *      from "large, chunked binary data" so a deployment can point them at
 *      different storage backends (e.g. a fast KV store for `store`, object
 *      storage for `blob`) without either engine caring.
 *   3. Writes a small metadata QuBit (`name`, `mime`, `size`, `blobPath`
 *      pointing at the blob location) under the ORIGINAL path + `/meta`, on
 *      the `store` mount, so normal signing/encryption apply to the
 *      metadata like any other document.
 *
 * NOTE: metadata intentionally uses `blobPath`, NOT `$ref` - `$ref` is
 * CollectionEngine's generic "this whole value is a redirect, replace it
 * with the referenced value" convention (see collection-engine.js). Asset
 * metadata needs to KEEP its own fields (name/mime/size) while ALSO
 * pointing at the blob chunks, which is a different meaning than "this
 * entire record IS something else" - reusing `$ref` here would make
 * CollectionEngine silently swap the metadata for whatever (nothing) lives
 * at the blob mount's bare directory path.
 *
 * Chunks are written CONCURRENTLY (`Promise.all`), not one at a time - the
 * original prototype awaited each chunk sequentially in a loop, which turns
 * upload latency into `chunks * one_round_trip` for no reason once the
 * adapter can handle concurrent writes.
 *
 * Requires a `blob` mount to be registered on the QuCore this Engine is
 * attached to (any adapter with put/get works - MemoryAdapter, FsAdapter, ...).
 *
 * Chunks are stored as base64 STRINGS, not raw `Uint8Array`s. This matters
 * for any adapter that persists via `JSON.stringify` (e.g. FsAdapter):
 * `JSON.stringify(new Uint8Array([1,2,3]))` serialises to the OBJECT
 * `{"0":1,"1":2,"2":3}` (typed arrays aren't `Array.isArray`), which is
 * roughly 7-8x larger on disk than the equivalent bytes and slower to
 * parse back. A base64 string round-trips through JSON as a single short
 * string instead.
 */
import { QuCrypto, isEncryptedEnvelope } from '@qu/core';

export class AssetEngine {
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {{chunkSize?: number}} [options]
   */
  constructor(qu, { chunkSize = 1024 * 1024 } = {}) {
    this.qu = qu;
    this.chunkSize = chunkSize;
    this._unregister = qu.registerEngine({
      segment: 'assets',
      order: 10,
      put: (ctx) => this.#handlePut(ctx),
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }

  async #handlePut(ctx) {
    // `/meta` is a reserved suffix this Engine writes to itself (below). A
    // path ending in it is metadata being sealed, not a new file to chunk -
    // without this guard, writing the meta QuBit would recurse straight
    // back into this handler (its path still contains the `assets`
    // segment that routed here) and fail normalizeFileInput() on a plain
    // metadata object. Returning nothing here lets QuStore fall through to
    // its default seal+persist for the metadata write.
    if (ctx.path.endsWith('/meta')) return;

    // `onProgress` is consumed here, never forwarded to a chunk/meta
    // put() - those go through the normal seal pipeline, which only reads
    // the signing/encryption keys it recognises and would otherwise just
    // ignore this anyway, but stripping it keeps `putOptions` an honest
    // reflection of what actually gets signed/encrypted.
    const { onProgress, ...putOptions } = ctx.options ?? {};

    const file = await normalizeFileInput(ctx.val);
    const blobPath = toBlobPath(ctx.path);

    const chunks = chunkData(file.data, this.chunkSize);
    // Content hash per chunk, over the PLAINTEXT bytes (before any
    // encryption `putOptions` applies below) - stored in meta so
    // getAsset() can verify what it reassembles actually matches what was
    // uploaded (see that method), and reused here for RESUME: retrying an
    // interrupted upload of the same file (same chunkSize -> same
    // boundaries -> same hashes) should only re-send chunks that aren't
    // already there, not start over.
    const chunkHashes = await Promise.all(chunks.map((chunk) => hashChunk(chunk)));
    const isEncrypted = !!putOptions.encryptWith;

    let completedChunks = 0;
    await Promise.all(
      chunks.map(async (chunk, i) => {
        const chunkPath = `${blobPath}/chunk_${i}`;
        // Dedup/resume check only makes sense for UNENCRYPTED chunks: two
        // independent `encryptWith` calls over the same plaintext produce
        // DIFFERENT ciphertext (ephemeral-ECDH per call, see
        // @qu/core/crypto.js's encrypt()), so an already-stored encrypted
        // chunk can never be recognised as "the same content" this way -
        // always re-write in that case, same as before this change.
        if (!isEncrypted) {
          const existing = await this.qu.get(chunkPath);
          if (existing && !isEncryptedEnvelope(existing.val)) {
            const existingHash = await hashChunk(QuCrypto.fromBase64(existing.val));
            if (existingHash === chunkHashes[i]) {
              completedChunks++;
              onProgress?.(completedChunks / chunks.length);
              return; // already present, byte-identical - nothing to resend
            }
          }
        }
        await this.qu.put(chunkPath, QuCrypto.toBase64(chunk), putOptions);
        completedChunks++;
        // A chunk-count proxy for progress, not byte-exact (chunks write
        // concurrently, not necessarily in order) - see AssetService's own
        // doc comment on `onProgress`. Good enough for a UI progress bar on
        // a multi-chunk upload; a 1-chunk file just jumps straight to 1.
        onProgress?.(completedChunks / chunks.length);
      })
    );

    const meta = { name: file.name, mime: file.mime, size: file.size, chunkCount: chunks.length, chunkHashes, blobPath };
    const metaQuBit = await this.qu.put(`${ctx.path}/meta`, meta, putOptions);

    return { handled: true, result: metaQuBit };
  }

  /**
   * Reassembles a stored asset from its chunks.
   *
   * Backfills via `syncFetch` (if given) on a local miss, both for the meta
   * document AND for any individual chunk still missing - the same
   * "subscribe() only covers writes from here on" gap every other
   * Service's syncFetch backfill closes (see DirectoryService.listVisible()
   * for the canonical shape). An asset uploaded by someone else, opened for
   * the first time in a session that only just subscribed to this space,
   * would otherwise resolve to null forever even though `/blob/<space>` IS
   * subscribed - subscribing only delivers writes from the moment of the
   * call onward, not history.
   * `decrypt` (if given) is applied to the meta document AND each chunk
   * independently whenever it looks like an encrypted envelope (see
   * `isEncryptedEnvelope()`) - both are written through the SAME `put()`
   * options an upload was given (see `#handlePut()` forwarding `ctx.options`
   * to every chunk and the meta write alike), so an encrypted upload
   * produces an encrypted meta doc too, not just encrypted chunks. A
   * caller that never uploads anything encrypted (no `decrypt` given, or
   * an unencrypted asset) sees no behavior change.
   *
   * INTEGRITY: each decoded chunk is checked against `meta.chunkHashes[i]`
   * (see `#handlePut()`) when present - a chunk whose content doesn't
   * match what was actually uploaded (transit corruption, or a tampering
   * peer) is treated exactly like a MISSING chunk: one `syncFetch` backfill
   * attempt, then given up on if still bad, rather than silently
   * reassembled into corrupted output. Assets written before this field
   * existed have no `chunkHashes` and are read as before, unverified.
   * @param {string} storePath - The original path passed to `put()`, e.g. `/store/gallery/assets/photo1`.
   * @param {(path: string) => Promise<object|null>} [syncFetch]
   * @param {(quBit: {val: *, pub: string|null}) => Promise<*|null>} [decrypt]
   * @returns {Promise<{meta: object, data: Uint8Array}|null>}
   */
  async getAsset(storePath, syncFetch = null, decrypt = null) {
    let metaQuBit = await this.qu.get(`${storePath}/meta`);
    if (!metaQuBit && syncFetch) {
      await syncFetch(`${storePath}/meta`).catch(() => {});
      metaQuBit = await this.qu.get(`${storePath}/meta`);
    }
    if (!metaQuBit) return null;

    let meta = metaQuBit.val;
    if (decrypt && isEncryptedEnvelope(meta)) {
      meta = await decrypt(metaQuBit);
    }
    if (!meta) return null;

    const fetchChunkBits = () =>
      Promise.all(Array.from({ length: meta.chunkCount }, (_, i) => this.qu.get(`${meta.blobPath}/chunk_${i}`)));

    // Decodes+decrypts+hash-verifies one chunk; `null` means "not usable
    // yet, for any reason" (missing, undecryptable, or hash mismatch) -
    // the caller treats all three identically as something to backfill.
    const decodeChunk = async (chunkBit, index) => {
      if (!chunkBit) return null;
      let v = chunkBit.val;
      if (decrypt && isEncryptedEnvelope(v)) v = await decrypt(chunkBit);
      if (v == null) return null; // couldn't decrypt - not a reader, or sender unresolvable
      const bytes = QuCrypto.fromBase64(v);
      if (meta.chunkHashes?.[index] && (await hashChunk(bytes)) !== meta.chunkHashes[index]) {
        console.warn(`[AssetEngine] chunk ${index} of "${storePath}" failed hash verification - discarding`);
        return null;
      }
      return bytes;
    };

    let chunkBits = await fetchChunkBits();
    let chunkByteArrays = await Promise.all(chunkBits.map((c, i) => decodeChunk(c, i)));

    if (syncFetch && chunkByteArrays.some((b) => !b)) {
      await Promise.all(
        chunkByteArrays.map((b, i) => (b ? null : syncFetch(`${meta.blobPath}/chunk_${i}`).catch(() => {})))
      );
      chunkBits = await fetchChunkBits();
      chunkByteArrays = await Promise.all(chunkBits.map((c, i) => decodeChunk(c, i)));
    }
    if (chunkByteArrays.some((b) => !b)) return null; // still missing/corrupt after backfill - incomplete upload, or unreachable/malicious peer

    const totalLength = chunkByteArrays.reduce((sum, b) => sum + b.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const bytes of chunkByteArrays) {
      data.set(bytes, offset);
      offset += bytes.length;
    }
    return { meta, data };
  }
}

/** @param {Uint8Array} bytes @returns {Promise<string>} Hex SHA-256, used for chunk content-verification/dedup. */
async function hashChunk(bytes) {
  return QuCrypto.toHex(await QuCrypto.sha256(bytes));
}

/**
 * `/store/gallery/assets/photo1` -> `/blob/gallery/photo1`.
 *
 * The `assets` segment is deliberately dropped, not just the mount prefix
 * swapped: chunks are themselves written via `qu.put()` (so they go through
 * signing/encryption like any other value), and QuStore's Engine index
 * routes purely by path SEGMENT (see @qu/core/store.js). If the blob path
 * still contained an `assets` segment, every chunk write would re-trigger
 * this very engine, which would try to chunk the chunk. Stripping the
 * segment means chunk paths never match AssetEngine's registration.
 */
function toBlobPath(storePath) {
  return storePath.replace(/^\/store\//, '/blob/').replace('/assets/', '/');
}

/**
 * Accepts a Blob/File, a raw Uint8Array/ArrayBuffer, or a plain
 * `{name, mime, data}` object and normalises to `{name, mime, data: Uint8Array, size}`.
 */
async function normalizeFileInput(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const data = new Uint8Array(await input.arrayBuffer());
    return { name: input.name ?? 'unnamed', mime: input.type || 'application/octet-stream', data, size: data.length };
  }
  if (input instanceof Uint8Array) {
    return { name: 'unnamed', mime: 'application/octet-stream', data: input, size: input.length };
  }
  if (input instanceof ArrayBuffer) {
    const data = new Uint8Array(input);
    return { name: 'unnamed', mime: 'application/octet-stream', data, size: data.length };
  }
  if (input && typeof input === 'object' && input.name && input.mime && input.data) {
    let data = input.data;
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    else if (typeof Blob !== 'undefined' && data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
    else if (!(data instanceof Uint8Array)) throw new Error('AssetEngine: data must be Uint8Array, ArrayBuffer or Blob');
    return { name: input.name, mime: input.mime, data, size: input.size ?? data.length };
  }
  throw new Error('AssetEngine: unrecognised file input - expected Blob, Uint8Array, ArrayBuffer or {name, mime, data}');
}

function chunkData(data, chunkSize) {
  const chunks = [];
  for (let i = 0; i < data.length; i += chunkSize) chunks.push(data.slice(i, i + chunkSize));
  return chunks.length ? chunks : [new Uint8Array(0)]; // always at least one chunk, even for empty files
}
