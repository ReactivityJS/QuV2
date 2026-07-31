# QuV2 / QUniverse

A monorepo implementing the layered architecture from the Qu/QUniverse
brainstorming: a small, stable core that never learns what a "document" or
a "thread" is, with everything domain-specific built in replaceable layers
above it - up through a full QUniverse shell: self-generating navigation,
declarative reactive UI components, and a set of apps/services (Threads,
Favorites, Contacts, Directory, CMS) built the same way any third-party app
would be.

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

`@qu/runtime`, `@qu/identity`, `@qu/sync`, `@qu/reactive`, `@qu/ui` and
`@qu/relay` sit alongside/above this stack: Runtime bootstraps a Core with
default mounts, Identity derives keys from a BIP-39 seed, Sync replicates
between peers, Reactive turns a write-notification bus into a "watch this
path" primitive, UI is the Qu-Components layer built on it, and Relay is
the Node.js server that wires all of the above together, serves the
QUniverse shell, and can load Apps - local or remote - at boot.

## Why this shape

QuStore only ever deals in one thing, a QuBit:

```js
{ path, val, ts, pub, sig }  // Key, Value, Timestamp, Signer, Signature
```

It has no idea what a "document" or a "thread" is. That's the point:
`DocumentEngine`, `CollectionEngine`, `AssetEngine` and `ThreadEngine` (in
`@qu/engines`) each register against QuStore's put/get pipeline for the one
path *segment* they care about (`docs`, `files`, `threads`... see
`@qu/core/src/store.js`), and everything above them - `@qu/services`'
`DocumentService`, `CollectionService`, `AssetService`, `ActorService`,
`ThreadService`, `FavoritesService`, `ContactsService`, `DirectoryService`,
`CmsService` - hides those conventions behind a plain async API:

```js
const doc = await Qu.documents.create('wiki', 'intro', { title: 'Intro' });
const list = await Qu.collections.list('wiki', 'all-pages');
const asset = await Qu.assets.upload('gallery', 'logo', fileBlob);
await Qu.threads.postMessage('board', 'general', { body: 'hi **all**' });
```

An App (see `apps/notes`) never touches a Qu path directly - it asks the
Foundation `Registry` for the Services it `requires` in its
`manifest.quapp` and calls those. That's what keeps Apps small.

## Threads: one primitive behind Forum, Chat, Mail and Notifications

`ThreadEngine` + `ThreadService` are a single configurable primitive - a
"mail inbox" is a Thread with one reader; a "forum board" is a Thread with
public readers/writers; a "chat room" is a Thread scoped to a fixed member
list. They differ only in **config**, never in mechanism:

```js
import { THREAD_PRESETS } from '@qu/services';

await Qu.threads.createThread('board', 'general', THREAD_PRESETS.forum());
await Qu.threads.createThread('mailboxes', myInboxId, THREAD_PRESETS.mail(myActorPub));
await Qu.threads.createThread('rooms', roomId, THREAD_PRESETS.chat([aliceId, bobId]));
```

