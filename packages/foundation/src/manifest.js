/**
 * MANIFEST — the declarative description every loadable Qu package
 * (Engine, Service or App) ships as `manifest.quapp` (a plain JSON file).
 *
 * This is the concrete implementation of the "Foundation" idea from the
 * architecture brainstorming: packages declare what they need and what they
 * provide, so the Loader can resolve dependencies and third parties can
 * write Engines/Services/Apps without ever touching Qu Core directly.
 *
 * Example (an app):
 *   {
 *     "name": "forum",
 *     "version": "1.0.0",
 *     "kind": "app",
 *     "main": "./index.js",
 *     "requires": ["thread-engine", "document-service", "notification-service"]
 *   }
 *
 * Example (an engine that registers itself):
 *   {
 *     "name": "thread-engine",
 *     "version": "1.0.0",
 *     "kind": "engine",
 *     "main": "./index.js",
 *     "requires": ["document-service"],
 *     "provides": ["thread-engine"]
 *   }
 *
 * Example (a UI app a shell mounts in-place, see apps/shell):
 *   {
 *     "name": "notes",
 *     "version": "1.0.0",
 *     "kind": "app",
 *     "main": "./index.js",
 *     "clientMain": "./client.js",
 *     "label": "Notes",
 *     "icon": "📝",
 *     "navOrder": 20,
 *     "requires": ["document-service", "collection-service"]
 *   }
 */

/** Fields every manifest must have. */
export const REQUIRED_FIELDS = Object.freeze(['name', 'version', 'main']);

/** The three kinds of package the Loader understands. Apps are UI-only by convention (see brainstorming). */
export const MANIFEST_KINDS = Object.freeze(['engine', 'service', 'app']);

/** The small shared vocabulary a `pushActions` entry's optional `type` may use - see that field's own doc comment below for why. */
export const PUSH_ACTION_TYPES = Object.freeze(['create', 'update', 'delete', 'mention', 'custom']);

