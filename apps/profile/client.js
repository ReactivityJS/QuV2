/**
 * PROFILE — the one app behind two routes:
 *   - `#/profile` (no pub) is deliberately ambiguous about whose profile
 *     it means, so it redirects client-side to this identity's own
 *     `#/~<pub>` route and nothing else - see boot()'s redirect below.
 *   - `#/~<pub>` (the shell's reserved sigil - see apps/shell/src/main.js's
 *     `_renderRoute()` - matching the real Qu's own `#/~<fp>` convention)
 *     is THE public profile route for any identity: this identity's own
 *     pub shows the full editable view (alias/avatar/custom fields, plus
 *     this identity's settings - directory visibility, notification
 *     prefs); any other pub shows the same document read-only, with a
 *     contact toggle instead of edit controls.
 *
 * A profile IS an identity's keypair - the public view always shows BOTH
 * public keys in full: `pub` (Ed25519 signing key, same value as the
 * identity itself) and `epub` (X25519 encryption key - what ThreadService
 * resolves to encrypt a private thread's messages FOR this identity, see
 * @qu/services/thread-service.js's `#resolveReaderXKeys`). Never truncated
 * here - unlike the header's short `~abcd1234…` display, this is the one
 * place a user needs to read/copy the whole thing (verifying a contact's
 * key out of band, etc).
 */
import { createI18n, getStoredLocale, setLocale } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { actorPath } from '@qu/identity';

/** Locales every app's dictionary in this codebase actually ships - see @qu/i18n's own doc comment for why this is a device preference, not per-identity. */
const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
];

const DICT = {
  en: {
    titleOwn: 'My profile',
    titleOther: 'Profile',
    pub: 'Public key (pub)',
    epub: 'Encryption key (epub)',
    noProfile: 'This identity has not published a profile yet.',
    alias: 'Alias',
    avatar: 'Avatar (emoji or image URL)',
    fields: 'Custom fields',
    fieldKey: 'Field name',
    fieldValue: 'Value',
    public: 'Public',
    private: 'Private',
    addField: 'Add field',
    remove: 'Remove',
    save: 'Save',
    saved: 'Saved',
    settings: 'Settings',
    listedInDirectory: 'Listed in directory (visible to the User List)',
    language: 'Language',
    notificationSettings: 'Notification settings →',
    addContact: 'Add contact',
    removeContact: 'Remove contact',
    message: '💬 Message',
  },
  de: {
    titleOwn: 'Mein Profil',
    titleOther: 'Profil',
    pub: 'Öffentlicher Schlüssel (pub)',
    epub: 'Verschlüsselungsschlüssel (epub)',
    noProfile: 'Diese Identität hat noch kein Profil veröffentlicht.',
    alias: 'Alias',
    avatar: 'Avatar (Emoji oder Bild-URL)',
    fields: 'Eigene Felder',
    fieldKey: 'Feldname',
    fieldValue: 'Wert',
    public: 'Öffentlich',
    private: 'Privat',
    addField: 'Feld hinzufügen',
    remove: 'Entfernen',
    save: 'Speichern',
    saved: 'Gespeichert',
    settings: 'Einstellungen',
    listedInDirectory: 'In der Nutzerliste sichtbar',
    language: 'Sprache',
    notificationSettings: 'Benachrichtigungseinstellungen →',
    addContact: 'Kontakt hinzufügen',
    removeContact: 'Kontakt entfernen',
    message: '💬 Nachricht',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-profile-style';
const STYLE = `
  .qu-profile-form { display: flex; flex-direction: column; gap: 0.8rem; max-width: 32rem; }
  .qu-profile-row { display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-profile-row label { font-size: 0.85em; opacity: 0.7; }
  .qu-profile-row input { padding: 0.4rem; }
  .qu-profile-field { display: flex; gap: 0.4rem; align-items: center; }
  .qu-profile-field input[data-role="key"] { width: 9rem; }
  .qu-profile-field input[data-role="value"] { flex: 1; }
  .qu-profile-status { opacity: 0.7; font-size: 0.85em; }
  .qu-profile-keys { display: flex; flex-direction: column; gap: 0.6rem; max-width: 32rem; margin: 1rem 0; }
  .qu-profile-key-row label { font-size: 0.85em; opacity: 0.7; display: block; margin-bottom: 0.2rem; }
  .qu-profile-key-value { font-family: ui-monospace, monospace; font-size: 0.85em; word-break: break-all; background: #8881; border-radius: 0.3rem; padding: 0.4rem 0.5rem; }
  .qu-profile-public-fields { display: flex; flex-direction: column; gap: 0.3rem; max-width: 32rem; }
  .qu-profile-public-fields div { display: flex; gap: 0.5rem; }
  .qu-profile-public-fields span:first-child { opacity: 0.7; min-width: 8rem; }
  .qu-profile-settings { display: flex; flex-direction: column; gap: 0.6rem; max-width: 32rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #8884; }
  .qu-profile-settings label { display: flex; align-items: center; gap: 0.4rem; }
  .qu-profile-settings a { color: inherit; }
  .qu-profile-actions { display: flex; gap: 0.8rem; align-items: center; margin-top: 0.5rem; }
  .qu-profile-empty { opacity: 0.7; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { qu, services, segments }) {
  ensureStyle();
  let stopped = false;
  let stopWatch = null;

  const raw = segments[0] ?? 'profile';

  (async () => {
    const myActorPub = await services.actors.whoAmI();
    if (stopped) return;

    // `#/profile` alone is unclear about whose profile it means - redirect
    // to this identity's own unambiguous `#/~<pub>` route rather than
    // guessing or rendering something ownerless.
    if (!raw.startsWith('~')) {
      location.hash = `#/~${myActorPub}`;
      return;
    }

    const targetPub = raw.slice(1);
    const isOwn = targetPub === myActorPub;

    // Reactive, not a one-time snapshot: re-renders whenever this
    // identity's profile document changes, whether from THIS session's own
    // save below or a live sync update from elsewhere - the same watch()
    // pattern the header's alias display uses (see apps/shell/src/main.js).
    stopWatch = watch(qu, actorPath(targetPub, 'profile'), () => {
      if (stopped) return;
      if (isOwn) renderOwnProfile(container, services, () => stopped);
      else renderPublicProfile(container, services, targetPub, () => stopped);
    });
  })();

  return () => { stopped = true; stopWatch?.(); };
}

