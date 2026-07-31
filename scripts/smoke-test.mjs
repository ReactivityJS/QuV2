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
  console.log('\nAll smoke tests passed.');
} finally {
  for (const relay of relays) await relay.close();
  await rm(tmp, { recursive: true, force: true });
}
