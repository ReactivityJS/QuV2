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
 * settings FORM below is the one PRIVILEGED action this app exposes, and
 * it is genuinely protected: saving signs the new settings with this
 * identity's own key (`services.actors.signPayload()`) and posts to
 * `POST /admin/settings`, which independently verifies that signature
 * against `adminPubs` SERVER-SIDE before persisting anything (see
 * relay.js's `#handleAdminSettings()`) - never trusting that only an
 * admin's client would ever call it, exactly like every other writer/
 * reader ACL in this codebase (see ThreadEngine).
 */
import { createI18n } from '@qu/i18n';

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
