# Effect-TS Migration Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for Phase 1 (its tasks use `- [ ]` step tracking). Phases 2+ are intentionally lower-resolution — re-plan each at this same granularity *after* the phase before it lands, because each slice teaches the next.

**Goal:** Adopt Effect-TS ([ADR-0011](adr/0011-effect-ts-daemon-substrate.md)) across the daemon incrementally, starting with the ModelGateway → Runs slice, without breaking the existing plain-async test suite.

**Architecture:** A single `ManagedRuntime` built from migrated `Layer`s at the composition root ([createServer()](../src/server/index.ts)) is the one place effects run. Each migrated module keeps a thin legacy proxy (its current `createX()`/handle shape, implemented by running the Effect service through the runtime) so unmigrated consumers and tests keep working. Modules migrate one at a time, Core first.

**Tech Stack:** `effect` **v4, pinned `4.0.0-beta.75`** (exact, no `^`), Bun, existing `bun test` suite. This is a playground; beta breakage is accepted ([ADR-0011](adr/0011-effect-ts-daemon-substrate.md)). `Stream.fromAsyncIterable` / `Effect.tryPromise` at I/O edges; `Context.Service` for modules with one obvious implementation. Zod stays the boundary validator (not `@effect/schema`), so the v4 Schema overhaul does not touch this repo. **Exact API names are verified below — do not trust v3 muscle memory.**

---

## Status — where a fresh session starts (updated 2026-06-03)

**Branch `spike/effect-runs-gateway`, suite 495 pass / 0 fail.** Phases 0–3b are committed; **Phase 4 is next.** Read this section + the API map below, then build Phase 4 **manually** (see the tooling caveat).

| Phase | Status | Commits |
| --- | --- | --- |
| 0 — effect v4 + interop bridge | ✅ done | `30524d8` |
| 1 — gateway `completeStream` | ✅ done | `006037e` |
| 2 — HiveDbLive + executor typed-error win | ✅ done | `ab72d1f`, `e0bdc7b`, `0b2b39f` |
| audit `ts` wall-clock flake fix | ✅ done | `b567214` |
| 3a — Secrets + Config | ✅ done | Secrets commit, then `cc50b9f` (Config) |
| 3b — Catalog (ThreadsLive deferred) | ✅ done | `ebb6a7b` |
| **4 — composition root + cross-cutting** | **NEXT** | — |

