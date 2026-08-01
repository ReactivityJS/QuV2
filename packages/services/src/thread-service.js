import { QuCrypto } from '@qu/core';
import { threadMetaPath, threadMessagePath, threadMessagesCollectionId, collectionPath } from './paths.js';
import { applyFormatting } from './thread-formatting.js';
import { putPrivate, getPrivate } from './private-storage.js';

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
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./collection-service.js').CollectionService} collectionService
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
   */
  constructor(qu, identityEngine, collectionService, syncFetch = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.collections = collectionService;
    this.syncFetch = syncFetch;
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
    if (local || !this.syncFetch) return local;
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
    const existing = await this.getConfig(spaceId, threadId);
    if (existing) return existing;

    const normalized = { writers: '*', readers: '*', replyMode: 'flat', formatting: [], ...config };
    await this.qu.put(threadMetaPath(spaceId, threadId), normalized);
    await this.collections.create(spaceId, threadMessagesCollectionId(threadId), []);
    return normalized;
  }

  /** @param {string|number} spaceId @param {string} threadId @returns {Promise<object|null>} */
  async getConfig(spaceId, threadId) {
    const quBit = await this.qu.get(threadMetaPath(spaceId, threadId));
    return quBit?.val ?? null;
  }

  /**
   * Records "I've seen everything in this thread up to now" - a generic,
   * per-identity, private read-marker usable by any thread (Chat unread
   * counts, and the header's notification badge - see
   * apps/notifications/client.js and apps/shell/src/main.js). Private
   * because how far you've read is nobody else's business.
   * @param {string|number} spaceId @param {string} threadId
   */
  async markRead(spaceId, threadId) {
    const actorPub = await this.#myActorPub();
    await putPrivate(this.qu, this.identity, `/store/actors/~${actorPub}/private/thread-read/${spaceId}/${threadId}`, { readAt: Date.now() });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @returns {Promise<number>} Epoch ms of the last `markRead()` call, or 0 if never marked.
   */
  async getLastReadAt(spaceId, threadId) {
    const actorPub = await this.#myActorPub();
    const marker = await getPrivate(this.qu, this.identity, `/store/actors/~${actorPub}/private/thread-read/${spaceId}/${threadId}`);
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
    await this.qu.put(path, message, putOptions);
    await this.collections.addItem(spaceId, threadMessagesCollectionId(threadId), path);
    return { id: messageId, ...message };
  }

  /**
   * Lists every message in a thread, newest-last, decrypting each if the
   * thread is private and this identity is one of its readers.
   * @param {string|number} spaceId
   * @param {string} threadId
   * @returns {Promise<Array<object>>}
   */
  async listMessages(spaceId, threadId) {
    const { adapter, rel } = this.qu.resolveMount(collectionPath(spaceId, threadMessagesCollectionId(threadId)));
    const raw = await adapter.get(rel);
    const paths = raw?.val?.$list ?? [];

    const messages = [];
    for (const path of paths) {
      const quBit = await this.qu.get(path);
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

  /**
   * @param {Array<string>} readerPubs - base64url Ed25519 actor pubkeys.
   * @returns {Promise<Array<Uint8Array>>} Their raw X25519 public keys.
   * @throws {Error} If any reader has no published profile/X key - fails
   *   closed rather than posting a partially-unprotected message.
   */
  async #resolveReaderXKeys(readerPubs) {
    const keys = [];
    for (const pub of readerPubs) {
      const profile = await this.#getProfile(pub);
      if (!profile?.xPublicKey) {
        throw new Error(`ThreadService: reader "${pub}" has no published profile - cannot encrypt for them`);
      }
      keys.push(QuCrypto.fromBase64Url(profile.xPublicKey));
    }
    return keys;
  }

  /**
   * @param {object} quBit
   * @returns {Promise<object|null>} The decrypted message, or the message
   *   as-is if it was never encrypted, or null if this identity can't
   *   decrypt it (not a listed reader, or the sender's profile/key is unresolvable).
   */
  async #decryptMessage(quBit) {
    const val = quBit.val;
    const isEncrypted = val && typeof val === 'object' && typeof val.iv === 'string' && typeof val.ct === 'string' && Array.isArray(val.to);
    if (!isEncrypted) return val;
    if (!quBit.pub) return null; // no signer identity to resolve the sender's X key from

    const myXKey = await this.identity.getMainXKey();
    const myXPubB64 = QuCrypto.toBase64(myXKey.publicKey);
    const entry = val.to.find((e) => e.pub === myXPubB64);
    if (!entry) return null;

    const senderActorPub = QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub));
    const senderProfile = await this.#getProfile(senderActorPub);
    if (!senderProfile?.xPublicKey) return null;

    try {
      const plaintext = await QuCrypto.decrypt(
        QuCrypto.fromBase64(val.iv),
        QuCrypto.fromBase64(val.ct),
        QuCrypto.fromBase64(entry.key),
        QuCrypto.fromBase64Url(senderProfile.xPublicKey),
        myXKey.privateKeyPkcs8
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      return null;
    }
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

  /** A personal inbox: anyone can send TO it, only the owner can read it - exactly a mailbox. */
  mail: (ownerPub) => ({ writers: '*', readers: [ownerPub], replyMode: 'flat', formatting: ['markdown', 'mentions'] }),

  /** System/app-generated notices, visible only to the owner, no formatting. */
  notifications: (ownerPub) => ({ writers: '*', readers: [ownerPub], replyMode: 'flat', formatting: [] }),
};
