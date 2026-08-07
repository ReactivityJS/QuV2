/**
 * TEMPLATES — the `{param}` substitution convention shared by every
 * declarative, manifest-driven extension point in this codebase (action
 * slots' `hrefTemplate`, and Phase 7.6's push-routing `spacePattern`/
 * `threadIdPattern`/`titleTemplate`/`bodyTemplate`/`urlTemplate`) - one
 * tiny shared implementation instead of independently drifting copies.
 *
 * Two directions over the SAME syntax:
 *   - `fillTemplate()` - data -> string ("{pub}" + {pub: "AbC"} -> "AbC").
 *   - `matchTemplate()` - string -> data, the reverse ("calendar-{id}" +
 *     "calendar-abc123" -> {id: "abc123"}), used to recognize which app a
 *     concrete `spaceId`/`threadId` belongs to and extract its params.
 */

const TOKEN_RE = /\{(\w+)\}/g;

/**
 * @param {string} template - e.g. `"#/chat/{pub}"`.
 * @param {Record<string, string>} params
 * @param {{encode?: boolean}} [options] - URL-encode each substituted value
 *   (for a single URL segment, e.g. `hrefTemplate`) - leave off for a
 *   multi-segment route template (e.g. `urlTemplate`, which may embed
 *   several `{param}`s inside one hash-route string).
 * @returns {string}
 * @throws {Error} If the template references a param that wasn't provided.
 */
export function fillTemplate(template, params, { encode = false } = {}) {
  return template.replace(TOKEN_RE, (match, key) => {
    if (!(key in params)) throw new Error(`fillTemplate: template "${template}" needs param "${key}", got none`);
    return encode ? encodeURIComponent(params[key]) : params[key];
  });
}

/** Escapes every regex-special character in a literal (non-`{param}`) template fragment. */
function escapeRegExp(fragment) {
  return fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The reverse of `fillTemplate()`: turns a template into a pattern and
 * extracts the concrete value of each `{param}` from a real string, e.g.
 * `matchTemplate("calendar-{calendarId}", "calendar-abc123")` ->
 * `{calendarId: "abc123"}`. A template with no `{param}` tokens at all
 * (e.g. `"chat"`) is a plain exact-string match.
 * @param {string} template
 * @param {string} value
 * @returns {Record<string, string>|null} The extracted params (possibly
 *   empty), or `null` if `value` doesn't match the template's shape at all.
 */
export function matchTemplate(template, value) {
  const paramNames = [];
  let pattern = '';
  let lastIndex = 0;
  for (const match of template.matchAll(TOKEN_RE)) {
    pattern += escapeRegExp(template.slice(lastIndex, match.index));
    paramNames.push(match[1]);
    pattern += '([^/]+)'; // one path/space segment - never crosses a `/`, matching how spaceId/threadId segments are built (see @qu/services/paths.js)
    lastIndex = match.index + match[0].length;
  }
  pattern += escapeRegExp(template.slice(lastIndex));

  const matched = value.match(new RegExp(`^${pattern}$`));
  if (!matched) return null;
  const params = {};
  paramNames.forEach((name, i) => { params[name] = matched[i + 1]; });
  return params;
}
