/**
 * QU DEMO — a small browser page exercising the full stack: Core, Runtime
 * (IndexedDB), Engines, Services, Identity and Sync against a running relay.
 *
 * This file is the SOURCE for the demo; `npm run build` bundles it (via
 * esbuild, see scripts/build-all.mjs) into `apps/demo/dist/bundle.js`,
 * which `public/index.html` loads with a plain `<script type="module">` -
 * no import map or dev server needed to view the demo, just a static file
 * server pointed at `apps/demo/public` (and `dist` alongside it).
 *
 * Start a relay first (`npm run relay` from the repo root) so the "Connect"
 * button has something to talk to.
 */
import { QuRuntime, IndexedDBAdapter } from '@qu/runtime';
import { DocumentEngine, CollectionEngine, AssetEngine, AccessEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { createServices, paths } from '@qu/services';

const SPACE_ID = 'demo-space';
const NOTES_COLLECTION = 'notes';

const runtime = new QuRuntime({ storeAdapter: new IndexedDBAdapter('qu-demo-store') });
const qu = runtime.core;
qu.mount('blob', new IndexedDBAdapter('qu-demo-blob'));

new AccessEngine(qu);
new DocumentEngine(qu);
new CollectionEngine(qu);
const assetEngine = new AssetEngine(qu);
const identityEngine = new QuIdentityEngine(qu);
const Qu = createServices(qu, { assetEngine, identityEngine });

let sync = null;

function log(message) {
  const logs = document.getElementById('logs');
  const line = document.createElement('div');
  line.className = 'log';
  line.textContent = message;
  logs.prepend(line);
}

async function ensureIdentity() {
  if (await identityEngine.hasIdentity()) return;
  const mnemonic = identityEngine.generateMnemonic();
  await identityEngine.importMnemonic(mnemonic);
  log(`New local identity created. Recovery phrase (save this!): ${mnemonic}`);
}

document.getElementById('btnConnect').addEventListener('click', async () => {
  const url = document.getElementById('relayUrl').value.trim();
  try {
    const transport = new WebSocketClientTransport(url);
    await transport.connect();
    sync = new SyncEngine(qu, transport);
    sync.subscribe(`/store/${SPACE_ID}`);
    log(`Connected to ${url} and subscribed to /store/${SPACE_ID}`);
  } catch (err) {
    log(`Connection failed: ${err.message}`);
  }
});

document.getElementById('btnAddNote').addEventListener('click', async () => {
  await ensureIdentity();
  const text = document.getElementById('noteText').value.trim();
  if (!text) return;
  try {
    const note = await Qu.documents.create(SPACE_ID, crypto.randomUUID(), { text });
    await Qu.collections.addItem(SPACE_ID, NOTES_COLLECTION, paths.documentPath(SPACE_ID, note._id));
    log(`Note created: "${note.text}" (${note._id})`);
  } catch (err) {
    log(`Error creating note: ${err.message}`);
  }
});

document.getElementById('btnListNotes').addEventListener('click', async () => {
  try {
    const notes = (await Qu.collections.list(SPACE_ID, NOTES_COLLECTION)) ?? [];
    log(`Notes (${notes.length}): ${notes.map((n) => n.text).join(' | ') || '(none)'}`);
  } catch (err) {
    log(`Error listing notes: ${err.message}`);
  }
});

document.getElementById('btnUpload').addEventListener('click', async () => {
  await ensureIdentity();
  const input = document.getElementById('fileInput');
  const file = input.files[0];
  if (!file) {
    log('Pick a file first.');
    return;
  }
  try {
    const meta = await Qu.assets.upload(SPACE_ID, file.name, file);
    log(`Uploaded "${meta.name}" (${meta.size} bytes, ${meta.chunkCount} chunk(s))`);
  } catch (err) {
    log(`Upload failed: ${err.message}`);
  }
});

document.getElementById('btnDownload').addEventListener('click', async () => {
  const assetId = document.getElementById('assetIdInput').value.trim();
  if (!assetId) return;
  try {
    const asset = await Qu.assets.download(SPACE_ID, assetId);
    if (!asset) {
      log(`No asset found: "${assetId}"`);
      return;
    }
    const blob = new Blob([asset.data], { type: asset.meta.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = asset.meta.name;
    a.click();
    URL.revokeObjectURL(url);
    log(`Downloaded "${asset.meta.name}" (${asset.data.length} bytes)`);
  } catch (err) {
    log(`Download failed: ${err.message}`);
  }
});

log('Qu demo ready. Connect to a relay, then create notes and upload files.');
