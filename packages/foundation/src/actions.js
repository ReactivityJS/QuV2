/**
 * ACTIONS — pure helpers over the manifest catalog's declarative `actions`
 * field (see manifest.js's own doc comment for the full "mounts and
 * actions" rationale). No state, no registry instance: every app already
 * has the full catalog in hand (it's `/apps.json`, fetched once by the
 * shell and handed to every mounted app as `ctx.apps` - see
 * apps/shell/src/main.js), so filtering it for one mount id is just a pure
 * function over an array a caller already has.
 *
 * This is deliberately NOT the same mechanism as Registry.registerCapability
 * (see registry.js) - that one's for a runtime JS handler, which only makes
 * sense between packages that are ACTUALLY loaded together in the same
 * process (Engines/Services, server-side). A UI "mount" here crosses app
 * boundaries where only ONE app's `clientMain` is ever loaded/mounted at a
 * time (see apps/shell/src/main.js's `_renderRoute()` - the previous app is
 * unmounted before the next one's module is even imported), so an action
 * can only ever be DATA (a label/icon/href template), never a live function
 * reference to code that isn't there.
 */

/**
 * @param {Array<{name: string, actions?: Array<{mount: string, id: string, label: string, icon?: string, hrefTemplate: string, order?: number}>}>} apps -
 *   The manifest catalog (e.g. `ctx.apps`, see apps/shell/src/main.js).
 * @param {string} mountId - e.g. `"contact-row"`.
 * @returns {Array<{appId: string, id: string, label: string, icon: string|null, hrefTemplate: string}>}
 *   Every action any loaded app declared for this mount, sorted by its
 *   `order` (lower first, ties broken by declaration order) - empty if none.
 */
export function actionsForMount(apps, mountId) {
  const found = [];
  for (const app of apps ?? []) {
    for (const action of app.actions ?? []) {
      if (action.mount !== mountId) continue;
      found.push({
        appId: app.name,
        id: action.id,
        label: action.label,
        icon: action.icon ?? null,
        hrefTemplate: action.hrefTemplate,
        order: action.order ?? 0,
      });
    }
  }
  return found
    .sort((a, b) => a.order - b.order)
    .map(({ appId, id, label, icon, hrefTemplate }) => ({ appId, id, label, icon, hrefTemplate }));
}

/**
 * Fills in an action's `hrefTemplate` (e.g. `"#/chat/{pub}"`) with concrete
 * values, URL-encoding each substitution.
 * @param {{id: string, hrefTemplate: string}} action - As returned by `actionsForMount()`.
 * @param {Record<string, string>} params - e.g. `{pub: actorPub}`.
 * @returns {string} The resolved href, e.g. `"#/chat/AbC123..."`.
 * @throws {Error} If the template references a param that wasn't provided.
 */
export function resolveActionHref(action, params) {
  return action.hrefTemplate.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in params)) throw new Error(`resolveActionHref: action "${action.id}" needs param "${key}", got none`);
    return encodeURIComponent(params[key]);
  });
}
