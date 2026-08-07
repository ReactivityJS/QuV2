# Qu V3 & Quniverse — Critical Review of the Architecture Concept

This document reviews the external "Qu V3 & Quniverse: Technische
Architekturspezifikation" (inspired by Drupal CMS, ProcessWire CMS, and GunDB)
against the actual, verified state of the QuV2 codebase, and derives a
revised, leaner set of architectural decisions for a **fresh V3 build that
selectively reuses QuV2** rather than migrating it in place.

The goal stated for V3 is explicit: **simple and very robust**, not
maximally general. Every recommendation below is filtered through that goal
— several ideas in the original concept are technically feasible but not
worth their complexity given that goal, and are called out as such.

No code was changed to produce this document. It is a decision record for
the next planning round.

## How this review was done

Three areas of the current codebase were read directly (not inferred from
prior planning notes) and checked against the concept's assumptions:
core/storage, sync/relay/network, and services/UI/apps. Every claim below
about "what QuV2 does today" is grounded in that reading, with file
references. Several concept assumptions turned out to be wrong about the
current system — in both directions: some things the concept treats as
missing are already built (and built well), and some things the concept
proposes would make a real, already-present bottleneck worse.

## Executive summary — top 5 findings

1. **A real Zero-Trust hole is still open**: `AccessEngine` (writer ACL
   enforcement) only runs on locally-originated `QuStore.put()` calls.
   Synced writes received from a peer go through `putSealed()` and land in
   the adapter directly, bypassing writer-list enforcement entirely
   (`packages/core/src/store.js`, `packages/engines/src/access-engine.js`).
   This was flagged before and never fixed. It must be **V3 milestone #1**,
   ahead of any new feature work — a "Zero-Trust" system that only checks
   trust locally isn't zero-trust.
2. **The concept's "flat QuBit per field" model would multiply I/O and sync
   traffic by roughly the field-count of every entity**, and turns every
   entity read into a multi-path join with visible partial states. QuV2
   already deliberately does the opposite — coarse per-entity documents by
   default, with flat single-purpose QuBits reserved for facts that are
   genuinely independent per actor (one reaction, one flag, one presence
   heartbeat — never a message's `body` split from its `formattedHtml`).
   This existing hybrid should become the explicit V3 rule, not the
   concept's literal example.
3. **`CollectionService`'s full-array read-modify-write is the single
   largest real scalability bottleneck already in production**, underneath
   messages, reactions, public flags, and presence lists alike. The
   previous QuV2 planning round deferred this to "Phase 8" (lowest
   priority). That was the wrong call for V3: every new "everything is a
   Flag/Like/Notification" feature the concept wants sits directly on top
   of this bottleneck. It needs to be solved early, and a fresh build is
   the right time to reconsider the primitive itself (see §4 below) rather
   than patch around it.
4. **Two "god objects" already exist at the composition root** (`relay.js`,
   894 lines; `apps/shell/src/main.js`, 656 lines) despite a real
   Services/Engines layer underneath — proof that having clean layers lower
   down doesn't by itself prevent a monolith at the top. V3's "Unified
   Runtime" idea is sound, but needs to be an enforced discipline (small,
   registered modules), not just an intention.
5. **Several concept goals are already fully or mostly built** and should
   simply be carried forward: the persistent sync outbox with ack/replay,
   reconnect-time catch-up sync, the generic Flags module (Drupal-Flag
   style, private + public modes), and the manifest/actions/slots +
   HookBus extension mechanism (data-only actions, code-only hooks, cleanly
   separated per trust boundary). These are the strongest parts of the
   current system and should be the foundation V3's runtime is built on,
   not replaced.

## Ground truth: concept assumption vs. verified QuV2 state

