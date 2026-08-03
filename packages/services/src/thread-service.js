import { QuCrypto } from '@qu/core';
import { threadMetaPath, threadMessagePath, threadMessagesCollectionId, threadReactionsCollectionId, threadPinsCollectionId, threadReadMarkerPath, collectionPath } from './paths.js';
import { applyFormatting } from './thread-formatting.js';
import { putPrivate, getPrivate } from './private-storage.js';
import { isEncryptedEnvelope, resolveReaderXKeys, decryptEnvelope } from './crypto-envelope.js';
import { createFreshnessTracker } from './sync-freshness.js';

/**
 * THREAD SERVICE — the Entity API for Threads (see @qu/engines/thread-engine.js
 * for the pipeline half of this: ACL enforcement + stamping).
 *
 * Handles the two things ThreadEngine deliberately leaves to this layer:
 *   - Content: applying the thread's configured formatters (markdown/mentions).
 *   - Privacy: a thread with a specific `readers` list is genuinely
 *     encrypted for exactly those readers (not just a UI-level filter) -
 *     every reader must have a published profile with an X25519 key (see
 *     @qu/identity), or posting fails closed rather than silently writing
 *     the message unencrypted.
 *
 * `THREAD_PRESETS` at the bottom is the concrete answer to "Forum/Chat/
 * Mail/Notifications differ only by config": each is a small factory
 * producing a `createThread()` config, nothing else app-specific.
 */
export class ThreadService {
  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./collection-service.js').CollectionService} collectionService
   * @param {import('./access-service.js').AccessService} accessService - Mirrors
   *   `writers`/`readers` into the generic `acl/threads/<id>` convention
   *   (see @qu/engines' AccessEngine) alongside this thread's own `meta`
   *   document, so a Thread's write-ACL is enforced by the SAME central
   *   mechanism any other entity kind uses, not a Thread-only special case.
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   `SyncEngine.fetch()` (see @qu/sync), for backfilling a profile this
   *   identity doesn't have LOCALLY yet. `subscribe()`-based sync only ever
   *   covers writes made AFTER subscribing (see SyncEngine's own doc
   *   comment) - a chat partner's, or a total stranger's (Inbox: any
   *   writer can send), profile may well have been published before this
   *   session ever connected. Without a way to backfill it on demand,
   *   encrypting FOR a reader (`#resolveReaderXKeys`) or decrypting a
   *   message FROM a sender (`#decryptMessage`) whose profile hasn't
   *   happened to sync yet would fail every time for no fixable reason
   *   from the UI's perspective. Omit this (e.g. server-side/relay usage,
   *   which has no peer to fetch from in the same sense) and both methods
   *   simply behave as before - local-only, no fallback.
   * @param {() => number} [getGeneration] - Optional: `SyncEngine.getGeneration()`
   *   (see @qu/sync) - enables a background staleness re-check for a thread
   *   config/messages collection/message that already exists locally (see
   *   @qu/services/sync-freshness.js). Without this, `subscribe()`'s
   *   "future writes only" gap meant a room this session had already
   *   opened before going offline never caught up on what was posted while
   *   it was away, even after reconnecting - the local-miss-only backfill
   *   below never re-runs once something is cached.
   */
  constructor(qu, identityEngine, collectionService, accessService, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.collections = collectionService;
    this.access = accessService;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  /** @returns {Promise<string>} base64url pubkey of this identity's main key. */
  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * @param {string} actorPub
   * @returns {Promise<object|null>} Same as `identity.getProfile()`, but
   *   backfills via `syncFetch` (if provided) on a local miss before giving
   *   up - see the constructor's own doc comment for why.
   */
  async #getProfile(actorPub) {
    const local = await this.identity.getProfile(actorPub);
    if (local) {
      this.#backgroundRefresh(`/store/actors/~${actorPub}/profile`); // e.g. a reader's key rotated while this session was offline
      return local;
    }
    if (!this.syncFetch) return null;
    try {
      await this.syncFetch(`/store/actors/~${actorPub}/profile`);
    } catch {
      return null; // peer unreachable, or genuinely has no profile - either way, nothing more to try
    }
    return this.identity.getProfile(actorPub); // re-read now that syncFetch (on success) persisted it locally
  }

