# Adopt Effect-TS as the daemon substrate

## What this ADR records

The decision to adopt **Effect-TS (`effect`, the latest v4 line — beta as of 2026)** as the default substrate for all daemon source (`src/`), the **coexistence mechanism** that lets it land incrementally without breaking the existing plain-async test suite, and the **migration ordering**. AGENTS.md "Architecture defaults" already states the posture as a convention; this ADR records the underlying trade so the decision is reversible-with-context rather than folklore. The execution sequence lives in [docs/effect-migration-plan.md](../effect-migration-plan.md); the LLM-transport corner of it is [ADR-0010](0010-llm-transport-pi-ai-retained.md).

## Context

The daemon is a functional-core modular monolith in plain-async TypeScript: `createX(opts)` factories returning handle types, wired by hand in one composition root, [createServer()](../../src/server/index.ts). Dependency injection is manual `Deps` objects; errors are a mix of thrown exceptions and in-band event payloads; cancellation is hand-rolled `AbortController` bookkeeping.

Two recurring costs motivated the change:

- **Untyped, dual error paths.** The same failure reaches a caller two ways. The Run executor wraps `gateway.complete()` in a `try/catch` *and* inspects in-stream `error` events, reconciling them by hand ([runs/executor.ts](../../src/runs/executor.ts), comment "gateway.complete threw out of band"). Nothing in a signature says what can fail.
- **DI threaded wide.** Every dependency — including shared infrastructure like the one SQLite handle Threads and Runs both use — is passed through the composition root explicitly. There is no boundary at which a module discharges its own internals.

Effect addresses both directly: the typed `E` channel makes failure part of the signature, and `Layer`/`Context` makes DI a typed requirement (`R`) discharged at module boundaries. The bet rides the `effect` core itself — not the AI package; LLM transport stays on pi-ai per [ADR-0010](0010-llm-transport-pi-ai-retained.md), deferred there for an auth gap that is independent of which `effect` version we run.

**This repo is an architecture playground, not a production system.** Its purpose is to exercise the current paradigm and learn from it. That reframes the version trade-off below: staying on the newest line is the goal, and beta churn is an accepted — even useful — forcing function, not a risk to minimize.

## Decision

Adopt `effect` as the substrate for daemon source, incrementally.

- **Adopt the latest line (`effect` v4, currently beta); stay current, accept breakage.** Because this is a playground (above), the usual "load-bearing seams ride stable cores" posture is *deliberately overridden for this repo only* — were this production, v3 would be the call. Adopting v4 now also avoids a later v3→v4 bump on a greenfield Effect surface. Contain the beta risk operationally: pin an exact beta (`effect@4.0.0-beta.N`), bump deliberately and revert a bad bump rather than working around it, rely on v4's single-version package rule (every `@effect/*` shares the same beta number), and keep `effect/unstable/*` usage conscious (those paths may break in minors; non-`unstable` follows semver). Zod stays the boundary validator (AGENTS.md), so the largest v4 breaking surface — the Schema overhaul — does not touch this repo. Take v4's rewritten runtime and unified package system now rather than deferring them.
- **Typed `E` + `Layer`/`Context` DI, discharged at the module boundary.** A module's public service exposes a clean interface and provides its own dependencies when building its `Layer`; `R` is not leaked to the root for deps a module can satisfy itself. Errors are values in `E` with a semantic taxonomy owned at the port (Effect gives the channel, not the meaning).
- **Plain async only at I/O edges.** Thin interop adapters at true external boundaries (Hono, Drizzle/`bun:sqlite`, pi-ai, filesystem, Electron) wrap with `Effect.tryPromise` / `Stream.fromAsyncIterable` and return Effect/Stream inward. Domain and application code is never plain async.
- **Coexistence, never big-bang.** A single `ManagedRuntime`, built from the migrated modules' `Layer`s at the composition root, is the one place effects are run. Each migrated module keeps a **thin legacy proxy** — its existing `createX()`/handle shape, implemented by running the Effect service through the runtime — so unmigrated consumers and the existing plain-async tests keep working unchanged. Modules migrate one at a time; the proxy is deleted when the last consumer migrates. This mirrors the published fp-ts→Effect coexistence pattern (parallel companion APIs over a `ManagedRuntime`), adapted to plain-async→Effect.
- **Order by subdomain.** **Core** first — the ModelGateway seam, then the Run executor (the highest-gain pair, and the slice the `spike/effect-runs-gateway` branch already names). **Supporting** modules (Secrets, Config, Threads, Catalog, Capabilities) follow as their consumers need typed contracts. **Generic/infrastructure** (the `hive.db` opener, Hono routes, the trace logger) is wrapped at the edge, not migrated — the trace logger stays a call-site singleton by existing design. Whether the cross-cutting `TypedEmitter` event bus becomes Effect `PubSub`/`Stream` is a separate decision, not settled here.

## Consequences

- **The floor to contribute rises**, accepted deliberately for one bright-line paradigm that is uniform for human and agent contributors, versus a case-by-case async/Effect boundary that is worse than either consistent choice.
- **The composition root changes role.** [createServer()](../../src/server/index.ts) becomes the `Layer` assembly + `ManagedRuntime` owner; HTTP handlers stay async at the edge and run effects through the runtime.
- **Semi-irreversible.** Once core modules are Effect-native, reverting means re-threading manual DI and un-typing errors across the most-trafficked seams. That is the point of recording it here.
- **Tests are preserved through coexistence**, then migrated per module — the large plain-async suite is never broken in one sweep.
- **Beta breakage is expected and absorbed, not avoided.** A `effect` beta bump that breaks the build is pinned-and-reverted; the playground context (above) is what makes that acceptable. When v4 graduates to its stable LTS, the "bump" is just dropping the pin from a beta to the release.
- **Revisit triggers:** the typed-error win fails to materialize in the gateway→runs slice (the Phase-1 gate in the plan), which would argue for narrowing the adoption rather than continuing; or coexistence proxies measurably outlive their usefulness (a sign the ordering is wrong); or this repo's playground status changes (e.g. it starts backing something real), at which point the v4-beta bet should be re-examined against stability.

## Alternatives considered

- **Stay plain-async.** Rejected: the dual error path and wide DI are recurring, not incidental, and compound as backends (tool-loop re-runs, multiple Agent Backends) multiply through the gateway seam.
- **Full `@effect/ai` stack.** Deferred in [ADR-0010](0010-llm-transport-pi-ai-retained.md) — no subscription/OAuth auth, alpha maturity.
- **Big-bang rewrite.** Rejected: higher risk for no incremental value; published large-scale migrations (≈500k LOC, ~10% time, coexistence throughout) converted module-by-module instead. The repo's own architecture default ("migrate one at a time, never big-bang") encodes the same conclusion.
- **Pin the stable v3 line.** Rejected *for this repo*: it optimizes for production stability this playground does not need, and incurs a later v3→v4 bump on code we are writing greenfield right now. The playground goal is to live on the current paradigm. (In a production repo this would invert — v3 would be the responsible choice, and the beta risk above would be disqualifying.)
