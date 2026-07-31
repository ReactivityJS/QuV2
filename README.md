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

### Configuring the relay

Three layers, each overriding the one before (`packages/relay/src/server.js`):
QuRelay's own defaults -> `relay.config.json` in the working directory, if
present (copy `relay.config.example.json`) -> environment variables:

| Variable | Overrides | Example |
|---|---|---|
| `QU_PORT` | `port` | `8080` |
| `QU_STORE_DIR` | `storeDir` | `/data/store` |
| `QU_BLOB_DIR` | `blobDir` | `/data/blob` |
| `QU_APPS_DIR` | `appsDir` | `/app/apps` |
| `QU_IDENTITY_MNEMONIC` | `identityMnemonic` | `"word1 word2 ... word24"` |
| `QU_SERVE_SHELL` | `serveShell` | `0` disables the shell at `/` |
| `QU_REMOTE_APPS_JSON` | `remoteApps` | `'[{"manifestUrl":"https://...","trustedPublisherPubs":["..."]}]'` |

Env vars exist specifically so a container/orchestrator never needs to bake
or bind-mount a config file just to set a port or data directory - see
Docker below.

## Docker

```bash
docker compose up --build
```

Builds the image (multi-stage: installs + `npm run build` in a builder
stage, then `npm prune --omit=dev` before copying into a fresh runtime
stage - `dist/` is gitignored build output, so the image has to produce it
itself, same as any other fresh checkout) and starts one container serving
the whole platform on `:8080`, with a named volume (`quniverse-data`) for
`relay-data/` so identity and stored data survive a container restart.
Configure via environment variables in `docker-compose.yml` (see the table
above) - `QU_IDENTITY_MNEMONIC` is worth pinning explicitly for a
production deployment rather than relying on the auto-generated one, so the
relay's own identity is documented/recoverable independent of the volume.

Without Compose:

```bash
docker build -t quniverse-relay .
docker run -p 8080:8080 -v quniverse-data:/data \
  -e QU_STORE_DIR=/data/store -e QU_BLOB_DIR=/data/blob \
  quniverse-relay
```

The container runs as a non-root `quniverse` user, but starts as root just
long enough for `docker-entrypoint.sh` to `chown` `$QU_STORE_DIR`/
`$QU_BLOB_DIR` to that user before dropping privileges (via `su-exec`) and
launching the relay - a fresh *or already-existing* named volume is root-owned
by default, and only the entrypoint running on every start (not a one-time
image setting) fixes that reliably. If you still see `EACCES: permission
denied, mkdir '/data/...'`, you're most likely running an image built
before this entrypoint existed - `docker compose build --no-cache` (or
`docker build --no-cache`) and restart.

The image also ships a `HEALTHCHECK` (`GET /healthz` on `$QU_PORT`, default
`8080`) so `docker ps`/`docker compose ps` shows `unhealthy` if the relay's
HTTP loop stops responding, instead of just `Up` for as long as the process
hasn't exited.

### Troubleshooting: 503 from a domain in front of the relay

A `503` (or `502`) on a public URL like `https://your-domain.example/` is a
status the *relay itself never returns* - `#handleHttp()` in `relay.js` only
ever answers `200`, `404`, or `500`. Seeing `503` means something sitting in
front of the container (a reverse proxy: Traefik, nginx, Caddy, Cloudflare
Tunnel, a PaaS's own router, ...) can't reach it, not that the relay
answered and rejected the request. Narrow it down in this order:

1. **Is the container actually running and healthy?**
   ```bash
   docker compose ps
   ```
   If it's not `Up (healthy)`, check why it exited/crashed:
   ```bash
   docker compose logs quniverse-relay --tail=100
   ```
   A container stuck restarting on the old `EACCES` bug (see above) or any
   other boot-time crash presents to the outside world exactly as a 503,
   because there's nothing listening on `8080` for the proxy to reach.

2. **Does the relay answer directly, bypassing the proxy?** From the host
   running the container:
   ```bash
   curl -i http://localhost:8080/healthz
   ```
   `200 {"status":"ok",...}` here means the relay itself is fine and the
   problem is entirely in the routing layer between the public domain and
   this port - check that layer's own config/logs (e.g. Traefik/nginx
   upstream address and port, DNS pointing at the right host, the container
   actually being on the network/port the proxy expects). No response, a
   connection error, or the wrong port means the relay itself isn't
   reachable on `8080` yet - back to step 1.

3. **Is the port mapping and `QU_PORT` consistent?** `docker-compose.yml`
   maps `${QU_PORT:-8080}:8080` and always sets the container's own
   `QU_PORT=8080` explicitly - if you changed one without the other (e.g.
   overrode `QU_PORT` in `environment:` to something other than `8080`
   without also updating the `ports:` mapping's container-side port), the
   proxy would be pointed at a port nothing is listening on.

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
