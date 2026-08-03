/**
 * RELAY ADMIN — a status panel over information the relay already serves
 * publicly (`/healthz`, `/apps.json`, `/config.json` - see
 * @qu/relay/relay.js): peer id, loaded apps, the configured admin pubkey
 * list, and (below that) an actual settings FORM - default locale, a
 * message-rate limit, and per-app enable/disable toggles.
 *
 * The status panel is read-only over public data; the shell only links
 * here for an identity in `adminPubs` (see apps/shell/src/main.js's
 * `isAdmin`), and this app repeats that same check before rendering
 * anything - but BOTH are a UI convenience, not a security boundary. The
 * settings FORM and the Data Explorer below are the two PRIVILEGED actions
 * this app exposes, and both are genuinely protected: each signs its
 * request with this identity's own key (`services.actors.signPayload()`)
 * and posts to a `POST /admin/...` route, which independently verifies
 * that signature against `adminPubs` SERVER-SIDE before doing anything
 * (see relay.js's `#handleAdminSettings()`/`#verifyAdmin()`) - never
 * trusting that only an admin's client would ever call it, exactly like
 * every other writer/reader ACL in this codebase (see ThreadEngine).
 *
 * The Data Explorer (`/admin/data/list`, `/admin/data/import`) lists every
 * QuBit this relay has ever stored under a given path prefix, straight off
 * disk - a debugging tool, not a Service, since there is no in-store
 * wildcard query anywhere else in this codebase (see @qu/relay's
 * `walkJsonFiles()`). Encrypted values stay encrypted over the wire and on
 * screen; this admin's OWN identity is tried against each one locally
 * (`services.actors.decryptForMe()`), so a value only ever becomes
 * readable here if this identity happens to be one of its listed readers -
 * the relay operator gets a debug view, not a skeleton key. Export
 * downloads the raw (still-sealed) QuBits as JSON; Import restores them
 * exactly as exported (`QuStore.putSealed()` server-side - original
 * signatures/encryption untouched), the same shape a fresh export produces.
 */
import { createI18n } from '@qu/i18n';
import { injectStyle } from '@qu/ui';

const DICT = {
  en: {
    title: 'Relay Admin',
    denied: 'This identity is not a configured relay admin.',
    peerId: 'Relay peer id',
    adminPubs: 'Configured admin pubkeys',
    loadedApps: 'Loaded apps',
    settings: 'Settings',
    defaultLocale: 'Default language for new visitors',
    rateLimit: 'Max messages per connection per minute (0 = unlimited)',
    disabledApps: 'Apps',
    save: 'Save',
    saved: 'Saved',
    saveError: 'Could not save: {message}',
    dataExplorer: 'Data Explorer',
    prefixLabel: 'Path prefix',
    limitLabel: 'Limit',
    browse: 'Browse',
    browsing: 'Loading…',
    noEntries: 'No matching entries.',
    moreAvailable: '{shown} of {total} shown — narrow the prefix or raise the limit to see more.',
    selectAll: 'Select all shown',
    exportSelected: 'Export selected ({count})',
    exportAll: 'Export all shown',
    decrypt: 'Try decrypt',
    plaintext: '(already plaintext)',
    notForYou: '🔒 Encrypted — not readable by this identity.',
    truncatedValue: '(value too large to preview: {bytes} bytes — still exportable)',
    unreadable: '(unreadable on disk)',
    importTitle: 'Import',
    importBtn: 'Import',
    importResult: 'Imported {imported}, skipped {skipped}, of {total}.',
    importError: 'Import failed: {message}',
    listError: 'Could not list data: {message}',
  },
  de: {
    title: 'Relay-Admin',
    denied: 'Diese Identität ist kein konfigurierter Relay-Admin.',
    peerId: 'Relay Peer-ID',
    adminPubs: 'Konfigurierte Admin-Pubkeys',
    loadedApps: 'Geladene Apps',
    settings: 'Einstellungen',
    defaultLocale: 'Standardsprache für neue Besucher',
    rateLimit: 'Max. Nachrichten pro Verbindung pro Minute (0 = unbegrenzt)',
    disabledApps: 'Apps',
    save: 'Speichern',
    saved: 'Gespeichert',
    saveError: 'Konnte nicht gespeichert werden: {message}',
    dataExplorer: 'Daten-Explorer',
    prefixLabel: 'Pfad-Präfix',
    limitLabel: 'Limit',
    browse: 'Durchsuchen',
    browsing: 'Lädt…',
    noEntries: 'Keine passenden Einträge.',
    moreAvailable: '{shown} von {total} angezeigt — Präfix eingrenzen oder Limit erhöhen, um mehr zu sehen.',
    selectAll: 'Alle angezeigten auswählen',
    exportSelected: 'Auswahl exportieren ({count})',
    exportAll: 'Alle angezeigten exportieren',
    decrypt: 'Entschlüsseln versuchen',
    plaintext: '(bereits Klartext)',
    notForYou: '🔒 Verschlüsselt — für diese Identität nicht lesbar.',
    truncatedValue: '(Wert zu groß für Vorschau: {bytes} Bytes — weiterhin exportierbar)',
    unreadable: '(auf Datenträger nicht lesbar)',
    importTitle: 'Import',
    importBtn: 'Importieren',
    importResult: '{imported} importiert, {skipped} übersprungen, von {total}.',
    importError: 'Import fehlgeschlagen: {message}',
    listError: 'Daten konnten nicht aufgelistet werden: {message}',
  },
};
const { t } = createI18n(DICT);

