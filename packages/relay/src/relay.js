/**
 * QU RELAY — a Node.js peer that persists to disk, syncs with other peers,
 * and boots/serves Engines, Services and Apps.
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
import { WebSocketServer } from 'ws';

import { QuRuntime } from '@qu/runtime';
import { Registry } from '@qu/foundation';
import { QuLoader, discoverLocalPackages } from '@qu/loader';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { DocumentEngine, CollectionEngine, AssetEngine } from '@qu/engines';
import { createServices } from '@qu/services';

import { FsAdapter } from './adapters/fs-adapter.js';
import { WebSocketServerTransport } from './transports/websocket-server-transport.js';
import { serveApps } from './static-apps.js';

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
 */

export class QuRelay {
  /** @param {QuRelayOptions} [options] */
  constructor(options = {}) {
    this.options = {
      storeDir: './relay-data/store',
      blobDir: './relay-data/blob',
      appsDir: './apps',
      port: 8080,
      remoteApps: [],
      ...options,
    };

    this.registry = new Registry();
    this.runtime = new QuRuntime({ storeAdapter: new FsAdapter(this.options.storeDir) });
    this.core = this.runtime.core;
    this.core.mount('blob', new FsAdapter(this.options.blobDir));

    this.documentEngine = new DocumentEngine(this.core);
    this.collectionEngine = new CollectionEngine(this.core);
    this.assetEngine = new AssetEngine(this.core);
    this.registry.registerEngine('document-engine', this.documentEngine);
    this.registry.registerEngine('collection-engine', this.collectionEngine);
    this.registry.registerEngine('asset-engine', this.assetEngine);

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

    this.loader = new QuLoader(this.core, this.registry);

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

    this._httpServer = createServer((req, res) => {
      serveApps(req, res, this.options.appsDir).then((served) => {
        if (!served) res.writeHead(404).end('Not Found');
      });
    });
    this._wss = new WebSocketServer({ server: this._httpServer });
    await new Promise((resolve) => this._httpServer.listen(this.options.port, resolve));

    this.transport = new WebSocketServerTransport(this._wss);
    this.sync = new SyncEngine(this.core, this.transport);

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
