# Qu V3 — Technical Concept: Core, Runtime, Engines, Services

This is the follow-up to [`v3-architecture-spec.md`](./v3-architecture-spec.md) (the
critical review of the external V3 concept against verified QuV2 code). That review
identified what to keep, what to challenge, and what to defer. This document turns
those conclusions into an actual technical design: how Core, Runtime, Engines, and
Services work in Qu V3, with every real weakness found in QuV2 paired with a concrete,
technically checked solution — aimed squarely at the stated goal: **simple, robust,
maintainable, more capable where it matters than GunDB, Drupal, or ProcessWire, without
copying their known failure modes.**

Every design decision below is grounded in QuV2 code actually read for this document
(file:line references given), not assumption. Three findings surfaced during this pass
that weren't in the previous review and materially change the design:

- **The same "read-modify-write a whole list" pattern is duplicated three times**
  (`CollectionService`, `StarredService`, and by extension anything built on either) —
  and one of the three (`StarredService`, which backs Favorites/Contacts) has **no**
  race mitigation at all, unlike `CollectionService`'s lock+retry. This turns "fix
  CollectionService's scalability" into "replace the list pattern itself" — see §4.2,
  the centerpiece of this document.
- `FsAdapter.getAll()` (the prefix-scan primitive sync and any future derived-list
  design depend on) returns entries in raw filesystem iteration order — **not sorted by
  `ts`**. Any design relying on prefix scans for ordered lists needs to say explicitly
  whose job sorting is (§1.2, §4.2).
- `AccessEngine`'s own doc comment (`packages/engines/src/access-engine.js:42-47`)
  already names the exact ACL-bypass gap this document treats as V3 milestone #1 — it
  is not a hidden bug, it's a **documented, accepted limitation that was never closed**.
  §3.3 gives it a concrete fix design, not just a flag.

## 0. Principles (unchanged from the review, now binding design constraints)

1. **Local-first, offline-first.** Every write lands durably on the local device before
   anything about the network matters.
2. **Zero-trust, uniformly.** A write is authorized by what it cryptographically proves,
   checked the same way regardless of whether it arrived locally or over sync. (Today
   this is true for encryption/readers, false for writer-ACLs on synced data — fixed
   in §3.3.)
3. **Entity-grained by default, fact-grained by exception.** One QuBit per entity
   document; flat single-purpose QuBits only for independently-lifecycled per-actor
   facts (a reaction, a flag, a presence beat).
4. **Simple over general.** Every mechanism below is scoped to a problem QuV2's own
   code has actually hit. No generic subsystem is proposed for a need that hasn't been
   demonstrated.
5. **One primitive per problem.** Where QuV2 has 2-3 independently-evolved
   implementations of the same idea (see §4.2), V3 collapses them to one, hardened once.

---

## 1. Layer 1 — QuCore & Persistence

### 1.1 QuBit — unchanged

```js
{ path, val, ts, pub, sig }
```

Verified already exactly this shape, `QUBIT_FIELDS` frozen (`packages/core/src/qubit.js`).
No change — this is already as minimal as the original concept asked for.

### 1.2 Mounts & the Adapter Contract

**Keep** the existing flat, exact-segment mount table (`packages/core/src/mount.js`) —
`resolve(path)` splits on `/`, takes the first segment as the mount name, rejects `.`/
`..`/NUL segments centrally (already the one correct chokepoint for path-traversal
safety, `mount.js:53-59`). **Reject** the concept's `/users/`, `/spaces/` as separate
mounts — no adapter/backend difference, stays path convention under `store`
(`packages/services/src/paths.js`).

**Add** three mounts the concept correctly identifies as missing, because they *do*
represent a genuine backend/lifetime distinction:

| Mount | Backend | Lifetime | Synced? |
|---|---|---|---|
| `store` (existing) | FsAdapter / IndexedDBAdapter | Durable | Yes |
| `blob` (existing) | chunked file storage | Durable | Yes (content-addressed) |
| `event`, `net` (existing) | pass-through pub/sub | Transient | N/A (not persisted) |
| `session` (new) | in-memory, tab-scoped | Dies with the tab | No |
| `local` (new) | IndexedDB, device-scoped | Durable per device | No (deliberately — this is where the sync outbox itself already effectively lives) |
| `temp` (new) | pure RAM | Dies with the process | No |

