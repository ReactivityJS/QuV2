/**
 * QU RELAY — a Node.js peer that persists to disk, syncs with other peers,
 * and boots/serves Engines, Services and Apps. Also the single process
 * that serves the QUniverse shell at `/` - the same "one server process"
 * model the real Qu's own README documents for its shell + services, just
 * with the shell's apps coming from manifests instead of being hard-coded
 * into the server's own source.
 *
 * This is the concrete implementation of the "can the relay load apps
 * remotely at startup" idea from the architecture brainstorming: a relay
 * always loads its OWN local `apps/` directory (and serves it back out over
 * HTTP for other relays to consume), and optionally loads additional apps
 * from remote manifest URLs listed in its config - each one integrity- and
 * (optionally) signature-checked by @qu/loader before a single byte of it
 * runs. Nothing about @qu/core changed to make this possible: it all sits
 * in the Foundation/Loader/Engine/Service layers above it, exactly as the
 * brainstorming's "keep Qu small, evolve QUniverse" conclusion argued for.
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, sep } from 'node:path';
import { WebSocketServer } from 'ws';

import { QuCrypto } from '@qu/core';
import { QuRuntime } from '@qu/runtime';
import { Registry } from '@qu/foundation';
import { QuLoader, discoverLocalPackages } from '@qu/loader';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine, AccessEngine } from '@qu/engines';
import { createServices, NotificationPrefsService, THREAD_PRESETS } from '@qu/services';
import { generateVapidKeys, sendWebPush } from '@qu/push';

import { FsAdapter } from './adapters/fs-adapter.js';
import { WebSocketServerTransport } from './transports/websocket-server-transport.js';
import { serveApps } from './static-apps.js';
import { buildAppsCatalog } from './apps-catalog.js';

const SHELL_DIST_DIR = fileURLToPath(new URL('../../../apps/shell/dist/', import.meta.url));
const SHELL_PUBLIC_DIR = fileURLToPath(new URL('../../../apps/shell/public/', import.meta.url));

// Under LOCAL_ONLY_PREFIX (see @qu/sync/sync-engine.js) - this relay's OWN
// operational settings must never sync out to a peer relay, and @qu/sync
// refuses any INCOMING synced write under this prefix too, so it can't be
// clobbered by a peer either. Read publicly via `/config.json`'s
// `settings` field (see #handleHttp below); written only via the signed,
// admin-checked `POST /admin/settings` route - never through the normal
// qu.put() pipeline a regular client could reach.
const RELAY_SETTINGS_PATH = '/store/secure/admin/settings';

const DEFAULT_RELAY_SETTINGS = Object.freeze({
  defaultLocale: 'en',
  rateLimits: Object.freeze({ maxMessagesPerMinute: 0 }), // 0 = unlimited
  disabledApps: Object.freeze([]),
  // Admin-editable Flag TYPE catalog (see @qu/services' FlagService) - what
  // a "flag" even IS (Like/Bookmark/Favorite, which entity kinds it applies
  // to, whether it's a private list or a public counter) is data, not code,
  // same reasoning as `disabledApps`. Shipped with sane defaults so
  // bookmarking/favoriting works out of the box with zero admin action;
  // `favorite` here is descriptive only (FavoritesService/ContactsService
  // already implement it, unconditionally, regardless of this list - see
  // FlagService's own doc comment for why removing it here wouldn't
  // actually disable app/user favoriting).
  flagTypes: Object.freeze([
    Object.freeze({ id: 'favorite', label: 'Favorite', icon: '⭐', mode: 'private', entityKinds: Object.freeze(['app', 'user']) }),
    Object.freeze({ id: 'bookmark', label: 'Bookmark', icon: '🔖', mode: 'private', entityKinds: Object.freeze(['forum-thread', 'user']) }),
    Object.freeze({ id: 'like', label: 'Like', icon: '👍', mode: 'public', entityKinds: Object.freeze(['thread-message']) }),
  ]),
});

// Presence-aware push suppression (see the constructor's own doc comment
// for `presenceByActor` and #deliverThreadPush()'s use of it below): an
// actor last seen within this window is treated as "still online enough
// that a web push would be redundant" - they'll see the in-app
// notification (never suppressed) the moment they're back. Deliberately a
// plain time window, not a live "is this exact peerId's socket still
// open" check - the transport already tears the connection down promptly
// on a real disconnect, so a stale entry ages out on its own within this
// window either way, and tracking peerId liveness on top would be
// meaningfully more bookkeeping for a case this window already covers.
const PRESENCE_FRESH_MS = 60_000;
// Bounded the same way @qu/identity's own key/attestation caches are (see
// identity.js) - a long-running relay must not grow this map forever as
// distinct actors pass through over its lifetime.
const MAX_PRESENCE_ENTRIES = 2000;

/**
 * @typedef {Object} RemoteAppConfig
 * @property {string} manifestUrl
 * @property {string[]} [trustedPublisherPubs]
 */

