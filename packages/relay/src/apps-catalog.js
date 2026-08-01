/**
 * APPS CATALOG — builds the JSON `/apps.json` serves: every loaded app's
 * nav-relevant manifest fields, plus a resolved, ready-to-fetch
 * `clientMainUrl` (see @qu/foundation's manifest schema for why
 * `clientMain` needs resolving at all - it's a path relative to wherever
 * the app was loaded FROM, local directory or remote manifest URL, and a
 * browser shell has no way to know which on its own).
 *
 * This is the self-generating menu's actual data source (see apps/shell) -
 * directly analogous to the real Qu's `/relay/services` endpoint
 * (`server/service-registry.mjs`'s `toJSON()`), just backed by
 * @qu/loader's manifests instead of a hand-maintained service-registry.
 */

/**
 * @param {import('@qu/loader').QuLoader} loader
 * @param {string[]} [disabledAppNames] - Names an admin has turned off (see
 *   relay.js's `POST /admin/settings`) - still LISTED (relay-admin needs to
 *   see and re-enable them), just marked `enabled: false`. Every OTHER
 *   consumer of this catalog already filters on that flag - see
 *   apps/shell/src/nav.js's `resolveFavoriteApps()` and apps/app-list's own
 *   identical filter, both written before anything actually set it to
 *   false - and apps/shell/src/main.js's `_renderRoute()`, which treats a
 *   disabled app exactly like an unknown one.
 * @returns {Array<object>} One entry per loaded app with a `clientMain` (apps
 *   without one - pure server-side Engines/Services - are omitted; there's
 *   nothing for a shell to mount for them).
 */
export function buildAppsCatalog(loader, disabledAppNames = []) {
  const out = [];
  for (const { manifest, originUrl } of loader.listManifests()) {
    if (!manifest.clientMain) continue;
    out.push({
      name: manifest.name,
      label: manifest.label ?? manifest.name,
      icon: manifest.icon,
      navOrder: manifest.navOrder,
      clientMainUrl: resolveClientMainUrl(manifest, originUrl),
      clientIntegrity: manifest.clientIntegrity,
      clientSignature: manifest.clientSignature,
      enabled: !disabledAppNames.includes(manifest.name),
      pushActions: manifest.pushActions ?? [],
    });
  }
  return out;
}

function resolveClientMainUrl(manifest, originUrl) {
  if (originUrl) {
    // Loaded from a remote manifest URL - resolve clientMain the same way
    // @qu/loader's loadRemote() resolves `main`, relative to that URL.
    return new URL(manifest.clientMain, originUrl).href;
  }
  // Local - this relay serves it itself under /apps/<name>/ (see static-apps.js).
  return `/apps/${manifest.name}/${manifest.clientMain.replace(/^\.\//, '')}`;
}