**Weakness found**: `FsAdapter.getAll(prefix)` (`packages/relay/src/adapters/fs-adapter.js:176-188`)
returns entries in raw directory-walk order — no `ts` ordering, no pagination. Every
future feature that wants "recent N children of a path, in order" (see §4.2) needs this
and today would have to sort client-side after loading everything, which doesn't scale.

**Solution — extend, don't replace, the adapter contract**:

```js
/**
 * @typedef {object} QuAdapter
 * @property {(rel: string, quBit: object) => Promise<object>} put
 * @property {(rel: string) => Promise<object|null>} get
 * @property {(relPrefix: string, opts?: {sort?: 'ts', order?: 'asc'|'desc', limit?: number, before?: number}) => Promise<Array<{rel, quBit}>>} getAll
 */
```

`sort`/`order`/`limit`/`before` are **optional** — an adapter that ignores them still
behaves exactly as today (full unsorted scan), so this is additive, not breaking.
`FsAdapter`'s reference implementation satisfies the contract simply (load matching
files, sort/slice in memory) — correct but O(n) per call, matching its own documented
positioning ("swap for a real database adapter if you outgrow it,"
`fs-adapter.js:29-34`). `IndexedDBAdapter` gets the real payoff: an actual `ts`-indexed
cursor range query, `O(limit)` instead of `O(n)`. This one contract change is what makes
§4.2's redesign possible without inventing a second storage mechanism.

### 1.3 Store pipeline — unchanged, validated as already correct

`packages/core/src/store.js`'s fixed TRANSFORM → SEAL → PERSIST → NOTIFY sequence, with
engines indexed by path segment (`#resolveEngines`, O(matching engines) not O(all
engines)), is kept exactly as-is. Its own doc comment documents a **prior** attempt at a
generic Koa-style onion pipeline that was deliberately reverted for exactly the reasons
a "flat handler chain" is attractive in the abstract (correctness/performance got
tangled, every engine ran on every path). **Do not reintroduce that pattern in V3** —
this is a case where the concept's "flat handler chain" language actually already
matches the better-performing implementation that's in place, not a gap.

`registerEngine({segment, order, put, get})` stays the one Engine extension point.

### 1.4 Entity granularity — the explicit V3 rule

> One QuBit per **entity document** by default (a message, a profile, a document). One
> QuBit per **independent fact** only when the fact is genuinely owned by one actor and
> concurrently written by many (a reaction, a flag, a presence heartbeat, a pin).

This is already how ThreadEngine/FlagService work today (message = 1 QuBit; reaction =
1 QuBit per actor) — V3 makes it a documented rule instead of an emergent convention, so
new Engines don't reinvent the field-level-QuBit mistake the external concept's
`/spaces/uuid-123/title` example would otherwise invite.

### 1.5 Identity & Keys — unchanged, vault deferred

Deterministic per-space keypairs (`getSpaceKey(spaceId)`) plus attestation
(`createAttestation()`/`resolveMainUser()`) already deliver unlinkable per-context
identity with zero sync cost for key material. **No incognito-alias vault in V3 launch
scope** — open question to revisit only if a concrete need surfaces that per-space
determinism can't satisfy (freely revocable aliases not bound to one space).

---

## 2. Layer 2 — Runtime: Registry, HookBus, RuntimeContainer

### 2.1 The god-object problem and its fix

**Weakness found**: `relay.js` (894 lines) and `apps/shell/src/main.js` (656 lines) are
both composition roots that accumulated unrelated responsibilities (HTTP+WS+push+
admin+static serving; routing+menu+auth+badge+mount-context) despite a clean
Services/Engines layer existing underneath both. Layering the *domain* code well didn't
prevent a monolith at the *composition* root.

**Solution — `RuntimeContainer`**, the same shape as the `Registry`+`HookBus` pair that
already works well, generalized to be the one place both relay and shell wire things up:

```js
class RuntimeContainer {
  register(name, factory) { /* lazy singleton by name */ }
  resolve(name) { /* instantiate-once, return */ }
}
```

Every cross-cutting concern becomes one small registered module instead of a method on
a god class:

```js
runtime.register('pushDelivery', () => new PushDeliveryService(registry, catalog));
runtime.register('adminApi', () => new AdminApiRouter(registry, identity));
runtime.register('router', () => new ShellRouter(registry, hooks));
runtime.register('menu', () => new MenuBuilder(registry, flags));
```