  /**
   * Creates a thread, or returns the existing config unchanged if one
   * already exists at this id - idempotent by design, so a caller can
   * always call this before posting without risking silently resetting an
   * existing thread's ACL (the same "ensure" pattern a lazily-created
   * personal inbox needs).
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {object} config - See THREAD_PRESETS for ready-made shapes.
   * @param {'*'|string[]} [config.writers='*'] - base64url actor pubkeys allowed to post, or '*' for anyone.
   * @param {'*'|string[]} [config.readers='*'] - base64url actor pubkeys allowed to read, or '*' for public.
   *   A non-'*' list means every message is ENCRYPTED for exactly these readers.
   * @param {'flat'|'threaded'} [config.replyMode='flat']
   * @param {string[]} [config.formatting=[]] - 'markdown' and/or 'mentions'.
   * @returns {Promise<object>} The thread's config (existing or newly created).
   */
  async createThread(spaceId, threadId, config = {}) {
    // A deterministically-derived thread (Chat's roomId(), or any app that
    // calls createThread() unconditionally on every mount - see
    // @qu/thread-ui's mountThreadView()) is very often ALREADY created by
    // the other side by the time this identity opens it for the first
    // time. getConfig()'s own syncFetch backfill is what stops a
    // local-only miss from being misread as "doesn't exist" here - without
    // it, this would blow away an existing thread's messages collection
    // with a fresh empty one (collections.create() is an unconditional
    // overwrite, not a create-if-absent - see CollectionService.create()).
    const existing = await this.getConfig(spaceId, threadId);
    if (existing) return existing;

    const normalized = { writers: '*', readers: '*', replyMode: 'flat', formatting: [], ...config };
    await this.qu.put(threadMetaPath(spaceId, threadId), normalized);
    // Mirror into the generic ACL convention - see this method's own
    // "accessService" param doc comment above. includeSelfAsWriter:false
    // because `normalized.writers` already IS the intended writer set
    // (verbatim from the caller's config, e.g. THREAD_PRESETS.chat's
    // memberPubs) - silently appending the creator on top would change
    // that set out from under a caller who deliberately specified it.
    await this.access.protect(spaceId, 'threads', threadId, { writers: normalized.writers, readers: normalized.readers }, { includeSelfAsWriter: false });
    await this.collections.create(spaceId, threadMessagesCollectionId(threadId), []);
    return normalized;
  }

  /**
   * Resets a thread's history back to empty - same threadId, same config/
   * members, only the messages and pins lists are cleared. Deliberately a
   * ThreadService method, not something any one app (Chat, Forum, Inbox -
   * all built on this same class) should reimplement by poking
   * CollectionService directly: "delete/recreate a chat" is a thread-level
   * operation, not a Chat-specific one.
   *
   * There is no delete primitive anywhere in Qu's storage layer - every
   * write is an overwrite, never a removal (see @qu/core's QuStore) - so
   * this does NOT erase the old message documents themselves, only the
   * COLLECTIONS that list them (same "unlinked, not erased" shape as
   * CollectionService.removeItem() - see its own doc comment). A thread
   * with non-'*' readers is encrypted for every member, not just the
   * caller: resetting its collections is a normal write like any other in
   * this thread, so it is visible to - and syncs to - every member, not
   * just this device. Callers should treat this as destructive and confirm
   * with the user first.
   * @param {string|number} spaceId @param {string} threadId
   */
  async clearMessages(spaceId, threadId) {
    await this.collections.create(spaceId, threadMessagesCollectionId(threadId), []);
    await this.collections.create(spaceId, threadPinsCollectionId(threadId), []);
  }