| Concept assumption | Verified current state |
|---|---|
| QuBit is `{path, val, ts, pub, sig}` | Exactly matches — 5 fields, `QUBIT_FIELDS` is a frozen closed list (`packages/core/src/qubit.js`). Already as lean as proposed. |
| Flat top-level mounts `/users/`, `/spaces/`, `/session/`, `/local/`, `/temp/` | Actual mounts are `store`, `event`, `net`, `blob` — a flat table keyed by **exact** segment name (`packages/core/src/mount.js`, `resolve()`). `/users/…`, `/spaces/…` are **path convention under the single `store` mount** (`packages/services/src/paths.js`), not separate mounts. No `session`/`local`/`temp` mounts exist yet. |
| Natural interceptor pipeline (no pre/post) | Already exactly this: a fixed TRANSFORM → SEAL → PERSIST → NOTIFY sequence (`packages/core/src/store.js`), with engines dispatched via an indexed `segment → Engine[]` map, not a full scan. The store's own doc comment describes this as a deliberate rewrite away from an earlier generic onion-middleware design — i.e. the concept's "flat handler chain" idea is already implemented, and a generic Koa-style onion was tried and reverted. |
| `*` / `**` path pattern matching | Does not exist at the mount/adapter level. Adapters support `getAll(prefix)` (an efficient prefix scan), which covers most real query needs already. |
| Persistent Sync-Out Queue (Outbox) | **Already fully implemented**: `SyncEngine` writes to a durable `OutboxStore` before sending, clears an entry only on a matching `sync-ack`, and replays the whole outbox on every reconnect (`packages/sync/src/sync-engine.js`, `packages/sync/src/outbox.js`). |
| Persistent Sync-In Queue (Inbox) | Does not exist as a separate structure — and arguably doesn't need to. Incoming writes are persisted directly, durably, with a `ts`-based regression guard (`#persistDirectly`). That already gives inbox-equivalent durability without a second, potentially divergent source of truth. |
| Reciprocal sync on reconnect | Effectively already achieved through two existing mechanisms working together: outbox replay (client → relay) and `fetchPrefix()` on reconnect (client actively pulls from relay for every active subscription). Not implemented as an explicit wire-protocol "reciprocal" flag, but the behavioral gap it targets is already closed. |
| Universal Peer paradigm (any node = client/relay/storage-mirror via config) | Transport today is strictly a client↔relay star; no WebRTC/P2P code exists anywhere in `packages/`. Core/services/engines are already adapter-based and not hard-wired to "relay-only," which is the useful part of this principle. |
| Content-addressed, resumable chunked file transfer | Already implemented in `AssetEngine`: per-chunk SHA-256, resume-by-hash-comparison, concurrent chunk writes. Dedup is per-asset only, not global cross-asset — a reasonable scope. |
| Generic Flags module (Drupal-inspired) | **Already fully implemented**: `FlagService` (private self-encrypted lists + public per-actor signed slots with count/enumeration), with `FavoritesService`/`ContactsService` refactored into thin facades over it. Nothing left to build here for V1. |
| Actions/hooks/registry extension points | Already cleanly split: manifest `actions[]` are pure data (no live function references — enforced by the code's own design), while `HookBus` (separate client- and server-side instances, one per trust boundary) is the only place real callback code runs. `Registry.registerCapability()` exists but has **zero callers** — dead code, not a working mechanism. |
| Collaborative editing via CRDTs (Yjs) | Does not exist. Would be a new, non-trivial dependency (merge semantics, binary deltas, realtime transport) with no current equivalent. |
| Incognito alias identities with a synced key vault | Does not exist. Current identity model instead derives deterministic per-space keypairs from one seed plus an attestation mechanism for selective disclosure — a different approach that already gives unlinkable per-context identity without storing or syncing any key material. |

## Point-by-point critique

### 1. QuBit granularity — the concept's biggest risk

The concept's example path, `/spaces/uuid-123/title`, implies one QuBit per
*field*. Taken literally across a real entity (a chat message has body,
formatted HTML, mentions, author, replyTo, extra…), this multiplies file
I/O, sync messages, outbox entries, and acks by roughly the field count —
and removes atomicity: a reader could observe a message with `body` written
but `formattedHtml` not yet, since there is no multi-field transaction.

QuV2 today does the opposite by default: one QuBit per *entity* (a whole
message, a whole profile, a whole document), and reserves flat,
single-purpose QuBits for facts that are genuinely independent per actor —
exactly the reaction/flag/presence pattern, where "one QuBit per actor per
fact" is correct because each actor's fact really is independent and
concurrently written by different actors.

**Recommendation**: make this hybrid the explicit V3 rule — entity-grained
documents by default; flat QuBits only for per-actor, independently
lifecycled facts. Do not take the concept's field-level example literally.

### 2. Five top-level mounts

A mount should represent a genuine backend/lifetime distinction (what
adapter, what persistence and durability semantics), not an entity
taxonomy. `session`, `local`, and `temp` are real, currently-missing
distinctions (tab-scoped volatile, device-local unsynced, RAM-only) and are
a reasonable addition. `users` vs. `spaces` as **separate mounts**, however,
would split identical backend/sync semantics into two mounts for no
adapter-level benefit — this should stay path convention under one data
mount, as it is today.

### 3. Generic `*`/`**` pattern matching

Feasible, but must not be built as an unindexed glob over mount/adapter
resolution — an unindexed `**` scan is exactly GunDB's well-known scaling
problem (full graph traversal with no real query engine), which is worth
avoiding explicitly given GunDB is cited as an inspiration for other parts
of this concept. The existing `getAll(prefix)` scan is efficient and should
remain the default; general pattern matching belongs in an explicitly
indexed query layer built *on top of* prefix scans, scoped to the patterns
actually queried — not offered as an implicit promise to match anything
cheaply.

### 4. A second persistent inbox queue

Redundant given the current durable-direct-write-with-ts-guard already
gives the same crash-safety guarantee without a second, potentially
diverging source of truth. Skip it unless a concrete need appears (e.g.
multi-step transactions needing pre-validation before apply).

### 5. Reciprocal sync as an explicit protocol feature

Structurally already solved via outbox replay + `fetchPrefix()`. A literal
reciprocal-request wire feature would save at most one round trip on
reconnect — low priority, not a structural gap.

### 6. "Universal Peer" taken literally

As a *principle* (core/services/engines must not hard-code relay-only
assumptions), this is sound and mostly already true. As a *literal launch
goal* (full peer symmetry, WebRTC mesh, any node interchangeably
client/relay/storage-mirror), it is high effort and high risk for unclear
near-term payoff, and is exactly the design GunDB is known to have
consistency and peer-flooding problems with. Prior architecture reviews of
this codebase reached the same conclusion independently ("no current need"
for multi-transport routing). **Recommendation: keep the client-relay star
as V3's actual transport; treat Universal Peer only as a non-precluding
principle**, not a V1 deliverable.

### 7. ACL enforcement on synced writes

Confirmed still broken (see executive summary #1). This is not a new
finding — it was on the original bug list — but it remains unfixed and
must not be deprioritized again. Every write must go through the same
authorization check regardless of whether it originated locally or arrived
via sync.

### 8. Incognito alias vault

Technically buildable with the same envelope-encryption pattern already
used for attestation. But the existing deterministic per-space-key model
already delivers unlinkable per-context identity at zero sync/storage cost
for key material — a vault only earns its complexity if there's a concrete
need the current model can't satisfy (e.g. aliases not bound 1:1 to a
space, or freely creatable/revocable aliases). This is listed as an open
question for the user below rather than decided here.

### 9. CRDT/Yjs collaborative editing

Real, self-contained complexity (merge semantics, binary deltas, realtime
transport) that's orthogonal to the rest of the system. Should be an
optional, later Engine module, not part of the V3 core — including it in
V1 directly conflicts with the "simple and robust" goal.

### 10. `CollectionService` scalability

Confirmed as a real, already-present bottleneck: `addItem()`/`removeItem()`
read and rewrite the entire `$list` array on every mutation
(`packages/services/src/collection-service.js`), with no chunking or
pagination. This underlies thread messages, reactions, public flags, and
presence — i.e. every feature the concept wants to build more of. The
previous plan filed this as lowest priority ("Phase 8"); that was
backwards. For a fresh build, the right question isn't just "how do we
chunk the list" but whether an explicit `$list` index is needed at all for
the common case, if the adapter contract guarantees a `ts`-sorted prefix
scan — "list children of a path" could then be answered directly from
storage instead of via a redundant, racy index document. This should be
decided as part of the adapter contract from day one, not retrofitted.

### 11. God objects at the composition root

`relay.js` (894 lines: HTTP server, WebSocket transport wiring, push
delivery incl. hardcoded per-app routing, presence tracking, full admin
HTTP API, static/PWA serving, app loading) and `apps/shell/src/main.js`
(656 lines: routing, menu building, auth/admin config, notification badge,
per-app mount-context assembly) both mix multiple unrelated
responsibilities, despite a real Services/Engines layer existing
underneath both. This shows that a clean lower-layer split doesn't by
itself prevent a monolith at the root. **V3 should introduce a small
`RuntimeContainer`** — a thin registration/resolution surface, the same
shape as the existing `Registry` + `HookBus` — and require every
cross-cutting concern (push delivery, admin API, routing, badge/menu
building) to be its own registered module. This needs to be an enforced
discipline, not just a stated intention, since the current codebase
already had the *intention* of a services split and still produced two god
objects at the top.

### 12. Generic push-routing template engine

The underlying need (routing not hardcoded per-app) is real and confirmed
— `relay.js#deliverThreadPush()` is still a hardcoded if/else chain per
app, and no `push-routing.js`/`templates.js` exists despite being planned
before. But a full pattern-matching template DSL with priority ordering is
likely over-engineering for the ~5 apps that currently need it.
**Recommendation**: start with a simple, explicit declarative mapping per
app in the manifest; only grow into a general template/pattern language if
real variety in routing needs demands it.

### 13. `ThreadService` monolith

778 lines covering five distinct concerns (messages, read receipts,
reactions, pins, presence) in one class. Legitimate candidate for
decomposition into focused services (messages, reactions, pins, presence)
sharing common collection/path helpers — at the **service layer**, not as
a new storage-pipeline Engine (consistent with the earlier, still-correct
decision that these are formatting/behavior concerns, not storage
integrity rules).

### 14. Declarative UI (`qu-components`) vs. actual usage

`<qu-list>`, `<qu-view>`, `<qu-if>` etc. exist and work, but are used in
roughly 1 of ~7,958 lines of app client code — built, essentially never
adopted. Carrying this contradiction into V3 unexamined would repeat the
same mistake. **Recommendation**: before committing either way, spike the
declarative components on 2–3 real apps, then make a binding decision
(declarative, or imperative + shared helpers like `injectStyle`) instead
of maintaining an unused parallel abstraction indefinitely.

### 15. `Registry.registerCapability`

Zero call sites despite being framed as "the declarative capability API."
Either give it a real caller in the V1 design or cut it — don't carry
forward speculative, unused surface area.

### 16. Manifest/Actions/Slots + HookBus

The cleanest part of the current system: actions are pure data (verified —
no live function references anywhere), and `HookBus` is the sole place
real callback code executes, with separate instances per trust boundary
(client vs. server never share hook state). **This should be the literal
foundation of V3's "Unified Runtime"** — every new extension point (push
routing, flag UI placement, thread hooks) should route through these same
two primitives rather than inventing a third mechanism.

