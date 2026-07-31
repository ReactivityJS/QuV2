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
import { QuCrypto } from '@qu/core';

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

    const file = await normalizeFileInput(ctx.val);
    const blobPath = toBlobPath(ctx.path);

    const chunks = chunkData(file.data, this.chunkSize);
    await Promise.all(
      chunks.map((chunk, i) => this.qu.put(`${blobPath}/chunk_${i}`, QuCrypto.toBase64(chunk), ctx.options))
    );

    const meta = { name: file.name, mime: file.mime, size: file.size, chunkCount: chunks.length, blobPath };
    const metaQuBit = await this.qu.put(`${ctx.path}/meta`, meta, ctx.options);

    return { handled: true, result: metaQuBit };
  }

  /**
   * Reassembles a stored asset from its chunks.
   * @param {string} storePath - The original path passed to `put()`, e.g. `/store/gallery/assets/photo1`.
   * @returns {Promise<{meta: object, data: Uint8Array}|null>}
   */
  async getAsset(storePath) {
    const metaQuBit = await this.qu.get(`${storePath}/meta`);
    const meta = metaQuBit?.val;
    if (!meta) return null;

    const chunks = await Promise.all(
      Array.from({ length: meta.chunkCount }, (_, i) => this.qu.get(`${meta.blobPath}/chunk_${i}`))
    );
    if (chunks.some((c) => !c)) return null; // a chunk is missing - incomplete/corrupt upload

    const chunkBytes = chunks.map((c) => QuCrypto.fromBase64(c.val));
    const totalLength = chunkBytes.reduce((sum, b) => sum + b.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const bytes of chunkBytes) {
      data.set(bytes, offset);
      offset += bytes.length;
    }
    return { meta, data };
  }
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
