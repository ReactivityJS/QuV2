#!/usr/bin/env node
/**
 * SMOKE TEST — exercises the whole stack together, end to end, and fails
 * loudly (non-zero exit) if any of it breaks. Run via `npm run test:smoke`.
 *
 * This is not a unit test suite - it is deliberately a single realistic
 * scenario per concern, proving the packages actually work TOGETHER as
 * shipped (workspace resolution, cross-package wiring, real network
 * sockets), which is exactly the kind of thing unit tests miss.
 *
 * Covers:
 *   1. A relay booting and auto-loading a local app (apps/notes) via the
 *      manifest/DependencyResolver machinery.
 *   2. Two independent relay processes syncing a write over a real
 *      WebSocket connection.
 *   3. Identity: two separate local identities, an attestation privately
 *      linking a pseudonymous "space" identity to a main identity, and
 *      proof that an untrusted third party cannot resolve it.
 *   4. Assets: chunked upload + reassembled download round-trip.
 *   5. Remote loading: integrity pinning and Ed25519 signature
 *      verification, including that tampering and untrusted signers are
 *      correctly rejected.
 *   6. The QUniverse Services layer: Threads (a public forum and a private
 *      mail inbox from the SAME ThreadService, differing only by config -
 *      see THREAD_PRESETS), Favorites/Contacts (both built on
 *      StarredService), Directory visibility, and CMS pages.
 *   7. Push: VAPID JWT signing/verification and RFC 8291 payload encryption.
 *   8. The generic notification pipeline (ThreadService.notify() ->
 *      @qu/relay's #deliverThreadPush() -> the recipient's own notifications
 *      Thread) using the exact space convention apps/geochase/client.js's
 *      invite flow uses, proving a non-Thread-native app gets a properly
 *      labeled, deep-linked notification "for free" the same way Calendar's
 *      invite flow already did.
 *   9. Mounts and actions: actionsForMount()/resolveActionHref() (the
 *      Contact List / Chat "contact-row" pattern).
 *  10. Sync freshness/reconnect catch-up: a message posted while a peer
 *      genuinely wasn't connected (transport closed, then reconnected) is
 *      NOT delivered by subscribe() alone, but IS picked up by @qu/services'
 *      background-refresh-on-reconnect mechanism (see
 *      @qu/services/sync-freshness.js and @qu/sync's SyncEngine.getGeneration())
 *      - this is the fix for "messages/events from while I was offline never
 *      show up even after reconnecting", covering every Service built on
 *      DocumentService/CollectionService/ThreadService (Chat, Calendar, Geo
 *      Chase, Forum, Todo, ...), not just one app.
 *  11. Sync outbox: a write made while genuinely offline (not just a
 *      mid-session drop - a full "reload", i.e. the old SyncEngine/transport
 *      pair and its in-memory send queue are discarded) is still delivered
 *      to the relay once a new connection is established, and the outbox
 *      entry is cleared once the relay acknowledges it (see @qu/sync's
 *      outbox.js and SyncEngine's `sync-ack` handling).
 *  12. Reciprocal prefix catch-up AT THE SyncEngine LEVEL (not via any
 *      Service-level freshness tracker, unlike #10): SyncEngine's own
 *      reconnect hook asks the relay for everything under each subscribed
 *      prefix and merges it, so a plain `qu.get()` (no Service, no
 *      backgroundRefresh call) already sees a write missed while offline.
 *  13. Assets: per-chunk content-hash verification rejects a
 *      corrupted/tampered chunk instead of silently reassembling it, and
 *      re-uploading an unchanged file resumes by skipping chunks already
 *      present with matching content (see AssetEngine's chunkHashes).
 *  14. Identity backup/transfer: QuIdentityEngine.exportSeedCode() ->
 *      importSeedCode() reconstructs the SAME identity (same derived main
 *      keypair) in a fresh store, the cross-device mechanism
 *      apps/profile/client.js's backup section and apps/shell's onboarding
 *      screen both build their UI around - plus the overwrite guard
 *      (rejects a conflicting import without { overwrite: true }) and
 *      malformed-code rejection.
 *  15. @qu/qr: encodeToImageData() -> decodeFromImageData() round-trips a
 *      real payload-shaped string (the exact shape exportSeedCode()
 *      produces) through actual QR encoding/decoding - no browser/DOM
 *      needed, see that package's own doc comment for why.
 *  16. Cross-device data recovery: a SECOND client that imports device A's
 *      backup code (see #11) must not just derive the same keypair - its
 *      OWN alias/avatar/epub (ProfileService.getOwnProfile()) and starred
 *      items (StarredService, e.g. Favorites) must actually show up too,
 *      by backfilling from the relay rather than starting blank. Both had
 *      NO backfill at all before this section existed (found from a real
 *      user report after #11 shipped: "epub and alias/favorites don't
 *      transfer") - this is the regression test for that fix.
 *
 * NOT covered here (verified manually with Playwright during development,
 * not wired into this script to avoid adding a browser-automation
 * dependency to routine test runs): apps/shell actually rendering in a
 * browser - self-generating nav from /apps.json, mounting apps/notes'
 * clientMain, <qu-view>/<qu-bind>/<qu-list> reactivity, favoriting,
 * identity/data persistence across a reload via IndexedDB, the onboarding
 * screen (apps/shell/src/onboarding.js), the profile app's backup UI
 * (camera-based QR scanning in particular - `getUserMedia`/`<video>` have
 * no meaningful Node equivalent), and IndexedDBAdapter.destroy() (there is
 * no `indexedDB` global in Node) - the identity/QR *logic* those UIs are
 * built on is what sections 11-12 above actually verify.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import ws from 'ws';

import { QuRelay } from '@qu/relay';
import { QuRuntime } from '@qu/runtime';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { QuCrypto } from '@qu/core';
import { Registry } from '@qu/foundation';
import { QuLoader } from '@qu/loader';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
let step = 0;
function section(name) {
  console.log(`\n[${++step}] ${name}`);
}

const tmp = await mkdtemp(join(tmpdir(), 'qu-smoke-'));
const relays = [];
async function bootRelay(opts) {
  const relay = await new QuRelay(opts).boot();
  relays.push(relay);
  return relay;
}

try {
  // ---------------------------------------------------------------------
  section('Relay boots and auto-loads apps/notes');
  // ---------------------------------------------------------------------
  const relayA = await bootRelay({
    storeDir: join(tmp, 'relayA/store'),
    blobDir: join(tmp, 'relayA/blob'),
    appsDir: join(REPO_ROOT, 'apps'),
    port: 0, // let the OS pick a free port
  });
  assert.ok(relayA.loader.isLoaded('notes'), 'apps/notes should have been auto-loaded at boot');
  const note = await globalThis.NotesApp.addNote('smoke', 'from the smoke test');
  assert.equal(note.text, 'from the smoke test');
  const notes = await globalThis.NotesApp.listNotes('smoke');
  assert.ok(notes.some((n) => n._id === note._id), 'note should be listed back');
  console.log('    OK - notes app loaded and functional via the relay');

  // ---------------------------------------------------------------------
  section('Two relays sync a write over a real WebSocket connection');
  // ---------------------------------------------------------------------
  const relayPortA = relayA.port;
  const relayB = await bootRelay({
    storeDir: join(tmp, 'relayB/store'),
    blobDir: join(tmp, 'relayB/blob'),
    appsDir: join(tmp, 'empty-apps-dir'), // no local apps for this one
    port: 0,
  });

  const clientTransport = new WebSocketClientTransport(`ws://127.0.0.1:${relayPortA}`, { WebSocketImpl: ws });
  await clientTransport.connect();
  const clientSync = new SyncEngine(relayB.core, clientTransport);
  clientSync.subscribe('/store/wiki');
  await new Promise((r) => setTimeout(r, 50));

  await relayA.services.documents.create('wiki', 'welcome', { title: 'Welcome' });
  await new Promise((r) => setTimeout(r, 100));
  const synced = await relayB.services.documents.get('wiki', 'welcome');
  assert.equal(synced?.title, 'Welcome', 'relay B should have received the synced document from relay A');
  clientSync.close();
  clientTransport.close();
  console.log('    OK - write on relay A appeared on relay B via SyncEngine');

  // ---------------------------------------------------------------------
  section('Identity: attestation privately links a space identity to a main identity');
  // ---------------------------------------------------------------------
  // Each identity keeps its OWN local secrets (the master seed), but
  // profiles/attestations are PUBLIC data - simulate a shared relay for
  // those by routing '/store/actors/...' writes/reads through one shared
  // Map instead of each identity's own private store.
  const publicStore = new Map();
  function withPublicMount(memoryStore, publicMap) {
    return {
      async put(rel, v) {
        return rel.startsWith('/actors/') ? (publicMap.set(rel, v), v) : memoryStore.put(rel, v);
      },
      async get(rel) {
        return rel.startsWith('/actors/') ? (publicMap.get(rel) ?? null) : memoryStore.get(rel);
      },
    };
  }
  const { MemoryAdapter } = await import('@qu/runtime');
  const alice = new QuRuntime({ storeAdapter: withPublicMount(new MemoryAdapter(), publicStore) });
  const bob = new QuRuntime({ storeAdapter: withPublicMount(new MemoryAdapter(), publicStore) });
  const eve = new QuRuntime({ storeAdapter: withPublicMount(new MemoryAdapter(), publicStore) });

  const aliceIdentity = new QuIdentityEngine(alice.core);
  const bobIdentity = new QuIdentityEngine(bob.core);
  const eveIdentity = new QuIdentityEngine(eve.core);
  await aliceIdentity.importMnemonic(aliceIdentity.generateMnemonic());
  await bobIdentity.importMnemonic(bobIdentity.generateMnemonic());
  await eveIdentity.importMnemonic(eveIdentity.generateMnemonic());

  const aliceMain = await aliceIdentity.getMainKey();
  const bobPub = await bobIdentity.publishMainProfile({ name: 'Bob' });
  const spacePub = await aliceIdentity.publishProfile('chat-room', { name: 'Anon123' });
  await aliceIdentity.createAttestation('chat-room', [bobPub]);

  const bobResolved = await bobIdentity.resolveMainUser(spacePub);
  const eveResolved = await eveIdentity.resolveMainUser(spacePub);
  assert.equal(bobResolved, QuCrypto.toBase64Url(aliceMain.publicKey), 'Bob (trusted) should resolve the attestation');
  assert.equal(eveResolved, null, 'Eve (untrusted) must NOT resolve the attestation');
  console.log('    OK - trusted contact resolves the link, untrusted third party cannot');

  // ---------------------------------------------------------------------
  section('Assets: chunked upload + reassembled download round-trip');
  // ---------------------------------------------------------------------
  const payload = new TextEncoder().encode('Qu asset round-trip test. '.repeat(50));
  await relayA.services.assets.upload('files', 'demo.txt', { name: 'demo.txt', mime: 'text/plain', data: payload });
  const downloaded = await relayA.services.assets.download('files', 'demo.txt');
  assert.ok(downloaded, 'asset should be downloadable');
  assert.equal(Buffer.from(downloaded.data).toString(), Buffer.from(payload).toString(), 'reassembled bytes must match the original');
  console.log(`    OK - ${downloaded.meta.chunkCount} chunk(s) reassembled correctly (${downloaded.data.length} bytes)`);

  // ---------------------------------------------------------------------
  section('Remote loading: integrity + signature verification');
  // ---------------------------------------------------------------------
  const fixtureDir = join(tmp, 'remote-fixture');
  await import('node:fs/promises').then((fs) => fs.mkdir(fixtureDir, { recursive: true }));
  const source = Buffer.from("export async function register(){ globalThis.__smokeRemoteLoaded = true; }\n");
  await writeFile(join(fixtureDir, 'index.js'), source);

  const publisher = await QuCrypto.generateKeypair();
  const goodDigest = QuCrypto.toBase64(await QuCrypto.sha256(source));
  const goodSignature = QuCrypto.toBase64Url(await QuCrypto.sign(source, publisher.privateKey));
  await writeFile(
    join(fixtureDir, 'manifest.quapp'),
    JSON.stringify({
      name: 'remote-smoke-widget',
      version: '1.0.0',
      main: './index.js',
      integrity: `sha256-${goodDigest}`,
      signature: goodSignature,
    })
  );

  const httpServer = createServer((req, res) => {
    const map = { '/manifest.quapp': ['application/json', 'manifest.quapp'], '/index.js': ['text/javascript', 'index.js'] };
    const entry = map[req.url];
    if (!entry) return void res.writeHead(404).end();
    import('node:fs/promises').then((fs) =>
      fs.readFile(join(fixtureDir, entry[1])).then((buf) => res.writeHead(200, { 'content-type': entry[0] }).end(buf))
    );
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const fixturePort = httpServer.address().port;
  const manifestUrl = `http://127.0.0.1:${fixturePort}/manifest.quapp`;

  const loaderRuntime = new QuRuntime();
  const loader = new QuLoader(loaderRuntime.core, new Registry());

  await loader.loadRemote(manifestUrl, { trustedPublisherPubs: [QuCrypto.toBase64Url(publisher.publicKey)] });
  assert.equal(globalThis.__smokeRemoteLoaded, true, 'correctly-signed, correctly-pinned remote package should load');

  const wrongKey = await QuCrypto.generateKeypair();
  await assert.rejects(
    () => loader.loadRemote(manifestUrl, { trustedPublisherPubs: [QuCrypto.toBase64Url(wrongKey.publicKey)], forceReload: true }),
    /does not match any trusted publisher/,
    'wrong trusted key should be rejected'
  );

  await writeFile(join(fixtureDir, 'index.js'), Buffer.concat([source, Buffer.from('// tampered')]));
  await assert.rejects(
    () => loader.loadRemote(manifestUrl, { forceReload: true }),
    /integrity check failed/,
    'tampered content should be rejected'
  );
  httpServer.close();
  console.log('    OK - signed+pinned package loads; wrong signer and tampered content are both rejected');

  // ---------------------------------------------------------------------
  section('QUniverse services: Threads, Favorites/Contacts, Directory, CMS');
  // ---------------------------------------------------------------------
  {
    const quniverseRt = new QuRuntime();
    const { MemoryAdapter } = await import('@qu/runtime');
    const { DocumentEngine, CollectionEngine, ThreadEngine } = await import('@qu/engines');
    const { createServices, THREAD_PRESETS } = await import('@qu/services');

    // Shared "world" store for public/thread data; each identity keeps its own local seed - see identity.js's importMnemonic() doc.
    const sharedStore = new Map();
    function withSharedWorld() {
      const local = new MemoryAdapter();
      return {
        put: (rel, v) => (rel.startsWith('/secure/') ? local.put(rel, v) : sharedStore.set(rel, v) && v),
        get: (rel) => (rel.startsWith('/secure/') ? local.get(rel) : Promise.resolve(sharedStore.get(rel) ?? null)),
      };
    }
    function makeIdentityAndServices() {
      const rt = new QuRuntime({ storeAdapter: withSharedWorld() });
      new DocumentEngine(rt.core);
      new CollectionEngine(rt.core);
      new ThreadEngine(rt.core);
      const identity = new QuIdentityEngine(rt.core);
      return { rt, identity, Qu: null };
    }

    const aliceCtx = makeIdentityAndServices();
    const bobCtx = makeIdentityAndServices();
    await aliceCtx.identity.importMnemonic(aliceCtx.identity.generateMnemonic());
    await bobCtx.identity.importMnemonic(bobCtx.identity.generateMnemonic());
    aliceCtx.Qu = createServices(aliceCtx.rt.core, { assetEngine: null, identityEngine: aliceCtx.identity });
    bobCtx.Qu = createServices(bobCtx.rt.core, { assetEngine: null, identityEngine: bobCtx.identity });

    await aliceCtx.Qu.actors.publishMainProfile({ name: 'Alice' }); // needed so Bob can encrypt mail FOR her (see ThreadService)
    const alicePub = await aliceCtx.Qu.actors.whoAmI();
    await bobCtx.Qu.actors.publishMainProfile({ name: 'Bob' });
    const bobPub = await bobCtx.Qu.actors.whoAmI();

    // Threads: public forum + private mail, same Service, different config.
    await aliceCtx.Qu.threads.createThread('board', 'general', THREAD_PRESETS.forum());
    await aliceCtx.Qu.threads.postMessage('board', 'general', { body: 'hi **all**' });
    const forumSeenByBob = await bobCtx.Qu.threads.listMessages('board', 'general');
    assert.equal(forumSeenByBob.length, 1, 'forum message should be publicly readable');
    assert.equal(forumSeenByBob[0].formattedHtml, 'hi <strong>all</strong>', 'forum preset includes markdown formatting');

    await aliceCtx.Qu.threads.createThread('mailboxes', 'alice-inbox', THREAD_PRESETS.mail(alicePub));
    await bobCtx.Qu.threads.postMessage('mailboxes', 'alice-inbox', { body: 'private note' });
    assert.equal((await aliceCtx.Qu.threads.listMessages('mailboxes', 'alice-inbox')).length, 1, 'owner should read their inbox');

    // Favorites + Contacts, both built on StarredService.
    await aliceCtx.Qu.favorites.add('notes');
    assert.deepEqual(await aliceCtx.Qu.favorites.list(), ['notes']);
    await aliceCtx.Qu.contacts.addContact(bobPub, { nickname: 'Bobby' });
    const contacts = await aliceCtx.Qu.contacts.listContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].profile.name, 'Bob', 'contact should resolve to the live published profile');

    // Directory: opt-in visibility.
    await aliceCtx.Qu.directory.setVisible(true, { name: 'Alice' });
    assert.equal(await aliceCtx.Qu.directory.isVisible(alicePub), true);
    await aliceCtx.Qu.directory.setVisible(false);
    assert.equal(await aliceCtx.Qu.directory.isVisible(alicePub), false);

    // CMS: pages built on Document+Collection, no dedicated Engine needed.
    await aliceCtx.Qu.cms.savePage('site', 'home', { title: 'Home' });
    await aliceCtx.Qu.cms.savePage('site', 'home', { title: 'Home v2' });
    const pages = await aliceCtx.Qu.cms.listPages('site');
    assert.equal(pages.length, 1, 'saving the same slug twice must not duplicate the page listing');
    assert.equal(pages[0].title, 'Home v2');

    console.log('    OK - threads (forum+mail+ACL), favorites, contacts, directory, and CMS all work as designed');
  }

  // ---------------------------------------------------------------------
  section('Push: VAPID JWT signature verifies; payload encryption round-trips');
  // ---------------------------------------------------------------------
  {
    const { generateVapidKeys, signVapidJwt, encryptPayload, decryptPayload, fromBase64Url } = await import('@qu/push');
    const { createECDH, createPublicKey, verify: cryptoVerify, randomBytes } = await import('node:crypto');

    // --- VAPID: the JWT's signature must actually verify against the public key ---
    const vapid = generateVapidKeys();
    const jwt = signVapidJwt({ audience: 'https://example-push-service.test', subject: 'mailto:ops@example.test' }, vapid.privateKey);
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const rawPublic = fromBase64Url(vapid.publicKey); // 0x04 || x || y
    const jwk = { kty: 'EC', crv: 'P-256', x: rawPublic.subarray(1, 33).toString('base64url'), y: rawPublic.subarray(33, 65).toString('base64url') };
    const publicKeyObject = createPublicKey({ key: jwk, format: 'jwk' });
    const verified = cryptoVerify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKeyObject, dsaEncoding: 'ieee-p1363' },
      fromBase64Url(sigB64)
    );
    assert.equal(verified, true, 'VAPID JWT signature must verify against its own public key');
    const claims = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
    assert.equal(claims.aud, 'https://example-push-service.test');

    // --- Payload encryption: encrypt as the SENDER, decrypt as a simulated RECEIVER (a browser, in reality) ---
    const receiverEcdh = createECDH('prime256v1');
    receiverEcdh.generateKeys();
    const authSecret = randomBytes(16);
    const clientKeys = { p256dh: receiverEcdh.getPublicKey('base64url'), auth: authSecret.toString('base64url') };

    const plaintext = JSON.stringify({ title: 'New message', body: 'Alice sent you a message in Chat' });
    const encrypted = encryptPayload(new TextEncoder().encode(plaintext), clientKeys);
    const decrypted = decryptPayload(encrypted, { uaPrivateD: receiverEcdh.getPrivateKey(), authSecret });
    assert.equal(new TextDecoder().decode(decrypted), plaintext, 'decrypted push payload must match the original plaintext');

    console.log('    OK - VAPID JWT verifies, and RFC 8291 payload encryption round-trips (see @qu/push for what this does NOT prove - no live push service in this environment)');
  }

  // ---------------------------------------------------------------------
  section('Notification pipeline: ThreadService.notify() reaches the recipient (Geo Chase / Calendar pattern)');
  // ---------------------------------------------------------------------
  {
    const { DocumentEngine, CollectionEngine, ThreadEngine } = await import('@qu/engines');
    const { createServices } = await import('@qu/services');
    const { MemoryAdapter } = await import('@qu/runtime');

    // A real client of relayA (booted in step 1), same shape apps/shell's
    // own boot() uses: `publishAllTo: 'relay'` so every local write syncs
    // out unconditionally, `syncFetch` wired so ThreadService can backfill
    // a not-yet-synced profile on demand.
    async function connectClient() {
      const rt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
      new DocumentEngine(rt.core);
      new CollectionEngine(rt.core);
      new ThreadEngine(rt.core);
      const identity = new QuIdentityEngine(rt.core);
      await identity.importMnemonic(identity.generateMnemonic());
      const transport = new WebSocketClientTransport(`ws://127.0.0.1:${relayA.port}`, { WebSocketImpl: ws });
      await transport.connect();
      const sync = new SyncEngine(rt.core, transport, { publishAllTo: 'relay' });
      const Qu = createServices(rt.core, { identityEngine: identity, syncFetch: (p) => sync.fetch(p) });
      return { identity, sync, transport, Qu };
    }

    const aliceClient = await connectClient();
    const bobClient = await connectClient();

    await aliceClient.Qu.actors.publishMainProfile({ name: 'Alice-Notify' });
    await bobClient.Qu.actors.publishMainProfile({ name: 'Bob-Notify' });
    const bobPub = await bobClient.Qu.actors.whoAmI();
    await new Promise((r) => setTimeout(r, 200)); // let both profiles reach relayA

    // Mirrors apps/geochase/client.js's notifyInvitees(): space
    // `geochase-<id>` is exactly what @qu/relay's #deliverThreadPush() now
    // recognizes as a Geo Chase notice (see relay.js's `geochaseMatch`).
    await aliceClient.Qu.threads.notify('geochase-testgame', bobPub, 'invited', { gameId: 'testgame' });
    await new Promise((r) => setTimeout(r, 250)); // let the write sync to relayA and #deliverThreadPush() run

    bobClient.sync.subscribe(`/store/notifications-${bobPub}`);
    let notifMsgs = await bobClient.Qu.threads.listMessages(`notifications-${bobPub}`, 'notifications');
    if (notifMsgs.length === 0) {
      await bobClient.sync.fetch(`/store/notifications-${bobPub}`);
      notifMsgs = await bobClient.Qu.threads.listMessages(`notifications-${bobPub}`, 'notifications');
    }
    assert.equal(notifMsgs.length, 1, 'Bob should have exactly one in-app notification');
    assert.equal(notifMsgs[0].appId, 'geochase', 'notification should be attributed to the geochase app, not a raw spaceId');
    assert.equal(notifMsgs[0].url, '#/geochase/testgame', 'notification should deep-link to the specific game');

    aliceClient.sync.close();
    aliceClient.transport.close();
    bobClient.sync.close();
    bobClient.transport.close();
    console.log('    OK - a Geo Chase-style invite (ThreadService.notify()) reaches the recipient as a labeled, deep-linked notification');
  }

  // ---------------------------------------------------------------------
  section('Mounts and actions: actionsForMount()/resolveActionHref() (Contact List / Chat pattern)');
  // ---------------------------------------------------------------------
  {
    const { actionsForMount, resolveActionHref } = await import('@qu/foundation');

    // The real catalog shape @qu/relay's apps-catalog.js builds from
    // manifest.quapp files - see apps/chat/manifest.quapp's `actions` and
    // apps/contact-list/client.js, which consumes exactly this.
    const apps = [
      { name: 'chat', actions: [{ mount: 'contact-row', id: 'chat', label: 'Chat', icon: '💬', hrefTemplate: '#/chat/{pub}' }] },
      { name: 'contact-list', actions: [] },
      { name: 'notes' }, // no `actions` field at all - must be tolerated, not just an empty array
    ];

    const contactRowActions = actionsForMount(apps, 'contact-row');
    assert.equal(contactRowActions.length, 1, 'only chat declared a contact-row action');
    assert.equal(contactRowActions[0].appId, 'chat');
    assert.equal(resolveActionHref(contactRowActions[0], { pub: 'AbC123-_' }), '#/chat/AbC123-_', 'base64url pubkeys must survive the template substitution unmangled');
    assert.equal(actionsForMount(apps, 'no-such-mount').length, 0, 'an unknown mount id must yield an empty list, not throw');
    assert.throws(() => resolveActionHref(contactRowActions[0], {}), /needs param "pub"/, 'a missing template param must fail loudly, not silently produce a broken href');

    console.log('    OK - actionsForMount()/resolveActionHref() filter, sort and resolve declared actions correctly');
  }

  // ---------------------------------------------------------------------
  section('Sync freshness: a message missed while genuinely disconnected is picked up on reconnect, not just via subscribe()');
  // ---------------------------------------------------------------------
  {
    const { DocumentEngine, CollectionEngine, ThreadEngine } = await import('@qu/engines');
    const { createServices, THREAD_PRESETS } = await import('@qu/services');
    const { MemoryAdapter } = await import('@qu/runtime');

    async function connectClient() {
      const rt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
      new DocumentEngine(rt.core);
      new CollectionEngine(rt.core);
      new ThreadEngine(rt.core);
      const identity = new QuIdentityEngine(rt.core);
      await identity.importMnemonic(identity.generateMnemonic());
      const transport = new WebSocketClientTransport(`ws://127.0.0.1:${relayA.port}`, { WebSocketImpl: ws });
      await transport.connect();
      const sync = new SyncEngine(rt.core, transport, { publishAllTo: 'relay' });
      const Qu = createServices(rt.core, {
        identityEngine: identity,
        syncFetch: (p) => sync.fetch(p),
        getSyncGeneration: () => sync.getGeneration(),
      });
      return { identity, sync, transport, Qu };
    }

    const alice = await connectClient();
    const bob = await connectClient();
    await alice.Qu.actors.publishMainProfile({ name: 'Alice-Freshness' });
    await bob.Qu.actors.publishMainProfile({ name: 'Bob-Freshness' });
    const alicePub = await alice.Qu.actors.whoAmI();
    const bobPub = await bob.Qu.actors.whoAmI();
    await new Promise((r) => setTimeout(r, 200)); // let both profiles reach relayA

    const spaceId = 'chat';
    const threadId = 'smoke-freshness-room';
    bob.sync.subscribe(`/store/${spaceId}`); // mirrors apps/chat/client.js's own unconditional subscribe()

    await alice.Qu.threads.createThread(spaceId, threadId, THREAD_PRESETS.chat([alicePub, bobPub]));
    await alice.Qu.threads.postMessage(spaceId, threadId, { body: 'first message, while Bob is live-connected' });
    await new Promise((r) => setTimeout(r, 200));
    const beforeDisconnect = await bob.Qu.threads.listMessages(spaceId, threadId);
    assert.equal(beforeDisconnect.length, 1, 'Bob, still connected, should already have the first message via live subscribe()');

    // Bob "goes offline": a deliberate close (not a network blip) so this
    // test doesn't race real auto-reconnect timing - reconnect is driven
    // explicitly below instead, same net effect.
    bob.transport.close();
    await new Promise((r) => setTimeout(r, 50));

    // Alice posts a SECOND message while Bob is genuinely disconnected -
    // nothing delivers this to Bob no matter how long he waits, per
    // SyncEngine's own doc comment (subscribe() only ever covers writes
    // made AFTER a live connection exists).
    await alice.Qu.threads.postMessage(spaceId, threadId, { body: 'second message, sent while Bob was offline' });
    await new Promise((r) => setTimeout(r, 150));

    // Bob reconnects (transport.connect() re-arms it - see
    // WebSocketClientTransport's own doc comment). SyncEngine's onReconnect
    // hook bumps the generation and replays Bob's subscription BEFORE this
    // await resolves (see @qu/sync/sync-engine.js's constructor).
    await bob.transport.connect();

    const immediatelyAfterReconnect = await bob.Qu.threads.listMessages(spaceId, threadId);
    assert.equal(immediatelyAfterReconnect.length, 1, 'the second message should NOT be visible yet - the background refresh this listMessages() call just triggered is fire-and-forget, not awaited');

    await new Promise((r) => setTimeout(r, 400)); // let the background refresh's fetch() round-trip complete
    const afterBackgroundRefresh = await bob.Qu.threads.listMessages(spaceId, threadId);
    assert.equal(afterBackgroundRefresh.length, 2, 'both messages should now be visible - reconnecting triggered a background catch-up that subscribe() alone never would have delivered');
    assert.equal(afterBackgroundRefresh[1].body, 'second message, sent while Bob was offline');

    alice.sync.close();
    alice.transport.close();
    bob.sync.close();
    bob.transport.close();
    console.log('    OK - a message missed while genuinely disconnected self-corrects on reconnect via background refresh');
  }

  // ---------------------------------------------------------------------
  section('Sync outbox: a write made while genuinely offline survives a "reload" and reaches the relay on reconnect');
  // ---------------------------------------------------------------------
  {
    const { MemoryAdapter } = await import('@qu/runtime');
    const { createServices } = await import('@qu/services');
    const { DocumentEngine } = await import('@qu/engines');
    const { MemoryOutboxStore } = await import('@qu/sync');

    const rt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
    new DocumentEngine(rt.core);
    const Qu = createServices(rt.core, {});

    // Stands in for the browser's IndexedDBOutboxStore (same OutboxStore
    // contract, see @qu/sync/outbox.js) - what matters for this test is
    // that it survives what's about to be discarded below, exactly like
    // IndexedDB would survive a real page reload.
    const outbox = new MemoryOutboxStore();

    const transport1 = new WebSocketClientTransport(`ws://127.0.0.1:${relayA.port}`, { WebSocketImpl: ws });
    await transport1.connect();
    const sync1 = new SyncEngine(rt.core, transport1, { publishAllTo: 'relay', outbox });
    await new Promise((r) => setTimeout(r, 50));

    // Genuinely offline, THEN write - unlike a mid-session drop, this
    // transport (and its own in-memory send queue) is about to be thrown
    // away entirely, same as a reload would do.
    transport1.close();
    await new Promise((r) => setTimeout(r, 20));
    await Qu.documents.create('offline-space', 'note-1', { title: 'Written while offline' });

    const pendingBeforeReload = await outbox.getAll();
    assert.equal(pendingBeforeReload.length, 1, 'the offline write should have been recorded in the outbox');
    sync1.close(); // discard, along with transport1 - simulates the page (and its in-memory send queue) going away

    // "Reload": a brand new transport + SyncEngine, same outbox.
    const transport2 = new WebSocketClientTransport(`ws://127.0.0.1:${relayA.port}`, { WebSocketImpl: ws });
    const sync2 = new SyncEngine(rt.core, transport2, { publishAllTo: 'relay', outbox });
    await transport2.connect();
    await new Promise((r) => setTimeout(r, 250)); // let the outbox replay + relay's ack round-trip complete

    const onRelay = await relayA.services.documents.get('offline-space', 'note-1');
    assert.equal(onRelay?.title, 'Written while offline', 'the relay should have received the write via outbox replay on reconnect');

    const pendingAfterAck = await outbox.getAll();
    assert.equal(pendingAfterAck.length, 0, 'the outbox entry should be cleared once the relay acknowledged it');

    sync2.close();
    transport2.close();
    console.log('    OK - an offline write persisted in the outbox is replayed and acknowledged after reconnect, surviving a simulated reload');
  }

  // ---------------------------------------------------------------------
  section('Reciprocal prefix catch-up at the SyncEngine level (independent of any Service-level freshness tracker)');
  // ---------------------------------------------------------------------
  {
    const { MemoryAdapter } = await import('@qu/runtime');

    async function connectRawClient() {
      const rt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
      const transport = new WebSocketClientTransport(`ws://127.0.0.1:${relayA.port}`, { WebSocketImpl: ws });
      await transport.connect();
      const sync = new SyncEngine(rt.core, transport, { publishAllTo: 'relay' });
      return { rt, sync, transport };
    }

    const writer = await connectRawClient();
    const reader = await connectRawClient();
    reader.sync.subscribe('/store/prefix-catchup-space');
    await new Promise((r) => setTimeout(r, 50));

    reader.transport.close();
    await new Promise((r) => setTimeout(r, 20));

    // No engine registered for the 'notes' segment - a plain seal+persist
    // write, deliberately avoiding any Service/Engine machinery here so
    // this test isolates SyncEngine's OWN reconnect behaviour.
    await writer.rt.core.put('/store/prefix-catchup-space/notes/hello', { title: 'missed while reader was offline' }, {});
    await new Promise((r) => setTimeout(r, 150)); // let it reach relayA

    // Reconnect - SyncEngine's own onReconnect hook resubscribes AND fires
    // fetchPrefix() for every active subscription (see sync-engine.js).
    await reader.transport.connect();
    await new Promise((r) => setTimeout(r, 250)); // let the prefix-request/response round-trip complete

    // Read straight off the local mount, NOT through any Service-level
    // syncFetch/freshness-tracker call (unlike test #10) - proving this
    // arrived via SyncEngine's own reciprocal catch-up alone.
    const recovered = await reader.rt.core.get('/store/prefix-catchup-space/notes/hello');
    assert.equal(
      recovered?.val?.title,
      'missed while reader was offline',
      "SyncEngine's reconnect-time fetchPrefix() should have recovered the write the reader missed while disconnected"
    );

    writer.sync.close();
    writer.transport.close();
    reader.sync.close();
    reader.transport.close();
    console.log("    OK - SyncEngine's own reciprocal fetchPrefix() on reconnect recovered a write missed while disconnected, with no Service-level help");
  }

  // ---------------------------------------------------------------------
  section('Assets: chunk integrity verification rejects tampering, resumed re-upload skips unchanged chunks');
  // ---------------------------------------------------------------------
  {
    const { AssetEngine } = await import('@qu/engines');
    const { MemoryAdapter } = await import('@qu/runtime');

    const rt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
    rt.core.mount('blob', new MemoryAdapter());
    const assetEngine = new AssetEngine(rt.core, { chunkSize: 16 }); // force multiple small chunks

    const original = new TextEncoder().encode('0123456789ABCDEF'.repeat(4)); // 64 bytes -> 4 chunks of 16
    await rt.core.put('/store/files/assets/doc1', { name: 'doc1.txt', mime: 'text/plain', data: original }, {});

    const meta1 = (await rt.core.get('/store/files/assets/doc1/meta')).val;
    assert.equal(meta1.chunkCount, 4, 'expected 4 chunks for a 64-byte file with chunkSize 16');
    assert.equal(meta1.chunkHashes.length, 4, 'meta should carry one content hash per chunk');

    // Re-upload the IDENTICAL file - every chunk should be recognised as
    // already-present-and-identical and skipped (see #handlePut's resume/dedup check).
    const chunk0Before = await rt.core.get(`${meta1.blobPath}/chunk_0`);
    await rt.core.put('/store/files/assets/doc1', { name: 'doc1.txt', mime: 'text/plain', data: original }, {});
    const chunk0After = await rt.core.get(`${meta1.blobPath}/chunk_0`);
    assert.equal(chunk0After.ts, chunk0Before.ts, 'an identical re-upload should not rewrite an already-present chunk (resume/dedup)');

    // Corrupt one stored chunk directly (simulates transit corruption or a
    // tampering peer) and confirm getAsset() refuses to reassemble it.
    const { adapter: blobAdapter, rel: chunk1Rel } = rt.core.resolveMount(`${meta1.blobPath}/chunk_1`);
    const corrupted = { ...(await blobAdapter.get(chunk1Rel)) };
    corrupted.val = QuCrypto.toBase64(new TextEncoder().encode('TAMPERED-BYTES!'));
    await blobAdapter.put(chunk1Rel, corrupted);

    const result = await assetEngine.getAsset('/store/files/assets/doc1');
    assert.equal(result, null, 'a corrupted/tampered chunk must be rejected, never silently reassembled into the returned data');

    console.log('    OK - chunk content hashes are verified on read, corrupted chunks are rejected, and an identical re-upload resumes by skipping unchanged chunks');
  }

  // ---------------------------------------------------------------------
  section('Identity backup/transfer: exportSeedCode() -> importSeedCode()');
  // ---------------------------------------------------------------------
  {
    const { MemoryAdapter } = await import('@qu/runtime');

    const sourceRt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
    const sourceIdentity = new QuIdentityEngine(sourceRt.core);
    await sourceIdentity.importMnemonic(sourceIdentity.generateMnemonic());
    const sourceMainPub = QuCrypto.toBase64Url((await sourceIdentity.getMainKey()).publicKey);

    const code = await sourceIdentity.exportSeedCode();
    assert.equal(typeof code, 'string');
    assert.ok(code.length > 0);

    // A fresh "device" (its own empty store) importing that code must
    // derive the EXACT same main keypair - this is the whole point of the
    // transfer mechanism apps/profile's backup section exposes.
    const targetRt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
    const targetIdentity = new QuIdentityEngine(targetRt.core);
    await targetIdentity.importSeedCode(code);
    const targetMainPub = QuCrypto.toBase64Url((await targetIdentity.getMainKey()).publicKey);
    assert.equal(targetMainPub, sourceMainPub, 'importing a backup code must reconstruct the exact same identity');

    // The same one-seed-per-store guard importMnemonic() already has -
    // a second, DIFFERENT identity must not silently clobber an existing one.
    const otherRt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
    const otherIdentity = new QuIdentityEngine(otherRt.core);
    await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
    await assert.rejects(
      () => otherIdentity.importSeedCode(code),
      /already holds a different identity seed/,
      'importing a different identity without { overwrite: true } must be rejected'
    );
    await otherIdentity.importSeedCode(code, { overwrite: true }); // explicit overwrite must succeed
    assert.equal(QuCrypto.toBase64Url((await otherIdentity.getMainKey()).publicKey), sourceMainPub);

    // Garbage input must fail loudly, not silently derive a bogus identity.
    const garbageRt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
    await assert.rejects(
      () => new QuIdentityEngine(garbageRt.core).importSeedCode('not-a-real-backup-code'),
      /not a valid backup code/
    );

    console.log('    OK - a backup code reconstructs the exact same identity on a fresh store, with the same conflict guard as importMnemonic()');
  }

  // ---------------------------------------------------------------------
  section('@qu/qr: encodeToImageData() -> decodeFromImageData() round-trip');
  // ---------------------------------------------------------------------
  {
    const { encodeToImageData, decodeFromImageData } = await import('@qu/qr');
    // Same shape/length a real identity backup code has (base64url, ~86
    // chars for a 64-byte seed) - proving the QR mechanism can actually
    // carry this payload, not just a short test string.
    const payload = QuCrypto.toBase64Url(crypto.getRandomValues(new Uint8Array(64)));
    const { data, width, height } = encodeToImageData(payload);
    const decoded = decodeFromImageData(data, width, height);
    assert.equal(decoded, payload, 'a QR-encoded identity backup code must decode back to the exact original string');
    console.log('    OK - a full-size identity backup code survives a real QR encode/decode round trip');
  }

  // ---------------------------------------------------------------------
  section('Cross-device data recovery: own profile + favorites backfill after importSeedCode()');
  // ---------------------------------------------------------------------
  {
    const { DocumentEngine, CollectionEngine, ThreadEngine } = await import('@qu/engines');
    const { createServices } = await import('@qu/services');
    const { MemoryAdapter } = await import('@qu/runtime');

    async function connectClient(identitySeedCode) {
      const rt = new QuRuntime({ storeAdapter: new MemoryAdapter() });
      new DocumentEngine(rt.core);
      new CollectionEngine(rt.core);
      new ThreadEngine(rt.core);
      const identity = new QuIdentityEngine(rt.core);
      if (identitySeedCode) await identity.importSeedCode(identitySeedCode);
      else await identity.importMnemonic(identity.generateMnemonic());
      const transport = new WebSocketClientTransport(`ws://127.0.0.1:${relayA.port}`, { WebSocketImpl: ws });
      await transport.connect();
      const sync = new SyncEngine(rt.core, transport, { publishAllTo: 'relay' });
      const Qu = createServices(rt.core, {
        identityEngine: identity,
        syncFetch: (p) => sync.fetch(p),
        getSyncGeneration: () => sync.getGeneration(),
      });
      return { identity, sync, transport, Qu };
    }

    // "Device A": a real identity with an alias, a custom private field, and a favorited app.
    const deviceA = await connectClient();
    await deviceA.Qu.profile.saveProfile({
      alias: 'CrossDeviceAlias',
      avatar: '🚀',
      fields: [{ key: 'note', value: 'secret-note', visibility: 'private' }],
    });
    const ownProfileA = await deviceA.Qu.profile.getOwnProfile();
    await deviceA.Qu.favorites.add('chat');
    await new Promise((r) => setTimeout(r, 200)); // let it all reach relayA

    const backupCode = await deviceA.identity.exportSeedCode();

    // "Device B": a FRESH, empty store importing that same backup code -
    // exactly apps/profile/client.js's "Use a different identity" flow.
    const deviceB = await connectClient(backupCode);
    const mainPubA = QuCrypto.toBase64Url((await deviceA.identity.getMainKey()).publicKey);
    const mainPubB = QuCrypto.toBase64Url((await deviceB.identity.getMainKey()).publicKey);
    assert.equal(mainPubB, mainPubA, 'importing the backup code must derive the identical identity');

    // First read may still be pre-backfill (fire-and-forget) - same
    // "flash of empty, then self-corrects" shape as section 10's message
    // backfill. Poll briefly rather than assuming a single fixed wait.
    let ownProfileB = await deviceB.Qu.profile.getOwnProfile();
    let favoritesB = await deviceB.Qu.favorites.list();
    for (let i = 0; i < 10 && (ownProfileB.alias !== 'CrossDeviceAlias' || favoritesB.length === 0); i++) {
      await new Promise((r) => setTimeout(r, 300));
      ownProfileB = await deviceB.Qu.profile.getOwnProfile();
      favoritesB = await deviceB.Qu.favorites.list();
    }

    assert.equal(ownProfileB.alias, 'CrossDeviceAlias', 'alias must backfill on the newly-imported device');
    assert.equal(ownProfileB.avatar, '🚀', 'avatar must backfill on the newly-imported device');
    assert.equal(ownProfileB.epub, ownProfileA.epub, 'epub must backfill on the newly-imported device (it comes from the same published profile document, not local re-derivation)');
    assert.deepEqual(favoritesB, ['chat'], 'starred/favorited items must backfill on the newly-imported device');
    const privateField = ownProfileB.fields.find((f) => f.key === 'note');
    assert.equal(privateField?.value, 'secret-note', 'private profile fields (self-encrypted) must backfill and still decrypt correctly on the newly-imported device');

    deviceA.sync.close(); deviceA.transport.close();
    deviceB.sync.close(); deviceB.transport.close();
    console.log('    OK - alias, avatar, epub, private fields, and favorites all backfill onto a freshly-imported identity');
  }

  // ---------------------------------------------------------------------
  console.log('\nAll smoke tests passed.');
} finally {
  for (const relay of relays) await relay.close();
  await rm(tmp, { recursive: true, force: true });
}