`relay.js`/`shell/main.js` shrink to: construct the container, register each module,
start it. This is a discipline, not just a container class — the concrete rule for V3
is: **no file wires more than one cross-cutting concern's worth of behavior directly**;
if it needs a second one, it becomes a registered module instead of a method.

### 2.2 Registry — kept, `registerCapability` gets a real caller or gets cut

`packages/foundation/src/registry.js` (engine/service lookup + capability registration +
one `HookBus` per Registry instance) is kept as-is — it's the cleanest part of the
current system. **Weakness found**: `registerCapability()`/`capabilitiesFor()` has zero
call sites anywhere (verified by grep) despite being framed as "the declarative
capability API." For V3: either wire it as the actual mechanism behind context-menu
generation (§6.1 — "what actions exist for this entity kind" is exactly a context-menu
question) or remove it. Carrying forward unused, speculative API surface is exactly the
kind of drift this document is meant to prevent.

### 2.3 HookBus — kept exactly as designed

`packages/foundation/src/hooks.js`'s `on()`/`off()`/`run()` (sequential, payload-merging,
for transforms) / `notify()` (parallel, fire-and-forget, for side effects), with
**separate instances per trust boundary** (server `Registry.hooks` vs. each client app's
`ctx.hooks`, never shared) is kept unchanged. This is architecturally the same shape as
ProcessWire's `addHookBefore`/`addHookAfter` method-hooking system — see §7 — but scoped
correctly for a system where "client" and "server" are different trust domains, which
ProcessWire (single server process) never had to solve.

### 2.4 Actions/Slots — kept, terminology validated

`packages/foundation/src/actions.js`/`manifest.js`: `actions[].slot` entries are pure
data (label/icon/`hrefTemplate`), verified to contain **no live function references**
anywhere in the codebase. This is the right and only mechanism for "where does another
app's UI get placed" — kept unchanged. HookBus is for **code**, Actions/Slots are for
**data**; V3 must route every new extension point through one of these two, never a
third mechanism (this is exactly where the external concept's "Registry" chapter and
"Runtime" chapter overlap — they're not two systems, they're these two, already built).

### 2.5 Event namespaces — already achievable, no new mechanism needed

The concept's `/events/local/...` vs `/events/net/...` split doesn't need new mounts —
`event` and `net` are **already** separate mounts (`packages/runtime/src/index.js`).
V3 formalizes this as path convention (`/event/local/...`, `/net/...`) rather than
building a new namespace mechanism for something two existing mounts already provide.

---

## 3. Layer 3 — Sync & Network

### 3.1 Persistent Outbox — kept, it already works

`SyncEngine`'s `OutboxStore` (durable pre-send record, cleared only on `sync-ack`,
replayed on every reconnect including the very first connection of a fresh page load —
`packages/sync/src/sync-engine.js:146-151`, `outbox.js`) is a complete, correct
implementation of exactly what the concept's "Persistent Sync-Out Queue" asks for.
**No change.**

### 3.2 Reconnect catch-up — kept, already closes the "future writes only" gap

On every reconnect, `SyncEngine` resubscribes and fires `fetchPrefix()` for every active
subscription (`sync-engine.js:204-224`) — a fire-and-forget pull of everything the peer
has under that prefix, explicitly documented as "RECIPROCAL CATCH-UP" closing the
"subscribe only delivers future writes" gap. Combined with outbox replay, both sync
directions are already covered on reconnect. **No new wire-protocol feature needed** —
the concept's "reciprocal sync" goal is already met by the combination of these two
existing mechanisms.

### 3.3 ACL enforcement on synced writes — V3 milestone #1

**Weakness, confirmed and precisely located**: `AccessEngine`
(`packages/engines/src/access-engine.js`) registers as `{segment: null, order: 0}` and
correctly gates every **locally-originated** `QuStore.put()`. But `SyncEngine`'s
`#handleSync` persists an incoming, already-signed QuBit via `QuStore.putSealed()`
(`store.js:283-326`), which — by design, for the good reason documented right there
(never re-sign data this device didn't write) — **skips the entire TRANSFORM step**,
meaning `AccessEngine` never runs on it. `AccessEngine`'s own doc comment
(`access-engine.js:42-47`) names this exact limitation as accepted-but-unfixed. A
malicious or compromised peer can today write to any protected resource by sending a
synced QuBit directly, bypassing the writer-list check the local path enforces.

**Solution**: extract `AccessEngine`'s pure decision logic (`resolveResource()` +
`writerAllowed()`, `access-engine.js:51-76`) into a small exported function with no
QuStore dependency:

```js
// @qu/engines: export, not just internal to AccessEngine
export async function isWriteAuthorized(qu, path, quBit) {
  const resource = resolveResource(path);
  if (!resource) return true; // not a protectable path
  const acl = await resolveAclFor(qu, resource); // same ACL/legacy-meta-fallback lookup AccessEngine already does
  return writerAllowed(acl, { writerPub: quBit.pub ? QuCrypto.fromBase64(quBit.pub) : null });
}
```

`SyncEngine#handleSync` calls this **after** `isAuthentic(quBit)` (signature
verification — already happens, `sync-engine.js` around the `#onPeerIdentified` call)
and **before** `#persistDirectly` — reject and drop (don't persist, don't ack, don't
re-broadcast) a synced write that fails it. This closes the gap with the *same*
authorization decision the local path already makes, not a second, divergent ACL
system — zero duplicated logic, one function used from two call sites.

### 3.4 Presence & push suppression — kept

`onPeerIdentified(peerId, actorPub)` (verified via a real signature check, never
spoofable — `sync-engine.js:548-550`) feeding a bounded `Map<actorPub, {peerId,
lastSeenAt}>` that `#deliverThreadPush()` consults before sending a Web Push (in-app
notification always still written) is a sound, already-implemented design. **No
change.**

### 3.5 Push delivery batching

**Weakness**: `#deliverThreadPush()`'s candidate loop is still a plain sequential
`for...of` with `await` inside — confirmed unchanged since it was first flagged.
**Solution**: `Promise.allSettled()` over candidates with a small concurrency cap (e.g.
10 in flight), so one slow/failing push-service call never serializes behind the next —
a self-contained, low-risk change independent of everything else in this document, and
worth doing early since every feature that fans out notifications (Flags, Mentions,
future Views-style digests) sits on top of it.

### 3.6 Transport topology — star kept, "Universal Peer" scoped to a principle

No WebRTC/P2P in V3 launch scope. Client-relay star stays the shipped transport.
"Universal Peer" survives only as the constraint that Core/Services/Engines never assume
they're running inside a relay process (already true — verified, nothing in those
packages imports relay-specific code) — not as a shipped peer-symmetry capability. This
is deliberately the opposite of GunDB's model; see §7.

---

## 4. Layer 4 — Engines & Services

### 4.1 Engine vs. Service — kept, the right split

Engines (`ThreadEngine`, `DocumentEngine`, `AccessEngine`, `AssetEngine`) are storage-
pipeline participants — trust-boundary code, enforced on every write regardless of
caller. Services (`ThreadService`, `DocumentService`, `CollectionService`, `FlagService`)
are plain async facades apps call. **No new Engine is introduced for anything that's a
text/formatting/UI transform** (mentions, hashtags, spoilers, codeblocks) — that
decision, made in earlier QuV2 planning, is re-validated here and carried into V3
unchanged: those belong in a pluggable formatting pipeline at the Service layer, not a
new storage Engine.

### 4.2 The List Primitive redesign — centerpiece of this document

**Weakness, newly precise**: the "read entire list, compute new list, overwrite" pattern
exists **independently** in two places:

- `CollectionService.#mutateOnce()` (`packages/services/src/collection-service.js:134-152`)
  — has lock-serialization (`#locks`) *and* re-read-and-retry (`MAX_MUTATE_RETRIES = 5`).
  Its own doc comment documents a **real adversarial test** that lost 9 of 10 concurrent
  same-collection additions before this mitigation existed.
- `StarredService.star()`/`unstar()` (`packages/services/src/starred-service.js:81-99`)
  — plain read-modify-write, **no lock, no retry**. Its own doc comment explicitly flags
  this as a known, unmitigated race ("two open tabs... one could clobber the other"),
  accepted only because it currently backs low-stakes personal lists (Favorites,
  Contacts) — but `FlagService.setPrivate()` routes **every** private flag (including
  future ones, per app-configured `flagTypes`) through exactly this weaker path.

