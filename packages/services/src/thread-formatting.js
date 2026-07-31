/**
 * THREAD FORMATTING — optional, pluggable content transforms a Thread's
 * `config.formatting` list opts into. This is intentionally a small,
 * dependency-free, HONEST subset:
 *
 *   - `mentions` - extracts `@<actorId>` tokens for notification routing.
 *     Does NOT rewrite the body; a UI renders mentions from the returned
 *     list however it likes (link, highlight, ...).
 *   - `markdown` - a genuinely safe (HTML-escaped first, then a handful of
 *     whitelisted substitutions) but deliberately MINIMAL subset: bold,
 *     italic, http(s) links, line breaks. This is not a CommonMark
 *     implementation - it's exactly enough to prove "formatting is a
 *     pluggable, per-thread capability" without pulling in (or
 *     hand-rolling) a full parser. A real deployment wanting full Markdown
 *     support swaps this one function for a proper library; every other
 *     part of ThreadService is unaffected either way.
 *
 * Both run over the RAW body - never over each other's output - so there is
 * exactly one place text becomes HTML (formatMarkdown, which escapes before
 * substituting) and exactly one place it becomes a list of ids (extractMentions).
 */

const MENTION_RE = /@([A-Za-z0-9_-]{16,64})/g;

/**
 * @param {string} body
 * @returns {string[]} Unique candidate actor ids (base64url-shaped tokens) mentioned in the text.
 */
export function extractMentions(body) {
  const found = new Set();
  for (const match of body.matchAll(MENTION_RE)) found.add(match[1]);
  return [...found];
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {string} body
 * @returns {string} HTML-safe markup: bold/italic/http(s)-links/line-breaks only.
 */
export function formatMarkdown(body) {
  let html = escapeHtml(body);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // http(s) only, on purpose - a javascript:/data: URL here would be a stored-XSS vector once rendered.
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

/**
 * Applies every formatter named in `formatterNames` to `body`.
 * @param {string} body
 * @param {string[]} [formatterNames]
 * @returns {{formattedHtml: string|null, mentions: string[]}}
 */
export function applyFormatting(body, formatterNames = []) {
  return {
    formattedHtml: formatterNames.includes('markdown') ? formatMarkdown(body) : null,
    mentions: formatterNames.includes('mentions') ? extractMentions(body) : [],
  };
}
