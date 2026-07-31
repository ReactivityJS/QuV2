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
  console.log('\nAll smoke tests passed.');
} finally {
  for (const relay of relays) await relay.close();
  await rm(tmp, { recursive: true, force: true });
}
