/**
 * RELAY ADMIN — a read-only status panel over information the relay
 * already serves publicly (`/healthz`, `/apps.json`, `/config.json` - see
 * @qu/relay/relay.js): peer id, loaded apps, and the configured admin
 * pubkey list. The shell only links here for an identity in that list
 * (see apps/shell/src/main.js's `isAdmin`), and this app repeats that same
 * check before rendering anything - but BOTH checks are a UI convenience,
 * not a security boundary: everything shown here is already public
 * information any client could fetch directly. There is nothing
 * PRIVILEGED to protect yet because this panel is read-only. The moment a
 * real admin ACTION is added (disable an app, kick a peer, ...), it MUST
 * be a server-side route that verifies a signed request against
 * `adminPubs` itself (exactly like ThreadEngine's writer ACL enforcement -
 * see @qu/engines/thread-engine.js) - never trust that only an admin's
 * client would ever call it.
 */
import { createI18n } from '@qu/i18n';

const DICT = {
  en: {
    title: 'Relay Admin',
    denied: 'This identity is not a configured relay admin.',
    peerId: 'Relay peer id',
    adminPubs: 'Configured admin pubkeys',
    loadedApps: 'Loaded apps',
  },
  de: {
    title: 'Relay-Admin',
    denied: 'Diese Identität ist kein konfigurierter Relay-Admin.',
    peerId: 'Relay Peer-ID',
    adminPubs: 'Konfigurierte Admin-Pubkeys',
    loadedApps: 'Geladene Apps',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-relay-admin-style';
const STYLE = `
  .qu-admin-section { margin-top: 1rem; }
  .qu-admin-section h2 { font-size: 1em; opacity: 0.7; margin-bottom: 0.4rem; }
  .qu-admin-mono { font-family: ui-monospace, monospace; font-size: 0.9em; word-break: break-all; }
  .qu-admin-table { border-collapse: collapse; width: 100%; }
  .qu-admin-table th, .qu-admin-table td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid #8884; }
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
  })();

  return () => { stopped = true; };
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