async function renderOwnProfile(container, services, isStopped) {
  const ownProfile = await services.profile.getOwnProfile();
  const isListed = await services.directory.isVisible(ownProfile.pub);
  if (isStopped()) return;
  container.textContent = '';

  const heading = document.createElement('h1');
  heading.textContent = t('titleOwn');
  container.appendChild(heading);

  container.appendChild(keysSection(ownProfile.pub, ownProfile.epub));

  const form = document.createElement('form');
  form.className = 'qu-profile-form';

  const aliasInput = textRow(t('alias'), ownProfile.alias);
  const avatarInput = textRow(t('avatar'), ownProfile.avatar);

  const fieldsHeading = document.createElement('h2');
  fieldsHeading.textContent = t('fields');
  const fieldsEl = document.createElement('div');
  fieldsEl.className = 'qu-profile-fields';
  for (const field of ownProfile.fields) fieldsEl.appendChild(fieldRow(field));

  const addFieldBtn = document.createElement('button');
  addFieldBtn.type = 'button';
  addFieldBtn.textContent = t('addField');
  addFieldBtn.addEventListener('click', () => fieldsEl.appendChild(fieldRow({ key: '', value: '', visibility: 'public' })));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = t('save');

  const status = document.createElement('span');
  status.className = 'qu-profile-status';

  form.append(aliasInput.row, avatarInput.row, fieldsHeading, fieldsEl, addFieldBtn, saveBtn, status);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = [...fieldsEl.querySelectorAll('.qu-profile-field')]
      .map((row) => ({
        key: row.querySelector('[data-role="key"]').value.trim(),
        value: row.querySelector('[data-role="value"]').value,
        visibility: row.querySelector('[data-role="visibility"]').value,
      }))
      .filter((f) => f.key);

    await services.profile.saveProfile({ alias: aliasInput.input.value, avatar: avatarInput.input.value, fields });
    status.textContent = t('saved');
    setTimeout(() => { status.textContent = ''; }, 1500);
  });

  container.appendChild(form);

  // Settings consolidated here (was split between the shell's home screen
  // and a separate Notifications app) - one place for "how do others see
  // me, how am I notified".
  const settings = document.createElement('div');
  settings.className = 'qu-profile-settings';

  const settingsHeading = document.createElement('h2');
  settingsHeading.textContent = t('settings');
  settings.appendChild(settingsHeading);

  const visibilityLabel = document.createElement('label');
  const visibilityCheckbox = document.createElement('input');
  visibilityCheckbox.type = 'checkbox';
  visibilityCheckbox.checked = isListed;
  visibilityCheckbox.addEventListener('change', async () => {
    await services.directory.setVisible(visibilityCheckbox.checked);
  });
  visibilityLabel.append(visibilityCheckbox, document.createTextNode(t('listedInDirectory')));
  settings.appendChild(visibilityLabel);

  const languageLabel = document.createElement('label');
  const languageSpan = document.createElement('span');
  languageSpan.textContent = t('language');
  const languageSelect = document.createElement('select');
  const currentLocale = getStoredLocale();
  for (const { code, label } of AVAILABLE_LOCALES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    if (code === currentLocale) option.selected = true;
    languageSelect.appendChild(option);
  }
  languageSelect.addEventListener('change', () => {
    // Not live mid-session - @qu/i18n's createI18n() resolves the locale
    // once, when each already-loaded app's module first runs (see that
    // package's own doc comment) - a reload is the simplest way to make
    // every mounted app (shell chrome included) actually pick the new
    // choice up, rather than rebuilding i18n as an observable just for this.
    setLocale(languageSelect.value);
    location.reload();
  });
  languageLabel.append(languageSpan, languageSelect);
  settings.appendChild(languageLabel);

  const notifLink = document.createElement('a');
  notifLink.href = '#/notifications/settings';
  notifLink.textContent = t('notificationSettings');
  settings.appendChild(notifLink);

  container.appendChild(settings);
}

