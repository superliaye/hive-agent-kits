# Event bus: keep TypedEmitter, do not adopt Effect PubSub/Stream (for now)

## What this ADR records

Whether the cross-cutting in-process event bus — every emitter module's `events: TypedEmitter<XEvents>` (`src/lib/typed-emitter.ts`), to which Audit attaches via `wireSubscriptions` (`src/audit/subscriptions.ts`) — should be replaced by Effect `PubSub`/`Stream` as part of the Effect migration ([ADR-0011](0011-effect-ts-daemon-substrate.md)). ADR-0011 explicitly left this as "a separate decision, not settled here"; [docs/effect-migration-plan.md](../effect-migration-plan.md) §4.0 gates Phase 4 on settling it before Audit or any emitter is touched. This is the architecturally weightiest cross-cutting call left in the migration because it touches Audit plus all six emitter modules at once.

## Context

`TypedEmitter<EventMap>` is a ~30-line primitive. Its load-bearing contract is **synchronous, sequential, block-on-failure dispatch**: `emit()` awaits each listener in registration order, and the first listener that throws rejects the `emit()` promise, so subsequent listeners do not run (`src/lib/typed-emitter.ts:24-31`; covered by `src/lib/__tests__/typed-emitter.test.ts:44-63`).

Six modules expose a `TypedEmitter` today — Config, Secrets, Catalog, Capabilities/Registry, Runs, ModelGateway. **Two consumers** read the bus, and they want *opposite* failure semantics on the same primitive:

1. **Audit** (`src/audit/audit.ts`) attaches a synchronous listener per audited event type; a normalizer throw or a `bun:sqlite` persist failure propagates up through `TypedEmitter.emit` (`audit.ts:58-64`). This is exactly the ADR-0004 invariant *"Failure semantics: block, with transaction split"* — audit-first ordering, no silent gaps. The invariant is realized **only when the emit site `await`s** the emit; see *Known gap* below for where it currently does not.
2. The **`/api/events` SSE relay** (`src/server/routes.ts:487-547`) attaches listeners that wrap every `stream.writeSSE` in a per-listener `try/catch` that **swallows** write failures (`routes.ts:491-502`), specifically *"a single dead client must not propagate up through TypedEmitter.emit and fail the originating mutation."* This is deliberate drop-on-failure.

So one bus already carries both block-on-failure and drop-on-failure consumers, chosen per listener. That is a feature of the current design, not an accident.

**Known gap — closed.** Block-on-failure is only realized when the *emit site* `await`s. The audited **Secrets** (`src/secrets/store.ts`) and **Runs** (`src/runs/executor.ts`) emits previously used `void events.emit(...)` while wired to Audit (`src/audit/subscriptions.ts`), so an audit-persist failure became an unhandled rejection and did **not** fail the originating operation — and the side effect committed *before* the discarded emit, breaking audit-first ordering. Closed in Phase-4 §4.2: (1) the audited Secrets/Runs emits are now `await`-ed and emit-before-commit, restoring block-on-failure + audit-first ordering (regression-tested with throwing audit subscribers); (2) a project-wide, **non-suppressible** no-floating-promises guard prevents recurrence — **Biome 2.4.16** `linter.rules.nursery.noFloatingPromises: "error"` with **`linter.domains.types: "all"`** (the rule no-ops without the domain) stops future *bare* floats, and because Biome treats `void p` as valid, the custom `scripts/check-no-floating-suppressions.ts` (raw TS compiler API) is the enforcer that fails on any `void <promise>` expression or any `biome-ignore lint/nursery/noFloatingPromises` suppression. Both are scoped to `src/` + `scripts/` (the scanner gates its own dir) to keep the type scanner off the `shell/`/`bundled/` corpus; a repo-wide `.gitattributes` (`* text=auto eol=lf`) pins every text file to LF for stable line endings on Windows, and a tracked `.githooks/pre-commit` runs both guards on commit.

**A third site — a conscious exemption, not the same defect.** The *external-edit* config reload path (`src/config/store.ts`, `source:"external"`) also fire-and-forgot its audited `config.change` emit, but block-on-failure has no teeth here: the reload merely *observes* an already-committed external (e.g. vim) edit from a synchronous `fs.watch` callback that cannot `await`, and there is no originating operation to fail. It stays **best-effort with a loud trace-log** — §4.2 de-floats it with an explicit `.catch(err => log().error(...))` (handled, *not* suppressed) so the guard passes while the reload never blocks. ADR-0004's *no silent gaps* narrows here to *no silent gaps; external-observation audit failures are loud-logged best-effort*.

