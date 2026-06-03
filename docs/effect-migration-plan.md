# Effect-TS Migration Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for Phase 1 (its tasks use `- [ ]` step tracking). Phases 2+ are intentionally lower-resolution — re-plan each at this same granularity *after* the phase before it lands, because each slice teaches the next.

**Goal:** Adopt Effect-TS ([ADR-0011](adr/0011-effect-ts-daemon-substrate.md)) across the daemon incrementally, starting with the ModelGateway → Runs slice, without breaking the existing plain-async test suite.

**Architecture:** A single `ManagedRuntime` built from migrated `Layer`s at the composition root ([createServer()](../src/server/index.ts)) is the one place effects run. Each migrated module keeps a thin legacy proxy (its current `createX()`/handle shape, implemented by running the Effect service through the runtime) so unmigrated consumers and tests keep working. Modules migrate one at a time, Core first.

**Tech Stack:** `effect` **v4, pinned `4.0.0-beta.75`** (exact, no `^`), Bun, existing `bun test` suite. This is a playground; beta breakage is accepted ([ADR-0011](adr/0011-effect-ts-daemon-substrate.md)). `Stream.fromAsyncIterable` / `Effect.tryPromise` at I/O edges; `Context.Service` for modules with one obvious implementation. Zod stays the boundary validator (not `@effect/schema`), so the v4 Schema overhaul does not touch this repo. **Exact API names are verified below — do not trust v3 muscle memory.**

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
| Runtime | `ManagedRuntime.make` | present |
| Layer | `Layer.effect`, `Layer.succeed`, `Layer.provide`, `Layer.mergeAll` | **`Layer.scoped` is ABSENT** — Phase 2's scoped `HiveDbLive` must find the v4 scoped-resource mechanism (likely `Layer.effect` over `Effect.acquireRelease` in a `Scope`); confirm before relying on it. |

The exact constructor signature of `Context.Service` is **not yet exercised** (Phase 1 leans on `Data.TaggedError` + `Stream` + `Effect.runPromiseExit`, all confirmed). Confirm `Context.Service`'s shape the first time a service is defined (Phase 2's narrow ports).

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

## Phase 2 — Runs executor + Threads (realize the win)

**Why paired:** the executor is where the typed gateway stream pays off (delete the dual error path), and Threads + Runs share one `hive.db` handle — the top R-leak risk, which must be solved as a *shared scoped layer*, not a tag threaded through the root.

**Acceptance criteria:**
- The executor consumes `completeStream` directly (typed `E`), and the `try/catch` "threw out of band" reconciliation in [runs/executor.ts](../src/runs/executor.ts) is **deleted**.
- `HiveDbLive` is a single scoped `Layer` (owns open/dispose); `ThreadsLive` and `RunsLive` each `Layer.provide` it; **neither leaks a `HiveDb` requirement to the composition root** (verified by the root layer's `R` being `never` for the db). Layer memoization gives the one shared connection.
- The executor's deps become **narrow consumer-owned `Context.Service` ports** (`gateway.complete`, `secrets.getAuth`, `catalog.get`, `threads.{get,append,getCompletionMessages}`), not the full module interfaces.
- `AbortController` bookkeeping replaced by Effect interruption / `Scope`.
- Legacy `createRunExecutor()` handle preserved via proxy until the server route migrates.

**Task skeleton (re-plan to full granularity after Phase 1):** (1) `HiveDbLive` scoped layer + test that two consumers share one handle and it disposes once. (2) Narrow port tags for the executor's four dependencies. (3) Effect-native `startRun` returning `Stream<RunEvent, never>` (Run failures are *RunEvents*, not stream failures — preserve that domain semantic). (4) Delete the dual-error reconciliation; assert the existing executor tests still pass through the proxy. (5) Threads store as `Effect.Service` over `HiveDbLive`.

**Key risk:** `startRun`'s domain contract is "failures are `run.failed` *events*, the iterable itself doesn't throw." Keep that — only the *gateway* failure moves into `E` internally; the Run's own outcome stays an event. Don't let the typed channel leak the Run's domain outcome into `E`.

---

## Phase 3 — Supporting modules (as consumers need them)

Migrate when a consumer needs the typed contract; build plainly. Each: `Context.Service` + scoped resources + typed errors + legacy proxy + suite green.

- **Secrets** — typed errors for `no_credentials` / refresh failure / expiry; the OAuth refresh path (`oauth.ts`) becomes a scoped effect. On the executor's hot path, so it follows Phase 2 closely. *Risk:* the mid-stream `onRefresh` callback contract (ADR-0005/0008) must survive — model it as an effect the adapter runs, not a stored mutable callback.
- **Config** — reactive. **Do not** model as `Layer.succeed(staticValue)`; the port is a *service that reads live state per call* (back it with `SubscriptionRef`), preserving `config.watch(key, listener)` semantics (ADR-0006). *Risk:* reactive subscribers must keep firing across hot-reload.
- **Catalog / Capabilities** — loaders + file watchers. Watchers are I/O edges → `Stream`; malformed-manifest parse failures (today trace-logged) → typed `E` at the load boundary. Moderate gain, low urgency.

---

## Phase 4 — Edges, cross-cutting, and cleanup

- **Server as the Layer root.** `createServer()` becomes the `Layer` composition + `ManagedRuntime` owner; Hono handlers stay async at the edge and run effects through the runtime (SSE routes consume `Stream`). Adapter-selection by `mode: "file" | "memory"` stays at the root (that is its job — not an R-leak).
- **`TypedEmitter` → Effect `PubSub`/`Stream`?** Cross-cutting decision touching Audit + every emitter. **Needs its own ADR** before any code — do not migrate the event bus piecemeal. Until decided, keep `TypedEmitter` and bridge where needed.
- **Audit last.** Subscriber + SQLite writer; nearly pure I/O edge. Migrate only after the emitter/`PubSub` decision; its writes wrap with `Effect.tryPromise`.
- **Delete proxies.** When a module's last legacy consumer is migrated, remove its proxy and the old `createX()` shape. Migration is done when no proxy remains and `src/` has no plain-async outside I/O-edge adapters.
- **Do not migrate** the trace logger — `src/lib/log.ts` stays a call-site singleton by existing design (AGENTS.md).

---

## Self-review checks (run continuously)

- [ ] Every phase leaves the **full suite green** (coexistence invariant).
- [ ] No migrated module leaks an `R` to the root for a dep it can satisfy itself (`HiveDb` is the canonical test).
- [ ] No `any` / `as any` / `as unknown as` introduced (AGENTS.md) — including in interop helpers.
- [ ] Each migrated port is **narrow and consumer-owned**, not a mirror of the provider's full surface.
- [ ] Domain outcomes (a Run's `run.failed`) stay **events**; only infrastructure failures move into `E`.
