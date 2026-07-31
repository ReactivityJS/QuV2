# QuV2

A monorepo implementing the layered architecture from the Qu/QUniverse
brainstorming: a small, stable core that never learns what a "document" or
a "thread" is, with everything domain-specific built in replaceable layers
above it.

```
Apps            apps/*                    - thin UI, loaded via manifest.quapp
    |
Services        @qu/services              - the Entity API apps actually call
    |
Engines         @qu/engines                - behaviour that plugs into QuStore's pipeline
    |
Foundation      @qu/foundation, @qu/loader  - Registry, DependencyResolver, manifest/loader
    |
Qu Core         @qu/core                   - QuBit, QuStore, QuCrypto, QuMount, QuEvents
```

`@qu/runtime`, `@qu/identity`, `@qu/sync` and `@qu/relay` sit alongside this
stack: Runtime bootstraps a Core with default mounts, Identity derives keys
from a BIP-39 seed, Sync replicates between peers, and Relay is the Node.js
server that wires all of the above together and can load Apps - local or
remote - at boot.

## Why this shape

QuStore only ever deals in one thing, a QuBit:

```js
{ path, val, ts, pub, sig }  // Key, Value, Timestamp, Signer, Signature
```

It has no idea what a "document" is. That's the point: `DocumentEngine`,
`CollectionEngine` and `AssetEngine` (in `@qu/engines`) each register
against QuStore's put/get pipeline for the one path *segment* they care
about (`docs`, `files`... see `@qu/core/src/store.js`), and everything
above them - `@qu/services`' `DocumentService`, `CollectionService`,
`AssetService`, `ActorService` - hides those conventions behind a plain
async API:

```js
const doc = await Qu.documents.create('wiki', 'intro', { title: 'Intro' });
const list = await Qu.collections.list('wiki', 'all-pages');
const asset = await Qu.assets.upload('gallery', 'logo', fileBlob);
```

An App (see `apps/notes`) never touches a Qu path directly - it asks the
Foundation `Registry` for the Services it `requires` in its
`manifest.quapp` and calls those. That's what keeps Apps small.

## Quick start

```bash
npm install                # installs deps + links the workspace
npm run test:smoke         # exercises the whole stack end-to-end
npm run relay               # boots a relay on :8080, auto-loading apps/
npm run build               # bundles every package + the demo into dist/*.min.js
```

Then open `apps/demo/public/index.html` (via any static file server - it
loads `../dist/bundle.js`, produced by `npm run build`) to try documents,
collections and file uploads against the running relay from a browser.

## Packages

| Package | What it is |
|---|---|
| `@qu/core` | QuBit, QuStore (put/get pipeline + Engine routing), QuMount, QuCrypto, QuEvents, VolatileAdapter |
| `@qu/runtime` | QuRuntime bootstrap, MemoryAdapter, IndexedDBAdapter |
| `@qu/foundation` | Registry (engines/services/capabilities), DependencyResolver, manifest schema |
| `@qu/loader` | Loads a package from a local dir or a remote URL (integrity + signature checked), resolving `requires` first |
| `@qu/identity` | BIP-39/SLIP-10 key derivation, main + pseudonymous ("space") identities, private attestations |
| `@qu/sync` | Path-based pub/sub replication between peers over any Transport |
| `@qu/engines` | DocumentEngine, CollectionEngine, AssetEngine |
| `@qu/services` | The Entity API: DocumentService, CollectionService, AssetService, ActorService |
| `@qu/relay` | Node.js peer: persists to disk, syncs over WebSocket, boots/serves apps |

## Writing an app

An app is a directory with a `manifest.quapp` and a main ES module:

```json
{
  "name": "forum",
  "version": "1.0.0",
  "kind": "app",
  "main": "./index.js",
  "requires": ["document-service", "collection-service"]
}
```

```js
export async function register(qu, manifest, registry) {
  const documents = registry.getService('document-service');
  // ... build your UI, calling `documents` for data.
}
```

Drop it in `apps/` and a relay auto-loads it at boot (see `apps/notes` for a
complete, minimal example). `requires` is resolved against whatever's
already registered (built-in Engines/Services) plus every other manifest
found alongside it - `@qu/foundation`'s `DependencyResolver` computes the
load order and throws a clear error if something's missing or circular.

## Remote loading

A relay can also load apps published elsewhere:

```json
{
  "remoteApps": [
    { "manifestUrl": "https://apps.example.org/forum/manifest.quapp",
      "trustedPublisherPubs": ["<base64url Ed25519 public key>"] }
  ]
}
```
(see `relay.config.example.json`)

`@qu/loader` refuses to load a remote package unless its manifest declares
an `integrity: "sha256-<hash>"` of the main module's bytes - tampering
between publish and fetch is detected and rejected. If the manifest also
carries a `signature` and you list a `trustedPublisherPubs` entry that
verifies it, the loader confirms the code came from a publisher you named,
not just that it's byte-identical to *something* someone once published at
that URL. A remote main module must be a single, self-contained ES module
(it's imported via a `data:` URL, which has no base to resolve further
imports from) - exactly what `npm run build`'s esbuild bundles produce.

## What's deliberately not here yet

Following the brainstorming's own conclusion - keep Qu Core minimal, put
the growth in the layers above it - this repo stops at a working
Foundation/Engine/Service/Loader stack plus one trivial example app. Real
apps (Forum, Mail, Wiki, CMS) and the richer Engines they'd share (Thread,
Search, Permission, Notification) are the natural next layer, built the
same way `apps/notes` is: as thin consumers of Services that don't yet
exist, added when the first app that needs them is written.