  /**
   * Backfills via `syncFetch` (if provided) on a local miss - see
   * `createThread()`'s doc comment for why this matters even for a caller
   * that only wants to READ a config (e.g. Chat's group room view uses
   * this directly, without ever calling `createThread()`, to tell "this
   * group doesn't exist / I'm not in it" apart from "just hasn't synced
   * to this session yet").
   * @param {string|number} spaceId @param {string} threadId @returns {Promise<object|null>}
   */
  async getConfig(spaceId, threadId) {
    const path = threadMetaPath(spaceId, threadId);
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
   * Grows a thread's reader list in place - the missing piece
   * THREAD_PRESETS.chat/group's own doc comment flags as future work
   * ("membership fixed at creation... real future work, not implemented
   * here"). Needed for a thread whose membership is expected to change
   * over time (e.g. a shared calendar gaining a new invitee) WITHOUT
   * re-keying history: only messages posted AFTER this call are
   * encrypted for (and so visible to) the newly added reader - exactly
   * the same "can't see history from before you joined" trade-off most
   * messengers accept for group membership changes.
   *
   * A no-op (not an error) for an already-public thread (`readers: '*'`)
   * or a reader already present - safe to call unconditionally.
   * @param {string|number} spaceId @param {string} threadId @param {string} actorPub
   * @returns {Promise<object>} The thread's (possibly updated) config.
   */
  async addReader(spaceId, threadId, actorPub) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) throw new Error(`ThreadService.addReader: no thread "${threadId}" in space "${spaceId}" - call createThread() first`);
    if (!Array.isArray(config.readers) || config.readers.includes(actorPub)) return config;
    const updated = { ...config, readers: [...config.readers, actorPub] };
    // Signed, unlike this method's pre-AccessEngine shape - a restricted
    // thread's `meta` is now gated the same as any other write (see
    // AccessEngine's thread-path regex, which covers `meta` too), so this
    // write needs a verifiable writerPub the same way postMessage() always
    // has. A no-op for writers:'*' threads (e.g. Calendar's `activity`
    // preset, this method's only current caller) - AccessEngine only
    // checks the signer when writers isn't '*'.
    const signKey = await this.identity.getMainKey();
    await this.qu.put(threadMetaPath(spaceId, threadId), updated, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
    await this.access.protect(spaceId, 'threads', threadId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
    return updated;
  }

  /**
   * The inverse of `addReader()` - stops a former member from being
   * resolved as an encryption target or push candidate for future
   * messages (past messages remain readable to them; this isn't
   * retroactive, same caveat as `addReader()`).
   * @param {string|number} spaceId @param {string} threadId @param {string} actorPub
   * @returns {Promise<object>} The thread's (possibly updated) config.
   */
  async removeReader(spaceId, threadId, actorPub) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) throw new Error(`ThreadService.removeReader: no thread "${threadId}" in space "${spaceId}"`);
    if (!Array.isArray(config.readers)) return config;
    const updated = { ...config, readers: config.readers.filter((pub) => pub !== actorPub) };
    const signKey = await this.identity.getMainKey(); // see addReader()'s own comment for why this must now be signed
    await this.qu.put(threadMetaPath(spaceId, threadId), updated, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
    await this.access.protect(spaceId, 'threads', threadId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
    return updated;
  }

  /**
   * Records "I've seen everything in this thread up to now" - a generic,
   * per-identity, private read-marker usable by any thread (Chat unread
   * counts, and the header's notification badge - see
   * apps/notifications/client.js and apps/shell/src/main.js). Private
   * because how far you've read is nobody else's business, but still a
   * SYNCED path (not LOCAL_ONLY_PREFIX) - the whole point is that marking
   * something read on one device should be reflected on another.
   * @param {string|number} spaceId @param {string} threadId
   */
  async markRead(spaceId, threadId) {
    const actorPub = await this.#myActorPub();
    await putPrivate(this.qu, this.identity, threadReadMarkerPath(spaceId, threadId, actorPub), { readAt: Date.now() });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @returns {Promise<number>} Epoch ms of the last `markRead()` call, or 0 if never marked.
   */
  async getLastReadAt(spaceId, threadId) {
    const actorPub = await this.#myActorPub();
    const path = threadReadMarkerPath(spaceId, threadId, actorPub);
    // Same miss/hit freshness pattern as CollectionService.list() - without
    // it, a read-marker published on another device only shows up here
    // once something UNRELATED happens to re-trigger a read of this exact
    // path (found via real multi-device testing: the marker only appeared
    // to "sync" after adding a reaction, which just happened to force a
    // reload of nearby data - it never synced reliably on its own).
    const existing = await this.qu.get(path);
    if (existing) {
      this.#backgroundRefresh(path);
    } else if (this.syncFetch) {
      await this.syncFetch(path).catch(() => {});
    }
    const marker = await getPrivate(this.qu, this.identity, path);
    return marker?.readAt ?? 0;
  }

  /**
   * Posts a message. Applies the thread's configured formatters, enforces
   * writer ACL (via ThreadEngine, on the `qu.put()` below), and encrypts
   * for the thread's readers if it isn't public.
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {{body: string, replyTo?: string, asSpaceId?: string|number, extra?: object}} params
   *   `asSpaceId` posts under a pseudonymous space identity (see
   *   @qu/identity) instead of the main identity. `extra` is merged into the
   *   stored message as-is - e.g. relay-authored notifications attach
   *   `{title, url, appId, image}` alongside the normal human-authored
   *   `body`/`formattedHtml`/`mentions` shape (see relay.js's
   *   `#deliverThreadPush()` and apps/notifications/client.js).
   * @returns {Promise<object>} The stored message (plain value).
   */
  async postMessage(spaceId, threadId, { body, replyTo = null, asSpaceId = null, extra = {} }) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) {
      throw new Error(`ThreadService.postMessage: no thread "${threadId}" in space "${spaceId}" - call createThread() first`);
    }

    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const authorPub = QuCrypto.toBase64Url(signKey.publicKey);
    const { formattedHtml, mentions } = applyFormatting(body, config.formatting);

    // Set _id ourselves (instead of leaving it to ThreadEngine's own
    // "stamp if missing" default) so the id used in the storage PATH and
    // the id embedded in the message body are guaranteed to be the same
    // value, not two independently-generated UUIDs.
    const messageId = globalThis.crypto.randomUUID();
    const message = { _id: messageId, body, formattedHtml, mentions, author: authorPub, replyTo, ...extra };
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };

    if (config.readers !== '*') {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await this.#resolveReaderXKeys(config.readers);
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }

    const path = threadMessagePath(spaceId, threadId, messageId);
    const quBit = await this.qu.put(path, message, putOptions);
    await this.collections.addItem(spaceId, threadMessagesCollectionId(threadId), path);
    // `ts` (the sealed QuBit's own timestamp, not part of `message` itself)
    // is what a caller needs to confirm THIS exact write via
    // SyncEngine.waitForAck(path, ts) - see apps/chat/client.js's
    // confirmSync().
    return { id: messageId, ...message, ts: quBit.ts };
  }