Three inputs constrain any replacement (each verified against code):

- **(C1) The `{key, previous, current, source}` audit contract must survive.** The `config.change` audit row carries all four fields (`src/config/types.ts:37-46`), asserted in `src/audit/__tests__/subscriptions.test.ts:45-50`. Phase 3a already proved `SubscriptionRef.changes` *cannot* be the audit source: it emits whole-`S`, current-first, with **no `previous` and no `source`** (`src/config/effect/config-live.ts:1-12` header, decision C1). The `TypedEmitter` is the *only* path that carries the full per-key change record.
- **(C2) Block-on-failure / audit-first ordering (ADR-0004) must be preserved or consciously changed.** A standard Effect `PubSub` is decoupled/fire-and-forget: publishing does not synchronously run subscribers, and a subscriber failure does not fail the publisher. It gives back-pressure on a *bounded buffer* (publish suspends when full), not "publisher fails when a subscriber's write fails." Reproducing audit-first block-on-failure on a `PubSub` would mean re-inventing synchronous publisher-awaits-subscriber-and-fails-on-subscriber-failure on top of a primitive designed to avoid exactly that — net new complexity for no behavioral gain.
- **(C3) No concrete consumer needs bounded buffering or replay today.** The two consumers both work on the emitter: Audit is synchronous SQLite-write-in-listener (no buffering wanted — buffering would *weaken* the block-on-failure guarantee); the SSE relay is live-tail with intentional drop-on-dead-client (no replay wanted). Nothing needs PubSub's bounded queue, replay window, or multi-consumer fan-out-with-back-pressure.

## Decision

**Keep `TypedEmitter` as the typed event bus. Do not migrate the bus to Effect `PubSub`/`Stream`. Do not migrate it piecemeal.**

The Effect migration ([ADR-0011](0011-effect-ts-daemon-substrate.md)) continues for module internals (typed `E`, `Layer`/`Context` DI, Stream at I/O edges) without touching the cross-cutting bus. Audit (plan §4.2) migrates its *internals* to Effect if warranted, but keeps consuming `TypedEmitter` via `wireSubscriptions` unchanged.

Answers to the gated questions:

**(a) Keep or replace?** Keep. `TypedEmitter` already does the job; ADR-0011's "spend complexity on seams, keep boxes thin" argues against replacing a working 30-line seam with a heavier primitive that does not fit the dominant consumer.

**(b) How is block-on-failure / audit-first ordering preserved?** By keeping `TypedEmitter`'s sequential, throw-fails-the-emit dispatch (`typed-emitter.ts:24-31`) verbatim. Audit's listener stays synchronous and lets persist failures propagate (`audit.ts:58-64`), so for an emit site that `await`s the emit (Config, Catalog today) an audit-write failure fails the originating operation *before* it commits its side effect — the ADR-0004 invariant. The SSE relay's per-listener `try/catch` (`routes.ts:491-502`) continues to opt *out* of block-on-failure for dead clients. Keeping `TypedEmitter` keeps this guarantee *available at the seam* — the emit site must `await` to claim it, which the audited Secrets/Runs sites now do (the *Known gap* above is closed in §4.2). A standard `PubSub` would not offer the guarantee at the seam at all.

**(c) How does the `{key, previous, current, source}` contract survive?** It survives because the bus does not change: `ConfigChange` keeps flowing through `Config.events` as it does today (`config/types.ts:37-46`, `subscriptions.test.ts:45-50`). The Effect-native `ConfigLive` already keeps `watch()` and the audit stream on the `TypedEmitter` precisely because `SubscriptionRef.changes` cannot carry `previous`/`source` (`config-live.ts:1-12`). `SubscriptionRef.changes` remains exposed for future *reactive-state* consumers, never as the audit source.

**(d) Concrete trigger that would flip this later.** Adopt Effect `PubSub`/`Stream` for the bus only when a concrete consumer appears that genuinely needs one of PubSub's distinguishing capabilities — and the existing emitter cannot serve it without re-inventing that capability. Concretely, any of:

