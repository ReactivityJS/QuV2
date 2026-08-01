/**
 * ENTITY PATHS — the one place that knows how entity identifiers map to Qu
 * storage paths. Every Service imports from here instead of building path
 * strings inline, so the on-disk layout can change in one place without
 * touching Service logic (exactly the "apps never know how something is
 * stored" property the architecture brainstorming was after).
 */

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