  /**
   * Convenience for "tell one other actor something happened" - creates
   * (if needed) a single-reader mail thread for them and posts one message
   * into it, which is exactly what @qu/relay's `#deliverThreadPush()`
   * pipeline needs to notify them (in-app notification + push), gated by
   * THEIR OWN notification prefs for whichever app `spaceId` resolves to.
   * This is the one-shot equivalent of createThread()+postMessage() that
   * Calendar's invite flow (see apps/calendar/client.js) originally did by
   * hand - any app can reach the same generic notification pipeline this
   * way instead of re-deriving it, as long as it uses ThreadService at all
   * (an app that never touches Threads still gets nothing "for free" - see
   * this repo's README for that limitation).
   *
   * @param {string|number} spaceId - The calling app's own space (or
   *   sub-space, e.g. `geochase-<gameId>`) - this is what @qu/relay derives
   *   the notification's `appId` from, so it should match (or start with)
   *   the app's manifest `name` for its `pushActions` prefs to apply.
   * @param {string} recipientPub
   * @param {string} body - Plain text; content-blind by design downstream
   *   (the relay never decrypts this to build a push payload - see
   *   `#deliverThreadPush()`), so keep it human-readable for the in-app
   *   feed, not machine-parsed.
   * @param {object} [extra] - Merged into the stored message as-is, same as
   *   `postMessage()`'s own `extra` - e.g. `{gameId}` for a deep-link.
   * @returns {Promise<object>} The stored message (plain value).
   * @throws {Error} If the recipient has no resolvable encryption key yet
   *   (no published profile that's synced to this session) - same
   *   fail-closed behavior `postMessage()` already has for any private
   *   thread, see `#resolveReaderXKeys()`.
   */
  async notify(spaceId, recipientPub, body, extra = {}) {
    const threadId = `invite-${recipientPub}`;
    await this.createThread(spaceId, threadId, THREAD_PRESETS.mail(recipientPub));
    return this.postMessage(spaceId, threadId, { body, extra });
  }