Two independent implementations of the same idea, with two different (and one strictly
weaker) safety levels, is itself the architectural problem — not just performance.

**Solution**: replace both with **one** `ListService`, exposing two storage strategies
chosen by shape, not by caller:

```js
class ListService {
  /**
   * DERIVED list: no index document at all. Every item already lives at its
   * own path under `prefix` (e.g. a thread's messages, an entity's public
   * flags, a thread's pins-as-per-message-markers). list() is a sorted
   * adapter prefix scan (see §1.2's getAll({sort, limit, before})) -
   * addItem() is just qu.put() to the item's own path. No read-modify-write,
   * no lock, no retry, because there is nothing shared to race on: two
   * actors adding two different items write two different paths.
   */
  async listDerived(prefix, { limit = 50, before = null } = {}) { /* adapter.getAll(prefix, {sort:'ts', order:'desc', limit, before}) */ }

  /**
   * CURATED list: an explicit, user-ordered/user-curated index document -
   * for lists that reference items NOT colocated under one prefix (Favorites
   * references arbitrary app ids; Contacts references arbitrary actor pubs).
   * This is CollectionService's existing #mutate/#mutateOnce logic, kept
   * essentially as-is (it's already correct) - but now the ONLY
   * implementation, used by StarredService too instead of its own weaker copy.
   */
  async addCurated(listPath, itemId, data) { /* lock + optimistic retry, as CollectionService today */ }
  async removeCurated(listPath, itemId) { /* same */ }
  async listCurated(listPath) { /* read index document */ }
}
```

**Migration of existing call sites, by shape** (this is the concrete part — every
current list becomes one or the other, not a hypothetical third category):

| Today | Storage today | V3 |
|---|---|---|
| Thread messages (`threadMessagesCollectionId`) | Curated `$list` index, RMW per message | **Derived** — messages already live at their own path (`threadMessagePath`); list = sorted prefix scan of `.../msgs/` |
| Reactions (`threadReactionsCollectionId`) | Curated `$list` index | **Derived** — each reaction already a per-actor QuBit; same prefix-scan pattern as public Flags |
| Public Flags (`flagCollectionId`) | Curated `$list` index | **Derived** — identical shape to reactions, same fix |
| Pins (`threadPinsCollectionId`) | Curated `$list` index | **Derived** — store a pin as a per-message marker QuBit under `.../pins/<messageId>` instead of a central list; list = prefix scan |
| Favorites / Contacts / generic Starred namespaces | `StarredService` RMW, **no lock** | **Curated**, but now via the *hardened* shared implementation (lock + retry) instead of `StarredService`'s own weaker one |

This directly removes the read-modify-write race and its O(list-size) write cost from
the four highest-traffic use cases (messages, reactions, flags, pins — exactly what V3
wants to build *more* of), while making the remaining genuinely-curated lists
(Favorites/Contacts-shaped) strictly *safer* than they are today, not just left alone.
Pagination (`{limit, before}`) falls out of the same change for free via §1.2's adapter
contract, closing the old "Phase 8" concern as a side effect of a correctness fix rather
than a separate later effort.

### 4.3 `ThreadService` decomposition

**Weakness**: 778 lines, five concerns (messages, read receipts, reactions, pins,
presence) in one class (`packages/services/src/thread-service.js`). **Solution**: split
at the Service layer into `MessageService`, `ReactionService`, `PinService`,
`PresenceService`, each thin, sharing `paths.js` conventions and (per §4.2) the same
`ListService`. `THREAD_PRESETS` (the forum/chat/group/mail/notifications/activity
config factory) stays a single shared concept — it configures `MessageService`'s ACL
shape, not a reason to keep the other four concerns bundled with it.

### 4.4 `FlagService` — kept as-is, now built on `ListService`

Already a complete, correct implementation of the concept's "universal Flags module"
goal (`packages/services/src/flag-service.js`) — private mode via `StarredService`
(→ `ListService.addCurated`/`removeCurated` in V3), public mode via `CollectionService`
(→ `ListService.listDerived` in V3, since public flags are exactly the per-actor-QuBit
shape §4.2 describes). No API change for `FlagService`'s own callers — only its internal
storage strategy improves.

### 4.5 `AssetEngine` — kept

