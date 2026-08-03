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
import { QuRuntime, IndexedDBAdapter, IndexedDBOutboxStore } from '@qu/runtime';
import { DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { createServices, paths } from '@qu/services';
import { watch } from '@qu/reactive';
import { renderAvatar } from '@qu/ui';
import { parseHash, buildHash } from './router.js';
import { resolveFavoriteApps } from './nav.js';
import { loadClientModule } from './load-client-module.js';
import { qLogoSvgMarkup } from './logo.js';
import { registerServiceWorker, onUpdateAvailable, applyUpdate } from './pwa.js';
import { listenForNotificationClicks } from '@qu/push-client';
import { createDisclosureMenu, menuItem } from './menu.js';
import { buildAppContextMenu } from './context-menu.js';
import { t, locale } from './i18n.js';
import { getStoredLocale, setLocale, AVAILABLE_LOCALES } from '@qu/i18n';
import { renderOnboarding } from './onboarding.js';

const STORE_DB_NAME = 'quniverse-store';
const BLOB_DB_NAME = 'quniverse-blob';

/** @type {{trustedPublisherPubs?: string[], locale?: string}} */
const CONFIG = globalThis.QU_SHELL_CONFIG ?? {};

async function boot() {
  registerServiceWorker();
  listenForNotificationClicks((url) => { location.hash = url; });

  const storeAdapter = new IndexedDBAdapter(STORE_DB_NAME);
  const blobAdapter = new IndexedDBAdapter(BLOB_DB_NAME);
  const runtime = new QuRuntime({ storeAdapter });
  const qu = runtime.core;
  qu.mount('blob', blobAdapter);

  new DocumentEngine(qu);
  new CollectionEngine(qu);
  const assetEngine = new AssetEngine(qu);
  new ThreadEngine(qu);

  // Set up the relay connection BEFORE any local write happens (identity
  // creation, the new-identity profile publish below) - not because we
  // wait for it (we don't - connect() runs in the background, see the
  // catch() below), but because SyncEngine only ever observes writes from
  // the moment it's CONSTRUCTED onward (no history replay - see
  // sync-engine.js's own doc comment), and WebSocketClientTransport queues
  // anything sent before the handshake completes rather than dropping or
  // throwing (see websocket-client.js). Constructing both early, and
  // fire-and-forgetting connect() itself, means every local write from
  // here on is guaranteed to reach the relay once it's up, WITHOUT making
  // the whole page wait on a network round-trip just to render its shell.
  const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const relayUrl = CONFIG.relayUrl ?? `${wsScheme}//${location.host}`;
  const transport = new WebSocketClientTransport(relayUrl);
  // publishAllTo: 'relay' - see SyncEngine's own doc comment for why a
  // star-topology client (this shell, talking to its one relay) wants
  // unconditional publish rather than subscription-based broadcasting for
  // its OWN writes. `outbox`: a persistent (IndexedDB-backed) record of
  // writes not yet acknowledged by the relay - see outbox.js - so a write
  // made while genuinely offline survives a reload/relaunch and gets
  // resent once the relay is reachable again, instead of only surviving a
  // same-session reconnect (all the transport's own in-memory queue can do).
  const sync = new SyncEngine(qu, transport, { publishAllTo: 'relay', outbox: new IndexedDBOutboxStore('quniverse-sync-outbox') });
  transport.connect().catch((err) => console.error('[shell] relay connection failed:', err));

  const identity = new QuIdentityEngine(qu);
  if (!(await identity.hasIdentity())) {
    // Renders straight into document.body - no shell chrome exists yet at
    // this point in boot(), and none should: a device with no identity has
    // nothing meaningful to show a nav/header for. See onboarding.js for
    // the two paths (create new / import an existing identity from another
    // device via pasted code or QR scan) and why the mnemonic can ONLY
    // ever be shown at creation time (never again afterward - see
    // @qu/identity's exportSeedCode() doc comment).
    const outcome = await renderOnboarding(document.body, identity);
    if (outcome === 'created') {
      // Publish an (initially empty) public profile immediately, rather
      // than waiting for a visit to the Profile app - the ONLY thing
      // another identity needs to encrypt something FOR this one (an
      // encrypted Thread's reader key, an @qu/identity attestation, ...)
      // is the xPublicKey this always includes (see QuIdentityEngine's
      // publishMainProfile()), which is derivable the moment an identity
      // exists. Without this, the very first Chat/Inbox message to a
      // brand-new identity would fail with "no published profile" until
      // they happened to open Profile first - alias/avatar can be filled
      // in later, but the key an encrypted message needs shouldn't be
      // gated on a UI visit that has nothing to do with encryption.
      await identity.publishMainProfile({});
    }
    // 'imported': this identity's profile was already published by
    // whichever device it originated on (and will sync in once this
    // session subscribes/backfills - see @qu/services/sync-freshness.js) -
    // publishing an EMPTY one here would overwrite the real alias/avatar
    // the moment it synced out, so this path deliberately does nothing.
  }

  // See ThreadService's constructor doc comment (@qu/services) for why it
  // needs this: encrypting for a reader, or decrypting a message from a
  // sender, whose profile hasn't happened to sync to THIS session yet
  // (subscribe() only covers writes made after subscribing - no history
  // replay) would otherwise fail for no reason a user could fix.
  const Qu = createServices(qu, {
    assetEngine, identityEngine: identity,
    syncFetch: (path) => sync.fetch(path),
    // Lets every Service background-refresh data it already has cached but
    // that might have gone stale while this session was offline (see
    // @qu/services/sync-freshness.js) - subscribe()-based live sync alone
    // never catches up on anything missed while disconnected.
    getSyncGeneration: () => sync.getGeneration(),
  });
  const actorPub = await Qu.actors.whoAmI();

  // "Forget this identity" (see apps/profile/client.js's backup section,
  // exposed to it via ctx.wipeIdentity below) - permanently deletes BOTH
  // local IndexedDB databases (see IndexedDBAdapter.destroy()'s own doc
  // comment for why an all-or-nothing wipe is the only option this stack
  // has) and reloads, landing back on the onboarding screen above. Defined
  // here (closing over storeAdapter/blobAdapter, which the Shell instance
  // itself has no reason to hold onto otherwise) rather than as a Shell
  // method.
  async function wipeIdentity() {
    sync.close();
    transport.close();
    await Promise.all([storeAdapter.destroy(), blobAdapter.destroy()]);
    location.reload();
  }

  const shell = new Shell(qu, Qu, actorPub, sync, wipeIdentity);
  await shell.mount(document.body);
}

class Shell {
  constructor(qu, Qu, actorPub, sync, wipeIdentity) {
    this.qu = qu;
    this.Qu = Qu;
    this.actorPub = actorPub;
    this.sync = sync;
    this.wipeIdentity = wipeIdentity;
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

    // Brand comes FIRST - the one fixed anchor of the header, everything
    // else (history, menu, identity) reads left-to-right after it.
    const brand = document.createElement('a');
    brand.href = buildHash('');
    brand.className = 'qu-shell-brand';
    brand.title = 'QUniverse';
    brand.innerHTML = qLogoSvgMarkup({ size: 28 });

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

    const spacer = document.createElement('span');
    spacer.className = 'qu-shell-spacer';

    this.headerMenu = createDisclosureMenu({ label: t('nav.menu'), buttonContent: '☰' });

    // Hidden until onUpdateAvailable() fires (see pwa.js) - a new service
    // worker/bundle is installed and waiting, but per sw.js's own doc
    // comment does NOT take over on its own, specifically so this can be a
    // deliberate user action rather than a reload happening mid-interaction.
    const updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = 'qu-shell-update-btn';
    updateBtn.hidden = true;
    updateBtn.textContent = t('pwa.updateAvailable');
    updateBtn.title = t('pwa.updateAvailable');
    updateBtn.addEventListener('click', () => {
      updateBtn.disabled = true; // applyUpdate() leads to a reload - nothing left to click again for
      applyUpdate();
    });
    onUpdateAvailable(() => { updateBtn.hidden = false; });

    // Available everywhere, not just buried in Profile's settings section
    // (see apps/profile/client.js's identical picker) - a first-run
    // visitor's language choice shouldn't require finding their own
    // profile page first. Same reload-on-change tradeoff as Profile's:
    // @qu/i18n resolves each `createI18n()` call once per page load (see
    // that package's own doc comment), so there's no live-retranslation
    // mechanism to hook into instead.
    const langSelect = document.createElement('select');
    langSelect.className = 'qu-shell-lang';
    langSelect.title = t('nav.language');
    langSelect.setAttribute('aria-label', t('nav.language'));
    const currentLocale = getStoredLocale() ?? locale;
    for (const { code, label } of AVAILABLE_LOCALES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = label;
      if (code === currentLocale) option.selected = true;
      langSelect.appendChild(option);
    }
    langSelect.addEventListener('change', () => {
      setLocale(langSelect.value);
      location.reload();
    });

    // Standalone bell - deliberately NOT inside headerMenu (the user wants
    // new-notification visibility at a glance, not one tap deep in a
    // hamburger menu). Links straight to the notification feed (Task #38);
    // the badge's live count comes from _watchNotifBadge() below.
    const bellBtn = document.createElement('a');
    bellBtn.href = buildHash('notifications');
    bellBtn.className = 'qu-shell-bell';
    bellBtn.title = t('nav.notifications');
    bellBtn.setAttribute('aria-label', t('nav.notifications'));
    bellBtn.textContent = '🔔';
    this.notifBadgeEl = document.createElement('span');
    this.notifBadgeEl.className = 'qu-shell-bell-badge';
    this.notifBadgeEl.hidden = true;
    bellBtn.appendChild(this.notifBadgeEl);

    // Reactively bound to this identity's own profile (watch(), not a
    // one-time read - see the user's explicit "UI soll komplett reactive
    // sein" request): shows the alias the moment it's set/changed anywhere,
    // falling back to the short pubkey while none is set. Links to this
    // identity's own public-profile route (#/~<pub>, see _renderRoute()).
    const idLink = document.createElement('a');
    idLink.className = 'qu-shell-id';
    idLink.href = buildHash(`~${this.actorPub}`);
    let idAvatarEl = renderAvatar(this.actorPub, '', null, { size: '1.6rem' });
    const idText = document.createElement('span');
    idText.textContent = `~${this.actorPub.slice(0, 10)}…`;
    idLink.append(idAvatarEl, idText);
    // watch() as TRIGGER, re-fetch via ProfileService - not the raw notify
    // value, which for a profile is a signed envelope (`{profile,
    // signature}`, see @qu/identity's `#publishProfileWithKeys()`), not the
    // flat fields, and hasn't had its signature verified. Same pattern
    // used everywhere else reactive UI in this app reads Thread/profile
    // data (see @qu/reactive's own doc comment).
    watch(this.qu, actorPath(this.actorPub, 'profile'), async () => {
      const profile = await this.Qu.profile.getOwnProfile();
      idText.textContent = profile.alias || `~${this.actorPub.slice(0, 10)}…`;
      const nextAvatar = renderAvatar(this.actorPub, profile.alias, profile.avatar, { size: '1.6rem' });
      idAvatarEl.replaceWith(nextAvatar);
      idAvatarEl = nextAvatar;
    });

    header.append(brand, backBtn, forwardBtn, spacer, updateBtn, langSelect, this.headerMenu.el, bellBtn, idLink);

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

    // A small, fixed set of prefixes covering what the shell itself needs
    // live: public profiles/attestations (contacts, directory), and the
    // directory's own visibility index. Apps mounted later are responsible
    // for subscribing to whatever ELSE they need (their own spaces) -
    // the shell has no way to know that in advance. (This SyncEngine was
    // already constructed - and its transport's connect() already kicked
    // off - back in boot(), before any local write could happen; see that
    // function's own doc comment for why the ordering matters.)
    this.sync.subscribe('/store/actors');
    this.sync.subscribe('/store/directory');
    this.sync.subscribe(`/store/notifications-${this.actorPub}`);
    this._watchNotifBadge();

    await this._loadAdminConfig();
    await this._refreshApps();
    await this._renderRoute();
  }

  /**
   * Live unread-count badge on the header bell - reuses the exact
   * notifications space/thread convention `apps/notifications/client.js`
   * writes to and reads from (space `notifications-<myPub>`, thread id
   * `notifications`, see THREAD_PRESETS.notifications). Recomputed on THREE
   * independent triggers:
   *   - `watch()` on the thread's message-list path - a brand new
   *     notification arriving (locally or via sync).
   *   - `watch()` on this identity's OWN read-marker path, PLUS a `syncFetch`
   *     on both watches (see @qu/reactive's `watch()` own doc comment) - a
   *     read marker published from ANOTHER DEVICE lands on a path nothing
   *     else here would otherwise re-check until some unrelated write
   *     happened to touch the message list too (found via real multi-device
   *     testing: without this, a notification marked read elsewhere kept
   *     showing as unread here for one to several reload cycles, until pure
   *     luck lined up a background refresh with a re-render).
   *   - the `qu:notifications-read` window event, dispatched by
   *     apps/notifications/client.js's feed view right after it calls
   *     `markRead()` FROM THIS device - that write lands on the same
   *     read-marker path the second `watch()` above covers, but a LOCAL
   *     write's own notify fires before this method's watch() has had a
   *     chance to register in some mount orderings, so the explicit event
   *     stays as a belt-and-braces trigger. Same cross-app window-event
   *     convention `qu:favorites-changed` already uses.
   */
  _watchNotifBadge() {
    const spaceId = `notifications-${this.actorPub}`;
    const listPath = paths.collectionPath(spaceId, paths.threadMessagesCollectionId('notifications'));
    const readMarkerPath = paths.threadReadMarkerPath(spaceId, 'notifications', this.actorPub);
    const syncFetch = (path) => this.sync.fetch(path);
    const update = async () => {
      const [messages, lastReadAt] = await Promise.all([
        this.Qu.threads.listMessages(spaceId, 'notifications'),
        this.Qu.threads.getLastReadAt(spaceId, 'notifications'),
      ]);
      const unread = messages.filter((m) => (m.ts ?? 0) > lastReadAt).length;
      this.notifBadgeEl.textContent = unread > 9 ? '9+' : String(unread);
      this.notifBadgeEl.hidden = unread === 0;
    };
    watch(this.qu, listPath, update, { syncFetch });
    watch(this.qu, readMarkerPath, update, { initial: false, syncFetch });
    window.addEventListener('qu:notifications-read', update);
  }

  /**
   * Fetches the relay's admin pubkey list (see @qu/relay's `/config.json`) -
   * a UI hint only, see that route's own doc comment for why it's not a
   * security boundary - plus its current settings, of which only
   * `defaultLocale` matters to the shell itself (rate limits/disabled apps
   * are enforced server-side, nothing for the shell to DO with them beyond
   * what apps-catalog.js's `enabled` flag already achieves via
   * `_renderRoute()`).
   *
   * Adopting `defaultLocale` here is honestly incomplete: this fetch
   * finishes well after @qu/i18n's `createI18n()` already ran for the
   * shell's OWN chrome (apps/shell/src/i18n.js's module-level call, long
   * before boot() reaches this point) - so a first-ever visitor still sees
   * the header/menu in their BROWSER's language for this one page load.
   * What DOES work: `setLocale()` here persists the choice before this
   * session mounts its first app, so every app (each its own dynamically
   * imported module, each calling its OWN `createI18n()` fresh) already
   * picks it up THIS load, and a reload picks it up for the shell chrome
   * too. Doing better than that would mean server-templating index.html
   * per-request instead of serving it as a static file - real future work,
   * not done here.
   */
  async _loadAdminConfig() {
    try {
      const res = await fetch('/config.json');
      const config = res.ok ? await res.json() : {};
      this.adminPubs = config.adminPubs ?? [];
      if (!getStoredLocale() && config.settings?.defaultLocale) setLocale(config.settings.defaultLocale);
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

    // #/~<pub> is a reserved sigil (matching the real Qu's own #/~<fp>
    // profile-link convention) meaning "show this identity's public
    // profile" - always dispatches to the 'profile' app regardless of the
    // normal by-name catalog lookup below. `segments` is passed through
    // UNCHANGED (still `['~<pub>']`) so apps/profile/client.js parses the
    // pub back out of segments[0] itself; the shell doesn't need to know
    // what a pub even looks like beyond this one prefix check.
    const catalogName = appId.startsWith('~') ? 'profile' : appId;
    const app = this.apps.find((a) => a.name === catalogName);
    // A relay admin turning an app off (see apps/relay-admin/client.js and
    // @qu/relay's `POST /admin/settings`) must actually stop it from being
    // reachable, not just unlist it from menus - `enabled: false` still
    // APPEARS in this.apps (relay-admin needs to see it to re-enable it,
    // see apps-catalog.js's own doc comment) but is treated exactly like
    // an unknown app here, same as the other apps that already filter on
    // this flag (nav.js's resolveFavoriteApps(), apps/app-list).
    if (!app?.clientMainUrl || app.enabled === false) {
      this._renderAppToolbar(null);
      const msg = document.createElement('p');
      msg.textContent = `Unknown or non-mountable app: "${appId}"`;
      this.screenEl.appendChild(msg);
      return;
    }

    await this._renderAppToolbar(catalogName);

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
    // `subscribe` lets an app ask the shell's ONE relay connection to also
    // push live updates for a space the shell itself has no way to know
    // about in advance (see this.sync's own default subscriptions above,
    // which only cover what the SHELL chrome needs) - e.g. Forum/Chat/Inbox
    // subscribing to their own space so @qu/reactive's `watch()` (what
    // @qu/thread-ui's message view is built on) actually has live data to
    // react to, not just this browser's own writes. `fetch` is the
    // COMPLEMENTARY pull for data that's NOT going to arrive via
    // subscribe() no matter how long an app waits - subscribe() only ever
    // covers writes made AFTER subscribing (see SyncEngine's own doc
    // comment), so a value written ONCE and never updated again (e.g. Geo
    // Chase's game config - see apps/geochase/client.js) needs an explicit
    // one-time pull when opened via a link shared after the fact, the
    // same reasoning ThreadService's own `syncFetch` backfill already
    // applies to a not-yet-synced profile.
    const stop = mod.mount(this.screenEl, {
      qu: this.qu, services: this.Qu, appId, segments,
      // The full manifest catalog (same data `_refreshApps()` fetched from
      // `/apps.json`) - lets a mounted app discover what OTHER apps have
      // declared for one of ITS OWN mount points (see
      // @qu/foundation/actions.js's `actionsForMount()`) without ever
      // importing them: only one app's `clientMain` is ever loaded at a
      // time (see this method's own doc comment above), so this static
      // catalog is the only cross-app discovery a mounted app has.
      apps: this.apps,
      subscribe: (pathPrefix) => this.sync.subscribe(pathPrefix),
      fetch: (path) => this.sync.fetch(path),
      // Permanently deletes this identity and every byte of its local data,
      // then reloads - see boot()'s own definition of this function for
      // exactly what that means. Used by apps/profile/client.js's backup
      // section; any app COULD call it, but only Profile currently does.
      wipeIdentity: this.wipeIdentity,
      // Lets a mounted app know when the RELAY has durably persisted a
      // specific write, not just that it was sent - see SyncEngine's own
      // `waitForAck()` doc comment. apps/chat/client.js's `confirmSync()`
      // is the first consumer (replacing a single fetch()-and-hope attempt
      // that could strand a message's tick in "syncing…" forever).
      waitForAck: (path, ts, timeoutMs) => this.sync.waitForAck(path, ts, timeoutMs),
      onReconnect: (cb) => this.sync.onReconnect(cb),
    });
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

  // Directory visibility used to be toggled directly on the home screen;
  // it now lives with the rest of this identity's settings in the Profile
  // app's own-profile view (see apps/profile/client.js) - one settings
  // surface instead of two.
  async _renderHome() {
    const welcome = document.createElement('p');
    welcome.textContent = t('home.welcome', { actor: this.actorPub.slice(0, 16) });
    this.screenEl.appendChild(welcome);
  }
}

boot().catch((e) => {
  console.error('[shell] startup failed:', e);
  document.body.textContent = `Startup failed: ${e.message}`;
});