- A consumer needs **bounded buffering / back-pressure** between emit and consume (e.g. a slow durable exporter that must not block mutations but also must not drop), where today's bus offers only block-or-drop with nothing in between.
- A consumer needs **replay / a buffered window** of recent events (e.g. an SSE client that reconnects and must catch up on missed events), which `TypedEmitter`'s fire-and-forget dispatch cannot provide.
- **Effect-native interruption/Scope** must propagate through the bus (e.g. emit becomes part of an interruptible Effect graph and listener execution must participate in structured cancellation), which a plain Promise-based emitter cannot model.
- A second block-on-failure consumer with a *different* transactional ordering requirement than Audit appears, making per-listener convention insufficient and a typed publish-result channel worth its cost.

When one of these lands, revisit as a single cross-cutting change (Audit + all emitters together), not a piecemeal swap.

## Consequences

- **Audit (plan §4.2) and the SSE relay are unblocked** to proceed without a bus rewrite. Phase 4 spends its complexity on collapsing the per-module `ManagedRuntime` proxies into one composition-root runtime (plan §4.1), not on the bus.
- **The dual-semantics-on-one-bus property is retained**: block-on-failure (Audit) and drop-on-failure (SSE) coexist by listener choice. A `PubSub` would force re-deriving the block-on-failure side.
- **Known block-on-failure gap closed in §4.2.** The audited Secrets/Runs emits are now `await`-ed (block-on-failure + audit-first), and a non-suppressible no-floating-promises guard (Biome 2.4.16 `nursery/noFloatingPromises` + `domains.types: "all"`, backed by `scripts/check-no-floating-suppressions.ts` which forbids `void <promise>` and rule-suppressions) prevents recurrence. This ADR keeps the seam *capable* of the guarantee; the §4.2 code makes every audited site *claim* it and the guard keeps it claimed.
- **`SubscriptionRef.changes` and the `TypedEmitter` keep distinct roles**: reactive *state* (whole-`S`, current-first) vs. audit *events* (per-key, with `previous`/`source`). Conflating them was already rejected in Phase 3a; this ADR makes that boundary durable.
- **Semi-reversible.** This is a *deferral*, not a one-way door: nothing new is built, so flipping to `PubSub` later when a trigger appears costs the same as deciding it now would have — minus the speculative work avoided. The cost of being wrong is low.
- **`@effect/ai` parallel:** mirrors ADR-0011's posture of not adopting Effect surface area speculatively (pi-ai retained per ADR-0010) — adopt the heavier primitive when a concrete need forces it, not on principle.

## Alternatives considered

- **Replace `TypedEmitter` with a single Effect `PubSub` per module + `Stream` subscribers.** Rejected now: the dominant consumer (Audit) needs synchronous block-on-failure, which `PubSub` is explicitly designed *not* to provide; reproducing it means building publisher-awaits-subscriber-and-fails semantics on top of a decoupled primitive — more code for behavior we already have. No consumer needs PubSub's buffering/replay today (C3).
- **Hybrid: `PubSub` for the SSE relay, keep `TypedEmitter` for Audit.** Rejected: this is the explicitly-forbidden piecemeal migration. Two buses per module doubles the emission surface and the wiring, splits the audit-vs-trace mental model, and earns nothing — the SSE relay works fine on the emitter today.
- **Use `SubscriptionRef.changes` as the audit source to retire the Config `TypedEmitter`.** Rejected (re-confirms Phase 3a C1): `SubscriptionRef.changes` cannot carry `previous`/`source`, breaking the `{key, previous, current, source}` contract (`config-live.ts:1-12`; `subscriptions.test.ts:45-50`).
- **Migrate the bus opportunistically, module by module, during Phase 4.** Rejected: ADR-0011 and the migration plan both forbid big-bang *and* incoherent partial states for a cross-cutting seam; a bus half on `TypedEmitter` and half on `PubSub` is the worst of both. If it ever changes, it changes as one slice.

## Revisit trigger

Adopt Effect `PubSub`/`Stream` for the event bus when a concrete consumer needs **bounded buffering/back-pressure**, **replay of a recent window**, or **Effect-native interruption propagation** through emit — and the `TypedEmitter` cannot serve it without re-inventing that capability. Until then, leave the bus alone.
