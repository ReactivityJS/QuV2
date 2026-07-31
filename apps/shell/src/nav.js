/**
 * NAV — pure catalog filtering/sorting for the self-generating menu. Kept
 * DOM-free (mirrors the real Qu's own shell/nav-catalog.mjs split) so the
 * logic is testable without a browser; main.js only wires the DOM.
 *
 * The catalog itself is whatever the relay's `/apps.json` endpoint returns
 * (see @qu/relay) - every currently loaded app's manifest, filtered to the
 * nav-relevant fields.
 */

/**
 * Which catalog entries the nav ever shows: not explicitly disabled, and
 * mountable (has a `clientMainUrl` a shell can actually load - see
 * @qu/relay's apps-catalog.js, which is what resolves a manifest's
 * `clientMain` into this absolute/root-relative URL in the first place).
 * @param {Array<object>} manifests
 * @returns {Array<object>}
 */
export function visibleApps(manifests) {
  return manifests.filter((m) => m.enabled !== false && !!m.clientMainUrl);
}

/** navOrder ascending (missing sorts last), then label/name as the tiebreak. */
export function sortByNavOrder(manifests) {
  return [...manifests].sort((a, b) => {
    const orderA = a.navOrder ?? Infinity;
    const orderB = b.navOrder ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return (a.label ?? a.name).localeCompare(b.label ?? b.name);
  });
}

/**
 * Resolves a favorited-appId list (see @qu/services' FavoritesService)
 * against the CURRENT catalog - a favorited id that's since been
 * removed/disabled is silently dropped, never a broken menu entry.
 * @param {Array<object>} manifests
 * @param {string[]} favoriteIds
 * @returns {Array<object>}
 */
export function resolveFavoriteApps(manifests, favoriteIds) {
  const byId = new Map(visibleApps(manifests).map((m) => [m.name, m]));
  return favoriteIds.map((id) => byId.get(id)).filter(Boolean);
}