## Revised V3 principles (the "simple and robust" cut)

1. Entity-grained QuBits by default; flat per-actor QuBits only for
   independently lifecycled facts. Not literal per-field storage.
2. Mounts = backend/lifetime distinctions only. Keep `store`/`blob`/`event`/
   `net`; add `session`/`local`/`temp`. No `users`/`spaces` mounts — path
   convention under `store`, as today.
3. No generic unindexed glob query layer in V1. Prefix scans + targeted
   indices only.
4. Keep the outbox (already robust). No separate durable inbox.
5. No WebRTC/P2P mesh in V1. Client-relay star stays the transport;
   Universal Peer is a non-precluding principle in core/services/engines,
   not a shipped capability.
6. **ACL enforcement on synced writes is V3 milestone #1** — before any new
   feature work.
7. Incognito alias vault: open question, default to not building it.
8. CRDT/Yjs: explicitly out of V3 core scope; later optional Engine.
9. `CollectionService` scalability is an early milestone, not a late one —
   decide the sorted-prefix-scan adapter contract before building more
   features (Flags/Notifications) on top of the current primitive.
10. Enforce `RuntimeContainer` discipline for `relay`/`shell`-shaped
    composition roots — no new god objects.
11. Push routing: simple declarative mapping first; template DSL only if
    real variety demands it.