  /**
   * Overwrites an existing message's body in place (same path, same
   * `_id`/`replyTo`), re-applying the thread's formatters and re-encrypting
   * for its readers exactly like `postMessage()` - editing is really just
   * "post again at the same id".
   *
   * AUTHOR-ONLY, enforced HERE rather than by ThreadEngine's ACL: the
   * engine's `writers` check only answers "is this signer allowed to post
   * IN this thread at all" - for a public thread (`writers: '*'`) that
   * would let literally anyone overwrite anyone else's message just by
   * knowing its id, which the write ACL was never meant to prevent. This
   * check is the actual guard.
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {string} messageId
   * @param {{body: string, asSpaceId?: string|number}} params
   * @returns {Promise<object>} The updated message (plain value).
   * @throws {Error} If the message doesn't exist, can't be read, or the
   *   caller isn't its original author.
   */
  async editMessage(spaceId, threadId, messageId, { body, asSpaceId = null }) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) {
      throw new Error(`ThreadService.editMessage: no thread "${threadId}" in space "${spaceId}"`);
    }

    const path = threadMessagePath(spaceId, threadId, messageId);
    const quBit = await this.qu.get(path);
    if (!quBit) throw new Error(`ThreadService.editMessage: no message "${messageId}"`);
    const existing = await this.#decryptMessage(quBit);
    if (!existing) throw new Error(`ThreadService.editMessage: cannot read message "${messageId}"`);

    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const authorPub = QuCrypto.toBase64Url(signKey.publicKey);
    if (existing.author !== authorPub) {
      throw new Error(`ThreadService.editMessage: only the original author can edit message "${messageId}"`);
    }

    const { formattedHtml, mentions } = applyFormatting(body, config.formatting);
    const message = { _id: messageId, body, formattedHtml, mentions, author: authorPub, replyTo: existing.replyTo ?? null, editedAt: Date.now() };
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };

    if (config.readers !== '*') {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await this.#resolveReaderXKeys(config.readers);
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }

    await this.qu.put(path, message, putOptions);
    return { id: messageId, ...message };
  }

  /**
   * Lists every message in a thread, newest-last, decrypting each if the
   * thread is private and this identity is one of its readers.
   *
   * Backfills via `syncFetch` (if provided) on a local miss, both for the
   * messages-collection document itself AND for any individual message it
   * references that hasn't synced yet - the same "subscribe() only covers
   * writes from here on, fetch() covers history" gap as
   * DirectoryService.listVisible(): a room opened for the first time after
   * messages were already exchanged (e.g. the other side messages first,
   * or this identity never subscribed to the thread's space before now)
   * would otherwise show up silently empty.
   *
   * A LOCAL HIT (the collection doc already exists) also gets a background
   * staleness re-check (see sync-freshness.js), and so does every
   * already-cached individual message - THIS is what actually fixes
   * "a message from while I was offline never shows up even after
   * reconnecting": the miss-only backfill above only ever helps a room
   * opened for the very first time; a room this session had already synced
   * SOME of before going offline previously had no way to notice it missed
   * anything, because the collection document (and most/all message docs)
   * were never actually "missing" locally, just stale. Re-checking an
   * already-known MESSAGE path also catches an edit made while offline
   * (`editMessage()` overwrites the same path, so a cached copy would
   * otherwise show the pre-edit body forever).
   * @param {string|number} spaceId
   * @param {string} threadId
   * @returns {Promise<Array<object>>}
   */
  async listMessages(spaceId, threadId) {
    const collPath = collectionPath(spaceId, threadMessagesCollectionId(threadId));
    const { adapter, rel } = this.qu.resolveMount(collPath);
    let raw = await adapter.get(rel);
    if (raw) {
      this.#backgroundRefresh(collPath);
    } else if (this.syncFetch) {
      await this.syncFetch(collPath).catch(() => {});
      raw = await adapter.get(rel);
    }
    const paths = raw?.val?.$list ?? [];

    let quBits = await Promise.all(paths.map((path) => this.qu.get(path)));
    if (this.syncFetch && quBits.some((b) => !b)) {
      await Promise.all(paths.map((path, i) => (quBits[i] ? null : this.syncFetch(path).catch(() => {}))));
      quBits = await Promise.all(paths.map((path) => this.qu.get(path)));
    }
    for (const path of paths) this.#backgroundRefresh(path);

    const messages = [];
    for (const quBit of quBits) {
      if (!quBit) continue;
      const val = await this.#decryptMessage(quBit);
      if (val) messages.push({ id: val._id, ts: quBit.ts, ...val });
    }
    return messages;
  }

  /**
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {string} parentMessageId
   * @returns {Promise<Array<object>>} Messages whose `replyTo` matches `parentMessageId`.
   */
  async listReplies(spaceId, threadId, parentMessageId) {
    return (await this.listMessages(spaceId, threadId)).filter((m) => m.replyTo === parentMessageId);
  }

  // =========================================================================
  // REACTIONS, PINS, PRESENCE — ported from QUniverse V1's modules/chat.js
  // and modules/presence.js (calls/WebRTC deliberately excluded). V1 could
  // enumerate "every reactor of message X" via a queryable store
  // (`session.query()`); @qu/core's QuStore has no such wildcard/prefix
  // query (see DirectoryService's own doc comment for the same limitation
  // stated elsewhere), so each of these uses a small CollectionService
  // index instead - exactly the same pattern threadMessagesCollectionId()
  // already uses to make a thread's OWN messages enumerable. Presence
  // doesn't need an index at all: a chat room already has a fixed member
  // list (THREAD_PRESETS.chat's `readers`), so "who's online" just means
  // reading one slot per already-known member, not discovering who exists.
  //
  // SECURITY NOTE, same one V1's own source states plainly for these three
  // (unlike a thread MESSAGE, which ThreadEngine's writer ACL protects):
  // a reaction/pin/presence write is NOT ACL-checked by ThreadEngine (it
  // only recognizes `.../msgs/...` paths) - any current writer of the
  // room can technically write to any OTHER member's reaction/presence
  // slot by path. The path is addressing, not trust: a UI must always key
  // off the QuBit's own verified `pub` (see `#actorPubOf()` below), never
  // trust a path segment as proof of who wrote it.
  // =========================================================================

  /** @returns {Promise<{privateKeyPkcs8: ArrayBuffer, publicKey: Uint8Array}>} */
  async #signingKey(asSpaceId) {
    return asSpaceId ? this.identity.getSpaceKey(asSpaceId) : this.identity.getMainKey();
  }

  /** @param {object} quBit @returns {string|null} base64url actor pubkey, or null if unsigned. */
  #actorPubOf(quBit) {
    return quBit?.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
  }

  /**
   * Sets (or clears) this identity's OWN reaction on a message - a second
   * call with a different emoji simply replaces the first (one reaction
   * per person per message, same rule WhatsApp/Matrix/Slack all use), a
   * `null` emoji clears it.
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @param {string|null} emoji
   * @param {{asSpaceId?: string|number}} [options]
   */
  async setReaction(spaceId, threadId, messageId, emoji, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const actorPub = QuCrypto.toBase64Url(signKey.publicKey);
    const path = `/store/${spaceId}/threads/${threadId}/reactions/${messageId}/${actorPub}`;
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    await this.qu.put(path, emoji, putOptions);
    const collectionId = threadReactionsCollectionId(threadId, messageId);
    if (emoji) await this.collections.addItem(spaceId, collectionId, path, putOptions);
    else await this.collections.removeItem(spaceId, collectionId, path, putOptions);
  }

  /**
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @returns {Promise<Record<string, string[]>>} `{ emoji: [reactorActorPub, ...] }`.
   */
  async getReactions(spaceId, threadId, messageId) {
    const collectionId = threadReactionsCollectionId(threadId, messageId);
    // listRawPaths() ALREADY backfills correctly on its own (see
    // CollectionService.listRawPaths()'s own doc comment): a blocking
    // syncFetch when this collection has genuinely never been seen
    // locally, or a gated (once-per-generation) background-refresh when
    // it has - a length-0 RESULT here can't tell those two cases apart
    // (unlike getConfig()'s null-vs-value distinction), so a second,
    // ungated "still empty? fetch again" attempt on top used to refetch
    // on EVERY call once this collection was confirmed genuinely empty -
    // each fetch re-persisting the same already-known QuBit (same or
    // older `ts`, never newer - see SyncEngine#persistDirectly's
    // never-regress check, which only skips a STRICTLY older write) fired
    // a fresh `storage:put`, which re-triggered every `watch()` on this
    // path, which called back in here - a self-sustaining loop with
    // nothing left to converge on. Trust listRawPaths()'s own backfill.
    const paths = await this.collections.listRawPaths(spaceId, collectionId);
    const byEmoji = {};
    await Promise.all(paths.map(async (path) => {
      let quBit = await this.qu.get(path);
      if (quBit) {
        // Same-path background refresh - a reactor CHANGING their reaction
        // (setReaction() always writes to this same fixed per-actor path,
        // see above) never adds a new collection entry, so the
        // "collection was empty" backfill above never re-fires for an
        // updated value - this per-document refresh is what actually
        // catches that case.
        this.#backgroundRefresh(path);
      } else if (this.syncFetch) {
        // A collection entry can arrive (via the backfill above, or a live
        // subscribe() push) before this session has ever fetched the
        // REACTION DOCUMENT itself at that path - without this, such a
        // reaction showed up as a path with nothing behind it, forever.
        await this.syncFetch(path).catch(() => {});
        quBit = await this.qu.get(path);
      }
      const reactorPub = this.#actorPubOf(quBit);
      if (!reactorPub || !quBit.val) return;
      (byEmoji[quBit.val] ??= []).push(reactorPub);
    }));
    return byEmoji;
  }

  /**
   * Pins (or unpins) a message - any current writer of the thread may pin
   * or unpin any message (V1's own rule too - see modules/chat.js), so
   * there's no per-person state to track, just membership in one
   * per-thread collection.
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @param {boolean} pinned
   * @param {{asSpaceId?: string|number}} [options]
   */
  async setPinned(spaceId, threadId, messageId, pinned, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    const collectionId = threadPinsCollectionId(threadId);
    const path = threadMessagePath(spaceId, threadId, messageId);
    if (pinned) await this.collections.addItem(spaceId, collectionId, path, putOptions);
    else await this.collections.removeItem(spaceId, collectionId, path, putOptions);
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @returns {Promise<string[]>} Currently pinned message ids. See
   *   getReactions()'s doc comment for why this relies entirely on
   *   listRawPaths()'s own (correctly gated) backfill rather than adding
   *   a second, ungated "still empty? fetch again" attempt on top.
   */
  async listPinned(spaceId, threadId) {
    const collectionId = threadPinsCollectionId(threadId);
    const paths = await this.collections.listRawPaths(spaceId, collectionId);
    return paths.map((path) => path.slice(path.lastIndexOf('/') + 1));
  }

  /**
   * Publishes this identity's own presence in a thread. Call again every
   * `intervalMs` (see startHeartbeat() below) - staleness, not an
   * explicit "offline", is what getPresence() actually trusts, since an
   * ungraceful disconnect (closing a tab) never gets a chance to publish
   * 'offline'.
   * @param {string|number} spaceId @param {string} threadId @param {'online'|'offline'} status
   * @param {{asSpaceId?: string|number}} [options]
   */
  async setPresence(spaceId, threadId, status, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const path = `/store/${spaceId}/threads/${threadId}/presence/${QuCrypto.toBase64Url(signKey.publicKey)}`;
    await this.qu.put(path, { status, lastSeen: Date.now() }, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @param {string[]} memberPubs - Whose presence to check - a chat room
   *   already has a fixed member list (see THREAD_PRESETS.chat), so unlike
   *   reactions/pins this never needs its own discovery index.
   * @param {{staleAfterMs?: number}} [options] - Default 15s = 3x the
   *   default heartbeat (5s, see startHeartbeat()) - tight enough that
   *   "online" flips to "offline" within a few seconds of really going
   *   away, loose enough not to falsely flash offline on one missed beat.
   * @returns {Promise<Record<string, {status: string, lastSeen: number, online: boolean}>>}
   */
  async getPresence(spaceId, threadId, memberPubs, { staleAfterMs = 15_000 } = {}) {
    const now = Date.now();
    const result = {};
    await Promise.all(memberPubs.map(async (pub) => {
      const quBit = await this.qu.get(`/store/${spaceId}/threads/${threadId}/presence/${pub}`);
      if (!quBit?.val) return;
      const { status, lastSeen } = quBit.val;
      result[pub] = { status, lastSeen, online: status === 'online' && now - lastSeen < staleAfterMs };
    }));
    return result;
  }

  /**
   * Publishes 'online' every `intervalMs`, and 'offline' once when stopped
   * (best-effort - an ungraceful disconnect skips this; readers must still
   * treat staleness, not just the last published status, as the source of
   * truth - see getPresence()).
   * @param {string|number} spaceId @param {string} threadId
   * @param {{intervalMs?: number, asSpaceId?: string|number}} [options]
   * @returns {() => Promise<void>} Stop function.
   */
  startHeartbeat(spaceId, threadId, { intervalMs = 5_000, asSpaceId = null } = {}) {
    this.setPresence(spaceId, threadId, 'online', { asSpaceId }).catch(() => {});
    const timer = setInterval(() => {
      this.setPresence(spaceId, threadId, 'online', { asSpaceId }).catch(() => {});
    }, intervalMs);
    return async () => {
      clearInterval(timer);
      await this.setPresence(spaceId, threadId, 'offline', { asSpaceId }).catch(() => {});
    };
  }

  /**
   * Publishes "I've read everything up to this timestamp" - VISIBLE TO
   * OTHER MEMBERS (unlike `markRead()`/`getLastReadAt()` above, which are
   * PRIVATE per-identity markers for this identity's own unread badge).
   * This is what lets a sender show a "read" tick (✓✓) on their own
   * messages - the reader publishing this is a deliberate, visible signal,
   * same as WhatsApp/Signal read receipts, not something that can be
   * inferred from encrypted message traffic alone.
   * @param {string|number} spaceId @param {string} threadId
   * @param {number} uptoTs - Epoch ms; typically the newest message's `ts`.
   * @param {{asSpaceId?: string|number}} [options]
   */
  async publishReadReceipt(spaceId, threadId, uptoTs, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const path = `/store/${spaceId}/threads/${threadId}/reads/${QuCrypto.toBase64Url(signKey.publicKey)}`;
    await this.qu.put(path, { upto: uptoTs }, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @param {string[]} memberPubs - Same fixed-member-list reasoning as `getPresence()`.
   * @returns {Promise<Record<string, number>>} `{ actorPub: uptoTs }` - a
   *   member absent from the result has never published a read receipt here.
   */
  async getReadReceipts(spaceId, threadId, memberPubs) {
    const result = {};
    await Promise.all(memberPubs.map(async (pub) => {
      const path = `/store/${spaceId}/threads/${threadId}/reads/${pub}`;
      let quBit = await this.qu.get(path);
      // Same miss/hit freshness pattern used throughout this file - this
      // method previously had NONE at all, so a read receipt published on
      // another device (or while this session was offline) only ever
      // appeared once something unrelated happened to re-trigger a read.
      if (quBit) {
        this.#backgroundRefresh(path);
      } else if (this.syncFetch) {
        await this.syncFetch(path).catch(() => {});
        quBit = await this.qu.get(path);
      }
      if (typeof quBit?.val?.upto === 'number') result[pub] = quBit.val.upto;
    }));
    return result;
  }

  /**
   * @param {Array<string>} readerPubs - base64url Ed25519 actor pubkeys.
   * @returns {Promise<Array<Uint8Array>>} Their raw X25519 public keys.
   * @throws {Error} If any reader has no published profile/X key - fails
   *   closed rather than posting a partially-unprotected message.
   */
  async #resolveReaderXKeys(readerPubs) {
    return resolveReaderXKeys(readerPubs, (pub) => this.#getProfile(pub));
  }

  /**
   * @param {object} quBit
   * @returns {Promise<object|null>} The decrypted message, or the message
   *   as-is if it was never encrypted, or null if this identity can't
   *   decrypt it (not a listed reader, or the sender's profile/key is unresolvable).
   */
  async #decryptMessage(quBit) {
    if (!isEncryptedEnvelope(quBit.val)) return quBit.val;
    return decryptEnvelope(quBit, this.identity, (pub) => this.#getProfile(pub));
  }
}

/**
 * Ready-made configs proving "Forum/Chat/Mail/Notifications differ only by
 * config" - each still goes through the exact same createThread()/
 * postMessage()/listMessages() as any other thread.
 */
export const THREAD_PRESETS = {
  /** A public board: anyone can read, anyone can post, markdown + mentions. */
  forum: () => ({ writers: '*', readers: '*', replyMode: 'flat', formatting: ['markdown', 'mentions'] }),

  /** A shared room restricted to a fixed member list. */
  chat: (memberPubs) => ({ writers: memberPubs, readers: memberPubs, replyMode: 'flat', formatting: ['mentions'] }),

  /**
   * A named multi-member room - same encrypted-for-a-fixed-member-list
   * shape as `chat`, plus `name` (display) and `kind: 'group'` (so a
   * generic reader of `getConfig()` - the Chat app's room list - can tell
   * a group apart from a 1:1 room without a separate metadata store).
   * Membership is fixed at creation, matching this preset's own fixed
   * `readers` list: adding/removing members would mean re-keying every
   * future message for a different reader set, which is real future work,
   * not implemented here (a new group is the workaround for now, same as
   * many messengers' own "can't add someone to an already-encrypted
   * history" limitation).
   */
  group: (memberPubs, name) => ({ writers: memberPubs, readers: memberPubs, replyMode: 'flat', formatting: ['mentions'], kind: 'group', name }),

  /** A personal inbox: anyone can send TO it, only the owner can read it - exactly a mailbox. */
  mail: (ownerPub) => ({ writers: '*', readers: [ownerPub], replyMode: 'flat', formatting: ['markdown', 'mentions'] }),

  /** System/app-generated notices, visible only to the owner, no formatting. */
  notifications: (ownerPub) => ({ writers: '*', readers: [ownerPub], replyMode: 'flat', formatting: [] }),

  /**
   * A membership list that GROWS over time (via `addReader()`/
   * `removeReader()`, unlike `chat`/`group`'s fixed list) - e.g. Calendar's
   * `activity` thread, whose readers must track a shared calendar's current
   * member list as people are invited or removed. `writers: '*'` because
   * only the owning app's own code posts into it (a system activity feed,
   * not open user content), so there's no separate writer allowlist to
   * maintain in lockstep with `readers`.
   */
  activity: (memberPubs) => ({ writers: '*', readers: memberPubs, replyMode: 'flat', formatting: [] }),
};