**Pattern to mirror for any remaining module** — `src/<m>/effect/{errors,<m>-live}.ts` + a `ManagedRuntime` proxy in `src/<m>/index.ts`. Reference impls: `src/db/effect/hive-db-live.ts`, `src/secrets/effect/`, `src/config/effect/`, `src/catalog/effect/`.
- Tag + layer: `class X extends Context.Service<X, XSvc>()("<m>/X") {}`; `XLive(opts) = Layer.effect(X, Effect.acquireRelease(Effect.sync(() => buildSvc(...)), (svc) => Effect.sync(() => svc.dispose?.())))`.
- Proxy: `const rt = ManagedRuntime.make(XLive(opts)); const svc = rt.runSync(X);` → expose the legacy surface + `dispose: () => void rt.dispose()`. `runSync` works because the acquire is synchronous (in-memory stores + sync persistence reads).
- Typed `E` (`Data.TaggedError`) **only for genuine failures**; absence / normal branches stay `undefined` or domain events (Secrets `getAuth` stays `undefined`; a Run's `run.failed` stays an event — confirmed taste calls, not oversights).
- **Generic services:** a nominal `Context.Service` tag can't carry a type parameter. Config keeps the tag non-generic (`{dispose}`) and returns the typed `ConfigSvc<S>` via a **closure holder**, not through the tag (`src/config/effect/config-live.ts`).

**Gating decision for Phase 4:** the **`TypedEmitter` → Effect `PubSub` question needs its own ADR before Audit or the event bus is touched.** Decide it first (see Phase 4).

**Tooling caveat — `/loop-build` cannot build in this harness.** The `Workflow` args (`startFrom`/`stopAfter`/`resolutions`/`feature`) never reach `loop-swe.js` (`args` arrives empty), so it always re-plans, can't skip to build, and `resumeFromRunId` can't inject resolutions to clear a gate. It **plans** well (and its review caught real issues), but **build Phase 4 by hand.** Full bug report: `%TEMP%\handoff-loop-build-issues.md`.

**Open housekeeping:** add `.loop-swe/` to `.gitignore`; pre-existing latent `tsc` errors in `src/config/store.ts:88,161` and `store.test.ts:173` (present on HEAD; bun's runtime never enforced them — separate cleanup).

---

## Altitude note (deliberate deviation from the writing-plans template)

The writing-plans skill wants every step to carry complete, final code. That is right for **Phase 1**, which is concrete below. It is **wrong** for Phases 2+: the exact `Layer` shapes there depend on what Phase 1 proves about the coexistence boundary, and the precise Effect v4 API surface (a beta — names shift between betas) must be confirmed against `tsc` during execution, not asserted on paper here. Writing speculative final code for all 11 modules now would be the placeholder anti-pattern in a different disguise. So Phases 2+ carry **acceptance criteria + task skeletons + the specific risk each must resolve**, and are re-planned at full granularity when reached. This matches the repo principle "migrate one at a time, never big-bang."

Treat every code block below as **reference shape**, not verbatim truth — confirm against the API map below and `bun test`.

## Confirmed v4-beta.75 API map (project-resolved, Phase 0)

These were verified against this repo's own `node_modules/effect@4.0.0-beta.75` under `bun`. **Gotcha that cost real time:** probing `effect` from a scratch dir (`bun /tmp/x.ts`) auto-installs a *different* build and reports a different surface — always probe the project copy. v4 renamed several v3 names:

| Need | v4-beta.75 name (confirmed) | Note |
| --- | --- | --- |
| Service / DI tag | **`Context.Service`** (+ `Context.Reference`) | **not** `Context.Tag`, `Effect.Service`, or `ServiceMap.Service` |
| Typed error | `Data.TaggedError` | unchanged from v3 |
| Stream error handler | **`Stream.catch`** | **not** `Stream.catchAll` (renamed) |
| Async-iterable interop | `Stream.fromAsyncIterable`, `Stream.toAsyncIterable` (+ `…With`) | present |
| Run at edge | `Effect.runPromiseExit`, `Effect.tryPromise`, `Effect.gen` | present |
| Collect a stream | `Stream.runCollect` returns a **plain `Array`** | **not** a `Chunk` — `Chunk.toReadonlyArray` throws on it (Phase 1 finding) |
| Extract a failure (tests) | `Effect.flip` then `Effect.runPromise` | `Cause.failureOption` is **absent**; flip swaps `E`↔`A` cleanly |
| Runtime | `ManagedRuntime.make(layer)`; `.runSync`, `.runPromise`, `.dispose` | `runSync(Tag)` resolves a service synchronously when its layer's acquire is sync — the basis of the sync legacy proxies |
| Scoped resource | **`Layer.effect(Tag, Effect.acquireRelease(acquire, release))`** | confirmed — **`Layer.scoped` is ABSENT**; `Layer.effect` discharges the `Scope`. `Layer.{effect,succeed,provide,mergeAll}` present |
| Service / tag shape | `class X extends Context.Service<X, XShape>()("key") {}` | confirmed (Phase 2+). Nominal — **can't carry a generic**; for generic services keep the tag non-generic and return the typed svc via closure (Config, C3) |
| Reactive cell | `SubscriptionRef.make` / `get` / `set` / `update` / `modify` + **`SubscriptionRef.changes(ref)`** | `changes` is the **functional form** `SubscriptionRef.changes(ref)` returning a `Stream` (emits current-first); **NOT** an instance property `ref.changes` (Phase 3a finding) |

---

## Phase 0 — Foundation (no behavior change)

**Definition of done:** `effect` is a dependency, a shared runtime + interop helpers exist, the full existing suite is green, and nothing in `src/` yet depends on Effect except the new scaffold.

### Task 0.1: Add the dependency

**Files:** Modify `package.json`

- [ ] **Step 1: Install the latest (v4 beta) line, pinned exact**

Run: `bun add effect@beta` then pin to the exact resolved beta in `package.json` (e.g. `"effect": "4.0.0-beta.N"`, no `^` — beta minors may break, so bumps are deliberate). If any `@effect/*` companion package is added later, match the same beta number (v4's single-version rule).
Expected: `effect` at an exact `4.x` beta in `dependencies`, `bun install` clean.

- [ ] **Step 2: Verify the suite is still green**

Run: `bun test`
Expected: the existing suite passes unchanged (no Effect in use yet).

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build: add effect (v4 beta) dependency"
```

### Task 0.2: Coexistence interop helper ✅ DONE

**Files (as built):**

- Create: `src/lib/effect-interop.ts`
- Create: `src/lib/effect-interop.test.ts`

**Deviation from original plan, stated:** named `effect-interop.ts` (not `runtime.ts`) because it holds only the coexistence bridge. The `makeRuntime` wrapper was **dropped** — nothing builds a `Layer` yet, so it would be unused ceremony (YAGNI; "keep boxes thin"). `ManagedRuntime.make` is called directly at the composition root in Phase 4, where a real layer exists.

The one genuinely-needed, reused primitive is the failure-mapping bridge: drain a `Stream<A, E>` into an `AsyncIterable<A>`, turning a typed failure into a *terminal element* (not a throw) so a migrated module keeps the legacy stream contract.

- [x] **Step 1–4: TDD the bridge** — test (success round-trips; a `Stream.fail` maps to a terminal element); implement; green.

```ts
// src/lib/effect-interop.ts
import { Stream } from "effect";

export function streamToAsyncIterable<A, E>(
  stream: Stream.Stream<A, E>,
  onError: (error: E) => A,
): AsyncIterable<A> {
  // Stream.catch (NOT catchAll — renamed in v4) maps the failure into a final element.
  return Stream.toAsyncIterable(stream.pipe(Stream.catch((e) => Stream.make(onError(e)))));
}
```

Verified: `bun test src/lib/effect-interop.test.ts` → 2 pass; full suite `bun test` → 475 pass / 0 fail; `bunx tsc --noEmit` clean for the file; `bunx biome check` clean.

- [ ] **Step 5: Commit** (pending user confirmation)

```bash
git add package.json bun.lock src/lib/effect-interop.ts src/lib/effect-interop.test.ts
git commit -m "feat(lib): add Effect v4 + stream→async-iterable coexistence bridge"
```

---

## Phase 1 — ModelGateway slice (the proof)

The gateway is the safe end to pull: a leaf (no module deps), its error taxonomy already exists (`GatewayErrorCode`/`GatewayError`), its I/O edge is already isolated in `adapters/`. Goal: `complete` becomes Effect-native internally, errors land in the typed `E` channel, and the legacy `ModelGateway` handle keeps its exact current contract via a proxy so [runs/executor.ts](../src/runs/executor.ts) and all gateway tests pass untouched.

**Definition of done:** a new internal `completeStream(input): Stream<GatewayEvent, GatewayFailure>` exists; `registry.resolve` becomes an `Effect<GatewayAdapter, GatewayFailure>`; the pi-ai/fake adapters expose Effect streams; `createGateway()` still returns today's `ModelGateway` (AsyncIterable, in-band `error` event preserved) via the proxy; **the gateway test suite and the runs executor tests pass with zero changes to the executor.**

### Task 1.1: Typed gateway failure in the `E` channel

**Files:**
- Create: `src/model-gateway/effect/failure.ts`
- Create: `src/model-gateway/effect/failure.test.ts`

- [ ] **Step 1: Write the failing test** — a `GatewayFailure` carries the existing `GatewayErrorCode` + `retryable`, narrowed by `_tag`, and maps to/from the in-band `error` event shape losslessly.

```ts
import { expect, test } from "bun:test";
import { GatewayFailure, toErrorEvent } from "./failure.ts";

test("GatewayFailure maps to the in-band error event losslessly", () => {
  const f = new GatewayFailure({ code: "rate_limited", message: "slow down" });
  expect(f.retryable).toBe(true);
  expect(toErrorEvent(f)).toEqual({
    type: "error",
    code: "rate_limited",
    message: "slow down",
    retryable: true,
  });
});
```

- [ ] **Step 2: Run, confirm fail** — Run: `bun test src/model-gateway/effect/failure.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (reference shape):

```ts
import { Data } from "effect";
import { isRetryable } from "../errors.ts";
import type { GatewayErrorCode, GatewayEvent } from "../types.ts";

export class GatewayFailure extends Data.TaggedError("GatewayFailure")<{
  readonly code: GatewayErrorCode;
  readonly message: string;
}> {
  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

export function toErrorEvent(f: GatewayFailure): Extract<GatewayEvent, { type: "error" }> {
  return { type: "error", code: f.code, message: f.message, retryable: f.retryable };
}
```

- [ ] **Step 4: Run, confirm pass.** Run: `bun test src/model-gateway/effect/failure.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): typed GatewayFailure in the E channel"`.

### Task 1.2: Adapter resolution as an Effect

**Files:**
- Modify: `src/model-gateway/registry.ts` (add an Effect-returning `resolveEffect`; keep the throwing `resolve` for the legacy proxy)
- Modify/Create: `src/model-gateway/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test** — resolving an unregistered provider yields `Effect.fail(GatewayFailure{code:"model_not_found"})`, not a throw.

```ts
import { Effect, Exit } from "effect";
import { expect, test } from "bun:test";
import { createGatewayRegistry } from "../registry.ts";

test("resolveEffect fails with typed GatewayFailure for unknown provider", async () => {
  const reg = createGatewayRegistry();
  const exit = await Effect.runPromiseExit(reg.resolveEffect("nope/x"));
  expect(Exit.isFailure(exit)).toBe(true);
});
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** `resolveEffect(model): Effect.Effect<GatewayAdapter, GatewayFailure>` alongside the existing `resolve`; the parse/lookup failures become `Effect.fail(new GatewayFailure(...))`.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): Effect-returning adapter resolution"`.

### Task 1.3: Adapter edge → `Stream.fromAsyncIterable`

**Files:**
- Create: `src/model-gateway/effect/complete.ts` (`completeStream`)
- Create: `src/model-gateway/effect/complete.test.ts`

- [ ] **Step 1: Write the failing test** using the existing `fake` adapter: a fake emitting `[text_start, text_delta, done]` is consumable as a `Stream<GatewayEvent, GatewayFailure>`; a fake that throws surfaces as `GatewayFailure` in `E` (not an in-band event).
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** — `completeStream(input)` = `resolveEffect(input.model)` then `Stream.fromAsyncIterable(adapter.complete(input), (e) => mapUnknownToGatewayFailure(e))`. (This is the concrete instance of "plain async only at I/O edges" + ADR-0010.)
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): completeStream wraps adapters as Effect Stream"`.

### Task 1.4: Legacy proxy — preserve the exact current contract

**Files:**
- Modify: `src/model-gateway/index.ts` (`createGateway().complete` delegates to `completeStream`, bridged back to `AsyncIterable<GatewayEvent>` with the terminal in-band `error` event preserved)

- [ ] **Step 1: Write the failing test** — `createGateway().complete()` on a failing resolve still yields a terminal `{type:"error",...}` event then completes (today's contract the executor depends on), now sourced from the typed stream.
- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** the proxy: consume `completeStream`, and on stream failure emit `toErrorEvent(failure)` as the final event before the iterator ends. `registerAdapter`/`events` unchanged.
- [ ] **Step 4: Run the WHOLE gateway + runs suite, confirm pass with no executor changes.**

Run: `bun test src/model-gateway src/runs`
Expected: PASS, executor untouched.

- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): Effect-native core behind unchanged legacy handle"`.

### Phase 1 gate (the decision point ADR-0011 names)

After 1.4, evaluate honestly: did the typed `E` channel remove real complexity, or just relocate it behind a proxy? Confirm against the executor's current `try/catch` reconciliation — Phase 2 deletes that, which is where the win is realized. **If the win is not visible here, stop and reconsider scope before migrating Runs.**

---

## Phase 2 — Runs executor + Threads ✅ DONE (`ab72d1f`, `e0bdc7b`, `0b2b39f`)

**Delivered:** `HiveDbLive` scoped layer (`src/db/effect/hive-db-live.ts`); executor consumes `completeStream` via **narrow consumer-owned `Context.Service` ports** (`src/runs/effect/ports.ts`: `Completion`, `SecretsResolver`, `AgentLookup`, `ThreadHistory`, `RunLifecycle`); the dual out-of-band `try/catch` reconciliation is **deleted** — a typed `GatewayFailure` now arrives as data via `drainCompletion` (`src/runs/effect/consume.ts`) carrying its real code.

**Decisions made during build (review-escalated):**
- **`error ⇒ done` contract tightened** ([ADR-0005](adr/0005-model-gateway-design.md)): an `error` event is always followed by `done(finishReason:"error")`; the legacy gateway proxy emits both; the now-dead executor disjunct was removed.
- Out-of-band adapter throws are trace-logged at the gateway seam (`complete.ts` `toFailure`).

**Deviations from the original plan (intentional):**
- **`AbortController` cancellation was NOT migrated** to Effect interruption — kept as-is; `startRun` still returns `AsyncIterable<RunEvent>` (Run failures stay *events*, not `E`). Effect-native `startRun`/interruption is deferred.
- **`ThreadsLive` was NOT built** — Threads is pure sync CRUD with no error-channel win; the executor only needs the narrow `ThreadHistory` port, which it has. (Re-confirmed and deferred again in Phase 3b.)

---

## Phase 3 — Supporting modules ✅ DONE (3a: Secrets + Config; 3b: Catalog)

Built manually (loop couldn't drive its own build — see Status caveat). All keep the legacy `createX()` as a `ManagedRuntime` proxy; full suites + audit-subscriptions contract stayed green.

- **Secrets** (`src/secrets/effect/`) — `SecretsLive`; typed `E`: `SecretsNoCredentials` (on `requireAuth`) + `SecretsRefreshTarget`. **Decision (operator):** absence *is* a typed error on the Effect surface, **but** `getAuth`/the `SecretsResolver` port still return `undefined` so the executor is untouched (both coexist). OAuth `onRefresh` stays plain-async at the pi-ai edge, persisting mid-call.
- **Config** (`src/config/effect/`) — reactive `ConfigLive`. **Decisions (C1/C2/C3):** `SubscriptionRef<S>` is the state cell (`.changes` exposed for Phase 4, **not** consumed yet); `watch()` + audit stay on the **`TypedEmitter`** (the only path carrying `{key,previous,current,source}` — `SubscriptionRef.changes` can't, so it can *not* be the audit source); `writeQueue` + deep-equals kept; tag non-generic, `S` via closure.
- **Catalog** (`src/catalog/effect/`) — `CatalogLive`; typed `E`: `requireAgent` → `CatalogAgentNotFound`. Legacy mutation verbs still throw `AgentNotFoundError` (`server/routes.ts` narrows on it). **Scope calls:** the file watcher (shared `createTieredManifestStore`) was **not** Stream-ified (out of scope); parse errors stay collected-as-data + trace-logged (skips, not failures).
- **ThreadsLive** — deferred (pure sync CRUD, no win; see Phase 2).

---

## Phase 4 — Edges, cross-cutting, and cleanup (NEXT)

**Start here: settle the gating decision before writing code.**

### 4.0 — `TypedEmitter` → Effect `PubSub`/`Stream`? (decide first; write an ADR)

Every module exposes a `TypedEmitter<XEvents>`, and Audit subscribes to all of them (`src/audit/subscriptions.ts`, ADR-0004 subscribe pattern). Whether to replace `TypedEmitter` with Effect `PubSub`/`Stream` is **one cross-cutting decision** that touches Audit + every emitter — **do not migrate it piecemeal.** It is the architecturally weightiest call left and deserves a design discussion + its own ADR. Inputs the decision needs: the audit payload contract `{key, previous, current, source}` must survive (Phase 3a proved `SubscriptionRef.changes` *cannot* carry it); the `block-on-failure` emit semantics in `TypedEmitter` (audit failure fails the originating op, ADR-0004) must be preserved or consciously changed; back-pressure/replay needs. **Recommendation: write the ADR, likely keep `TypedEmitter` as the typed event bus for now (it already does the job) and only adopt `PubSub` if a concrete need appears.** Until decided, leave the bus alone.

### 4.1 — Server as the Layer composition root

`createServer()` (`src/server/index.ts`) becomes the `Layer` composition + the single `ManagedRuntime` owner, replacing the per-module `ManagedRuntime`s the proxies create today. Hono handlers stay async at the edge and run effects through the runtime (SSE routes consume `Stream`). Adapter-selection by `mode: "file" | "memory"` stays at the root (its job — not an R-leak). This is where the per-module proxies start to collapse into one runtime.

### 4.2 — Audit (last)

Subscriber + SQLite writer; nearly pure I/O edge. Migrate **only after 4.0**; its writes wrap with `Effect.tryPromise`. (Note the audit `ts` is now wall-clock-anchored — `b567214`.)

### 4.3 — Delete the proxies

When a module's last legacy consumer is migrated (via 4.1), remove its `createX()` proxy and the legacy surface. **Migration is done when no proxy remains and `src/` has no plain-async outside I/O-edge adapters.** Optionally build `ThreadsLive` here if uniformity is wanted at that point.

**Do not migrate** the trace logger — `src/lib/log.ts` stays a call-site singleton by existing design (AGENTS.md).

---

## Self-review checks (run continuously)

- [ ] Every phase leaves the **full suite green** (coexistence invariant).
- [ ] No migrated module leaks an `R` to the root for a dep it can satisfy itself (`HiveDb` is the canonical test).
- [ ] No `any` / `as any` / `as unknown as` introduced (AGENTS.md) — including in interop helpers.
- [ ] Each migrated port is **narrow and consumer-owned**, not a mirror of the provider's full surface.
- [ ] Domain outcomes (a Run's `run.failed`) stay **events**; only infrastructure failures move into `E`.
