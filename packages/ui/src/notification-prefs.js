/**
 * `renderNotificationPrefsSection()` — the reusable "which notifications do
 * I want" form: a global on/off, a global @mention on/off, and one toggle
 * row per (app, pushAction) pair, all backed by
 * NotificationPrefsService.savePrefs()/getOwnPrefs(). Extracted out of
 * apps/notifications/client.js (this codebase's one central Notifications
 * screen) so it can ALSO be embedded directly inside any individual app's
 * own future settings area (see the Phase-7 roadmap's "Settings-Bereich
 * für User spezifische Einstellungen" - each app is meant to eventually
 * offer its OWN settings entry point, not just a central one) without
 * duplicating this logic there.
 *
 * `filterAppId` (optional) narrows the per-app rows to just ONE app - the
 * central Notifications screen calls this with no filter (today's exact
 * behavior, every loaded app's declared `pushActions`); a future
 * per-app settings screen would pass its own `name` and get just its own
 * rows, no other app's code involved.
 *
 * Self-contained styling (its own `injectStyle()` call, own class names) -
 * deliberately NOT coupled to apps/notifications' own `.qu-notif-*`
 * classes, since this is meant to be dropped into a DIFFERENT app's UI too.
 *
 * Async (unlike `renderFlagToggle()`'s sync-then-populate shape) because
 * EVERY row here depends on `getOwnPrefs()` - there's no meaningful
 * "empty" state to render before that resolves, so the caller awaits the
 * whole section instead of appending a still-loading skeleton.
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-notification-prefs-style';
const STYLE = `
  .qu-notification-prefs-section { margin: 1rem 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-notification-prefs-row { display: flex; align-items: center; gap: 0.6rem; }
  .qu-notification-prefs-apps { display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-notification-prefs-status { opacity: 0.7; font-size: 0.85em; }
`;

function toggleRow(label, checked) {
  const row = document.createElement('label');
  row.className = 'qu-notification-prefs-row';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  const span = document.createElement('span');
  span.textContent = label;
  row.append(checkbox, span);
  return { row, checkbox };
}

/**
 * @param {object} options
 * @param {{notificationPrefs: import('@qu/services').NotificationPrefsService}} options.services
 * @param {Array<{name: string, label?: string, icon?: string, pushActions?: Array<{id: string, label: string}>}>} options.appsCatalog -
 *   The manifest catalog (e.g. `/apps.json` - see @qu/relay/apps-catalog.js).
 * @param {string|null} [options.filterAppId] - Restrict rows to one app's OWN pushActions.
 * @param {{globalEnabled: string, mentions: string, perApp: string, save: string, saved: string}} options.labels - Pre-translated strings (this package doesn't own its own i18n dictionary - see @qu/ui's `renderFlagToggle()` for the same caller-supplies-strings convention).
 * @returns {Promise<HTMLElement>}
 */
export async function renderNotificationPrefsSection({ services, appsCatalog, filterAppId = null, labels }) {
  injectStyle(STYLE_ID, STYLE);
  const prefs = await services.notificationPrefs.getOwnPrefs();

  const section = document.createElement('div');
  section.className = 'qu-notification-prefs-section';

  const enabledRow = toggleRow(labels.globalEnabled, prefs.enabled);
  const mentionsRow = toggleRow(labels.mentions, prefs.mentions);

  const notifyingApps = appsCatalog.filter((a) => a.pushActions?.length && (!filterAppId || a.name === filterAppId));

  const perAppHeading = document.createElement('h2');
  perAppHeading.textContent = labels.perApp;
  const appsEl = document.createElement('div');
  appsEl.className = 'qu-notification-prefs-apps';
  // Map<appId, Map<actionId, checkbox>> - one row per (app, action) pair,
  // e.g. "💭 Chat — Mentions", not one row per app - an app can trigger
  // more than one KIND of notification, each independently toggleable.
  const actionToggles = new Map();
  for (const app of notifyingApps) {
    if (!filterAppId) {
      const appHeading = document.createElement('strong');
      appHeading.textContent = `${app.icon ?? ''} ${app.label ?? app.name}`.trim();
      appsEl.appendChild(appHeading);
    }
    const byAction = new Map();
    for (const action of app.pushActions) {
      const enabled = prefs.apps?.[app.name]?.functions?.[action.id] !== false; // default on
      const row = toggleRow(action.label, enabled);
      byAction.set(action.id, row.checkbox);
      appsEl.appendChild(row.row);
    }
    actionToggles.set(app.name, byAction);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = labels.save;
  const status = document.createElement('span');
  status.className = 'qu-notification-prefs-status';

  saveBtn.addEventListener('click', async () => {
    const appsPatch = {};
    for (const [appId, byAction] of actionToggles) {
      const functions = {};
      for (const [actionId, checkbox] of byAction) functions[actionId] = checkbox.checked;
      appsPatch[appId] = { functions };
    }
    await services.notificationPrefs.savePrefs({
      enabled: enabledRow.checkbox.checked,
      mentions: mentionsRow.checkbox.checked,
      apps: appsPatch,
    });
    status.textContent = labels.saved;
    setTimeout(() => { status.textContent = ''; }, 1500);
  });

  section.append(enabledRow.row, mentionsRow.row, perAppHeading, appsEl, saveBtn, status);
  return section;
}