const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
];

const STYLE_ID = 'qu-relay-admin-style';
const STYLE = `
  .qu-admin-section { margin-top: 1rem; }
  .qu-admin-section h2 { font-size: 1em; opacity: 0.7; margin-bottom: 0.4rem; }
  .qu-admin-mono { font-family: ui-monospace, monospace; font-size: 0.9em; word-break: break-all; }
  .qu-admin-table { border-collapse: collapse; width: 100%; }
  .qu-admin-table th, .qu-admin-table td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid #8884; }
  .qu-admin-form { display: flex; flex-direction: column; gap: 0.7rem; max-width: 28rem; }
  .qu-admin-form label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9em; }
  .qu-admin-form input, .qu-admin-form select { padding: 0.3rem; }
  .qu-admin-app-toggles { display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-admin-app-toggles label { flex-direction: row; align-items: center; gap: 0.5rem; }
  .qu-admin-status { opacity: 0.7; font-size: 0.85em; }
  .qu-admin-error { color: #c00; font-size: 0.9em; }
  .qu-admin-controls { display: flex; gap: 0.6rem; align-items: flex-end; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .qu-admin-controls label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9em; }
  .qu-admin-controls input { padding: 0.3rem; }
  .qu-admin-results-header { display: flex; align-items: center; gap: 0.8rem; margin: 0.5rem 0; flex-wrap: wrap; }
  .qu-admin-results-header label { display: flex; align-items: center; gap: 0.3rem; font-size: 0.9em; }
  .qu-admin-entries { display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-admin-entry { border: 1px solid #8884; border-radius: 0.4rem; padding: 0.4rem 0.6rem; }
  .qu-admin-entry-head { display: flex; align-items: center; gap: 0.5rem; }
  .qu-admin-entry-head .qu-admin-mono { flex: 1; }
  .qu-admin-entry-value { max-height: 12rem; overflow: auto; font-size: 0.8em; background: #8881; border-radius: 0.3rem; padding: 0.4rem; margin: 0.4rem 0 0; white-space: pre-wrap; word-break: break-all; }
  .qu-admin-entry-decrypted { border-left: 3px solid #3ea05e; }
`;