/**
 * @typedef {Object} QuRelayOptions
 * @property {string} [storeDir='./relay-data/store']
 * @property {string} [blobDir='./relay-data/blob']
 * @property {string} [appsDir='./apps'] - Local apps this relay hosts, auto-loaded at boot and served over HTTP.
 * @property {number} [port=8080]
 * @property {string} [identityMnemonic] - Pin the relay's own operational identity across restarts.
 *   Without it, a fresh one is generated on first boot and then reused (see hasIdentity()).
 * @property {RemoteAppConfig[]} [remoteApps] - Additional apps to load from remote manifest URLs at boot.
 * @property {boolean} [serveShell=true] - Serve the QUniverse shell at `/` (see apps/shell).
 * @property {string[]} [adminPubs=[]] - base64url actor pubkeys the shell UI treats as relay
 *   admins (see `/config.json` above for the security caveat - this is a UI hint, not an ACL).
 * @property {string} [vapidPublicKey] - Pin the relay's Web Push VAPID keypair across restarts
 *   (see @qu/push) - both this and `vapidPrivateKey` must be given together, or neither. Without
 *   them, a fresh keypair is generated on first boot and persisted under LOCAL_ONLY_PREFIX (see
 *   @qu/sync/sync-engine.js) - never synced anywhere, same treatment as the identity seed.
 * @property {string} [vapidPrivateKey]
 * @property {string} [vapidSubject='mailto:admin@example.com'] - Required by every push service
 *   (RFC 8292) so they have someone to contact about abuse - override this for a real deployment.
 */

/**
 * Recursively lists every `.json` file FsAdapter has ever written under
 * `dir` (see ./adapters/fs-adapter.js - one file per stored QuBit, path
 * structure mirrored 1:1 onto the filesystem). Used by Relay Admin's Data
 * Explorer (`#handleAdminDataList()` below) to enumerate stored data -
 * there is no in-store wildcard/prefix query anywhere in this codebase
 * (see @qu/services/directory-service.js's own doc comment for the same
 * limitation elsewhere), so listing has to walk the adapter's own files
 * directly, one directory below the relay's own process.
 * @param {string} dir
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function walkJsonFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist yet (e.g. blobDir on a relay that's never stored an asset) - nothing to list
  }
  const out = [];
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkJsonFiles(full)));
    // FsAdapter's atomic write leaves a `<path>.<uuid>.tmp` file briefly mid-rename - never a finished, readable QuBit.
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * @param {string} filePath - As returned by `walkJsonFiles()`.
 * @param {string} baseDir - The adapter's own base directory.
 * @param {string} mountPrefix - e.g. '/store' or '/blob'.
 * @returns {string} The logical Qu path this file corresponds to.
 */
function fileToLogicalPath(filePath, baseDir, mountPrefix) {
  const rel = relative(baseDir, filePath).split(sep).join('/');
  return `${mountPrefix}/${rel.replace(/\.json$/, '')}`;
}

export class QuRelay {
  /** @param {QuRelayOptions} [options] */
  constructor(options = {}) {
    this.options = {
      storeDir: './relay-data/store',
      blobDir: './relay-data/blob',
      appsDir: './apps',
      port: 8080,
      remoteApps: [],
      serveShell: true,
      adminPubs: [],
      vapidSubject: 'mailto:admin@example.com',
      ...options,
    };

    this.registry = new Registry();
    this.runtime = new QuRuntime({ storeAdapter: new FsAdapter(this.options.storeDir) });
    this.core = this.runtime.core;
    this.core.mount('blob', new FsAdapter(this.options.blobDir));

    this.accessEngine = new AccessEngine(this.core);
    this.documentEngine = new DocumentEngine(this.core);
    this.collectionEngine = new CollectionEngine(this.core);
    this.assetEngine = new AssetEngine(this.core);
    this.threadEngine = new ThreadEngine(this.core);
    this.registry.registerEngine('access-engine', this.accessEngine);
    this.registry.registerEngine('document-engine', this.documentEngine);
    this.registry.registerEngine('collection-engine', this.collectionEngine);
    this.registry.registerEngine('asset-engine', this.assetEngine);
    this.registry.registerEngine('thread-engine', this.threadEngine);

    // The relay's OWN identity (for signing relay-authored data). This is
    // NOT where end users' identities live - see @qu/identity's
    // importMnemonic() doc: one QuCore holds at most one identity. End
    // users run their own Qu instance (browser, device) with their own
    // seed; the relay only ever sees their already-signed QuBits.
    this.identity = new QuIdentityEngine(this.core);

    this.services = createServices(this.core, { assetEngine: this.assetEngine, identityEngine: this.identity });
    this.registry.registerService('document-service', this.services.documents);
    this.registry.registerService('collection-service', this.services.collections);
    this.registry.registerService('asset-service', this.services.assets);
    this.registry.registerService('actor-service', this.services.actors);
    this.registry.registerService('starred-service', this.services.starred);
    this.registry.registerService('thread-service', this.services.threads);
    this.registry.registerService('favorites-service', this.services.favorites);
    this.registry.registerService('contacts-service', this.services.contacts);
    this.registry.registerService('directory-service', this.services.directory);
    this.registry.registerService('cms-service', this.services.cms);
    this.registry.registerService('profile-service', this.services.profile);
    this.registry.registerService('notification-prefs-service', this.services.notificationPrefs);
    this.registry.registerService('push-subscription-service', this.services.pushSubscriptions);
    this.registry.registerService('geochase-service', this.services.geochase);

    this.loader = new QuLoader(this.core, this.registry);
    this.vapidKeys = null;

    // actorPub -> lastSeenAt(ms) - see PRESENCE_FRESH_MS/MAX_PRESENCE_ENTRIES
    // above and #deliverThreadPush()'s use of this below. Populated
    // passively by `this.sync`'s `onPeerIdentified` callback (see boot()),
    // not written to directly anywhere else.
    this.presenceByActor = new Map();

    this._httpServer = null;
    this._wss = null;
    this.sync = null;
    this.transport = null;
  }

