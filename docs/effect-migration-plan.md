# Effect-TS Migration Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for Phase 1 (its tasks use `- [ ]` step tracking). Phases 2+ are intentionally lower-resolution — re-plan each at this same granularity *after* the phase before it lands, because each slice teaches the next.

**Goal:** Adopt Effect-TS ([ADR-0011](adr/0011-effect-ts-daemon-substrate.md)) across the daemon incrementally, starting with the ModelGateway → Runs slice, without breaking the existing plain-async test suite.

**Architecture:** A single `ManagedRuntime` built from migrated `Layer`s at the composition root ([createServer()](../src/server/index.ts)) is the one place effects run. Each migrated module keeps a thin legacy proxy (its current `createX()`/handle shape, implemented by running the Effect service through the runtime) so unmigrated consumers and tests keep working. Modules migrate one at a time, Core first.

**Tech Stack:** `effect` **v4, pinned `4.0.0-beta.75`** (exact, no `^`), Bun, existing `bun test` suite. This is a playground; beta breakage is accepted ([ADR-0011](adr/0011-effect-ts-daemon-substrate.md)). `Stream.fromAsyncIterable` / `Effect.tryPromise` at I/O edges; `Context.Service` for modules with one obvious implementation. Zod stays the boundary validator (not `@effect/schema`), so the v4 Schema overhaul does not touch this repo. **Exact API names are verified below — do not trust v3 muscle memory.**

---

## Status — where a fresh session starts (updated 2026-06-04)

**Branch `spike/effect-runs-gateway`, suite 519 pass / 0 fail.** Phases 0–4 are committed. Every daemon module is now Effect-native: §4.0–§4.2 (event-bus [ADR-0012](adr/0012-event-bus-typed-emitter-vs-effect-pubsub.md); composition-root §4.1a/b; the §4.2 block-on-failure fix + non-suppressible no-floating-promises guard + Effect-native Audit), §4.3 (production proxies collapsed onto the single root runtime), and §4.x (`ThreadsLive` — the last module, built over the shared root `HiveDb`). Read this section + the API map below. Phase 4 was driven issue-by-issue through `/loop-full-swe` (see the tooling note).

| Phase | Status | Commits |
| --- | --- | --- |
| 0 — effect v4 + interop bridge | ✅ done | `30524d8` |
| 1 — gateway `completeStream` | ✅ done | `006037e` |
| 2 — HiveDbLive + executor typed-error win | ✅ done | `ab72d1f`, `e0bdc7b`, `0b2b39f` |
| audit `ts` wall-clock flake fix | ✅ done | `b567214` |
| 3a — Secrets + Config | ✅ done | Secrets commit, then `cc50b9f` (Config) |
| 3b — Catalog (ThreadsLive deferred) | ✅ done | `ebb6a7b` |
| **4 — composition root + cross-cutting** | ✅ done — all modules Effect-native | ADR-0012; 4.1a/b composition root; 4.2-A1/A2/B/C; 4.x ThreadsLive |