export function mount(container, { services }) {
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  (async () => {
    const [health, apps, config, myActorPub] = await Promise.all([
      fetch('/healthz').then((r) => r.json()),
      fetch('/apps.json').then((r) => r.json()),
      fetch('/config.json').then((r) => r.json()),
      services.actors.whoAmI(),
    ]);
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    if (!(config.adminPubs ?? []).includes(myActorPub)) {
      const denied = document.createElement('p');
      denied.textContent = t('denied');
      container.appendChild(denied);
      return;
    }

    container.appendChild(section(t('peerId'), mono(health.peerId ?? '(unknown)')));
    container.appendChild(section(t('adminPubs'), list((config.adminPubs ?? []).map((pub) => mono(pub)))));
    container.appendChild(section(t('loadedApps'), appsTable(apps)));
    container.appendChild(section(t('settings'), settingsForm(services, apps, config.settings)));
    container.appendChild(section(t('dataExplorer'), dataExplorerSection(services)));
  })();

  return () => { stopped = true; };
}

/**
 * @param {ReturnType<import('@qu/services').createServices>} services
 * @param {Array<object>} apps - from `/apps.json` (see apps-catalog.js) - every LOADED app, `enabled: false` for ones already disabled.
 * @param {{defaultLocale: string, rateLimits: {maxMessagesPerMinute: number}, disabledApps: string[]}} settings
 */
function settingsForm(services, apps, settings) {
  const form = document.createElement('form');
  form.className = 'qu-admin-form';

  const localeLabel = document.createElement('label');
  const localeSpan = document.createElement('span');
  localeSpan.textContent = t('defaultLocale');
  const localeSelect = document.createElement('select');
  for (const { code, label } of AVAILABLE_LOCALES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    if (code === settings.defaultLocale) option.selected = true;
    localeSelect.appendChild(option);
  }
  localeLabel.append(localeSpan, localeSelect);
  form.appendChild(localeLabel);

  const rateLabel = document.createElement('label');
  const rateSpan = document.createElement('span');
  rateSpan.textContent = t('rateLimit');
  const rateInput = document.createElement('input');
  rateInput.type = 'number';
  rateInput.min = '0';
  rateInput.step = '1';
  rateInput.value = String(settings.rateLimits.maxMessagesPerMinute ?? 0);
  rateLabel.append(rateSpan, rateInput);
  form.appendChild(rateLabel);

  const appsHeading = document.createElement('span');
  appsHeading.textContent = t('disabledApps');
  const appsEl = document.createElement('div');
  appsEl.className = 'qu-admin-app-toggles';
  const appToggles = new Map();
  for (const app of apps) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = app.enabled !== false;
    appToggles.set(app.name, checkbox);
    label.append(checkbox, document.createTextNode(`${app.icon ?? ''} ${app.label ?? app.name}`.trim()));
    appsEl.appendChild(label);
  }
  form.append(appsHeading, appsEl);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = t('save');
  const status = document.createElement('span');
  status.className = 'qu-admin-status';
  const error = document.createElement('p');
  error.className = 'qu-admin-error';
  form.append(saveBtn, status, error);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    status.textContent = '';
    const newSettings = {
      defaultLocale: localeSelect.value,
      rateLimits: { maxMessagesPerMinute: Number(rateInput.value) || 0 },
      disabledApps: [...appToggles.entries()].filter(([, checkbox]) => !checkbox.checked).map(([name]) => name),
    };
    try {
      const { actorPub, signature } = await services.actors.signPayload(newSettings);
      const res = await fetch('/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorPub, settings: newSettings, signature }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      status.textContent = t('saved');
      setTimeout(() => { status.textContent = ''; }, 1500);
    } catch (err) {
      error.textContent = t('saveError', { message: err.message });
    }
  });

  return form;
}

/**
 * @param {ReturnType<import('@qu/services').createServices>} services
 */
