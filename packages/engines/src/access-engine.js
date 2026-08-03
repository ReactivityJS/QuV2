/**
 * ACCESS ENGINE — the ONE place write-ACL enforcement lives, for every
 * entity kind, not just Threads. Registered `{segment: null, order: 0}` (see
 * @qu/core's QuStore.registerEngine()) so it runs on literally every put(),
 * before DocumentEngine/ThreadEngine (order 5) and AssetEngine (order 10) -
 * a resource protected this way is gated regardless of which higher-level
 * Engine/Service also happens to touch its path.
 *
 * Why this exists instead of ThreadEngine's own inline check staying the
 * only ACL in the codebase: DocumentEngine/CollectionEngine/AssetEngine have
 * NO access control at all today, and duplicating a writer-check inside each
 * of them (or inside every app that wants one) is exactly the "per-Engine/
 * per-App" outcome this was built to avoid. One Engine, one convention,
 * usable by anything that writes through QuStore.put() - a Document, a
 * Collection item, an Asset, or a Thread message alike.
 *
 * CONVENTION: a resource's ACL descriptor lives at a SIBLING path,
 * `/store/<space>/acl/<kind>/<resourceId>` (see @qu/services' `aclPath()`),
 * never nested inside the resource's own path - this Engine never needs to
 * understand a Document's/Collection's/Thread's own shape, only its own
 * `{writers, readers}` convention. No ACL doc for a resource means fully
 * open, exactly like today - this is a purely ADDITIVE capability, every
 * Document/Collection/Asset in production today has no ACL doc and keeps
 * working completely unchanged.
 *
 * `readers` is intentionally NOT enforced here - restricting who can
 * DECRYPT content is a content-layer (encryption) concern, already fully
 * generic at @qu/core's QuStore.#seal() level (see `options.encryptWith`),
 * not a pipeline-gate concern. This Engine only ever answers "is this
 * signer allowed to WRITE here."
 *
 * BACKWARD COMPATIBILITY for Threads specifically: a Thread's `writers`/
 * `readers` have always lived in `threads/<id>/meta` (see ThreadEngine),
 * predating this convention. Rather than requiring every already-deployed
 * Chat/Calendar/Inbox/Forum thread to be migrated, this Engine falls back
 * to reading `meta` directly for thread paths when no dedicated `acl/`
 * entry exists yet - reproducing the exact same decision ThreadEngine's own
 * (still-present, redundant-by-design) check already makes, so old and new
 * peers agree during the rollout window. See ThreadEngine's own doc comment
 * for why its check is being kept, not removed, alongside this one.
 *
 * HONEST LIMITATION (identical to ThreadEngine's own, inherited as-is):
 * this only protects LOCAL writes through `QuStore.put()`. A QuBit arriving
 * via @qu/sync's replication is written directly to the adapter, bypassing
 * the whole Engine pipeline - enforcing this against synced data too would
 * need an equivalent check in SyncEngine's incoming-write path, real future
 * work, not implemented here.
 */
import { QuCrypto } from '@qu/core';

const DOC_RE = /^\/store\/([^/]+)\/docs\/([^/]+)$/;
const COLLECTION_RE = /^\/store\/([^/]+)\/collections\/([^/]+)$/;
const ASSET_RE = /^\/store\/([^/]+)\/assets\/([^/]+)(?:\/meta)?$/;
const THREAD_RE = /^\/store\/([^/]+)\/threads\/([^/]+)\/(?:meta|msgs\/[^/]+)$/;
const ACL_RE = /^\/store\/([^/]+)\/acl\/([^/]+)\/([^/]+)$/;

/** @param {string} path @returns {{spaceId: string, kind: 'docs'|'collections'|'assets'|'threads', resourceId: string}|null} */
function resolveResource(path) {
  let match = path.match(DOC_RE);
  if (match) return { spaceId: match[1], kind: 'docs', resourceId: match[2] };
  match = path.match(COLLECTION_RE);
  if (match) return { spaceId: match[1], kind: 'collections', resourceId: match[2] };
  match = path.match(ASSET_RE);
  if (match) return { spaceId: match[1], kind: 'assets', resourceId: match[2] };
  match = path.match(THREAD_RE);
  if (match) return { spaceId: match[1], kind: 'threads', resourceId: match[2] };
  return null;
}

/** @param {object} acl @param {object} options @returns {boolean} */
function writerAllowed(acl, options) {
  if (!acl || acl.writers === '*') return true;
  const writerPub = options.writerPub;
  const writerPubB64Url = writerPub instanceof Uint8Array ? QuCrypto.toBase64Url(writerPub) : null;
  return !!writerPubB64Url && Array.isArray(acl.writers) && acl.writers.includes(writerPubB64Url);
}

export class AccessEngine {
  /** @param {import('@qu/core').QuCore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: null,
      order: 0,
      put: (ctx) => this.#handlePut(ctx),
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }

  async #handlePut(ctx) {
    // A write to an ACL descriptor itself: only an already-listed writer
    // (or nobody yet, i.e. first-write-wins, same bootstrap rule every
    // other resource already has) may change it - otherwise anyone could
    // hijack a protected resource by simply overwriting its own ACL.
    const aclMatch = ctx.path.match(ACL_RE);
    if (aclMatch) {
      const existingBit = await this.qu.get(ctx.path);
      if (!existingBit) return; // nothing protected yet - first writer establishes it
      if (!writerAllowed(existingBit.val, ctx.options)) {
        const [, , kind, resourceId] = aclMatch;
        throw new Error(`AccessEngine: not authorized to change access for ${kind} "${resourceId}"`);
      }
      return;
    }

    const resource = resolveResource(ctx.path);
    if (!resource) return; // not a recognized protectable path - leave it to the default pipeline

    const { spaceId, kind, resourceId } = resource;
    const aclBit = await this.qu.get(`/store/${spaceId}/acl/${kind}/${resourceId}`);
    let acl = aclBit?.val ?? null;

    // Legacy fallback: a Thread created before this Engine existed has no
    // dedicated acl/ entry, only its own `meta` document - fall back to
    // that so an old thread's enforcement doesn't silently change.
    if (!acl && kind === 'threads') {
      const metaBit = await this.qu.get(`/store/${spaceId}/threads/${resourceId}/meta`);
      acl = metaBit?.val ?? null;
    }

    if (!writerAllowed(acl, ctx.options)) {
      throw new Error(`AccessEngine: writer not authorized to write to ${kind} "${resourceId}"`);
    }
  }
}
