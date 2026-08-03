/**
 * THREAD FORMATTING — optional, pluggable content transforms a Thread's
 * `config.formatting` list opts into. This is intentionally a small,
 * dependency-free, HONEST subset, not a CommonMark implementation - exactly
 * enough to prove "formatting is a pluggable, per-thread capability" without
 * pulling in (or hand-rolling) a full parser:
 *
 *   - `mentions` - extracts `@<actorId>` tokens for notification routing
 *     (see @qu/relay's push-delivery, which reads this list). Independent
 *     of `markdown`: a thread can extract mentions for notifications
 *     without also wanting them visually rendered, though `formatMarkdown()`
 *     below always renders `@mentions` inline regardless of whether this
 *     formatter is separately enabled - the two are different concerns
 *     (notification routing vs. how the text looks).
 *   - `markdown` - HTML-escaped first, then a whitelisted set of
 *     substitutions applied in a fixed order chosen so none of them can
 *     corrupt one another: protect code spans first (nothing after this
 *     point may rewrite what's inside a code span - the same rule a real
 *     parser follows), then mentions/hashtags/spoilers/bold/italic/links/
 *     auto-links/line-breaks, then restore the protected code last. A real
 *     deployment wanting full Markdown support swaps this one function for
 *     a proper library; every other part of ThreadService is unaffected
 *     either way.
 *
 * Both run over the RAW body - never over each other's output - so there is
 * exactly one place text becomes HTML (formatMarkdown, which escapes before
 * substituting) and exactly one place it becomes a list of ids (extractMentions).
 */
import { URL_RE_GLOBAL } from './link-detect.js';

const MENTION_RE = /@([A-Za-z0-9_-]{16,64})/g;
const HASHTAG_RE = /(^|\s)#(\w+)/g;
const SPOILER_RE = /\|\|([^|]+)\|\|/g;
// Fenced code requires a newline right after the opening ``` (even with no
// language tag) - a same-line ```like this``` is deliberately NOT treated
// as a fenced block (falls through to inline-code handling below instead,
// or plain escaped text if that doesn't match either - an honest subset,
// not a full parser, per this file's own doc comment).
const FENCED_CODE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
// Looks like an HTML entity but isn't a real one - safe as a placeholder
// specifically BECAUSE escapeHtml() already ran before any of these are
// ever inserted: a literal "&" typed by a user became "&amp;" by then, so
// there is no way real message text can already contain a bare
// "&qufmt0;"-shaped sequence for this to collide with.
const PLACEHOLDER_RE = /&qufmt(\d+);/g;

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
 * @returns {string} HTML-safe markup: code spans, spoilers, hashtags,
 *   mentions, bold/italic, links (markdown-style and bare auto-linked),
 *   line breaks.
 */
export function formatMarkdown(body) {
  let html = escapeHtml(body);

  // Every "protect this exact HTML from later transforms" step below
  // stashes its finished markup here and leaves a placeholder behind,
  // restored in ONE final pass - so nothing produced by an earlier step
  // (e.g. an `<a href="...">` from the links step) can be accidentally
  // re-matched and double-wrapped by a later step (e.g. the bare-URL
  // auto-linker matching the same URL a second time inside that href).
  const protectedSegments = [];
  const protect = (segment) => {
    protectedSegments.push(segment);
    return `&qufmt${protectedSegments.length - 1};`;
  };

  // Code spans are protected FIRST and restored LAST - never reprocessed by
  // anything below, matching a real parser's "code isn't markdown" rule
  // (so e.g. `*not italic*` typed inside a code span stays literal).
  html = html.replace(FENCED_CODE_RE, (_m, _lang, code) => protect(`<pre class="qu-code-block"><code>${code}</code></pre>`));
  html = html.replace(INLINE_CODE_RE, (_m, code) => protect(`<code class="qu-inline-code">${code}</code>`));

  // Mentions - same pattern extractMentions() finds, rendered as a link to
  // that identity's public profile route using a short pub (matching this
  // codebase's other short-pub displays, e.g. the shell header's identity
  // link) - not a live-resolved alias: the message body is immutable once
  // posted, same as every other part of its rendered text.
  html = html.replace(MENTION_RE, (_m, pub) => protect(`<a href="#/~${pub}" class="qu-mention">@${pub.slice(0, 10)}…</a>`));

  // Hashtags - styled only, not linked: no search-by-tag feature exists to
  // link TO yet (see this file's own "honest subset" philosophy above).
  // The (^|\s) requirement stops a URL fragment like ".../page#section"
  // from matching - it's never preceded by whitespace/string-start there.
  html = html.replace(HASHTAG_RE, (_m, pre, tag) => `${pre}<span class="qu-hashtag">#${tag}</span>`);

  // Spoiler (Discord-style ||text||) - the click-to-reveal interaction is
  // pure UI (see @qu/thread-ui's renderBody()); this only marks the span.
  html = html.replace(SPOILER_RE, '<span class="qu-spoiler">$1</span>');

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // http(s) only, on purpose - a javascript:/data: URL here would be a
  // stored-XSS vector once rendered.
  html = html.replace(MD_LINK_RE, (_m, text, url) => protect(`<a href="${url}" rel="noopener noreferrer">${text}</a>`));

  // Auto-link any remaining bare http(s) URL not already part of a
  // [text](url) link above (which is already protected/placeholdered by
  // now, so this can never double-wrap it or match the same URL twice) -
  // same URL detection @qu/services' link-detect.js gives apps/chat's own
  // DOM-based renderer (which never opts into 'markdown' - see that file),
  // one implementation instead of two independently-drifting regexes.
  html = html.replace(URL_RE_GLOBAL, (url) => protect(`<a href="${url}" rel="noopener noreferrer">${url}</a>`));

  html = html.replace(/\n/g, '<br>');

  // Restore every protected segment last, in one pass - after every other
  // transform above had its chance to run on the surrounding text only.
  html = html.replace(PLACEHOLDER_RE, (_m, i) => protectedSegments[Number(i)]);
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
