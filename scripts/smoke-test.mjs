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
 *
 * NOT covered here (verified manually with Playwright during development,
 * not wired into this script to avoid adding a browser-automation
 * dependency to routine test runs): apps/shell actually rendering in a
 * browser - self-generating nav from /apps.json, mounting apps/notes'
 * clientMain, <qu-view>/<qu-bind>/<qu-list> reactivity, favoriting, and
 * identity/data persistence across a reload via IndexedDB.
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
  console.log('\nAll smoke tests passed.');
} finally {
  for (const relay of relays) await relay.close();
  await rm(tmp, { recursive: true, force: true });
}