Content-addressed per-chunk hashing, resume-by-hash-comparison, concurrent chunk writes
(`packages/engines/src/asset-engine.js`) already match the concept's file-transfer
goals. Dedup stays scoped per-asset (not global cross-asset) — a reasonable, explicit
trade-off, not a gap to close in V3.

---

## 5. Layer 5 — UI Architecture

**Weakness**: `qu-components` (`<qu-list>`, `<qu-view>`, `<qu-if>`,
`packages/ui/src/components.js`) is a real, working declarative layer used in roughly 1
of ~7,958 lines of app client code — built, essentially never adopted. Carrying an
unused parallel abstraction into V3 unexamined repeats the mistake.

**Solution**: before V3 commits either way, run a scoped spike — port 2-3 real apps
(one list-heavy like `todo` or `app-list`, one more complex like `forum`) to
`qu-components` end to end, including a real fix for its known "full teardown rebuild,
no keyed diffing" limitation. Only after that spike produces real numbers (dev
ergonomics, bundle size, rebuild-cost-under-scroll) does V3 mandate one direction. Until
then, the imperative + shared-helper pattern already in use (`injectStyle`,
`renderFlagToggle`, the pattern this document's `ListService`-driven UI helpers should
also follow) remains the *default*, not a placeholder waiting to be replaced — V3 must
not maintain two supported UI paradigms indefinitely, which is the actual failure mode
here, not "imperative is wrong."

---

## 6. Layer 6 — Quniverse Ecosystem

### 6.1 Apps, Manifest, Slots — kept

Manifest-declared apps, `actions[].slot` placement, `HookBus` extension — already the
right shape (§2.4). V3 additionally wires `Registry.registerCapability()` (§2.2) as the
mechanism behind context-menu generation, giving it the real caller it currently lacks.

### 6.2 Push routing — simple declarative mapping, not a template DSL

**Weakness**: `relay.js#deliverThreadPush()` is still a hardcoded if/else chain per app;
no generic manifest-driven routing exists despite being planned before. **Solution,
scoped down from the earlier plan**: a manifest field per app,
`pushRouting: { spacePrefix, resolve: 'byThreadIdPrefix' | 'always' }`, and a small
lookup table instead of a general `{param}`-template pattern-matching engine — the
earlier plan's `fillTemplate`/`matchTemplate` DSL is more machinery than 5 apps justify
(§principle 4). Grow into a template language only if a 6th or 7th app's routing needs
genuinely can't be expressed as a lookup.

### 6.3 Notifications as the Hooks-&-Actions worked example