`writers`/`readers` are enforced two different ways, deliberately: writers
are checked **at write time by `ThreadEngine`, in the pipeline** - an
unauthorized `qu.put()` throws before anything is persisted, regardless of
which Service or app code called it. Readers are enforced by **encryption**
(a non-`'*'` `readers` list means every message is genuinely encrypted for
exactly those readers via `@qu/core`'s envelope encryption) - QuStore's
`get()` has no access control, so privacy has to come from the data being
unreadable, not from a check nobody is forced to go through. Optional
per-thread formatting (`formatting: ['markdown', 'mentions']`) is a small,
honest, HTML-escaped subset - see `@qu/services/thread-formatting.js`.

**Known limitation, stated plainly:** the writer-ACL check only runs for
writes going through *this* QuStore's `put()`. A QuBit arriving via
`@qu/sync` replication is written straight to the adapter (so already-signed
remote data never gets re-sealed), which means it currently bypasses
`ThreadEngine`'s check too. Enforcing this against synced-in data as well
would need an equivalent check in `SyncEngine`'s incoming-write path - real
future work, not implemented here.

## The QUniverse shell

`apps/shell` replaces "one central HTML file with every app's `import`
hard-coded into it" with a shell that knows nothing about any specific app:
it boots identity/storage/sync, fetches the relay's `/apps.json` (every
currently loaded app's manifest), builds its nav menu **from that list**,
and mounts whichever app the URL selects via `clientMain` - local or
genuinely remote, integrity-checked either way
(`apps/shell/src/load-client-module.js`). Favoriting an app
(`FavoritesService`) adds it to a pinned section of the same
self-generating menu.

Qu-Components (`@qu/ui`, browser-only) are the declarative half of this:

```html
<qu-list path="/store/wiki/collections/all-pages">
  <template>
    <li>
      <qu-view field="title"></qu-view>
      <qu-bind field="body" attr="innerHTML" contenteditable="true"></qu-bind>
    </li>
  </template>
</qu-list>
```

`<qu-view>`/`<qu-bind>`/`<qu-list>` subscribe via `@qu/reactive`'s `watch()`
in `connectedCallback()` and unsubscribe in `disconnectedCallback()` - no
manual subscribe/unsubscribe wiring in an app's own code. See
`apps/notes/client.js` for a complete, minimal example app built this way.

## Quick start

```bash
npm install                # installs deps + links the workspace
npm run test:smoke         # exercises the whole stack end-to-end (Node-only)
npm run relay               # boots a relay on :8080 - serves the QUniverse shell at /
npm run build               # bundles every package + browser app into dist/*.min.js
```

`npm run relay` serves the whole platform from one process: open
`http://localhost:8080/` for the QUniverse shell (self-generating nav,
identity, directory visibility, and any apps under `apps/` with a
`clientMain` - `apps/notes` ships as a working example). `apps/demo/public/index.html`
is a separate, lower-level demo of `@qu/services` directly (documents,
collections, file uploads), independent of the shell.

## Packages

| Package | What it is |
|---|---|
| `@qu/core` | QuBit, QuStore (put/get pipeline + Engine routing), QuMount, QuCrypto, QuEvents, VolatileAdapter |
| `@qu/runtime` | QuRuntime bootstrap, MemoryAdapter, IndexedDBAdapter |
| `@qu/foundation` | Registry (engines/services/capabilities), DependencyResolver, manifest schema |
| `@qu/loader` | Loads a package from a local dir or a remote URL (integrity + signature checked), resolving `requires` first |
| `@qu/identity` | BIP-39/SLIP-10 key derivation, main + pseudonymous ("space") identities, private attestations |
| `@qu/sync` | Path-based pub/sub replication between peers over any Transport |
| `@qu/reactive` | `watch(qu, path, cb)` - the live-update primitive Qu-Components are built on |
| `@qu/ui` | Qu-Components: `<qu-view>`, `<qu-bind>`, `<qu-list>`, `<qu-key>` (browser-only) |
| `@qu/engines` | DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine |
| `@qu/services` | The Entity API: Document/Collection/Asset/Actor/Starred/Thread/Favorites/Contacts/Directory/Cms |
| `@qu/relay` | Node.js peer: persists to disk, syncs over WebSocket, serves the shell, boots/serves apps |

## Writing an app

An app is a directory with a `manifest.quapp` and a main ES module:

```json
{
  "name": "forum",
  "version": "1.0.0",
  "kind": "app",
  "main": "./index.js",
  "clientMain": "./dist/client.js",
  "label": "Forum",
  "icon": "💬",
  "navOrder": 10,
  "requires": ["document-service", "collection-service", "thread-service"]
}
```

```js
// index.js - runs server-side when the relay loads the app (optional; a
// UI-only app can leave this a no-op). Use it to register Engines/Services.
export async function register(qu, manifest, registry) {}
```

```js
// client.js - runs in the browser when a shell mounts the app in-place.
export function mount(container, { qu, services, appId, segments }) {
  // build your UI, calling `services.threads`/`services.documents`/... for data.
  return () => { /* optional cleanup, called on navigation away */ };
}
```

Drop it in `apps/` and a relay auto-loads it at boot (see `apps/notes` for a
complete, minimal example, and `scripts/build-all.mjs` for bundling
`client.js` - it needs the same bundling as any other browser entry point,
since bare imports like `@qu/ui` don't resolve in a raw browser). `requires`
is resolved against whatever's already registered (built-in Engines/
Services) plus every other manifest found alongside it -
`@qu/foundation`'s `DependencyResolver` computes the load order and throws
a clear error if something's missing or circular.

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

The same mechanism works **client-side**: an app's `clientMain` can point
at a different origin entirely, verified the same way via
`clientIntegrity`/`clientSignature` (`apps/shell/src/load-client-module.js`,
`@qu/loader/remote`'s isomorphic `RemoteLoader` - importable standalone in a
browser bundle without pulling in `node:fs`).

**Deliberately NOT remote-loadable:** server-side ingest/validation logic
that would affect what a whole relay accepts from the network (there is no
such extension point in this repo, on purpose) - only Engines/Services/Apps
an operator explicitly configures at boot, and client-side app UI. Loading
code that decides trust-relevant behaviour for other peers from a wire
message an operator didn't review is a different, much larger trust
boundary than "this deployment's operator chose to load this app" - worth
naming explicitly so it isn't accidentally widened later.

## What's deliberately not here yet

The Foundation/Engine/Service/Loader stack, the QUniverse shell, and a
working Thread primitive covering Forum/Chat/Mail/Notifications are all
here and tested. What's NOT: the actual Forum/Chat/Mail/Notifications
*apps* themselves (thin UI over `ThreadService` + the right preset - see
`apps/notes` for the shape any of them would take), a richer permission
model beyond Thread's writers/readers, and search. Each is a natural next
app/Service, built the same way `apps/notes` and `ThreadService` were: as a
thin consumer of what already exists, added when something actually needs it.
