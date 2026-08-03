import { QuCrypto } from '@qu/core';
import { aclPath } from './paths.js';
import { resolveReaderXKeys } from './crypto-envelope.js';
import { createFreshnessTracker } from './sync-freshness.js';

/**
 * ACCESS SERVICE — the Entity API for the generic ACL convention @qu/engines'
 * AccessEngine enforces (see that file's own doc comment for the pipeline
 * half of this). Any app - Document-, Collection-, Asset-, or Thread-based
 * alike - calls this ONE Service to protect a resource, instead of every
 * app (or every Engine) inventing its own writer/reader-list logic.
 *
 * `protect()` only ever needs to write ONE document (the ACL descriptor);
 * it never touches the resource itself. `writeOptionsFor()` is the other
 * half - a thin convenience wrapper that resolves the SAME
 * `resolveReaderXKeys()`/`encryptWith`/`signWith` machinery ThreadService
 * and AssetService already use internally (see crypto-envelope.js's own
 * doc comment: that helper was already extracted to be storage-agnostic),
 * so protecting a plain Document with real reader-restricted encryption
 * needs no new cryptography anywhere - only this one reusable wrapper.
 */
export class AccessService {
  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Same
   *   backfill-on-local-miss purpose as every other Service's own syncFetch
   *   (see e.g. ThreadService's constructor doc comment) - without it, a
   *   resource protected by a peer before this session ever subscribed
   *   would misread as "unprotected" instead of just "not synced yet".
   * @param {() => number} [getGeneration]
   */
  constructor(qu, identityEngine, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

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
   * @param {'docs'|'collections'|'assets'|'threads'} kind
   * @param {string} resourceId
   * @returns {Promise<{writers: '*'|string[], readers: '*'|string[]}|null>}
   *   `null` means unprotected (fully open, exactly like today's default).
   */
  async getAcl(spaceId, kind, resourceId) {
    const path = aclPath(spaceId, kind, resourceId);
    const local = await this.qu.get(path);
    if (local) {
      this.#backgroundRefresh(path);
      return local.val;
    }
    if (!this.syncFetch) return null;
    await this.syncFetch(path).catch(() => {});
    const retried = await this.qu.get(path);
    return retried?.val ?? null;
  }

  /**
   * Creates or updates a resource's ACL descriptor. `AccessEngine` itself
   * enforces that only an already-listed writer may call this again on an
   * already-protected resource - this method does not special-case that;
   * the throw simply propagates from `qu.put()`.
   *
   * @param {string|number} spaceId
   * @param {'docs'|'collections'|'assets'|'threads'} kind
   * @param {string} resourceId
   * @param {{writers?: '*'|string[], readers?: '*'|string[]}} [acl]
   *   Defaults to fully open - `protect(..., {})` (or omitting `acl`
   *   entirely) is exactly how you re-open an already-protected resource,
   *   same as `unprotect()` below.
   * @param {{asSpaceId?: string|number, includeSelfAsWriter?: boolean}} [options]
   *   `includeSelfAsWriter` (default `true` whenever `writers` is a finite
   *   array) auto-adds the caller's own pubkey unless already present or
   *   already `'*'` - avoids locking yourself out of a resource you just
   *   created.
   * @returns {Promise<{writers: '*'|string[], readers: '*'|string[]}>}
   */
  async protect(spaceId, kind, resourceId, acl = {}, { asSpaceId = null, includeSelfAsWriter = true } = {}) {
    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    let writers = acl.writers ?? '*';
    if (includeSelfAsWriter && Array.isArray(writers)) {
      const selfPub = QuCrypto.toBase64Url(signKey.publicKey);
      if (!writers.includes(selfPub)) writers = [...writers, selfPub];
    }
    const normalized = { writers, readers: acl.readers ?? '*' };
    await this.qu.put(aclPath(spaceId, kind, resourceId), normalized, {
      signWith: signKey.privateKeyPkcs8,
      writerPub: signKey.publicKey,
    });
    return normalized;
  }

  /** Sugar for `protect(spaceId, kind, resourceId, {writers: '*', readers: '*'})`. */
  async unprotect(spaceId, kind, resourceId, options = {}) {
    return this.protect(spaceId, kind, resourceId, { writers: '*', readers: '*' }, { ...options, includeSelfAsWriter: false });
  }

  async addWriter(spaceId, kind, resourceId, actorPub, options = {}) {
    const acl = await this.getAcl(spaceId, kind, resourceId);
    if (!acl) throw new Error(`AccessService.addWriter: ${kind} "${resourceId}" isn't protected - call protect() first`);
    if (!Array.isArray(acl.writers) || acl.writers.includes(actorPub)) return acl;
    return this.protect(spaceId, kind, resourceId, { ...acl, writers: [...acl.writers, actorPub] }, { ...options, includeSelfAsWriter: false });
  }

  async removeWriter(spaceId, kind, resourceId, actorPub, options = {}) {
    const acl = await this.getAcl(spaceId, kind, resourceId);
    if (!acl) throw new Error(`AccessService.removeWriter: ${kind} "${resourceId}" isn't protected`);
    if (!Array.isArray(acl.writers)) return acl;
    return this.protect(spaceId, kind, resourceId, { ...acl, writers: acl.writers.filter((pub) => pub !== actorPub) }, { ...options, includeSelfAsWriter: false });
  }

  async addReader(spaceId, kind, resourceId, actorPub, options = {}) {
    const acl = await this.getAcl(spaceId, kind, resourceId);
    if (!acl) throw new Error(`AccessService.addReader: ${kind} "${resourceId}" isn't protected - call protect() first`);
    if (!Array.isArray(acl.readers) || acl.readers.includes(actorPub)) return acl;
    return this.protect(spaceId, kind, resourceId, { ...acl, readers: [...acl.readers, actorPub] }, { ...options, includeSelfAsWriter: false });
  }

  /**
   * Removes a former reader from future encryption targeting - past writes
   * remain readable to them (not retroactive), the same trade-off
   * `ThreadService.removeReader()` already documents for the identical
   * reason (real E2E encryption, not a revocable access token).
   */
  async removeReader(spaceId, kind, resourceId, actorPub, options = {}) {
    const acl = await this.getAcl(spaceId, kind, resourceId);
    if (!acl) throw new Error(`AccessService.removeReader: ${kind} "${resourceId}" isn't protected`);
    if (!Array.isArray(acl.readers)) return acl;
    return this.protect(spaceId, kind, resourceId, { ...acl, readers: acl.readers.filter((pub) => pub !== actorPub) }, { ...options, includeSelfAsWriter: false });
  }

  /**
   * Builds the `put()` options a caller needs to actually write a protected
   * resource's own data: always `{signWith, writerPub}` (so AccessEngine's
   * writer check has something to check), plus `{encryptWith,
   * senderXPrivateKey}` when `readers` isn't `'*'` - real reader-restricted
   * encryption, identical to what ThreadService.postMessage() already does
   * inline for messages, generalized here for any entity kind. Pass the
   * result straight into `documents.create()/update()`,
   * `collections.create()/addItem()`, or `assets.upload()`.
   *
   * GOTCHA for `docs`/`collections`: setting a restricted `readers` list
   * via `protect()` makes this method return real `encryptWith` options,
   * and the resulting Document/Collection VALUE will genuinely be
   * ciphertext once written - but `DocumentService.get()`/
   * `CollectionService.list()` never decrypt anything (unlike
   * `ThreadService.listMessages()`/`AssetService.download()`, which both
   * are decrypt-aware). Restricting `readers` on a plain Document or
   * Collection today means NOBODY can read it back through those Services
   * again, not even a listed reader - there is no decrypt-aware Entity API
   * for those two kinds yet. Only restrict `writers` for `docs`/
   * `collections` until that gap is closed; `readers` restriction is
   * safe today only for `threads` (via ThreadService) and `assets` (via
   * AssetService), which already know how to decrypt what they wrote.
   *
   * @param {string|number} spaceId
   * @param {'docs'|'collections'|'assets'|'threads'} kind
   * @param {string} resourceId
   * @param {{asSpaceId?: string|number}} [options]
   * @returns {Promise<object>}
   * @throws {Error} If the resource is protected with restricted `readers`
   *   and any of them has no resolvable X25519 key - fails closed, same
   *   contract as `resolveReaderXKeys()`.
   */
  async writeOptionsFor(spaceId, kind, resourceId, { asSpaceId = null } = {}) {
    const acl = await this.getAcl(spaceId, kind, resourceId);
    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    if (acl && acl.readers !== '*') {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await resolveReaderXKeys(acl.readers, (pub) => this.#getProfile(pub));
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }
    return putOptions;
  }
}