`pushActions` manifest metadata (already real, already used to build the Notifications
app's per-app toggle catalog) plus §3.5's batching plus §6.2's simplified routing
together are the concrete "an app just declares its actions and plugs into
notifications" story the concept asks for — realized with existing mechanisms
(Manifest data + HookBus code + Registry lookup), not a new subsystem.

### 6.4 Flags as the universal ecosystem module — kept, done

Restated from §4.4: this concept-chapter's goal is already fully met by
`FlagService` + admin-configurable `flagTypes`. Nothing further to design here.

---

## 7. Positioning: Qu V3 vs. GunDB, Drupal, ProcessWire

| Aspect | GunDB | Drupal | ProcessWire | **Qu V3** |
|---|---|---|---|---|
| Data model | Schema-less graph, CRDT (HAM/LWW per field) | Relational DB, server-authoritative | Relational DB (pages/fields), server-authoritative | Signed, optionally encrypted QuBits — entity-grained by default (§1.4) |
| Trust model | Bolt-on (SEA), any peer trusted to relay/store anything | Server is the trust boundary | Server is the trust boundary | Zero-trust **uniformly** once §3.3 ships — every write's authorization checked the same way regardless of origin |
| Offline-first | Partial (per-peer local graph, but weak conflict guarantees) | No | No | Yes, by construction (§1, §3.1) |
| Sync robustness | Gossip, no durable outbox/ack primitive as strong as ours | N/A (not P2P) | N/A (not P2P) | Durable outbox + ack + reconnect catch-up (§3.1-3.2), already implemented |
| Query model | `.map()` full graph traversal — known scaling problem | SQL + Views module | Fluent `$pages->find()` API | Prefix scan + explicit derived/curated list split (§4.2) — deliberately *not* GunDB's unindexed graph traversal |
| Extension model | Minimal — direct graph mutation | `hook_*()` procedural convention, implicit ordering, historically prone to tangled/slow hook chains | `addHookBefore`/`addHookAfter` on method calls — clean, explicit | `HookBus` (§2.3): same shape as ProcessWire's hooks, but scoped per trust boundary (client vs. server never share hook state) — a distinction neither Drupal nor ProcessWire needs to make, since both are single-trust-domain servers |
| Universal "flag" concept | None built-in | Flag module (inspiration) | None built-in | `FlagService` (§4.4) — already Drupal-Flag-equivalent, generalized beyond Drupal's entity types |
| Composition root discipline | N/A | Large, sprawling core + contrib module surface | Cleaner core, smaller surface | `RuntimeContainer` (§2.1) — explicit discipline against exactly the god-object drift found in `relay.js`/`shell.js` |

**The actual differentiator isn't any single mechanism** — GunDB has sync, Drupal has
Flags, ProcessWire has clean hooks and a fluent API. It's that Qu V3 is the only one of
the four where **offline-first, cryptographic zero-trust, durable sync, and a clean
extension model are all true simultaneously**, because they're built on the same five
QuBit fields instead of bolted onto a server-authoritative core after the fact.

---

## 8. Weakness → Solution — consolidated

| # | Weakness (verified) | V3 Solution | Section |
|---|---|---|---|
| 1 | ACL bypass on synced writes (`AccessEngine` only guards local `put()`) | Shared `isWriteAuthorized()`, called from `SyncEngine#handleSync` before persist | §3.3 |
| 2 | List RMW race, duplicated 2x, one copy (`StarredService`) has **no** mitigation at all | Unified `ListService`: derived (no RMW) for colocated items, one hardened curated path for the rest | §4.2 |
| 3 | `FsAdapter.getAll()` unsorted, unpaginated | Adapter contract gains optional `{sort, limit, before}` | §1.2 |
| 4 | `relay.js`/`shell/main.js` composition-root god objects | `RuntimeContainer` + one-concern-per-module discipline | §2.1 |
| 5 | Sequential push delivery | `Promise.allSettled` + concurrency cap | §3.5 |
| 6 | Push routing hardcoded per-app in `relay.js` | Declarative manifest lookup table (not a template DSL) | §6.2 |
| 7 | `Registry.registerCapability` dead code | Wired to context-menu generation, or removed | §2.2 |
| 8 | `qu-components` built, ~unused | Scoped spike before a binding decision either way | §5 |
| 9 | `ThreadService` 778-line, 5-concern monolith | Split into 4 focused services over shared `ListService` | §4.3 |
| 10 | Concept's flat-QuBit-per-field example | Explicit entity-grained-by-default rule | §1.4 |
| 11 | Concept's 5-mount proposal | 3 justified new mounts (`session`/`local`/`temp`), reject `users`/`spaces` as mounts | §1.2 |
| 12 | Concept's separate inbox queue, reciprocal wire-protocol feature, WebRTC mesh | All already-solved or deliberately deferred — no new machinery | §3.1, §3.2, §3.6 |

---

## 9. Explicitly out of V3 launch scope

CRDT/Yjs collaborative editing (later optional Engine); incognito alias vault (open
question, default no); WebRTC/P2P mesh (principle only, not shipped); a generic
unindexed glob (`**`) query layer; a binding declarative-UI mandate (pending the §5
spike); a general push-routing template DSL (§6.2, only if real need appears).

## 10. Suggested build order (not a full phased plan — that's the next round)

1. §3.3 (ACL fix) + §1.2 (adapter contract) — foundation, security, and the prerequisite
   for everything in §4.2.
2. §4.2 (`ListService`) — the highest-leverage change; unblocks scaling for messages,
   reactions, flags, pins simultaneously.
3. §2.1 (`RuntimeContainer`) — do this while decomposing `relay.js`/`shell.js` for
   §3.5/§6.2 anyway, not as a separate pass.
4. §3.5, §6.2, §4.3 — independent, parallelizable once 1-3 land.
5. §5 (UI spike) — can run in parallel with anything above; informs, doesn't block.

Turning this into an actual phased implementation plan (file-by-file, in the style of
the earlier QuV2 planning rounds) is a good next step once these design decisions are
confirmed.