/**
 * @typedef {Object} Manifest
 * @property {string} name - Unique registry name, e.g. "thread-engine".
 * @property {string} version - Semver string. Only used for display today;
 *   the DependencyResolver checks *presence*, not version ranges (see there
 *   for why we deliberately don't do semver resolution yet).
 * @property {string} main - Path (relative to the manifest) to the ES module
 *   to `import()`.
 * @property {'engine'|'service'|'app'} [kind='app']
 * @property {string[]} [requires] - Names that must already be registered
 *   (or become registered as a side effect of loading) before this package
 *   loads.
 * @property {string[]} [provides] - Names this package registers into the
 *   Registry once loaded. Used to verify the package kept its promise.
 * @property {string[]} [capabilities] - Action names this package
 *   contributes (e.g. "reply", "pin", "mute") - see Registry.registerCapability.
 * @property {string} [integrity] - "sha256-<base64>" of the main module's
 *   source, required for remote loading (see @qu/loader).
 * @property {string} [signature] - base64url Ed25519 signature over the main
 *   module's bytes, checked against loadRemote()'s trustedPublisherPubs.
 *
 * Nav/UI fields - all optional, purely descriptive metadata a shell reads to
 * build a self-generating menu (see apps/shell). None of these are enforced
 * by the Loader or Registry; a consumer that doesn't know about one simply
 * never reads it. This is the same "additive, non-breaking" stance the real
 * Qu's server/service-registry.mjs documents for its own manifest fields.
 * @property {string} [label] - Display name for nav/menus (defaults to `name`).
 * @property {string} [icon] - An emoji or icon identifier for nav rendering.
 * @property {number} [navOrder] - Sort hint within a nav listing (lower first).
 * @property {string} [clientMain] - Path (relative to the manifest) OR an
 *   absolute URL to a browser ES module exporting
 *   `mount(container, ctx) -> stopFn|void`, for a shell to mount this app's
 *   UI in-place (see apps/shell). Separate from `main`, which the Loader
 *   imports SERVER-SIDE (Node) to register Engines/Services - an app can
 *   have either, both, or (if it's UI-only) a trivial no-op `main`.
 * @property {string} [clientIntegrity] - "sha256-<base64>" of `clientMain`'s
 *   source. `integrity`/`signature` above cover `main`; `clientMain` is a
 *   DIFFERENT file a BROWSER fetches, so it gets its own pinning fields -
 *   see apps/shell/src/load-client-module.js.
 * @property {string} [clientSignature] - base64url Ed25519 signature over
 *   `clientMain`'s bytes, the `clientMain` counterpart to `signature`.
 * @property {string} [spacePattern] - How this app names the `spaceId`s its
 *   Threads live under, as a `{param}`-templated string (same syntax as
 *   `hrefTemplate` below, resolved by @qu/foundation/templates.js's
 *   `matchTemplate()`/`fillTemplate()`) - e.g. `"calendar-{calendarId}"`,
 *   `"inbox-{actorPub}"`, or a literal with no `{}` tokens at all for a
 *   single fixed space like `"chat"`/`"forum"`. This is what
 *   @qu/foundation/push-routing.js's `matchPushAction()` uses to recognize
 *   "which app does this write belong to" and extract e.g. `calendarId`
 *   generically, instead of @qu/relay hard-coding a regex per app (see
 *   that file's own doc comment for the full mechanism). ONE per app
 *   (unlike `pushActions`, which can have several) since every Thread an
 *   app creates shares the same space-naming convention. An app with no
 *   push-worthy Threads of its own simply omits this field - its writes
 *   fall back to the generic, un-templated notification wording
 *   `resolvePushPayload()` already produces for an unrecognized `spaceId`.
 * @property {Array<{id: string, label: string, type?: 'create'|'update'|'delete'|'mention'|'custom', threadIdPattern?: string, requiresMention?: boolean, titleTemplate?: string, bodyTemplate?: string, urlTemplate?: string, alwaysPush?: boolean}>} [pushActions] - Push-
 *   notification categories THIS app can trigger (e.g. `{id: "mention",
 *   label: "Mentions", type: "mention"}`, `{id: "newMessage", label: "New
 *   messages", type: "create"}`) -
 *   `id` is what @qu/relay's push delivery passes as `functionName` to
 *   NotificationPrefsService.shouldNotify() (see @qu/relay's
 *   `#deliverThreadPush()`), `label` is what the Notifications app's
 *   settings screen shows next to this app's name/icon for the toggle -
 *   see apps/notifications/client.js, which builds its whole per-app
 *   settings list from every loaded app's declared `pushActions` instead
 *   of a hard-coded list. An app with no push-worthy events of its own
 *   (most apps) simply omits this field.
 *   `type` is an OPTIONAL, purely descriptive taxonomy hint (treated as
 *   `'custom'` when omitted) - it exists so every app declaring a
 *   notification category uses the SAME small vocabulary from day one
 *   instead of inventing its own free-form `id` naming with no shared
 *   meaning.
 *   The remaining fields (all optional) are what
 *   @qu/foundation/push-routing.js's `matchPushAction()`/
 *   `resolvePushPayload()` read to pick WHICH action applies to a given
 *   write and how to word it - see that file's own doc comment for the
 *   full matching algorithm:
 *   - `threadIdPattern` - a `{param}`-templated match against the write's
 *     `threadId` (e.g. `"guest~{eventId}~{actorPub}"`, or an exact literal
 *     like `"activity"`) - narrows this action to a specific Thread shape.
 *     Omitted means "generic" (matches by `requiresMention` instead, see
 *     below) - checked BEFORE any generic action, so a specific pattern
 *     always wins over a fallback.
 *   - `requiresMention` - for a generic (no `threadIdPattern`) action
 *     only: `true` matches only a write that actually @mentioned this
 *     recipient, omitted/`false` matches only one that didn't - together
 *     these two shapes are how e.g. Chat/Forum/Inbox tell "mention" and
 *     "newMessage" apart, since both share the same `threadId`.
 *   - `titleTemplate`/`bodyTemplate`/`urlTemplate` - `{param}`-templated
 *     notification wording/deep-link, filled with this action's own
 *     matched params PLUS a standard set @qu/relay always provides
 *     (`authorPub`, `authorShort`, `threadId`, `roomId` - see
 *     `#deliverThreadPush()`'s own doc comment). Omitting all three keeps
 *     today's generic fallback wording for JUST this one action.
 *   - `alwaysPush` (default `false`) - skips Phase 7.4's presence-based
 *     suppression (no push while the recipient is visibly online) for
 *     THIS action specifically - e.g. for a future genuinely urgent alert
 *     type. None of today's actions need this; purely additive.
 * @property {Array<{slot: string, id: string, label: string, icon?: string, hrefTemplate: string, order?: number}>} [actions] -
 *   UI actions THIS app contributes to a named "slot" (an extension point
 *   some OTHER app renders, e.g. `"contact-row"`) - the concrete,
 *   declarative half of the "action slots" idea from the architecture
 *   brainstorming (see @qu/foundation/registry.js's `registerCapability`
 *   for the older, still-unused runtime-handler half of the same idea).
 *   Called a "slot", not a "mount", specifically to avoid colliding with
 *   this codebase's OTHER two uses of similar words: the DOM-mounting
 *   sense (`mod.mount(container, ctx)`) and @qu/foundation's own
 *   `HookBus` (see hooks.js) - a slot here is pure data, never a live
 *   callback, which is what "hook" means in THIS codebase. A
 *   slot-rendering app never imports the contributing app; it reads every
 *   loaded app's `actions` off the SAME manifest catalog it already
 *   fetched (`/apps.json`, see apps/shell/src/main.js), filters to its own
 *   slot id via `actionsForSlot()`, and builds one link per action with
 *   `hrefTemplate`'s `{param}` tokens filled in via `resolveActionHref()`
 *   (see @qu/foundation/actions.js) - e.g. Chat declares `{slot:
 *   "contact-row", id: "chat", hrefTemplate: "#/chat/{pub}", ...}`, and
 *   Contact List (which has never heard of Chat) renders it by resolving
 *   `{pub}` to each contact's actorPub. `order` is a sort hint, lower
 *   first (defaults to 0). An app with nothing to contribute to any slot
 *   simply omits this field.
 */

