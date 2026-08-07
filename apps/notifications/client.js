/**
 * NOTIFICATIONS — two views on the same underlying Thread (space
 * `notifications-<myPub>`, thread id `notifications`, THREAD_PRESETS.
 * notifications - see @qu/services/thread-service.js), matching
 * @qu/relay's `#writeInAppNotification()` which writes into that exact
 * space/thread whenever it decides a push-worthy event happened (see
 * relay.js's `#deliverThreadPush()`), independent of whether the recipient
 * has push enabled at all:
 *   - `#/notifications` (default): the feed itself - title/body/image
 *     (mirroring what's partially already done for push payloads),
 *     newest first, each linking to `extra.url`. Opening it marks
 *     everything as read (see ThreadService's `markRead()`), which is
 *     what clears the header's bell badge - see the `qu:notifications-read`
 *     event dispatched below and apps/shell/src/main.js's
 *     `_watchNotifBadge()`, which listens for it.
 *   - `#/notifications/settings`: what used to be this app's ONLY view -
 *     device push on/off plus the granular per-app/@mention preferences
 *     (see @qu/services/notification-prefs-service.js for why these are
 *     public/signed rather than private).
 *
 * The per-app settings list is built from whatever's currently loaded, not
 * a hard-coded list: any app can declare its own push-worthy event types
 * via its manifest's `pushActions` (e.g. `{id: "mention", label:
 * "Mentions"}`, see @qu/foundation's manifest schema and
 * apps/forum|chat|inbox/manifest.quapp for real examples), and /apps.json
 * (see @qu/relay/apps-catalog.js) surfaces that here - one settings row
 * per (app, action) pair, labeled with both, backed by
 * NotificationPrefsService's existing `apps[appId].functions[actionId]`
 * granularity (already supported by shouldNotify(), just never exposed in
 * this UI before). An app with nothing push-worthy simply doesn't appear.
 */
import { subscribeToPush, unsubscribeFromPush, isPushSubscribed } from '@qu/push-client';
import { createI18n } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { paths } from '@qu/services';
import { injectStyle, renderNotificationPrefsSection } from '@qu/ui';

