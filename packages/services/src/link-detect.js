/**
 * LINK DETECTION — the one place a raw `http(s)://` URL gets found inside
 * plain text. Shared by two independent consumers that both need the exact
 * same answer to "where are the links in this text":
 *   - `thread-formatting.js`'s `formatMarkdown()`, which bakes an auto-link
 *     into `formattedHtml` at write time for any thread that opted into
 *     `'markdown'` formatting (see THREAD_PRESETS).
 *   - `apps/chat/client.js`'s own DOM-based renderer, which builds real
 *     anchor elements directly (no `innerHTML`) for THREAD_PRESETS.chat/
 *     group rooms - those never opt into `'markdown'` (see that preset's
 *     own history), so Chat needs the same detection independently, at
 *     render time rather than write time.
 * Before this module existed, Chat had its own private copy of this exact
 * regex/hostname-extraction logic; this is that logic moved to one shared,
 * pure place instead of two copies that could quietly drift apart.
 */
const URL_RE = /(https?:\/\/[^\s<>"]+)/gi;

/**
 * The one URL-matching pattern itself, exported for a caller that wants to
 * drive its own `.replace()`/`.matchAll()` directly (see
 * `thread-formatting.js`'s `formatMarkdown()`, which builds an HTML string
 * rather than a segment list). Safe to reuse across calls - unlike
 * `.exec()`/`.test()` in a loop, `String.prototype.replace()` and
 * `matchAll()` don't rely on (or mutate, for `matchAll`) a shared
 * `lastIndex` between separate calls on a global regex.
 */
export const URL_RE_GLOBAL = URL_RE;

/**
 * @param {string} text
 * @returns {Array<{type: 'text'|'link', value: string, hostname?: string}>}
 *   The FULL text, split into plain-text and link segments in order - a
 *   caller reconstructs the original by concatenating every segment's
 *   `value`, or renders each segment differently (link vs. plain text).
 */
export function detectLinks(text) {
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    const index = match.index;
    if (index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, index) });
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch { /* not a real URL - fall back to showing it verbatim */ }
    segments.push({ type: 'link', value: url, hostname });
    lastIndex = index + url.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}
