/**
 * ACTOR FORMAT — the "how do we show/search for an actor who might not
 * have set an alias yet" convention, previously duplicated identically in
 * apps/contact-list/client.js and apps/user-list/client.js (the two places
 * that render a plain list of actors with a search filter).
 */

/**
 * @param {string} actorPub
 * @param {{alias?: string}|null|undefined} profile
 * @returns {string} The actor's alias, or a truncated pubkey fallback for
 *   one who hasn't set one - what a contact/user row's name and a11y label
 *   both show.
 */
export function formatActorLabel(actorPub, profile) {
  return profile?.alias || `~${actorPub.slice(0, 16)}…`;
}

/**
 * @param {string} actorPub
 * @param {{alias?: string}|null|undefined} profile
 * @param {string} query - Free-text search input, typically straight from
 *   a search box's current value.
 * @returns {boolean} Whether this actor matches - alias OR pubkey
 *   substring, case-insensitive; an empty/whitespace-only query always
 *   matches (i.e. "show everything" is the no-filter state, not "match nothing").
 */
export function matchesActorQuery(actorPub, profile, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (profile?.alias || '').toLowerCase().includes(q) || actorPub.toLowerCase().includes(q);
}