async function renderPublicProfile(container, services, targetPub, isStopped) {
  const [profile, isContact] = await Promise.all([
    services.profile.getPublicProfile(targetPub),
    services.contacts.isContact(targetPub),
  ]);
  if (isStopped()) return;
  container.textContent = '';

  const heading = document.createElement('h1');
  heading.textContent = profile?.alias ? `${profile.alias}` : t('titleOther');
  container.appendChild(heading);

  if (profile?.avatar) {
    const avatar = document.createElement('p');
    avatar.textContent = profile.avatar;
    container.appendChild(avatar);
  }

  container.appendChild(keysSection(targetPub, profile?.epub ?? ''));

  if (!profile) {
    const empty = document.createElement('p');
    empty.className = 'qu-profile-empty';
    empty.textContent = t('noProfile');
    container.appendChild(empty);
  } else {
    const skip = new Set(['pub', 'epub', 'alias', 'avatar']);
    const extraEntries = Object.entries(profile).filter(([key]) => !skip.has(key));
    if (extraEntries.length > 0) {
      const fieldsEl = document.createElement('div');
      fieldsEl.className = 'qu-profile-public-fields';
      for (const [key, value] of extraEntries) {
        const row = document.createElement('div');
        const k = document.createElement('span');
        k.textContent = key;
        const v = document.createElement('span');
        v.textContent = value;
        row.append(k, v);
        fieldsEl.appendChild(row);
      }
      container.appendChild(fieldsEl);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'qu-profile-actions';

  // Chat rooms are derived from both pubs and self-created on first visit
  // (see apps/chat/client.js's renderRoom()) - no contact relationship is
  // required, so this link works for any identity, contact or not.
  const messageLink = document.createElement('a');
  messageLink.href = `#/chat/${targetPub}`;
  messageLink.textContent = t('message');
  actions.appendChild(messageLink);

  const contactBtn = document.createElement('button');
  contactBtn.type = 'button';
  let nowContact = isContact;
  const renderContactBtn = () => { contactBtn.textContent = nowContact ? t('removeContact') : t('addContact'); };
  renderContactBtn();
  contactBtn.addEventListener('click', async () => {
    if (nowContact) await services.contacts.removeContact(targetPub);
    else await services.contacts.addContact(targetPub);
    nowContact = !nowContact;
    renderContactBtn();
  });
  actions.appendChild(contactBtn);
  container.appendChild(actions);
}

function keysSection(pub, epub) {
  const section = document.createElement('div');
  section.className = 'qu-profile-keys';
  section.append(keyRow(t('pub'), pub), keyRow(t('epub'), epub));
  return section;
}

function keyRow(label, value) {
  const row = document.createElement('div');
  row.className = 'qu-profile-key-row';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'qu-profile-key-value';
  valueEl.textContent = value || '—';
  row.append(labelEl, valueEl);
  return row;
}

function textRow(label, value) {
  const row = document.createElement('div');
  row.className = 'qu-profile-row';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  row.append(labelEl, input);
  return { row, input };
}

function fieldRow({ key, value, visibility }) {
  const row = document.createElement('div');
  row.className = 'qu-profile-field';

  const keyInput = document.createElement('input');
  keyInput.dataset.role = 'key';
  keyInput.placeholder = t('fieldKey');
  keyInput.value = key ?? '';

  const valueInput = document.createElement('input');
  valueInput.dataset.role = 'value';
  valueInput.placeholder = t('fieldValue');
  valueInput.value = value ?? '';

  const visibilitySelect = document.createElement('select');
  visibilitySelect.dataset.role = 'visibility';
  for (const [optValue, optLabel] of [['public', t('public')], ['private', t('private')]]) {
    const option = document.createElement('option');
    option.value = optValue;
    option.textContent = optLabel;
    if (optValue === (visibility ?? 'public')) option.selected = true;
    visibilitySelect.appendChild(option);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = t('remove');
  removeBtn.addEventListener('click', () => row.remove());

  row.append(keyInput, valueInput, visibilitySelect, removeBtn);
  return row;
}