  /** @returns {import('@qu/core').QuCore} */
  get qu() {
    return this.core;
  }

  /** @returns {number} The actual listening port (resolves `options.port: 0` to the OS-assigned port). Only valid after boot(). */
  get port() {
    return this._httpServer.address().port;
  }

  /**
   * Boots the relay: establishes its own identity, starts the HTTP/WebSocket
   * server, then loads local apps (always) and remote apps (if configured).
   * @returns {Promise<QuRelay>} this
   */
  async boot() {
    if (this.options.identityMnemonic) {
      await this.identity.importMnemonic(this.options.identityMnemonic);
    } else if (!(await this.identity.hasIdentity())) {
      await this.identity.importMnemonic(this.identity.generateMnemonic());
    }

    // A published profile is what makes this identity's X25519 key
    // resolvable by anyone else - see @qu/services/thread-service.js's
    // `#resolveReaderXKeys()`/`#decryptMessage()`, which both fail closed
    // (silently treat the message as undecryptable) for a signer with no
    // profile. Without this, `#writeInAppNotification()` below - which
    // signs+encrypts each in-app notification under THIS identity - would
    // write messages no recipient could ever actually decrypt. Same
    // "publish immediately, don't wait for a UI visit" reasoning
    // apps/shell's boot() already applies to a brand-new end-user identity.
    const ownPub = QuCrypto.toBase64Url((await this.identity.getMainKey()).publicKey);
    if (!(await this.identity.getProfile(ownPub))) {
      await this.identity.publishMainProfile({});
    }

    await this.#setupVapidKeys();

    this._httpServer = createServer((req, res) => this.#handleHttp(req, res));
    this._wss = new WebSocketServer({ server: this._httpServer });
    await new Promise((resolve) => this._httpServer.listen(this.options.port, resolve));

    const settings = await this.#getSettings();
    this.transport = new WebSocketServerTransport(this._wss, { maxMessagesPerMinute: settings.rateLimits.maxMessagesPerMinute });
    this.sync = new SyncEngine(this.core, this.transport, {
      onPeerIdentified: (_peerId, actorPub) => this.#recordPresence(actorPub),
    });

    // Push delivery: fires for EVERY thread message write this relay ever
    // sees, whether authored locally (rare - the relay itself is never a
    // Thread participant in practice) or arriving via sync (the normal
    // case, since every browser client's messages are synced TO this
    // relay - see @qu/sync's `publishAllTo`). Deliberately a plain
    // `onStorageChange` listener here, NOT inside SyncEngine - this has
    // nothing to do with replication, it's the relay noticing its own
    // data changed, same as any other reactive consumer.
    this.core.onStorageChange(({ path, quBit }) => {
      const match = path.match(/^\/store\/([^/]+)\/threads\/([^/]+)\/msgs\/([^/]+)$/);
      if (!match) return;
      const [, spaceId, threadId] = match;
      this.#deliverThreadPush(spaceId, threadId, quBit).catch((err) => {
        console.error(`[QuRelay] push delivery failed for ${path}:`, err);
      });
    });

    const localApps = await discoverLocalPackages(this.options.appsDir);
    for (const app of localApps) {
      await this.loader.loadLocal(app.dir, { availableManifests: localApps });
    }

    for (const remote of this.options.remoteApps) {
      await this.loader.loadRemote(remote.manifestUrl, { trustedPublisherPubs: remote.trustedPublisherPubs ?? [] });
    }