12. Split `ThreadService` into focused services at the service layer.
13. Spike `qu-components` on real apps before mandating a UI strategy
    either way.
14. Build V3's extension model entirely on Manifest/Actions/Slots (data)
    + HookBus (code) — already the strongest part of the system.
15. Reuse `FlagService` as-is — concept goal already fully met.

## Reuse plan for the fresh build

- **Carry forward largely unchanged**: `packages/core` (QuBit, crypto,
  store pipeline — validated as already correct, including the
  deliberate rejection of a generic onion-middleware model),
  `packages/foundation` (Registry, HookBus, manifest, actions/slots),
  `FlagService`, `StarredService`, `packages/i18n`.
- **Rework**: `mount.js` (add `session`/`local`/`temp`), `collection-service.js`
  (scalability redesign), `thread-service.js` (decomposition),
  `relay.js`/`shell/main.js` (decompose via `RuntimeContainer`), push
  routing (new, simple).
- **New**: uniform ACL enforcement across local and synced write paths,
  `RuntimeContainer`.
- **Explicitly deferred, not part of V3 launch scope**: CRDT engine,
  incognito alias vault, WebRTC/P2P, generic glob query layer, a binding
  UI-strategy decision (pending the spike).

## Open decisions for the user

- **Incognito alias vault**: build it, or keep the existing deterministic
  per-space-key model (which already delivers unlinkability without
  syncing key material)?
- **`qu-components`**: schedule a spike now, or commit deliberately to the
  imperative + shared-helper pattern that's actually in use today?
- **Universal Peer depth**: principle only (no shipped P2P), or is a
  concrete near-term goal (e.g. a StorageMirror role) actually wanted?
- **Where does the fresh build live**: a new package set inside this repo,
  or a separate repository?

These are intentionally left open rather than decided unilaterally — they
should be resolved before the next round turns this into a phased
implementation plan.
