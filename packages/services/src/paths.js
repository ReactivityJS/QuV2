/**
 * ENTITY PATHS — the one place that knows how entity identifiers map to Qu
 * storage paths. Every Service imports from here instead of building path
 * strings inline, so the on-disk layout can change in one place without
 * touching Service logic (exactly the "apps never know how something is
 * stored" property the architecture brainstorming was after).
 */

/**
 * @param {string|number} spaceId @returns {string} The space's own storage
 *   root - what `subscribe()` needs to cover everything under a space, not
 *   any specific entity within it. Every OTHER helper below is really just
 *   this plus a fixed sub-path; kept as its own export because apps
 *   themselves need exactly this (and only this) shape for `subscribe()`
 *   calls, see e.g. apps/todo|forum|chat/client.js.
 */
export function spacePath(spaceId) {
  return `/store/${spaceId}`;
}

/** @param {string|number} spaceId @param {string} docId @returns {string} */
export function documentPath(spaceId, docId) {
  return `/store/${spaceId}/docs/${docId}`;
}

/** @param {string|number} spaceId @param {string} collectionId @returns {string} */
export function collectionPath(spaceId, collectionId) {
  return `/store/${spaceId}/collections/${collectionId}`;
}

/** @param {string|number} spaceId @param {string} assetId @returns {string} */
export function assetPath(spaceId, assetId) {
  return `/store/${spaceId}/assets/${assetId}`;
}

/** @param {string|number} spaceId @param {string} threadId @returns {string} */
export function threadMetaPath(spaceId, threadId) {
  return `/store/${spaceId}/threads/${threadId}/meta`;
}

/** @param {string|number} spaceId @param {string} threadId @param {string} messageId @returns {string} */
export function threadMessagePath(spaceId, threadId, messageId) {
  return `/store/${spaceId}/threads/${threadId}/msgs/${messageId}`;
}

/** @param {string} threadId @returns {string} The CollectionService collectionId used for a thread's message list. */
export function threadMessagesCollectionId(threadId) {
  return `thread-${threadId}`;
}

/** @param {string} threadId @param {string} messageId @returns {string} The CollectionService collectionId used for one message's reactions. */
export function threadReactionsCollectionId(threadId, messageId) {
  return `thread-${threadId}-reactions-${messageId}`;
}

/** @param {string} threadId @returns {string} The CollectionService collectionId used for a thread's pinned messages. */
export function threadPinsCollectionId(threadId) {
  return `thread-${threadId}-pins`;
}

/**
 * @param {string|number} spaceId @param {string} threadId @param {string} actorPub
 * @returns {string} This actor's PRIVATE (self-encrypted) "read up to" marker
 *   for a thread - see ThreadService's `markRead()`/`getLastReadAt()`.
 *   Exported (unlike most of this file's callers, which stay inside
 *   @qu/services) so apps/shell's notification badge can `watch()` this
 *   exact path directly - see that file's `_watchNotifBadge()` for why.
 */
export function threadReadMarkerPath(spaceId, threadId, actorPub) {
  return `/store/actors/~${actorPub}/private/thread-read/${spaceId}/${threadId}`;
}

/**
 * The ACL descriptor path for a resource - deliberately a SIBLING of the
 * resource's own path (`acl/<kind>/<id>`), not nested inside it, so
 * @qu/engines' AccessEngine can gate a write without knowing anything about
 * how that resource's own data is shaped. `kind` lives in the PATH (not the
 * ACL document's own content) so a doc and a collection that happen to
 * share the same id never collide on the same ACL entry.
 * @param {string|number} spaceId
 * @param {'docs'|'collections'|'assets'|'threads'} kind
 * @param {string} resourceId
 * @returns {string}
 */
export function aclPath(spaceId, kind, resourceId) {
  return `/store/${spaceId}/acl/${kind}/${resourceId}`;
}
