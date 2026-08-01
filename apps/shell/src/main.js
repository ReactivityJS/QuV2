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
 *
 * URL SCHEME: every route is `#/<appId>/<...path>` (see router.js) - the
 * first segment always selects which app's manifest to mount (its "space"
 * in the loose sense: the self-contained area of the page that app owns),
 * everything after is that app's own business (e.g. a thread id, a room).
 * Every app built for this shell is expected to follow this scheme for its
 * OWN internal navigation too (build hashes with `buildHash()`, never a
 * hand-rolled `#...` string) - that's what makes the header's back/forward
 * buttons below meaningful: hash changes are real browser history entries.
 */
import { QuRuntime, IndexedDBAdapter } from '@qu/runtime';
import { DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { createServices, paths } from '@qu/services';
import { parseHash, buildHash } from './router.js';
import { resolveFavoriteApps } from './nav.js';
import { loadClientModule } from './load-client-module.js';
import { qLogoSvgMarkup } from './logo.js';
import { registerServiceWorker } from './pwa.js';
import { createDisclosureMenu, menuItem } from './menu.js';
import { buildAppContextMenu } from './context-menu.js';
import { t } from './i18n.js';

/** @type {{trustedPublisherPubs?: string[], locale?: string}} */
const CONFIG = globalThis.QU_SHELL_CONFIG ?? {};

async function boot() {
  registerServiceWorker();

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
    this.adminPubs = [];
    this.stopMountedApp = null;
    this.appMenu = null;
  }

  get isAdmin() {
    return this.adminPubs.includes(this.actorPub);
  }

  async mount(root) {
    root.textContent = '';
    root.qu = this.qu; // establishes the Qu-Components context for the whole page

    const header = document.createElement('header');
    header.className = 'qu-shell-header';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'qu-shell-history-btn';
    backBtn.textContent = '◀';
    backBtn.title = t('nav.back');
    backBtn.setAttribute('aria-label', t('nav.back'));
    backBtn.addEventListener('click', () => history.back());

    const forwardBtn = document.createElement('button');
    forwardBtn.type = 'button';
    forwardBtn.className = 'qu-shell-history-btn';
    forwardBtn.textContent = '▶';
    forwardBtn.title = t('nav.forward');
    forwardBtn.setAttribute('aria-label', t('nav.forward'));
    forwardBtn.addEventListener('click', () => history.forward());

    const brand = document.createElement('a');
    brand.href = buildHash('');
    brand.className = 'qu-shell-brand';
    brand.title = 'QUniverse';
    brand.innerHTML = qLogoSvgMarkup({ size: 28 });

    const spacer = document.createElement('span');
    spacer.className = 'qu-shell-spacer';

    this.headerMenu = createDisclosureMenu({ label: t('nav.menu'), buttonContent: '☰' });

    const idLink = document.createElement('span');
    idLink.className = 'qu-shell-id';
    idLink.textContent = `~${this.actorPub.slice(0, 10)}…`;

    header.append(backBtn, forwardBtn, brand, spacer, this.headerMenu.el, idLink);

    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'qu-shell-toolbar';

    this.screenEl = document.createElement('main');
    this.screenEl.className = 'qu-shell-screen';

    root.append(header, this.toolbarEl, this.screenEl);

    window.addEventListener('hashchange', () => this._renderRoute());
    // The one cross-app notification convention this shell defines: ANY
    // favorite mutation, from ANYWHERE (the header menu below, the per-app
    // context menu, or a fully independent app like App-List/apps/app-list -
    // each mounted as its own bundle with no reference back to this Shell
    // instance) dispatches this instead of calling a render method directly,
    // so every place favorites are shown stays in sync no matter which of
    // them made the change.
    window.addEventListener('qu:favorites-changed', () => {
      this._renderHeaderMenu();
      this._renderAppToolbar(this._currentAppId());
    });

    await this._loadAdminConfig();
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

  /** Fetches the relay's admin pubkey list (see @qu/relay's `/config.json`) - a UI hint only, see that route's own doc comment for why it's not a security boundary. */
  async _loadAdminConfig() {
    try {
      const res = await fetch('/config.json');
      this.adminPubs = res.ok ? (await res.json()).adminPubs ?? [] : [];
    } catch (e) {
      console.warn('[shell] failed to load /config.json:', e);
      this.adminPubs = [];
    }
  }

  async _refreshApps() {
    try {
      const res = await fetch('/apps.json');
      this.apps = res.ok ? await res.json() : [];
    } catch (e) {
      console.error('[shell] failed to load /apps.json:', e);
      this.apps = [];
    }
    await this._renderHeaderMenu();
  }

  /**
   * The header's dropdown menu: pinned (favorited) apps first - see
   * FavoritesService, toggled from either the App-List app or the per-app
   * context menu (context-menu.js) - then the two fixed entries every
   * QUniverse install has: App List (browse/favorite everything) and,
   * only for an admin pubkey (see `isAdmin` above), Relay Admin.
   */
  async _renderHeaderMenu() {
    const panel = this.headerMenu.panel;
    panel.textContent = '';

    const favoriteIds = await this.Qu.favorites.list();
    const favorites = resolveFavoriteApps(this.apps, favoriteIds);

    if (favorites.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-menu-empty';
      empty.textContent = t('nav.favorites.empty');
      panel.appendChild(empty);
    } else {
      for (const app of favorites) panel.appendChild(this._favoriteMenuRow(app));
    }

    const sep = document.createElement('hr');
    sep.className = 'qu-menu-sep';
    panel.appendChild(sep);

    panel.appendChild(this._menuLink(buildHash('app-list'), `🗂 ${t('nav.appList')}`));
    if (this.isAdmin) panel.appendChild(this._menuLink(buildHash('relay-admin'), `🛠 ${t('nav.admin')}`));
  }

  _favoriteMenuRow(app) {
    const row = document.createElement('div');
    row.className = 'qu-menu-fav-row';
    row.append(
      this._menuLink(buildHash(app.name), `${app.icon ?? ''} ${app.label ?? app.name}`.trim()),
      this._favoriteToggle(app.name, true)
    );
    return row;
  }

  _menuLink(href, label) {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'qu-menu-link';
    a.textContent = label;
    a.addEventListener('click', () => this.headerMenu.close());
    return a;
  }

  _favoriteToggle(appId, isFavorite) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qu-menu-fav-toggle';
    btn.textContent = isFavorite ? '★' : '☆';
    btn.title = isFavorite ? t('appMenu.favorite.remove') : t('appMenu.favorite.add');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (isFavorite) await this.Qu.favorites.remove(appId);
      else await this.Qu.favorites.add(appId);
      window.dispatchEvent(new CustomEvent('qu:favorites-changed'));
    });
    return btn;
  }

  _currentAppId() {
    return parseHash(location.hash).appId;
  }

  async _renderRoute() {
    this.stopMountedApp?.();
    this.stopMountedApp = null;
    this.screenEl.textContent = '';

    const { appId, segments } = parseHash(location.hash);
    if (!appId) {
      this._renderAppToolbar(null);
      return this._renderHome();
    }

    const app = this.apps.find((a) => a.name === appId);
    if (!app?.clientMainUrl) {
      this._renderAppToolbar(null);
      const msg = document.createElement('p');
      msg.textContent = `Unknown or non-mountable app: "${appId}"`;
      this.screenEl.appendChild(msg);
      return;
    }

    await this._renderAppToolbar(appId);

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

  /**
   * The per-app "⋯" context menu (Share/Install/Back/Favorite - see
   * context-menu.js), rendered in the toolbar row above whichever app is
   * currently mounted. Rebuilt on every route change (its favorite-state
   * label depends on which app is now current) - `destroy()` first, since
   * it registers its own outside-click listener (see menu.js).
   * @param {string|null} appId - null on the home screen, which has no context menu.
   */
  async _renderAppToolbar(appId) {
    this.appMenu?.destroy();
    this.appMenu = null;
    this.toolbarEl.textContent = '';
    if (!appId) return;

    const isFavorite = await this.Qu.favorites.isFavorite(appId);
    this.appMenu = buildAppContextMenu({
      isFavorite,
      onToggleFavorite: async () => {
        if (isFavorite) await this.Qu.favorites.remove(appId);
        else await this.Qu.favorites.add(appId);
        window.dispatchEvent(new CustomEvent('qu:favorites-changed')); // triggers the listener in mount(), which rebuilds this same toolbar with the new label
      },
    });
    this.toolbarEl.appendChild(this.appMenu.el);
  }

  async _renderHome() {
    const welcome = document.createElement('p');
    welcome.textContent = t('home.welcome', { actor: this.actorPub.slice(0, 16) });
    this.screenEl.appendChild(welcome);

    const label = document.createElement('label');
    label.className = 'qu-shell-visibility-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = await this.Qu.directory.isVisible(this.actorPub);
    checkbox.addEventListener('change', async () => {
      await this.Qu.directory.setVisible(checkbox.checked, { actorPub: this.actorPub });
    });
    label.append(checkbox, document.createTextNode(' ' + t('home.listedInDirectory')));
    this.screenEl.appendChild(label);
  }
}

boot().catch((e) => {
  console.error('[shell] startup failed:', e);
  document.body.textContent = `Startup failed: ${e.message}`;
});