    console.log(`[QuRelay] listening on http://localhost:${this.port} (peer ${this.transport.getPeerId()})`);
    console.log(`[QuRelay] loaded apps: ${this.loader.listLoaded().join(', ') || '(none)'}`);
    return this;
  }

  /** @returns {Promise<{defaultLocale: string, rateLimits: {maxMessagesPerMinute: number}, disabledApps: string[], flagTypes: Array<{id: string, label: string, icon: string, mode: string, entityKinds: string[]}>}>} Always fully populated - missing fields fall back to DEFAULT_RELAY_SETTINGS. */
  async #getSettings() {
    const stored = await this.core.get(RELAY_SETTINGS_PATH);
    const val = stored?.val ?? {};
    return { ...DEFAULT_RELAY_SETTINGS, ...val, rateLimits: { ...DEFAULT_RELAY_SETTINGS.rateLimits, ...val.rateLimits } };
  }

  /**
   * @param {object} patch - Shallow-merged into the current settings (a
   * nested `rateLimits` patch replaces that whole sub-object, matching
   * every other Service's `update()`-style merge in this codebase -
   * apps/relay-admin/client.js always sends the full `rateLimits` object,
   * never a partial one, so this is never actually lossy in practice).
   * @returns {Promise<object>} The merged, persisted settings.
   */
  async #saveSettings(patch) {
    const merged = { ...(await this.#getSettings()), ...patch };
    await this.core.put(RELAY_SETTINGS_PATH, merged);
    return merged;
  }

  /**
   * Resolves this relay's VAPID keypair: explicit `options.vapidPublicKey`
   * + `vapidPrivateKey` win if both are given; otherwise a keypair
   * persisted under LOCAL_ONLY_PREFIX (see @qu/sync/sync-engine.js) is
   * reused across restarts, or generated once on first boot - the exact
   * same "pin explicitly, or auto-generate-and-persist" pattern this
   * relay already uses for its own operational identity (see boot()'s
   * `identityMnemonic` handling just above).
   */
  async #setupVapidKeys() {
    if (this.options.vapidPublicKey && this.options.vapidPrivateKey) {
      this.vapidKeys = { publicKey: this.options.vapidPublicKey, privateKey: this.options.vapidPrivateKey, subject: this.options.vapidSubject };
      return;
    }
    const stored = await this.core.get('/store/secure/push/vapid');
    const record = stored?.val ?? stored;
    if (record) {
      this.vapidKeys = { ...record, subject: this.options.vapidSubject };
      return;
    }
    const generated = generateVapidKeys();
    await this.core.put('/store/secure/push/vapid', generated);
    this.vapidKeys = { ...generated, subject: this.options.vapidSubject };
  }

  /**
   * Notification delivery for one thread message: figures out who should be
   * notified, checks each candidate's own NotificationPrefsService
   * settings, then does TWO independent things for each candidate that
   * passes - write an in-app notification record to their own
   * notifications Thread (always, so the header bell/feed - see
   * apps/shell/src/main.js's `_watchNotifBadge()` and
   * apps/notifications/client.js - has something to show even with push
   * off or unsupported), and send a generic (never-the-actual-content) Web
   * Push to every one of their registered devices (only if this relay has
   * VAPID keys AND they have subscriptions - unrelated to the first part).
   *
   * appId is derived from `spaceId` by a small, deliberately ad hoc
   * convention matching this repo's own built-in apps (forum/chat/
   * inbox-<pub>) - there is no formal "which app owns this space" registry
   * to consult instead; a third-party app using its own space naming
   * would currently just fall back to the raw spaceId as its appId, which
   * still works for per-app prefs, just without a nicer label.
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {object} quBit - The message QuBit as just persisted.
   */
  /**
   * Records that `actorPub` was just seen (see `this.sync`'s
   * `onPeerIdentified` callback, wired in boot()) - called passively off
   * whatever traffic that identity already generates (a posted message, a
   * thread-presence heartbeat, ...), never a dedicated "I'm online" signal.
   * @param {string} actorPub
   */
  #recordPresence(actorPub) {
    this.presenceByActor.delete(actorPub); // re-insert to move it to the end - see the eviction loop below, which relies on Map's insertion order
    this.presenceByActor.set(actorPub, Date.now());
    while (this.presenceByActor.size > MAX_PRESENCE_ENTRIES) {
      this.presenceByActor.delete(this.presenceByActor.keys().next().value);
    }
  }

  /** @param {string} actorPub @returns {boolean} */
  #isRecentlyOnline(actorPub) {
    const lastSeenAt = this.presenceByActor.get(actorPub);
    return typeof lastSeenAt === 'number' && Date.now() - lastSeenAt < PRESENCE_FRESH_MS;
  }

  async #deliverThreadPush(spaceId, threadId, quBit) {
    // A relay-authored notice about a message IN a notifications thread
    // would loop forever (deliver -> write notice -> deliver -> ...) -
    // notifications threads are a delivery TARGET, never a delivery
    // SOURCE. Checked first, before any other work.
    if (String(spaceId).startsWith('notifications-')) return;

    const config = await this.services.threads.getConfig(spaceId, threadId);
    if (!config) return;

    const authorPub = quBit.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
    const mentions = Array.isArray(quBit.val?.mentions) ? quBit.val.mentions : [];
    // `calendar-<id>` is Calendar's per-calendar space (see
    // apps/calendar/client.js's `activity`/`invite-<actorPub>` threads) -
    // recognized generically like `inbox-<pub>` below so every shared
    // calendar collapses into ONE 'calendar' row in notification settings
    // instead of one per calendar id.
    const calendarMatch = String(spaceId).match(/^calendar-(.+)$/);
    // `geochase-<id>` is Geo Chase's per-game space (see
    // @qu/services/geochase-service.js's `spaceFor()` and
    // apps/geochase/client.js's `notifyInvitees()`) - recognized the same
    // way `calendar-<id>` is above, so every game collapses into ONE
    // 'geochase' row in notification settings instead of one per game id.
    const geochaseMatch = String(spaceId).match(/^geochase-(.+)$/);
    const appId = spaceId === 'forum' ? 'forum' : spaceId === 'chat' ? 'chat'
      : String(spaceId).startsWith('inbox-') ? 'inbox' : calendarMatch ? 'calendar'
      : geochaseMatch ? 'geochase' : String(spaceId);

    /** @type {Array<{actorPub: string, mention: boolean}>} */
    let candidates;
    if (Array.isArray(config.readers)) {
      // A private thread (chat/mail/calendar activity+invites): every OTHER reader gets a notice.
      candidates = config.readers.filter((pub) => pub !== authorPub).map((actorPub) => ({ actorPub, mention: mentions.includes(actorPub) }));
    } else {
      // A public thread (forum): notifying every reader would mean notifying the entire
      // relay for every post - only explicit @mentions get pushed here.
      candidates = mentions.filter((pub) => pub !== authorPub).map((actorPub) => ({ actorPub, mention: true }));
    }

    // Calendar has three distinct push-worthy actions (see its manifest's
    // `pushActions`) distinguished by threadId, not by `mention`:
    //   - `activity` - candidates are every OTHER current member of the
    //     calendar (a growing reader list, see ThreadService.addReader()).
    //   - `invite-<actorPub>` - only ever has that one invitee as a
    //     candidate (see ThreadService's `mail` preset): a calendar-level share.
    //   - `guest~<eventId>~<actorPub>` - same single-candidate shape, but
    //     for inviting one person to one specific EVENT rather than the
    //     whole calendar (see apps/calendar/client.js's `inviteGuest()`).
    //     `~` is used as the separator (not `-`) because both a UUID event
    //     id and a base64url actor pubkey can themselves contain `-`,
    //     which would make splitting the threadId back apart ambiguous.
    const calendarFunctionName = appId !== 'calendar' ? null
      : threadId === 'activity' ? 'eventChange'
      : threadId.startsWith('guest~') ? 'guestInvite'
      : 'invite';
    // Geo Chase only ever posts one kind of notice (an `invite-<pub>`
    // thread on game creation - see apps/geochase/client.js's
    // `notifyInvitees()`), so unlike Calendar there's no second threadId to
    // branch on.
    const geochaseFunctionName = appId === 'geochase' ? 'invite' : null;

    for (const { actorPub, mention } of candidates) {
      const prefs = await this.services.notificationPrefs.getPrefsFor(actorPub);
      const functionName = calendarFunctionName ?? geochaseFunctionName ?? (mention ? 'mention' : 'newMessage');
      if (!NotificationPrefsService.shouldNotify(prefs, { appId, mention, functionName })) continue;

      // Content-blind by design (see this method's own doc comment) - even
      // for Calendar/Geo Chase, the relay never decrypts the activity/
      // invite body, so wording stays generic. The one thing it CAN safely
      // add is the calendar/game id itself: that's the storage path
      // (`spaceId`), not encrypted content, so the notification can
      // deep-link straight to the specific calendar/game instead of just
      // the app root.
      // Chat deep-links to the SPECIFIC room, not just `#/chat` (the room
      // list) - see apps/chat/client.js's own doc comment for its route
      // scheme (`#/chat/<peerActorPub>` for 1:1, `#/chat/g/<groupId>` for a
      // group). A group room's `threadId` IS its groupId (see
      // THREAD_PRESETS.group), so that's directly usable; a 1:1 room's
      // `threadId` is a one-way hash of both members' pubkeys (see
      // apps/chat/client.js's `roomId()`) and can't be reversed back into a
      // pubkey - but it doesn't need to be: a 1:1 room has EXACTLY two
      // readers, so from THIS candidate's point of view the "other side" of
      // the conversation is simply whoever authored this message (`authorPub`
      // is already excluded from `candidates` above, so it's never the
      // recipient themselves).
      const chatUrl = appId === 'chat'
        ? (config.kind === 'group' ? `#/chat/g/${threadId}` : `#/chat/${authorPub}`)
        : null;

      const payload = calendarFunctionName === 'invite'
        ? { title: 'Calendar invitation', body: 'You were invited to a shared calendar.', appId, url: `#/calendar/${calendarMatch[1]}` }
        : calendarFunctionName === 'eventChange'
        ? { title: 'Calendar updated', body: 'A shared calendar you belong to has new activity.', appId, url: `#/calendar/${calendarMatch[1]}` }
        : calendarFunctionName === 'guestInvite'
        // threadId is `guest~<eventId>~<actorPub>` - the middle segment is
        // the event id, safe to surface (routing metadata, not decrypted
        // content) so the notification deep-links straight to the event.
        ? { title: 'Event invitation', body: 'You were invited to an event.', appId, url: `#/calendar/${calendarMatch[1]}/${threadId.split('~')[1]}` }
        : geochaseFunctionName === 'invite'
        ? { title: 'Geo Chase invitation', body: 'You were invited to a Geo Chase game.', appId, url: `#/geochase/${geochaseMatch[1]}` }
        : chatUrl
        ? { title: mention ? 'Mentioned in Chat' : 'New message in Chat', body: `~${(authorPub ?? 'someone').slice(0, 10)}… sent a message`, appId, url: chatUrl }
        : {
            title: mention ? `Mentioned in ${appId}` : `New message in ${appId}`,
            body: `~${(authorPub ?? 'someone').slice(0, 10)}… sent a message`,
            appId,
            url: `#/${appId}`,
          };

      try {
        await this.#writeInAppNotification(actorPub, payload);
      } catch (err) {
        console.error(`[QuRelay] in-app notification write failed for ~${actorPub.slice(0, 10)}…:`, err.message);
      }

      if (!this.vapidKeys) continue;
      // Still visibly connected (see #recordPresence()/PRESENCE_FRESH_MS
      // above) - the in-app notification just written above already covers
      // them (their own client sees it live via subscribe(), same as the
      // header badge), a redundant push would just be noise.
      if (this.#isRecentlyOnline(actorPub)) continue;
      const subscriptions = await this.services.pushSubscriptions.listSubscriptionsFor(actorPub);
      for (const subscription of subscriptions) {
        try {
          const result = await sendWebPush(subscription, payload, this.vapidKeys);
          if (result.expired) {
            // Cannot clean this up ourselves - unsubscribing is a signed write only the
            // subscription's OWNER can make (see PushSubscriptionService). Logged so an
            // operator watching relay logs can see stale subscriptions accumulating; the
            // owner's own client naturally re-subscribes/cleans up next time it runs.
            console.warn(`[QuRelay] push subscription for ~${actorPub.slice(0, 10)}… has expired`);
          }
        } catch (err) {
          console.error(`[QuRelay] push send failed for ~${actorPub.slice(0, 10)}…:`, err.message);
        }
      }
    }
  }

  /**
   * Writes one notification into `actorPub`'s own notifications Thread
   * (space `notifications-<actorPub>`, same convention
   * apps/notifications/client.js reads from) - `createThread()` is
   * idempotent (see ThreadService), so this is safe to call before that
   * identity has ever opened the Notifications app. Posted under the
   * RELAY's own identity: THREAD_PRESETS.notifications() sets `writers:
   * '*'`, so no special authorization is needed for a system notice, same
   * as any other writer.
   * @param {string} actorPub - The notification's owner/recipient.
   * @param {{title: string, body: string, appId: string, url: string}} payload
   */
  async #writeInAppNotification(actorPub, payload) {
    const spaceId = `notifications-${actorPub}`;
    await this.services.threads.createThread(spaceId, 'notifications', THREAD_PRESETS.notifications(actorPub));
    await this.services.threads.postMessage(spaceId, 'notifications', {
      body: payload.body,
      extra: { title: payload.title, url: payload.url, appId: payload.appId },
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {number} [maxBytes=64KiB] - A settings payload is tiny; a Data
   *   Explorer import (see `#handleAdminDataImport()`) is a bulk restore of
   *   potentially many QuBits, so callers with genuinely larger bodies pass
   *   a bigger cap explicitly rather than this default growing for everyone.
   * @returns {Promise<object>} Parsed JSON body.
   * @throws {Error} On a body over `maxBytes` or malformed JSON.
   */
  async #readJsonBody(req, maxBytes = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('request body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * Shared gate for every admin-only HTTP action (`POST /admin/...`):
   * `actorPub` must be in `adminPubs` AND `signature` must actually verify
   * over `JSON.stringify(signedPayload)` - a request merely CLAIMING to be
   * from an admin pubkey proves nothing on its own. Writes a 403 response
   * and returns `false` itself on any failure, so a call site only needs
   * to check the return value.
   * @param {import('node:http').ServerResponse} res
   * @param {string} actorPub
   * @param {string} signature
   * @param {*} signedPayload - Must match exactly what the client signed.
   * @returns {Promise<boolean>}
   */
  async #verifyAdmin(res, actorPub, signature, signedPayload) {
    if (!this.options.adminPubs.includes(actorPub)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not a configured relay admin' }));
      return false;
    }
    let verified = false;
    try {
      verified = await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify(signedPayload)),
        QuCrypto.fromBase64Url(signature),
        QuCrypto.fromBase64Url(actorPub)
      );
    } catch {
      verified = false; // malformed base64/signature - treat exactly like "did not verify"
    }
    if (!verified) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'signature does not verify' }));
      return false;
    }
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async #handleAdminSettings(req, res) {
    let body;
    try {
      body = await this.#readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }

    const { actorPub, settings, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || typeof settings !== 'object' || settings === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, settings, signature }' }));
      return;
    }
    if (!(await this.#verifyAdmin(res, actorPub, signature, settings))) return;

    const merged = await this.#saveSettings(settings);
    // Applied live - an admin changing the rate limit shouldn't require
    // restarting the relay (which would drop every connected client) to
    // take effect.
    if (settings.rateLimits) this.transport.setRateLimit(merged.rateLimits.maxMessagesPerMinute);

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(merged));
  }

  /**
   * Relay Admin's Data Explorer (see apps/relay-admin/client.js): lists
   * every stored QuBit whose logical path starts with `query.prefix`
   * (default `/store`, the same mount `paths.js`'s helpers all write
   * under - `/blob` is included too if explicitly asked for, since asset
   * chunks live there under the exact same FsAdapter/JSON-file shape).
   * Debugging tool, not a Service - there is no in-store wildcard query
   * anywhere else in this codebase (see `walkJsonFiles()`'s own doc
   * comment), so this walks the adapters' files directly.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async #handleAdminDataList(req, res) {
    let body;
    try {
      body = await this.#readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }

    const { actorPub, query, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || typeof query !== 'object' || query === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, query, signature }' }));
      return;
    }
    if (!(await this.#verifyAdmin(res, actorPub, signature, query))) return;

    const prefix = typeof query.prefix === 'string' && query.prefix ? query.prefix : '/store';
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);

    const candidates = [
      ...(await walkJsonFiles(this.options.storeDir)).map((file) => fileToLogicalPath(file, this.options.storeDir, '/store')),
      ...(await walkJsonFiles(this.options.blobDir)).map((file) => fileToLogicalPath(file, this.options.blobDir, '/blob')),
    ]
      .filter((path) => path.startsWith(prefix))
      .sort();

    const MAX_VALUE_BYTES = 200 * 1024; // a debug preview, not a bulk export - see #handleAdminDataImport for the real bulk path
    const entries = [];
    for (const path of candidates.slice(0, limit)) {
      const { adapter, rel } = this.core.resolveMount(path);
      let raw;
      try {
        raw = await adapter.get(rel);
      } catch {
        entries.push({ path, error: 'unreadable on disk' });
        continue;
      }
      const size = raw ? JSON.stringify(raw).length : 0;
      if (size > MAX_VALUE_BYTES) entries.push({ path, truncated: true, byteLength: size });
      else entries.push({ path, value: raw });
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entries, total: candidates.length, hasMore: candidates.length > limit }));
  }

  /**
   * The write half of the Data Explorer: restores previously-exported
   * QuBits EXACTLY as they were (original signature/encryption/timestamp
   * intact) via `QuStore.putSealed()` - never through the normal
   * Engine-mediated `qu.put()` pipeline, which would re-stamp/re-sign
   * everything under THIS admin's own identity instead of preserving
   * original authorship (see `putSealed()`'s own doc comment on @qu/core's
   * QuStore). Deliberately not restricted to any path prefix: an admin
   * restoring their own relay's data is already trusted with its entire
   * disk.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async #handleAdminDataImport(req, res) {
    let body;
    try {
      body = await this.#readJsonBody(req, 20 * 1024 * 1024); // a bulk restore, not a settings tweak - see #readJsonBody's own doc comment
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }

    const { actorPub, entries, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || !Array.isArray(entries)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, entries, signature }' }));
      return;
    }
    if (!(await this.#verifyAdmin(res, actorPub, signature, entries))) return;

    let imported = 0;
    let skipped = 0;
    for (const entry of entries) {
      const path = entry?.path;
      const value = entry?.value;
      if (typeof path !== 'string' || !path.startsWith('/') || value === null || typeof value !== 'object') {
        skipped++;
        continue;
      }
      try {
        await this.core.putSealed(path, value);
        imported++;
      } catch {
        skipped++;
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ imported, skipped, total: entries.length }));
  }

  async #handleHttp(req, res) {
    try {
      // Cheap, dependency-free liveness probe - deliberately checked before
      // anything else touches disk or the loader. Meant for container
      // orchestrators/reverse proxies (Docker HEALTHCHECK, Traefik, k8s
      // probes, ...) to tell "container up, relay answering" apart from
      // "upstream unreachable", which is what those layers usually report
      // to clients as a 502/503 - if this route itself times out or refuses
      // to connect, the problem is in front of the relay, not in it.
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', peerId: this.transport?.getPeerId() ?? null }));
        return;
      }

      if (req.url === '/apps.json') {
        const settings = await this.#getSettings();
        const body = JSON.stringify(buildAppsCatalog(this.loader, settings.disabledApps));
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(body);
        return;
      }

      // Public, non-secret config the shell UI needs before it knows
      // anything else: which actor pubkeys are relay admins, so it can show
      // (or hide) the "Relay Admin" nav entry for the connected identity,
      // plus this relay's current admin-configurable settings (default
      // locale, rate limits, disabled apps - see #getSettings()). This is a
      // UX convenience ONLY, never an authorization boundary - all of this
      // is public information anyone could read here regardless; the
      // actual privileged admin ACTION (see `POST /admin/settings` below)
      // independently verifies a signed request against `adminPubs`
      // server-side, exactly like every other writer/reader ACL in this
      // codebase (see ThreadEngine), never trusting that only an admin's
      // client would ever render the button.
      if (req.url === '/config.json') {
        const settings = await this.#getSettings();
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ adminPubs: this.options.adminPubs, settings }));
        return;
      }

      // The one privileged admin ACTION this relay exposes: change its own
      // operational settings. `{ actorPub, settings, signature }` - signed
      // over `JSON.stringify(settings)` with `actorPub`'s Ed25519 key
      // (same sign/verify shape @qu/services/notification-prefs-service.js
      // already uses for its own signed-but-public documents), verified
      // HERE against `adminPubs` before anything is persisted - a request
      // merely CLAIMING to be from an admin pubkey proves nothing on its
      // own.
      if (req.url === '/admin/settings' && req.method === 'POST') {
        await this.#handleAdminSettings(req, res);
        return;
      }

      // Relay Admin's Data Explorer (see apps/relay-admin/client.js) -
      // list/restore raw QuBits straight off disk, for debugging. Both
      // POST-only and admin-signature-gated exactly like `/admin/settings`
      // above (see `#verifyAdmin()`), since this is by far the most
      // sensitive admin action this relay exposes: bulk read/write of
      // everything it stores, encrypted content included (still ciphertext
      // to anyone who isn't a listed reader - see `#handleAdminDataList()`'s
      // own doc comment - but that's a property of the DATA, not of who may
      // ask for it).
      if (req.url === '/admin/data/list' && req.method === 'POST') {
        await this.#handleAdminDataList(req, res);
        return;
      }
      if (req.url === '/admin/data/import' && req.method === 'POST') {
        await this.#handleAdminDataImport(req, res);
        return;
      }

      // The public half of this relay's VAPID keypair - what a browser's
      // `PushManager.subscribe({applicationServerKey: ...})` needs (see
      // apps/notifications). Public by definition (VAPID's whole point is
      // identifying the sender, same as a TLS cert - never a secret).
      if (req.url === '/push/vapid-public-key') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ publicKey: this.vapidKeys?.publicKey ?? null }));
        return;
      }

      if (await serveApps(req, res, this.options.appsDir)) return;

      if (this.options.serveShell) {
        // `cache-control: no-cache` (NOT `no-store`) on every file below
        // that a PWA UPDATE actually depends on - a browser may still keep
        // a cached copy, but must revalidate with the server before ever
        // reusing it, instead of silently serving a stale `index.html`/
        // bundle/`sw.js` byte-for-byte from HTTP cache (with no ETag/
        // Last-Modified set here, "revalidate" in practice just means "ask
        // again"). Without this, apps/shell/src/pwa.js's whole
        // update-detection flow could ask a browser to reload onto "the
        // latest version" and have the browser hand it right back the
        // stale one it already had cached - defeating the point of a
        // controlled update prompt.
        if (req.url === '/' || req.url === '/index.html') {
          const body = await readFile(SHELL_PUBLIC_DIR + 'index.html');
          res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' }).end(body);
          return;
        }
        if (req.url === '/shell-bundle.js' || req.url === '/shell-bundle.js.map') {
          const body = await readFile(SHELL_DIST_DIR + req.url.replace('/shell-bundle', 'bundle'));
          res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }).end(body);
          return;
        }
        // Same-origin-root PWA files (see apps/shell/src/pwa.js) - a service
        // worker's default scope is the directory it's served FROM, so
        // sw.js specifically must be served at "/", not under some subpath.
        if (req.url === '/manifest.webmanifest') {
          const body = await readFile(SHELL_PUBLIC_DIR + 'manifest.webmanifest');
          res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' }).end(body);
          return;
        }
        if (req.url === '/sw.js') {
          const body = await readFile(SHELL_PUBLIC_DIR + 'sw.js');
          // Doubly important here specifically: browsers already treat a
          // cached `sw.js` response as at-least-as-stale-as-24h regardless
          // of headers (a spec-mandated cap meant to stop indefinitely
          // stale workers), but `no-cache` still closes the gap for
          // anything shorter than that - an explicit `applyUpdate()` click
          // shouldn't ever be defeated by an HTTP cache in between.
          res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/', 'cache-control': 'no-cache' }).end(body);
          return;
        }
        if (req.url === '/favicon.ico') {
          const body = await readFile(SHELL_PUBLIC_DIR + 'favicon.ico');
          res.writeHead(200, { 'content-type': 'image/x-icon' }).end(body);
          return;
        }
        if (req.url === '/logo.svg') {
          const body = await readFile(SHELL_PUBLIC_DIR + 'logo.svg');
          res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(body);
          return;
        }
      }

      res.writeHead(404).end('Not Found');
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404).end('Not Found');
      } else {
        console.error('[QuRelay] HTTP handler error:', err);
        res.writeHead(500).end('Internal Server Error');
      }
    }
  }

  /** Shuts down the HTTP/WebSocket server. */
  async close() {
    this.sync?.close();
    // Must terminate live connections before closing the servers - both
    // WebSocketServer.close() and http.Server.close() wait indefinitely for
    // existing connections to end on their own otherwise, so a single
    // still-connected peer would hang shutdown forever.
    this.transport?.closeAllPeers();
    await new Promise((resolve) => this._wss?.close(resolve));
    await new Promise((resolve) => this._httpServer?.close(resolve));
  }
}
