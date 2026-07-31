/**
 * QUNIVERSE SHELL — the new "one central page". Unlike a shell that hard-
 * codes its apps (import statements baked in at build time), this one
 * knows NOTHING about any specific app: it boots identity/storage/sync,
 * fetches the currently loaded apps' manifests from its relay
 * (`/apps.json`, see @qu/relay), builds its nav menu FROM that list, and
 * mounts whichever app the URL selects via `clientMain` - locally hosted or
 * genuinely remote, integrity-checked either way (see load-client-module.js).
 *
 * This is deliberately close in spirit to the real Qu's own
 * shell/qu-app-shell.mjs (bootstrap once, mount apps in-place, one identity
 * for the whole session) - the concrete difference is WHERE an app's code
 * is allowed to come from: that shell only ever `import()`s same-origin
 * modules declared in the one repo's own index.js at deploy time; this one
 * can load anything a Loader-style manifest points at, local or remote,
 * because @qu/foundation's Registry + integrity/signature checking make
 * that safe to do without adding a new trust boundary silently.
 */
import { QuRuntime, IndexedDBAdapter } from '@qu/runtime';
import { DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { createServices, paths } from '@qu/services';
import { parseHash, buildHash } from './router.js';
import { visibleApps, sortByNavOrder, resolveFavoriteApps } from './nav.js';
import { loadClientModule } from './load-client-module.js';

/** @type {{trustedPublisherPubs?: string[]}} */
const CONFIG = globalThis.QU_SHELL_CONFIG ?? {};

async function boot() {
  const runtime = new QuRuntime({ storeAdapter: new IndexedDBAdapter('quniverse-store') });
  const qu = runtime.core;
  qu.mount('blob', new IndexedDBAdapter('quniverse-blob'));

  new DocumentEngine(qu);
  new CollectionEngine(qu);
  const assetEngine = new AssetEngine(qu);
  new ThreadEngine(qu);

  const identity = new QuIdentityEngine(qu);
  if (!(await identity.hasIdentity())) {
    const mnemonic = identity.generateMnemonic();
    await identity.importMnemonic(mnemonic);
    console.warn('[shell] New identity created. Recovery phrase (save this somewhere safe):', mnemonic);
  }

  const Qu = createServices(qu, { assetEngine, identityEngine: identity });
  const actorPub = await Qu.actors.whoAmI();

  const shell = new Shell(qu, Qu, actorPub);
  await shell.mount(document.body);
  await shell.connect();
}

class Shell {
  constructor(qu, Qu, actorPub) {
    this.qu = qu;
    this.Qu = Qu;
    this.actorPub = actorPub;
    this.apps = [];
    this.stopMountedApp = null;
  }

  async mount(root) {
    root.textContent = '';
    root.qu = this.qu; // establishes the Qu-Components context for the whole page

    const header = document.createElement('header');
    header.className = 'qu-shell-header';
    const brand = document.createElement('a');
    brand.href = buildHash('');
    brand.className = 'qu-shell-brand';
    brand.textContent = 'QUniverse';
    this.navEl = document.createElement('nav');
    this.navEl.className = 'qu-shell-nav';
    const idLink = document.createElement('span');
    idLink.className = 'qu-shell-id';
    idLink.textContent = `~${this.actorPub.slice(0, 10)}…`;
    header.append(brand, this.navEl, idLink);

    this.screenEl = document.createElement('main');
    this.screenEl.className = 'qu-shell-screen';

    root.append(header, this.screenEl);

    window.addEventListener('hashchange', () => this._renderRoute());

    await this._refreshApps();
    await this._renderRoute();
  }

  async connect() {
    // Mirror the page's own scheme (https -> wss, http -> ws) and host
    // (incl. port, if any) rather than hardcoding ws:// - behind a TLS-
    // offloading reverse proxy the browser is on https:// while the relay
    // itself only ever speaks plain ws:// on its own port, so a hardcoded
    // scheme here would either mixed-content-block (http URL from an https
    // page) or simply be wrong once a proxy sits in front of the relay.
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = CONFIG.relayUrl ?? `${wsScheme}//${location.host}`;
    const transport = new WebSocketClientTransport(url);
    await transport.connect();
    this.sync = new SyncEngine(this.qu, transport);
    // A small, fixed set of prefixes covering what the shell itself needs
    // live: public profiles/attestations (contacts, directory), and the
    // directory's own visibility index. Apps mounted later are responsible
    // for subscribing to whatever ELSE they need (their own spaces) -
    // the shell has no way to know that in advance.
    this.sync.subscribe('/store/actors');
    this.sync.subscribe('/store/directory');
  }

  async _refreshApps() {
    try {
      const res = await fetch('/apps.json');
      this.apps = res.ok ? await res.json() : [];
    } catch (e) {
      console.error('[shell] failed to load /apps.json:', e);
      this.apps = [];
    }
    await this._renderNav();
  }

  async _renderNav() {
    this.navEl.textContent = '';
    const visible = sortByNavOrder(visibleApps(this.apps));

    const favoriteIds = await this.Qu.favorites.list();
    const favorites = resolveFavoriteApps(this.apps, favoriteIds);
    for (const app of favorites) {
      this.navEl.appendChild(this._navLink(app, true));
    }
    if (favorites.length && visible.length) {
      const sep = document.createElement('span');
      sep.className = 'qu-shell-nav-sep';
      sep.textContent = '|';
      this.navEl.appendChild(sep);
    }
    for (const app of visible) {
      this.navEl.appendChild(this._navLink(app, favoriteIds.includes(app.name)));
    }
  }

  _navLink(app, isFavorite) {
    const a = document.createElement('a');
    a.href = buildHash(app.name);
    a.className = 'qu-shell-nav-link';
    a.textContent = `${app.icon ?? ''} ${app.label ?? app.name}`.trim();
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'qu-shell-fav-toggle';
    star.textContent = isFavorite ? '★' : '☆';
    star.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
    star.addEventListener('click', async (e) => {
      e.preventDefault();
      if (isFavorite) await this.Qu.favorites.remove(app.name);
      else await this.Qu.favorites.add(app.name);
      await this._renderNav();
    });
    const wrap = document.createElement('span');
    wrap.className = 'qu-shell-nav-item';
    wrap.append(a, star);
    return wrap;
  }

  async _renderRoute() {
    this.stopMountedApp?.();
    this.stopMountedApp = null;
    this.screenEl.textContent = '';

    const { appId, segments } = parseHash(location.hash);
    if (!appId) return this._renderHome();

    const app = this.apps.find((a) => a.name === appId);
    if (!app?.clientMainUrl) {
      const msg = document.createElement('p');
      msg.textContent = `Unknown or non-mountable app: "${appId}"`;
      this.screenEl.appendChild(msg);
      return;
    }

    const loading = document.createElement('p');
    loading.textContent = `Loading ${app.label ?? app.name}…`;
    this.screenEl.appendChild(loading);

    let mod;
    try {
      mod = await loadClientModule(app.clientMainUrl, {
        integrity: app.clientIntegrity,
        signature: app.clientSignature,
        trustedPublisherPubs: CONFIG.trustedPublisherPubs,
      });
    } catch (e) {
      console.error(`[shell] failed to load "${appId}":`, e);
      this.screenEl.textContent = '';
      const err = document.createElement('p');
      err.className = 'qu-shell-error';
      err.textContent = `Failed to load "${appId}": ${e.message}`;
      this.screenEl.appendChild(err);
      return;
    }
    if (typeof mod.mount !== 'function') {
      console.error(`[shell] "${appId}"'s clientMain has no mount() export`);
      return;
    }

    this.screenEl.textContent = '';
    const stop = mod.mount(this.screenEl, { qu: this.qu, services: this.Qu, appId, segments });
    this.stopMountedApp = typeof stop === 'function' ? stop : null;
  }

  async _renderHome() {
    const welcome = document.createElement('p');
    welcome.textContent = `Welcome, ~${this.actorPub.slice(0, 16)}…`;
    this.screenEl.appendChild(welcome);

    const label = document.createElement('label');
    label.className = 'qu-shell-visibility-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = await this.Qu.directory.isVisible(this.actorPub);
    checkbox.addEventListener('change', async () => {
      await this.Qu.directory.setVisible(checkbox.checked, { actorPub: this.actorPub });
    });
    label.append(checkbox, document.createTextNode(' Listed in directory'));
    this.screenEl.appendChild(label);
  }
}

boot().catch((e) => {
  console.error('[shell] startup failed:', e);
  document.body.textContent = `Startup failed: ${e.message}`;
});
