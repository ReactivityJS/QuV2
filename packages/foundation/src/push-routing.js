/**
 * PUSH ROUTING — the generic replacement for what used to be a hard-coded
 * if/else chain in @qu/relay's `#deliverThreadPush()`: recognizing which
 * app a Thread write belongs to, which of that app's declared
 * `pushActions` applies, and how to word the resulting notification.
 * Pure functions over the SAME manifest catalog shape `/apps.json` already
 * serves (see @qu/relay/apps-catalog.js's `buildAppsCatalog()`) - no
 * relay-specific state, fully unit-testable without booting a relay.
 *
 * The matching algorithm, given one app whose `spacePattern` matched a
 * write's `spaceId` (see `matchTemplate()`/`fillTemplate()` in
 * templates.js for the `{param}` mechanics both directions share):
 *   1. Any of that app's `pushActions` with a `threadIdPattern` is tried
 *      FIRST, in manifest declaration order - the first one whose pattern
 *      matches the write's `threadId` wins. This is thread-SHAPE-driven,
 *      independent of whether the write happened to @mention this
 *      recipient (e.g. Calendar's `guestInvite`/`eventChange`/`invite`,
 *      distinguished purely by `threadId` shape).
 *   2. Otherwise, among the REMAINING actions (no `threadIdPattern` - a
 *      "generic" action), the one whose `requiresMention` agrees with
 *      whether this write actually @mentioned the recipient wins (e.g.
 *      Chat/Forum/Inbox's `mention` vs `newMessage`, which share the same
 *      `threadId` and are told apart only by the mention flag).
 *   3. If the app matched but no action did (or an app declares no
 *      `pushActions` at all), the app is still correctly identified
 *      (`appId`/notification-prefs bucket), just with no specific
 *      action - `resolvePushPayload()` below falls back to generic
 *      wording for exactly this case, field by field.
 *   4. If NO app's `spacePattern` matches at all (an app that hasn't
 *      adopted this mechanism, or none loaded), `appId` falls back to the
 *      raw `spaceId` - the same fallback @qu/relay used unconditionally
 *      before this file existed.
 */
import { matchTemplate, fillTemplate } from './templates.js';

/**
 * @param {Array<{name: string, spacePattern?: string, pushActions?: Array<object>}>} apps -
 *   The manifest catalog (e.g. `buildAppsCatalog()`'s output, or `/apps.json`).
 * @param {string} spaceId
 * @param {string} threadId
 * @param {{mention: boolean}} context
 * @returns {{appId: string, action: object|null, params: Record<string, string>}}
 *   `params` are the `{param}`s extracted from `spacePattern`/`threadIdPattern`
 *   (e.g. `{calendarId: "..."}`), NOT including the standard params
 *   `resolvePushPayload()` adds separately (`authorPub`, `roomId`, ...).
 */
export function matchPushAction(apps, spaceId, threadId, { mention }) {
  for (const app of apps ?? []) {
    if (!app.spacePattern) continue;
    const params = matchTemplate(app.spacePattern, spaceId);
    if (!params) continue;

    for (const action of app.pushActions ?? []) {
      if (!action.threadIdPattern) continue;
      const threadParams = matchTemplate(action.threadIdPattern, threadId);
      if (threadParams) return { appId: app.name, action, params: { ...params, ...threadParams } };
    }
    for (const action of app.pushActions ?? []) {
      if (action.threadIdPattern) continue;
      if (Boolean(action.requiresMention) === Boolean(mention)) return { appId: app.name, action, params };
    }
    return { appId: app.name, action: null, params };
  }
  return { appId: spaceId, action: null, params: {} };
}

/**
 * @param {{appId: string, action: object|null, params: Record<string, string>}} matched - As returned by `matchPushAction()`.
 * @param {{authorPub: string|null, authorShort: string, threadId: string, roomId: string, mention: boolean}} standardParams -
 *   Computed by the caller (see @qu/relay's `#deliverThreadPush()`) -
 *   ALWAYS available to every template, on top of `matched.params`.
 *   `roomId` is the generic "which room/thread does a deep-link open"
 *   value (e.g. a private 1:1-vs-group Thread's `config.kind === 'group'
 *   ? threadId : authorPub` - see relay.js's own doc comment), deliberately
 *   computed by the caller since it needs `config`, which this pure
 *   module has no access to.
 * @returns {{appId: string, title: string, body: string, url: string}}
 */
export function resolvePushPayload({ appId, action, params }, standardParams) {
  const all = { ...params, ...standardParams };
  const genericTitle = standardParams.mention ? `Mentioned in ${appId}` : `New message in ${appId}`;
  const genericBody = `~${(standardParams.authorPub ?? 'someone').slice(0, 10)}… sent a message`;
  return {
    appId,
    title: action?.titleTemplate ? fillTemplate(action.titleTemplate, all) : genericTitle,
    body: action?.bodyTemplate ? fillTemplate(action.bodyTemplate, all) : genericBody,
    url: action?.urlTemplate ? fillTemplate(action.urlTemplate, all) : `#/${appId}`,
  };
}