/**
 * Validates a parsed manifest object. Throws a descriptive error on the
 * first problem found rather than collecting all of them - manifests are
 * small and meant to be fixed one mistake at a time during development.
 *
 * @param {*} manifest
 * @returns {Manifest} the same object, for chaining.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: expected a JSON object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      throw new Error(`Invalid manifest: missing or non-string required field "${field}"`);
    }
  }
  if (manifest.kind !== undefined && !MANIFEST_KINDS.includes(manifest.kind)) {
    throw new Error(`Invalid manifest: "kind" must be one of ${MANIFEST_KINDS.join(', ')}, got "${manifest.kind}"`);
  }
  for (const field of ['requires', 'provides', 'capabilities']) {
    if (manifest[field] !== undefined) {
      if (!Array.isArray(manifest[field]) || !manifest[field].every((x) => typeof x === 'string')) {
        throw new Error(`Invalid manifest: "${field}" must be an array of strings`);
      }
    }
  }
  if (manifest.integrity !== undefined && !/^sha256-[A-Za-z0-9+/]+=*$/.test(manifest.integrity)) {
    throw new Error('Invalid manifest: "integrity" must look like "sha256-<base64>"');
  }
  for (const field of ['label', 'icon', 'clientMain', 'signature', 'clientSignature']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') {
      throw new Error(`Invalid manifest: "${field}" must be a string`);
    }
  }
  if (manifest.navOrder !== undefined && typeof manifest.navOrder !== 'number') {
    throw new Error('Invalid manifest: "navOrder" must be a number');
  }
  if (manifest.clientIntegrity !== undefined && !/^sha256-[A-Za-z0-9+/]+=*$/.test(manifest.clientIntegrity)) {
    throw new Error('Invalid manifest: "clientIntegrity" must look like "sha256-<base64>"');
  }
  if (manifest.spacePattern !== undefined && typeof manifest.spacePattern !== 'string') {
    throw new Error('Invalid manifest: "spacePattern" must be a string');
  }
  if (manifest.pushActions !== undefined) {
    const valid = Array.isArray(manifest.pushActions) && manifest.pushActions.every(
      (a) => a && typeof a === 'object' && typeof a.id === 'string' && typeof a.label === 'string'
        && (a.type === undefined || PUSH_ACTION_TYPES.includes(a.type))
        && (a.threadIdPattern === undefined || typeof a.threadIdPattern === 'string')
        && (a.requiresMention === undefined || typeof a.requiresMention === 'boolean')
        && (a.titleTemplate === undefined || typeof a.titleTemplate === 'string')
        && (a.bodyTemplate === undefined || typeof a.bodyTemplate === 'string')
        && (a.urlTemplate === undefined || typeof a.urlTemplate === 'string')
        && (a.alwaysPush === undefined || typeof a.alwaysPush === 'boolean')
    );
    if (!valid) {
      throw new Error(
        'Invalid manifest: "pushActions" must be an array of {id, label, type?, threadIdPattern?, requiresMention?, '
        + `titleTemplate?, bodyTemplate?, urlTemplate?, alwaysPush?} where type is one of ${PUSH_ACTION_TYPES.join(', ')}`
      );
    }
  }
  if (manifest.actions !== undefined) {
    const valid = Array.isArray(manifest.actions) && manifest.actions.every(
      (a) => a && typeof a === 'object'
        && typeof a.slot === 'string' && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.hrefTemplate === 'string'
        && (a.icon === undefined || typeof a.icon === 'string')
        && (a.order === undefined || typeof a.order === 'number')
    );
    if (!valid) throw new Error('Invalid manifest: "actions" must be an array of {slot, id, label, hrefTemplate, icon?, order?}');
  }
  return manifest;
}
