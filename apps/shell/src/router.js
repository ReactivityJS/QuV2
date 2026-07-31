/**
 * ROUTER — pure hash-parsing logic, kept DOM-free so it's testable without
 * a browser (mirrors @qu/foundation's own "pure logic in its own file"
 * split). `#/<appId>/<...segments>` - the first segment selects which
 * app's manifest to mount, everything after is that app's own business.
 */

/**
 * @param {string} hash - e.g. "#/notes/inbox" or "" (home).
 * @returns {{appId: string|null, segments: string[]}}
 */
export function parseHash(hash) {
  const clean = (hash || '').replace(/^#\/?/, '');
  const segments = clean.split('/').filter(Boolean);
  return { appId: segments[0] ?? null, segments };
}

/** @param {string} appId @param {string[]} [rest] @returns {string} */
export function buildHash(appId, rest = []) {
  return ['#', appId, ...rest].filter(Boolean).join('/');
}