**Pattern to mirror for any remaining module** — `src/<m>/effect/{errors,<m>-live}.ts` + a `ManagedRuntime` proxy in `src/<m>/index.ts`. Reference impls: `src/db/effect/hive-db-live.ts`, `src/secrets/effect/`, `src/config/effect/`, `src/catalog/effect/`.
- Tag + layer: `class X extends Context.Service<X, XSvc>()("<m>/X") {}`; `XLive(opts) = Layer.effect(X, Effect.acquireRelease(Effect.sync(() => buildSvc(...)), (svc) => Effect.sync(() => svc.dispose?.())))`.
- Proxy: `const rt = ManagedRuntime.make(XLive(opts)); const svc = rt.runSync(X);` → expose the legacy surface + `dispose: () => void rt.dispose()`. `runSync` works because the acquire is synchronous (in-memory stores + sync persistence reads).
- Typed `E` (`Data.TaggedError`) **only for genuine failures**; absence / normal branches stay `undefined` or domain events (Secrets `getAuth` stays `undefined`; a Run's `run.failed` stays an event — confirmed taste calls, not oversights).
- **Generic services:** a nominal `Context.Service` tag can't carry a type parameter. Config keeps the tag non-generic (`{dispose}`) and returns the typed `ConfigSvc<S>` via a **closure holder**, not through the tag (`src/config/effect/config-live.ts`).

**Gating decision for Phase 4: RESOLVED** — [ADR-0012](adr/0012-event-bus-typed-emitter-vs-effect-pubsub.md) keeps `TypedEmitter` as the event bus (no `PubSub` swap). Audit (§4.2) and the SSE relay are unblocked; Phase 4 proceeds to the composition root (§4.1).

**Tooling note — the loop engine now receives `args`.** Earlier sessions saw `args` arrive empty at `loop-swe.js`; that is fixed — it normalizes a string-or-object `args` at `loop-swe.js:35`, so `/loop-full-swe` runs with `feature` + `resolutions` and the self-digest re-runs with injected gate answers. Known remaining limitation: on a `resumeFromRunId` *after* a build phase has already committed, a freshly-injected resolution is **not** re-applied to the committed files (the cache treats that phase as done) — apply such directed post-commit edits by hand.

**Open housekeeping:** pre-existing latent `tsc` errors in `src/config/store.ts:88,175` and `store.test.ts:173` (present on HEAD; bun's runtime never enforced them — separate cleanup).

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

- **Secrets** (`src/secrets/effect/`) — `SecretsLive`; typed `E`: `SecretsNoCredentials` (on `requireAuth`) + `SecretsRefreshTarget`. **Decision (operator):** absence *is* a typed error on the Effect surface; `getAuth`/the `SecretsResolver` port return `undefined` for absence (not a typed error). The four audited store verbs (`get`/`set`/`refresh`/`remove`) are async + block-on-failure (4.2-A1): each awaits its audit emit so a persist failure fails the originating op, with the mutating verbs emitting before they commit. `getAuth` therefore returns `Promise<AuthInput | undefined>` and the executor awaits it; an audit-persist failure surfaces as an Effect defect, not a typed `E`. OAuth `onRefresh` stays plain-async at the pi-ai edge, awaiting the async store refresh mid-call.
- **Config** (`src/config/effect/`) — reactive `ConfigLive`. **Decisions (C1/C2/C3):** `SubscriptionRef<S>` is the state cell (`.changes` exposed for Phase 4, **not** consumed yet); `watch()` + audit stay on the **`TypedEmitter`** (the only path carrying `{key,previous,current,source}` — `SubscriptionRef.changes` can't, so it can *not* be the audit source); `writeQueue` + deep-equals kept; tag non-generic, `S` via closure.
- **Catalog** (`src/catalog/effect/`) — `CatalogLive`; typed `E`: `requireAgent` → `CatalogAgentNotFound`. Legacy mutation verbs still throw `AgentNotFoundError` (`server/routes.ts` narrows on it). **Scope calls:** the file watcher (shared `createTieredManifestStore`) was **not** Stream-ified (out of scope); parse errors stay collected-as-data + trace-logged (skips, not failures).
- **ThreadsLive** — deferred here (pure sync CRUD, no error-channel win; see Phase 2), then built in §4.x for uniformity over the shared root `HiveDb`.

---

## Phase 4 — Edges, cross-cutting, and cleanup (NEXT)

**Start here: settle the gating decision before writing code.**

### 4.0 — `TypedEmitter` → Effect `PubSub`/`Stream`? ✅ RESOLVED → [ADR-0012](adr/0012-event-bus-typed-emitter-vs-effect-pubsub.md)

**Decision: keep `TypedEmitter`; do not migrate the bus to `PubSub`/`Stream`; do not migrate it piecemeal.** The bus already serves two consumers with opposite failure semantics by listener convention — Audit (block-on-failure, ADR-0004) and the `/api/events` SSE relay (drop-on-failure, `src/server/routes.ts:491-502`) — which a standard `PubSub` does not give for free. The `{key, previous, current, source}` audit contract keeps flowing through `Config.events` unchanged (Phase 3a proved `SubscriptionRef.changes` can't carry it). No consumer needs bounded buffering or replay today. Revisit trigger (ADR-0012): a consumer that genuinely needs back-pressure, replay, or Effect-native interruption through emit. Until then, leave the bus alone — Audit (§4.2) migrates its internals only, still consuming `TypedEmitter` via `wireSubscriptions`.

### 4.1 — Server as the Layer composition root

`createServer()` (`src/server/index.ts`) becomes the `Layer` composition + the single `ManagedRuntime` owner, replacing the per-module `ManagedRuntime`s the proxies create today. Hono handlers stay async at the edge and run effects through the runtime (SSE routes consume `Stream`). Adapter-selection by `mode: "file" | "memory"` stays at the root (its job — not an R-leak). This is where the per-module proxies start to collapse into one runtime.

### 4.2 — Audit (last)

Subscriber + SQLite writer; nearly pure I/O edge. **Migrated (4.2-C):** `AuditLive` is an Effect-native `Context.Service` + scoped `Layer` (`src/audit/effect/audit-live.ts`) behind the unchanged `createAudit()` `ManagedRuntime` proxy; `createServer()` resolves `Audit` off the single root runtime, so the audit DB handle (which nothing closed pre-4.2) now closes on `runtime.dispose()`. The persist path stays **synchronous** — `Effect.sync`/`Effect.try`, **not** `Effect.tryPromise` (bun:sqlite is sync, and the per-event listener stays a direct sync `persist` call so a throw stays on `emit`'s stack — block-on-failure). No new typed `E` (a normalizer/persist throw must bubble as its original value); `AuditSvc` is the clean legacy surface (`attach`/`query`/`subscriptions`), the DB handle captured in the layer closure. Redaction backstop, microsecond wall-clock `ts` (`b567214`), and monotonic `seq` preserved verbatim.

**Block-on-failure gap (closed — 4.2-A1 / A2 / B done).** The audited **Secrets** and **Runs** emits previously used `void events.emit(...)` while wired to Audit, so an audit-persist failure silently did **not** fail the originating op, and the side effect committed *before* the discarded emit (audit-first ordering broken) — a violation of ADR-0004's block-on-failure invariant. Closed in three slices:

- **4.2-A1 / A2** — the audited Secrets (`src/secrets/store.ts`) and Runs (`src/runs/executor.ts`) emits are now `await`-ed, emit-before-commit, so a persist failure fails the originating op. Regression tests attach a throwing audit subscriber and assert the op fails leaving no committed mutation.
- **4.2-B** — a project-wide, **non-suppressible** no-floating-promises guard so a `void`-ed audited emit cannot recur, split across two mechanisms because neither alone covers the directive:
  - **Biome 2.4.16** `linter.rules.nursery.noFloatingPromises: "error"` **plus `linter.domains.types: "all"`** (the rule no-ops without the domain). Type-aware; stops future *bare* floats. Biome treats `void p` as valid, so it cannot forbid the `void <promise>` form on its own.
  - **`scripts/check-no-floating-suppressions.ts`** (raw TS compiler API) is the enforcer for what Biome won't: it exits 1 on any `void <promise>` expression or any `biome-ignore lint/nursery/noFloatingPromises` suppression. Run via `bun run check:no-float`.
  - Both are **scoped to `src/` + `scripts/`** (`biome.json` `files.includes`; the script walks both roots, gating the gate dir itself) so the type scanner stays off the `shell/`/`ui/`/`bundled/` broken-import corpus. A repo-wide `.gitattributes` (`* text=auto eol=lf`) pins every text file to LF so the AST scanner sees stable line endings on Windows checkouts. A tracked `.githooks/pre-commit` (wired via the package.json `prepare` script) runs `check:no-float` + `biome check` on every commit.

The *external-edit* config reload (`src/config/store.ts`, `source:"external"`) is a **conscious exemption**, not a block-on-failure fix — its `fs.watch` callback can't `await` and the external edit is already committed (no op to block), so it de-floats with an explicit `.catch` + loud trace-log (`log().error`, handled-not-suppressed). The gateway/registry adapter emits and the legacy-proxy `dispose()` calls (Secrets/Catalog/Config) likewise de-float to trace `.catch`, not audit — they are not audited sources. ADR-0004 stays intact; ADR-0012 *Known gap* records the now-shipped guard.

### 4.3 — Delete the proxies (done — partial, by design)

Production is fully migrated: `createServer()` resolves every migrated service (`Config`/`Secrets`/`Catalog`/`Audit` + `HiveDb`) off the single root `ManagedRuntime` (§4.1b); no production code calls a `createX()` proxy. The proxies' only remaining consumers are the modules' plain-async **legacy-surface test suites**, which this plan explicitly permits keeping a proxy for.

- **`createCatalog()` — DELETED.** Its last consumer was a single audit-subscriptions test, migrated to `CatalogLive` + a `ManagedRuntime`; `src/catalog/index.ts` is now a pure re-export barrel. (`src/catalog/catalog.ts`'s `createCatalog`/`buildCatalog` is the real factory `CatalogLive` builds on — not a proxy, not deleted.)
- **`createSecrets()` / `createConfig()` / `createAudit()` — RETAINED**, each with an in-code `Retained (§4.3)` note. Each is depended on by a whole plain-async legacy-surface suite (`secrets/__tests__/index.test.ts`; `config/__tests__/{store,persistence}.test.ts`; `audit/__tests__/{audit,subscriptions}.test.ts`). Force-migrating those suites to the `XLive` layers is a larger, separate effort; per this plan's allowance the proxies stay until then.

**End-state, honestly:** the *production* end-state is reached — no proxy on any production path; `src/` has no plain-async outside the I/O-edge adapters and these three test-only proxies. The literal "no proxy remains" is **deferred** to a future test-migration pass. **Do not migrate** the trace logger — `src/lib/log.ts` stays a call-site singleton by existing design (AGENTS.md). `ThreadsLive` (§4.x) was built for uniformity — the last module brought onto the root runtime.

### 4.x — ThreadsLive (done — Phase 4 complete)

`ThreadsLive` (`src/threads/effect/threads-live.ts`) is the final module brought onto the root runtime. It is the deliberate odd-one-out: it owns **no** sqlite handle. Unlike the other Lives it does not `acquireRelease` a connection — it **depends on** the root `HiveDb` tag, yields that shared handle from context, and builds the `ThreadsStore` over it. So its layer type is `Layer.Layer<Threads, never, HiveDb>` — the `HiveDb` requirement is a genuine shared root resource, discharged at the root, not a leaked `R`.

- **One connection, proven.** The root binds `const dataLayer = HiveDbLive(dbPath)` **once** and uses that same layer *value* both in `Layer.mergeAll` (HiveDb stays exposed for the unmigrated Runs path) and on the Threads branch via `ThreadsLive().pipe(Layer.provide(dataLayer))`. Because it is one value, `ManagedRuntime` memoizes it: exactly one `hive.db` connection shared by Threads + Runs; `runtime.dispose()` closes it once. `threads-live.test.ts` proves this — a thread created via `Threads` is visible through a store over the SAME resolved `HiveDb` handle, and after `dispose()` that handle is closed.
- **Combinator (D2, with API-map correction).** Chosen: bound `dataLayer` value + plain `Layer.provide`. `Layer.provideMerge` **does** exist in `effect@4.0.0-beta.75` (`node_modules/effect/dist/Layer.d.ts`) — an earlier note that it was absent was stale; `provideMerge` would just re-add `HiveDb` to the union (redundant here, since `dataLayer` already exposes it). The bound-value + plain `provide` is the minimal one-connection form.
- **No typed `E` (D1).** Threads is pure synchronous CRUD with no port-level precondition a consumer narrows on, so `ThreadsSvc = ThreadsStore` verbatim — no Effect-returning verbs. (Contrast Catalog, which earned `requireAgent`/`CatalogAgentNotFound` because the executor narrows on a missing agent.) The one throw (`ThreadNotFoundError`, inside the `append` transaction) surfaces unchanged.
- **Legacy `createThreads()` — DELETED.** Its only consumer was `createServer()`, now wired through `ThreadsLive`; every test uses `createThreadsStore` directly. `src/threads/index.ts` is now a re-export barrel (keeps the `Threads` type alias, `ThreadNotFoundError`, and the row/input types), mirroring the §4.3 catalog barrel.

---

## Self-review checks (run continuously)

- [ ] Every phase leaves the **full suite green** (coexistence invariant).
- [ ] No migrated module leaks an `R` to the root for a dep it can satisfy itself (`HiveDb` is the canonical test).
- [ ] No `any` / `as any` / `as unknown as` introduced (AGENTS.md) — including in interop helpers.
- [ ] Each migrated port is **narrow and consumer-owned**, not a mirror of the provider's full surface.
- [ ] Domain outcomes (a Run's `run.failed`) stay **events**; only infrastructure failures move into `E`.
