/**
 * ACTIONS — pure helpers over the manifest catalog's declarative `actions`
 * field (see manifest.js's own doc comment for the full "action slots"
 * rationale). No state, no registry instance: every app already has the
 * full catalog in hand (it's `/apps.json`, fetched once by the shell and
 * handed to every mounted app as `ctx.apps` - see apps/shell/src/main.js),
 * so filtering it for one slot id is just a pure function over an array a
 * caller already has.
 *
 * Named "slot" (not "mount", an earlier name) to avoid colliding with two
 * OTHER, unrelated meanings already in this codebase: the DOM-mounting
 * sense (`mod.mount(container, ctx)`, see apps/shell/src/main.js) and
 * @qu/foundation's own `HookBus` (see hooks.js), which is the actual
 * "hook" in this system - a live, imperative JS callback, the opposite of
 * what this file does. A slot here is pure DATA (a label/icon/href
 * template): this is deliberately NOT the same mechanism as
 * Registry.registerCapability (see registry.js) - that one's for a
 * runtime JS handler, which only makes sense between packages that are
 * ACTUALLY loaded together in the same process (Engines/Services,
 * server-side). A UI slot here crosses app boundaries where only ONE
 * app's `clientMain` is ever loaded/mounted at a time (see
 * apps/shell/src/main.js's `_renderRoute()` - the previous app is
 * unmounted before the next one's module is even imported), so an action
 * can only ever be DATA, never a live function reference to code that
 * isn't there.
 */
import { fillTemplate } from './templates.js';

/**
 * @param {Array<{name: string, actions?: Array<{slot: string, id: string, label: string, icon?: string, hrefTemplate: string, order?: number}>}>} apps -
 *   The manifest catalog (e.g. `ctx.apps`, see apps/shell/src/main.js).
 * @param {string} slotId - e.g. `"contact-row"`.
 * @returns {Array<{appId: string, id: string, label: string, icon: string|null, hrefTemplate: string}>}
 *   Every action any loaded app declared for this slot, sorted by its
 *   `order` (lower first, ties broken by declaration order) - empty if none.
 */
export function actionsForSlot(apps, slotId) {
  const found = [];
  for (const app of apps ?? []) {
    for (const action of app.actions ?? []) {
      if (action.slot !== slotId) continue;
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
 * @param {{id: string, hrefTemplate: string}} action - As returned by `actionsForSlot()`.
 * @param {Record<string, string>} params - e.g. `{pub: actorPub}`.
 * @returns {string} The resolved href, e.g. `"#/chat/AbC123..."`.
 * @throws {Error} If the template references a param that wasn't provided.
 */
export function resolveActionHref(action, params) {
  return fillTemplate(action.hrefTemplate, params, { encode: true });
}
