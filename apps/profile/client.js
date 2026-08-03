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
import { createI18n, getStoredLocale, setLocale, AVAILABLE_LOCALES } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { actorPath, QuIdentityEngine } from '@qu/identity';
import { renderAvatar, injectStyle } from '@qu/ui';
import { renderQrCode, startCamera, scanQrFromVideo } from '@qu/qr';

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
    backupTitle: 'Identity backup & devices',
    backupIntro: 'Use this to set up the SAME identity on another device, back it up, or remove it from this one.',
    exportBtn: '🔗 Export identity',
    importBtn: '📥 Use a different identity',
    deleteBtn: '🗑 Delete identity & all local data',
    exportWarning: 'This code IS your private key - anyone with it fully controls this identity. Only show it to your own other device (e.g. via its camera), never share it anywhere else.',
    exportCopy: '📋 Copy code',
    exportCopied: 'Copied',
    exportDownload: '⬇ Download as file',
    exportClose: 'Close',
    importWarning: 'This REPLACES the identity on this device with a different one. Export your current identity first if you want to keep access to it.',
    importPasteLabel: 'Backup code',
    pasteCodePlaceholder: 'Paste backup code…',
    scanQr: '📷 Scan QR code',
    cancelScan: 'Cancel scan',
    importConfirm: 'Replace identity',
    importFailed: 'Could not import: {message}',
    cameraFailed: 'Could not access the camera: {message}',
    deleteWarning: 'This permanently deletes this identity and EVERY piece of data stored in this browser for it (contacts, chats, calendars, everything) - not just from this device\'s view, but from this device entirely. This cannot be undone. Export your identity first if you want to keep using it elsewhere.',
    deleteConfirmLabel: 'Type DELETE to confirm',
    deleteConfirmPlaceholder: 'DELETE',
    deleteConfirmBtn: 'Permanently delete',
    cancel: 'Cancel',
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
    backupTitle: 'Identitätssicherung & Geräte',
    backupIntro: 'Damit richtest du dieselbe Identität auf einem anderen Gerät ein, sicherst sie, oder entfernst sie von diesem Gerät.',
    exportBtn: '🔗 Identität exportieren',
    importBtn: '📥 Andere Identität verwenden',
    deleteBtn: '🗑 Identität & alle lokalen Daten löschen',
    exportWarning: 'Dieser Code IST dein privater Schlüssel - wer ihn hat, hat volle Kontrolle über diese Identität. Zeige ihn nur deinem eigenen anderen Gerät (z. B. per Kamera), niemals sonst wem.',
    exportCopy: '📋 Code kopieren',
    exportCopied: 'Kopiert',
    exportDownload: '⬇ Als Datei herunterladen',
    exportClose: 'Schließen',
    importWarning: 'Dies ERSETZT die Identität auf diesem Gerät durch eine andere. Exportiere zuerst deine aktuelle Identität, wenn du sie weiter nutzen willst.',
    importPasteLabel: 'Sicherungscode',
    pasteCodePlaceholder: 'Sicherungscode einfügen…',
    scanQr: '📷 QR-Code scannen',
    cancelScan: 'Scan abbrechen',
    importConfirm: 'Identität ersetzen',
    importFailed: 'Import fehlgeschlagen: {message}',
    cameraFailed: 'Kamera nicht zugänglich: {message}',
    deleteWarning: 'Dies löscht diese Identität und JEDES Datum, das für sie in diesem Browser gespeichert ist, dauerhaft (Kontakte, Chats, Kalender, alles) - nicht nur die Ansicht, sondern von diesem Gerät. Das kann nicht rückgängig gemacht werden. Exportiere die Identität zuerst, wenn du sie woanders weiter nutzen willst.',
    deleteConfirmLabel: 'Tippe LÖSCHEN zur Bestätigung',
    deleteConfirmPlaceholder: 'LÖSCHEN',
    deleteConfirmBtn: 'Endgültig löschen',
    cancel: 'Abbrechen',
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
  .qu-profile-avatar { margin: 0.3rem 0 0.9rem; }
  .qu-profile-backup { display: flex; flex-direction: column; gap: 0.6rem; max-width: 32rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #8884; }
  .qu-profile-backup-buttons { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .qu-profile-backup-panel { border: 1px solid #8884; border-radius: 0.5rem; padding: 0.8rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-profile-backup-warning { border-left: 3px solid #d0a02a; padding-left: 0.7rem; opacity: 0.9; }
  .qu-profile-backup-code { font-family: ui-monospace, monospace; font-size: 0.85em; word-break: break-all; background: #8881; border-radius: 0.4rem; padding: 0.6rem 0.7rem; }
  .qu-profile-backup-qr { display: flex; justify-content: center; padding: 0.5rem 0; }
  .qu-profile-backup-row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .qu-profile-backup textarea { width: 100%; min-height: 4rem; font-family: ui-monospace, monospace; padding: 0.5rem; box-sizing: border-box; }
  .qu-profile-backup video { width: 100%; max-width: 18rem; border-radius: 0.5rem; }
  .qu-profile-backup-error { color: #c0392b; }
  .qu-profile-backup-danger { color: #c0392b; border-color: #c0392b88; }
`;


export function mount(container, { qu, services, segments, wipeIdentity }) {
  injectStyle(STYLE_ID, STYLE);
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
      if (isOwn) renderOwnProfile(container, services, () => stopped, qu, wipeIdentity);
      else renderPublicProfile(container, services, targetPub, () => stopped);
    });
  })();

  return () => { stopped = true; stopWatch?.(); };
}

async function renderOwnProfile(container, services, isStopped, qu, wipeIdentity) {
  const ownProfile = await services.profile.getOwnProfile();
  const isListed = await services.directory.isVisible(ownProfile.pub);
  if (isStopped()) return;
  container.textContent = '';

  const heading = document.createElement('h1');
  heading.textContent = t('titleOwn');
  container.appendChild(heading);

  const ownAvatar = renderAvatar(ownProfile.pub, ownProfile.alias, ownProfile.avatar, { size: '4.5rem' });
  ownAvatar.classList.add('qu-profile-avatar');
  container.appendChild(ownAvatar);
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

  container.appendChild(renderBackupSection(qu, wipeIdentity));
}

// =============================================================================
// IDENTITY BACKUP & DEVICES — export (show this identity as a backup code /
// QR code another of the user's OWN devices can scan or paste), import
// (replace this device's identity with one exported elsewhere - the other
// direction of the same transfer), and delete (wipe this identity and
// every byte of its local data from this device). See @qu/identity's
// exportSeedCode()/importSeedCode() for what the backup code actually is
// (the raw master seed, base64url-encoded - NOT the original 24-word
// mnemonic, which only ever existed at creation time - see that method's
// own doc comment) and @qu/qr for the QR encode/decode this reuses.
//
// Deliberately inline panels toggled within this same page, not dialogs or
// new routes - same "no overlays" convention every other app in this shell
// follows (see e.g. apps/todo/client.js's inline forms).
// =============================================================================

function renderBackupSection(qu, wipeIdentity) {
  const section = document.createElement('div');
  section.className = 'qu-profile-backup';

  const heading = document.createElement('h2');
  heading.textContent = t('backupTitle');
  const intro = document.createElement('p');
  intro.textContent = t('backupIntro');

  const panelSlot = document.createElement('div');

  const buttons = document.createElement('div');
  buttons.className = 'qu-profile-backup-buttons';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('exportBtn');
  exportBtn.addEventListener('click', () => renderExportPanel(panelSlot, qu));

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = t('importBtn');
  importBtn.addEventListener('click', () => renderImportPanel(panelSlot, qu));

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'qu-profile-backup-danger';
  deleteBtn.textContent = t('deleteBtn');
  deleteBtn.addEventListener('click', () => renderDeletePanel(panelSlot, wipeIdentity));

  buttons.append(exportBtn, importBtn, deleteBtn);
  section.append(heading, intro, buttons, panelSlot);
  return section;
}

async function renderExportPanel(slot, qu) {
  const identity = new QuIdentityEngine(qu);
  const code = await identity.exportSeedCode();

  slot.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'qu-profile-backup-panel';

  const warning = document.createElement('p');
  warning.className = 'qu-profile-backup-warning';
  warning.textContent = t('exportWarning');

  const qrEl = document.createElement('div');
  qrEl.className = 'qu-profile-backup-qr';
  renderQrCode(qrEl, code);

  const codeBox = document.createElement('div');
  codeBox.className = 'qu-profile-backup-code';
  codeBox.textContent = code;

  const row = document.createElement('div');
  row.className = 'qu-profile-backup-row';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = t('exportCopy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = t('exportCopied');
      setTimeout(() => { copyBtn.textContent = t('exportCopy'); }, 1500);
    } catch { /* clipboard unavailable - the code box above is still selectable by hand */ }
  });

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.textContent = t('exportDownload');
  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'quniverse-identity-backup.txt';
    a.click();
    URL.revokeObjectURL(url);
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = t('exportClose');
  closeBtn.addEventListener('click', () => { slot.textContent = ''; });

  row.append(copyBtn, downloadBtn, closeBtn);
  panel.append(warning, qrEl, codeBox, row);
  slot.textContent = '';
  slot.appendChild(panel);
}

function renderImportPanel(slot, qu) {
  slot.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'qu-profile-backup-panel';

  const warning = document.createElement('p');
  warning.className = 'qu-profile-backup-warning';
  warning.textContent = t('importWarning');

  const label = document.createElement('label');
  label.textContent = t('importPasteLabel');
  const textarea = document.createElement('textarea');
  textarea.placeholder = t('pasteCodePlaceholder');

  const qrSlot = document.createElement('div');
  let stopScan = null;

  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.textContent = t('scanQr');
  scanBtn.addEventListener('click', async () => {
    if (stopScan) { stopScan(); stopScan = null; qrSlot.textContent = ''; scanBtn.textContent = t('scanQr'); return; }
    qrSlot.textContent = '';
    const video = document.createElement('video');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancelScan');
    qrSlot.append(video, cancelBtn);
    try {
      const stopCamera = await startCamera(video);
      const stopScanning = scanQrFromVideo(video, {
        onResult: (text) => {
          textarea.value = text;
          stopCamera();
          qrSlot.textContent = '';
          stopScan = null;
          scanBtn.textContent = t('scanQr');
        },
      });
      stopScan = () => { stopScanning(); stopCamera(); };
      cancelBtn.addEventListener('click', () => { stopScan?.(); stopScan = null; qrSlot.textContent = ''; scanBtn.textContent = t('scanQr'); });
    } catch (err) {
      qrSlot.textContent = '';
      const error = document.createElement('p');
      error.className = 'qu-profile-backup-error';
      error.textContent = t('cameraFailed', { message: err.message });
      qrSlot.appendChild(error);
    }
  });

  const error = document.createElement('p');
  error.className = 'qu-profile-backup-error';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'qu-profile-backup-danger';
  confirmBtn.textContent = t('importConfirm');
  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    const identity = new QuIdentityEngine(qu);
    try {
      await identity.importSeedCode(textarea.value, { overwrite: true });
      stopScan?.();
      location.reload();
    } catch (err) {
      error.textContent = t('importFailed', { message: err.message });
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = t('cancel');
  cancelBtn.addEventListener('click', () => { stopScan?.(); slot.textContent = ''; });

  const row = document.createElement('div');
  row.className = 'qu-profile-backup-row';
  row.append(scanBtn, confirmBtn, cancelBtn);

  panel.append(warning, label, textarea, qrSlot, row, error);
  slot.appendChild(panel);
}

function renderDeletePanel(slot, wipeIdentity) {
  slot.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'qu-profile-backup-panel';

  const warning = document.createElement('p');
  warning.className = 'qu-profile-backup-warning';
  warning.textContent = t('deleteWarning');

  const label = document.createElement('label');
  label.textContent = t('deleteConfirmLabel');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('deleteConfirmPlaceholder');

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'qu-profile-backup-danger';
  confirmBtn.textContent = t('deleteConfirmBtn');
  confirmBtn.disabled = true;
  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value.trim().toUpperCase() !== t('deleteConfirmPlaceholder');
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    await wipeIdentity();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = t('cancel');
  cancelBtn.addEventListener('click', () => { slot.textContent = ''; });

  const row = document.createElement('div');
  row.className = 'qu-profile-backup-row';
  row.append(confirmBtn, cancelBtn);

  panel.append(warning, label, input, row);
  slot.appendChild(panel);
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

  const publicAvatar = renderAvatar(targetPub, profile?.alias ?? '', profile?.avatar, { size: '4.5rem' });
  publicAvatar.classList.add('qu-profile-avatar');
  container.appendChild(publicAvatar);

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
