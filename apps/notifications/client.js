/**
 * NOTIFICATIONS — the settings screen for @qu/relay's push delivery (see
 * relay.js's `#deliverThreadPush()`): turn browser push on/off for this
 * device, and the granular preferences (@mention, per-app) that decide
 * WHICH of those pushes actually get sent - see
 * @qu/services/notification-prefs-service.js for why these preferences
 * are public/signed rather than private (the relay has to be able to read
 * them to decide whether to push at all).
 *
 * The per-app list here is a fixed, small set (the built-in apps that
 * actually trigger pushes today - Forum/Chat/Inbox, all Thread-backed) -
 * there's no manifest field yet for "this app produces notifications" to
 * discover it generically; a real third-party notification-producing app
 * would need its id added here (or, as future work, such a field added to
 * the manifest schema and this list built from it).
 */
import { subscribeToPush, unsubscribeFromPush, isPushSubscribed } from '@qu/push-client';
import { createI18n } from '@qu/i18n';

const NOTIFYING_APPS = [
  { id: 'forum', label: 'Forum', icon: '💬' },
  { id: 'chat', label: 'Chat', icon: '💭' },
  { id: 'inbox', label: 'Inbox', icon: '📥' },
];

const DICT = {
  en: {
    title: 'Notifications',
    devicePush: 'Push on this device',
    enablePush: 'Enable',
    disablePush: 'Disable',
    pushError: 'Could not enable push notifications: {message}',
    globalEnabled: 'Notifications enabled',
    mentions: '@mention notifications',
    perApp: 'Per app',
    save: 'Save',
    saved: 'Saved',
  },
  de: {
    title: 'Benachrichtigungen',
    devicePush: 'Push auf diesem Gerät',
    enablePush: 'Aktivieren',
    disablePush: 'Deaktivieren',
    pushError: 'Push-Benachrichtigungen konnten nicht aktiviert werden: {message}',
    globalEnabled: 'Benachrichtigungen aktiviert',
    mentions: '@mention-Benachrichtigungen',
    perApp: 'Pro App',
    save: 'Speichern',
    saved: 'Gespeichert',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-notifications-style';
const STYLE = `
  .qu-notif-section { margin: 1rem 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-notif-row { display: flex; align-items: center; gap: 0.6rem; }
  .qu-notif-apps { display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-notif-error { color: #c00; font-size: 0.9em; }
  .qu-notif-status { opacity: 0.7; font-size: 0.85em; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { services }) {
  ensureStyle();
  let stopped = false;

  (async () => {
    const [prefs, subscribed] = await Promise.all([services.notificationPrefs.getOwnPrefs(), isPushSubscribed()]);
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    // --- Device push subscription ---
    const deviceSection = document.createElement('div');
    deviceSection.className = 'qu-notif-section';
    const deviceRow = document.createElement('div');
    deviceRow.className = 'qu-notif-row';
    const deviceLabel = document.createElement('span');
    deviceLabel.textContent = t('devicePush');
    const deviceBtn = document.createElement('button');
    deviceBtn.type = 'button';
    const errorEl = document.createElement('p');
    errorEl.className = 'qu-notif-error';

    let isSubscribed = subscribed;
    function renderDeviceButton() {
      deviceBtn.textContent = isSubscribed ? t('disablePush') : t('enablePush');
    }
    renderDeviceButton();
    deviceBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      try {
        if (isSubscribed) await unsubscribeFromPush(services.pushSubscriptions);
        else await subscribeToPush(services.pushSubscriptions);
        isSubscribed = !isSubscribed;
        renderDeviceButton();
      } catch (err) {
        errorEl.textContent = t('pushError', { message: err.message });
      }
    });
    deviceRow.append(deviceLabel, deviceBtn);
    deviceSection.append(deviceRow, errorEl);
    container.appendChild(deviceSection);

    // --- Granular preferences ---
    const prefsSection = document.createElement('div');
    prefsSection.className = 'qu-notif-section';

    const enabledRow = toggleRow(t('globalEnabled'), prefs.enabled);
    const mentionsRow = toggleRow(t('mentions'), prefs.mentions);

    const perAppHeading = document.createElement('h2');
    perAppHeading.textContent = t('perApp');
    const appsEl = document.createElement('div');
    appsEl.className = 'qu-notif-apps';
    const appToggles = new Map();
    for (const app of NOTIFYING_APPS) {
      const appEnabled = prefs.apps?.[app.id]?.enabled !== false; // default on
      const row = toggleRow(`${app.icon} ${app.label}`, appEnabled);
      appToggles.set(app.id, row.checkbox);
      appsEl.appendChild(row.row);
    }

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = t('save');
    const status = document.createElement('span');
    status.className = 'qu-notif-status';

    saveBtn.addEventListener('click', async () => {
      const apps = {};
      for (const [appId, checkbox] of appToggles) apps[appId] = { enabled: checkbox.checked };
      await services.notificationPrefs.savePrefs({
        enabled: enabledRow.checkbox.checked,
        mentions: mentionsRow.checkbox.checked,
        apps,
      });
      status.textContent = t('saved');
      setTimeout(() => { status.textContent = ''; }, 1500);
    });

    prefsSection.append(enabledRow.row, mentionsRow.row, perAppHeading, appsEl, saveBtn, status);
    container.appendChild(prefsSection);
  })();

  return () => { stopped = true; };
}

function toggleRow(label, checked) {
  const row = document.createElement('label');
  row.className = 'qu-notif-row';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  const span = document.createElement('span');
  span.textContent = label;
  row.append(checkbox, span);
  return { row, checkbox };
}