function dataExplorerSection(services) {
  const wrap = document.createElement('div');
  let currentEntries = []; // [{path, value?, truncated?, byteLength?, error?, checkbox}]

  // --- Browse ---
  const controls = document.createElement('form');
  controls.className = 'qu-admin-controls';
  const prefixInput = document.createElement('input');
  prefixInput.value = '/store';
  const prefixLabel = document.createElement('label');
  prefixLabel.append(t('prefixLabel'), prefixInput);
  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.min = '1';
  limitInput.max = '1000';
  limitInput.value = '200';
  const limitLabel = document.createElement('label');
  limitLabel.append(t('limitLabel'), limitInput);
  const browseBtn = document.createElement('button');
  browseBtn.type = 'submit';
  browseBtn.textContent = t('browse');
  controls.append(prefixLabel, limitLabel, browseBtn);
  wrap.appendChild(controls);

  const status = document.createElement('p');
  status.className = 'qu-admin-status';
  wrap.appendChild(status);

  const resultsHeader = document.createElement('div');
  resultsHeader.className = 'qu-admin-results-header';
  resultsHeader.hidden = true;
  const selectAllLabel = document.createElement('label');
  const selectAllBox = document.createElement('input');
  selectAllBox.type = 'checkbox';
  selectAllLabel.append(selectAllBox, t('selectAll'));
  const exportSelectedBtn = document.createElement('button');
  exportSelectedBtn.type = 'button';
  exportSelectedBtn.textContent = t('exportSelected', { count: 0 });
  const exportAllBtn = document.createElement('button');
  exportAllBtn.type = 'button';
  exportAllBtn.textContent = t('exportAll');
  resultsHeader.append(selectAllLabel, exportSelectedBtn, exportAllBtn);
  wrap.appendChild(resultsHeader);

  const list = document.createElement('div');
  list.className = 'qu-admin-entries';
  wrap.appendChild(list);

  const moreNote = document.createElement('p');
  moreNote.className = 'qu-admin-status';
  wrap.appendChild(moreNote);

  function updateExportSelectedLabel() {
    const count = currentEntries.filter((e) => e.checkbox?.checked).length;
    exportSelectedBtn.textContent = t('exportSelected', { count });
    exportSelectedBtn.disabled = count === 0;
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  exportSelectedBtn.addEventListener('click', () => {
    const entries = currentEntries.filter((e) => e.checkbox?.checked && e.value !== undefined).map((e) => ({ path: e.path, value: e.value }));
    downloadJson(`qu-export-${Date.now()}.json`, { entries });
  });
  exportAllBtn.addEventListener('click', () => {
    const entries = currentEntries.filter((e) => e.value !== undefined).map((e) => ({ path: e.path, value: e.value }));
    downloadJson(`qu-export-${Date.now()}.json`, { entries });
  });
  selectAllBox.addEventListener('change', () => {
    for (const e of currentEntries) if (e.checkbox) e.checkbox.checked = selectAllBox.checked;
    updateExportSelectedLabel();
  });

  function entryRow(entry) {
    const row = document.createElement('div');
    row.className = 'qu-admin-entry';

    const head = document.createElement('div');
    head.className = 'qu-admin-entry-head';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = entry.value === undefined;
    checkbox.addEventListener('change', updateExportSelectedLabel);
    const path = document.createElement('span');
    path.className = 'qu-admin-mono';
    path.textContent = entry.path;
    head.append(checkbox, path);

    const decryptedEl = document.createElement('pre');
    decryptedEl.className = 'qu-admin-entry-value qu-admin-entry-decrypted';
    decryptedEl.hidden = true;

    if (entry.value !== undefined) {
      const decryptBtn = document.createElement('button');
      decryptBtn.type = 'button';
      decryptBtn.textContent = t('decrypt');
      decryptBtn.addEventListener('click', async () => {
        decryptBtn.disabled = true;
        try {
          const getProfile = services.profile.getPublicProfile.bind(services.profile);
          const { encrypted, value } = await services.actors.decryptForMe(entry.value, getProfile);
          decryptedEl.hidden = false;
          decryptedEl.textContent = !encrypted ? t('plaintext') : value === null ? t('notForYou') : JSON.stringify(value, null, 2);
        } finally {
          decryptBtn.disabled = false;
        }
      });
      head.appendChild(decryptBtn);
    }
    row.appendChild(head);

    const pre = document.createElement('pre');
    pre.className = 'qu-admin-entry-value';
    pre.textContent = entry.truncated
      ? t('truncatedValue', { bytes: entry.byteLength })
      : entry.error
      ? t('unreadable')
      : JSON.stringify(entry.value, null, 2);
    row.append(pre, decryptedEl);

    entry.checkbox = checkbox;
    return row;
  }

  controls.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = t('browsing');
    list.textContent = '';
    moreNote.textContent = '';
    resultsHeader.hidden = true;
    currentEntries = [];
    try {
      const query = { prefix: prefixInput.value.trim() || '/store', limit: Number(limitInput.value) || 200 };
      const { actorPub, signature } = await services.actors.signPayload(query);
      const res = await fetch('/admin/data/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorPub, query, signature }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const { entries, total, hasMore } = await res.json();
      status.textContent = '';
      if (entries.length === 0) {
        list.textContent = t('noEntries');
        return;
      }
      currentEntries = entries;
      resultsHeader.hidden = false;
      selectAllBox.checked = false;
      for (const entry of entries) list.appendChild(entryRow(entry));
      updateExportSelectedLabel();
      if (hasMore) moreNote.textContent = t('moreAvailable', { shown: entries.length, total });
    } catch (err) {
      status.textContent = t('listError', { message: err.message });
    }
  });

  // --- Import ---
  const importHeading = document.createElement('h3');
  importHeading.textContent = t('importTitle');
  wrap.appendChild(importHeading);

  const importForm = document.createElement('form');
  importForm.className = 'qu-admin-controls';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json';
  const importBtn = document.createElement('button');
  importBtn.type = 'submit';
  importBtn.textContent = t('importBtn');
  importForm.append(fileInput, importBtn);
  wrap.appendChild(importForm);

  const importStatus = document.createElement('p');
  importStatus.className = 'qu-admin-status';
  wrap.appendChild(importStatus);

  importForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    importStatus.textContent = '';
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const { actorPub, signature } = await services.actors.signPayload(entries);
      const res = await fetch('/admin/data/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorPub, entries, signature }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const { imported, skipped, total } = await res.json();
      importStatus.textContent = t('importResult', { imported, skipped, total });
    } catch (err) {
      importStatus.textContent = t('importError', { message: err.message });
    }
  });

  return wrap;
}

function section(title, content) {
  const el = document.createElement('div');
  el.className = 'qu-admin-section';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  el.append(h2, content);
  return el;
}

function mono(text) {
  const span = document.createElement('span');
  span.className = 'qu-admin-mono';
  span.textContent = text;
  return span;
}

function list(items) {
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.appendChild(item);
    ul.appendChild(li);
  }
  return ul;
}

// Built with textContent cell-by-cell, never innerHTML - `name`/`label` come
// from /apps.json, which mirrors whatever a manifest declares. Integrity
// pinning (see @qu/loader) only covers a remote app's CODE bytes, not its
// metadata fields, so a malicious remote manifest's `label` is untrusted
// text as far as this admin panel is concerned - the exact kind of input
// that must never reach innerHTML.
function appsTable(apps) {
  const table = document.createElement('table');
  table.className = 'qu-admin-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Name', 'Label', 'navOrder', 'Integrity-pinned']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  for (const app of apps) {
    const tr = document.createElement('tr');
    for (const value of [app.name, app.label ?? '', app.navOrder ?? '', app.clientIntegrity ? '✓' : '—']) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
}