const DICT = {
  en: {
    title: 'Notifications',
    empty: 'No notifications yet.',
    settingsLink: 'Settings →',
    backToFeed: '← Notifications',
    settingsTitle: 'Notification settings',
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
    empty: 'Noch keine Benachrichtigungen.',
    settingsLink: 'Einstellungen →',
    backToFeed: '← Benachrichtigungen',
    settingsTitle: 'Benachrichtigungseinstellungen',
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
  .qu-notif-error { color: #c00; font-size: 0.9em; }
  .qu-notif-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .qu-notif-header a { color: inherit; font-size: 0.85em; }
  .qu-notif-feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-notif-feed li { display: flex; gap: 0.7rem; padding: 0.6rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-notif-feed a { text-decoration: none; color: inherit; display: flex; gap: 0.7rem; flex: 1; }
  .qu-notif-feed img { width: 2.4rem; height: 2.4rem; border-radius: 0.3rem; object-fit: cover; flex-shrink: 0; }
  .qu-notif-feed-title { font-weight: 600; }
  .qu-notif-feed-body { opacity: 0.8; font-size: 0.9em; }
  .qu-notif-feed-time { opacity: 0.5; font-size: 0.8em; }
  .qu-notif-empty { opacity: 0.7; }
`;


export function mount(container, { qu, services, segments, subscribe, fetch: syncFetch }) {
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let stopWatch = null;

  const view = segments[1] === 'settings' ? 'settings' : 'feed';

  (async () => {
    if (view === 'settings') {
      await renderSettings(container, services, () => stopped);
      return;
    }

    const myActorPub = await services.actors.whoAmI();
    if (stopped) return;
    const spaceId = `notifications-${myActorPub}`;
    subscribe(paths.spacePath(spaceId)); // live updates for a relay-authored notice arriving while this feed is open

    const listPath = paths.collectionPath(spaceId, paths.threadMessagesCollectionId('notifications'));
    // `syncFetch` here (see @qu/reactive's watch() own doc comment) closes
    // the same "opened this view before a peer-authored notice/read-state
    // had synced in" gap the header bell badge now also closes - without
    // it, this feed only ever showed what was already local plus whatever
    // arrived AFTER `subscribe()` above, same one-reload-behind symptom a
    // real multi-device test found for read receipts/reactions elsewhere.
    stopWatch = watch(qu, listPath, () => renderFeed(container, services, spaceId, () => stopped), { syncFetch });
  })();

  return () => { stopped = true; stopWatch?.(); };
}

async function renderFeed(container, services, spaceId, isStopped) {
  const messages = await services.threads.listMessages(spaceId, 'notifications');
  if (isStopped()) return;
  container.textContent = '';

  const header = document.createElement('div');
  header.className = 'qu-notif-header';
  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const settingsLink = document.createElement('a');
  settingsLink.href = '#/notifications/settings';
  settingsLink.textContent = t('settingsLink');
  header.append(heading, settingsLink);
  container.appendChild(header);

  if (messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'qu-notif-empty';
    empty.textContent = t('empty');
    container.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'qu-notif-feed';
    for (const message of [...messages].reverse()) list.appendChild(feedRow(message)); // newest first
    container.appendChild(list);
  }

  // Opening the feed is what "reading" it means - clears the header
  // bell's badge. That badge watches the message-LIST path (see
  // apps/shell/src/main.js's `_watchNotifBadge()`), which this write does
  // NOT touch (markRead() is a private, separate path - see
  // ThreadService), so the badge needs an explicit nudge: the same
  // cross-app window-event convention `qu:flag-changed` already
  // established for flags (favorites, bookmarks, ...).
  await services.threads.markRead(spaceId, 'notifications');
  window.dispatchEvent(new CustomEvent('qu:notifications-read'));
}

function feedRow(message) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = message.url || '#/notifications';

  if (message.image) {
    const img = document.createElement('img');
    img.src = message.image;
    img.alt = '';
    a.appendChild(img);
  }

  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'qu-notif-feed-title';
  title.textContent = message.title || message.body;
  const body = document.createElement('div');
  body.className = 'qu-notif-feed-body';
  body.textContent = message.title ? message.body : '';
  const time = document.createElement('div');
  time.className = 'qu-notif-feed-time';
  time.textContent = message.ts ? new Date(message.ts).toLocaleString() : '';
  text.append(title, body, time);
  a.appendChild(text);

  li.appendChild(a);
  return li;
}

async function renderSettings(container, services, isStopped) {
  // `getOwnPrefs()` itself is fetched by `renderNotificationPrefsSection()`
  // below, not here - only the device-push subscription state is this
  // function's own concern.
  const subscribed = await isPushSubscribed();
  if (isStopped()) return;
  container.textContent = '';

  const back = document.createElement('a');
  back.href = '#/notifications';
  back.textContent = t('backToFeed');
  container.appendChild(back);

  const heading = document.createElement('h1');
  heading.textContent = t('settingsTitle');
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
  // Every option below comes from whatever's currently loaded, not a
  // hard-coded list - each app declares its own push-worthy events via its
  // manifest's `pushActions` (see @qu/foundation's manifest schema), and
  // /apps.json (see @qu/relay/apps-catalog.js) is what surfaces that here.
  // An app with nothing push-worthy (most apps) simply doesn't appear. See
  // @qu/ui's `renderNotificationPrefsSection()` for the shared
  // implementation - extracted so a future per-app settings screen can
  // embed just its OWN rows (`filterAppId`) without duplicating this.
  const appsCatalog = await fetch('/apps.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const prefsSection = await renderNotificationPrefsSection({
    services,
    appsCatalog,
    labels: { globalEnabled: t('globalEnabled'), mentions: t('mentions'), perApp: t('perApp'), save: t('save'), saved: t('saved') },
  });
  container.appendChild(prefsSection);
}
