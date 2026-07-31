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
