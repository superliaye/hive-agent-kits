# AGENTS.md

Repo conventions for AI coding agents working in this repo.

## Read first (in this order)

1. [CONTEXT.md](CONTEXT.md) — domain vocabulary. Every term used in design discussion is defined there. **Use these terms exactly.** Don't substitute "AI assistant", "service", "boundary", etc.
2. [docs/adr/](docs/adr/) — architectural decisions, numbered chronologically. Read the highest-numbered ones first.
3. Subtree `AGENTS.md` (e.g., `src/runs/AGENTS.md`) when working in that subtree, if it exists.

## What Hive is

A portable personal AI system. Capabilities carry an origin tag: Personal travels with the user; Workplace stays at the company. Two-sentence pitch; full vocabulary in CONTEXT.md.

## Reference projects (architecture sources, not clones)

- **OpenClaw** — `github.com/openclaw/openclaw`, local clone `E:\dev\GitRepos\openclaw`.
- **Hermes Agent** — `github.com/NousResearch/hermes-agent`, local clone `E:\dev\GitRepos\hermes-agent`.
- **work-claw** — internal Microsoft project; `docs/inventory-workclaw.md` is a *feature wishlist*, not an architectural source.

## Always keep in mind

### Audit vs trace awareness

Two distinct stores; don't conflate them.

**Audit** = what users and agents did: tool calls, permission decisions, secret accesses, harness edits, Run completions. SQLite-backed, retained, queryable. Subscribe pattern — modules emit typed events as side effects; the Audit module subscribes and persists. Never called directly (no `audit.record(...)` API). When your code does something user-visible (mutates state, makes a decision, invokes a capability), check the relevant event is emitted from the module's internal write path. Refs, not values — never put sensitive values in payloads.

**Trace** = system diagnostics: parse errors, watcher events, daemon startup chatter, perf counters. JSONL via Pino at `~/.hive/logs/daemon.log`. *No* subscribe pattern — import the `log()` singleton from `src/lib/log.ts` and write at the call site with full context: `log().warn({ module, path, err }, "skipped malformed manifest")`. `console.log`/`.warn`/`.error` in non-test source is wrong; use the trace logger.

Decision: was a user or agent the proximate cause? Yes → audit. No (system observed it during normal operation) → trace.

See [ADR-0004](docs/adr/0004-audit-log-design.md) for the full design: event types, transaction semantics, redaction backstop, retention.

### Style

- TypeScript strict. **`any` is forbidden.** `as unknown as` and `as any` are forbidden. Ask before silencing a type problem.
- Zod at every external boundary (HTTP body, MCP responses, manifests, audit payloads).
- Terse comments. Default to no comment; write one only when the *why* is non-obvious. Don't explain what the code does — names should.
- No emojis. No excessive praise. Direct and objective.

### Architecture defaults

Apply without asking when writing or reviewing daemon code; deviations need a stated reason. Guiding rule: spend complexity on **seams and contracts** (the expensive-to-reverse lines); keep the boxes thin.

**Effect-TS is the default substrate** for all daemon source (`src/`).

- **Typed error channel.** Errors are values in `E`. No `throw` of untyped errors, no stringly-typed handling. Effect gives the channel, not the meaning — own the *semantic* error taxonomy at your ports (e.g. the gateway's `GatewayErrorCode`); edges map into it.
- **DI via `Layer`/`Context`.** No hidden globals, no wide constructor-threading.
- **Discharge DI at the module boundary.** A module's public service (`Context.Tag`) exposes a clean interface and provides its own dependencies when building its `Layer`. Never leak `Requirements` (`R`) to the composition root for deps a module can satisfy itself.
- **Plain async only at I/O edges.** Thin interop adapters at true external boundaries (Hono, Drizzle, pi-ai, filesystem, Electron) wrap with `Effect.tryPromise` / `Stream.fromAsyncIterable` and return Effect/Stream inward. Domain and application code is never plain async.
- **Adopt incrementally.** Default for new code; migrate existing modules one at a time, never big-bang. (A large plain-async test suite remains — don't break it in one sweep.)

**Deep, hexagonal, modular — not academic DDD.**

- **Ports-and-adapters with deep modules.** Narrow, *consumer-owned* ports shaped to the consumer's need; the providing module / Config / external system is the adapter. Configuration is infrastructure behind a port — not a wide dependency, not a global.
- **Modular monolith, functional core.** Vertical slices under `src/<module>/`; hexagonal layers are *roles* (domain / application / adapter / infrastructure), not folders. A data record plus its module's factory verbs is a healthy functional core.
- **Skip tactical-DDD ceremony.** No aggregates-with-methods, no four-folder layering for its own sake, no abstraction for a single forever-adapter. Add a value object / domain service only where it earns its place.
- **Keep strategic DDD.** Ubiquitous language (`CONTEXT.md`), bounded contexts, the typed relationships between them. Spend modeling effort on **Core** subdomains; build **Supporting** plainly; buy/wrap **Generic** ones.

LLM transport stays on pi-ai wrapped in Effect at the adapter; `@effect/ai` is deferred. See [ADR-0010](docs/adr/0010-llm-transport-pi-ai-retained.md).

### Vocabulary discipline

When introducing or sharpening a domain term during design discussion, update `CONTEXT.md` immediately — don't batch. Don't couple `CONTEXT.md` to implementation details (file paths, schemas). Domain-meaningful terms only.

### ADR discipline

Write an ADR only when all three are true: hard to reverse, surprising without context, the result of a real trade-off. Skip otherwise. ADRs live in [docs/adr/](docs/adr/), sequentially numbered, next-number = highest + 1.

## Running the app

- **Dev (run the app):** `pwsh -NoProfile -File scripts/dev.ps1` via the **PowerShell tool** — not the Bash tool, not `bun run`. `-DaemonOnly` for the API alone.
- **Ship (build only):** `bun run ship` — any shell.

Why these invocations, failure modes, and internals: the **`run-app` skill** ([.claude/skills/run-app/SKILL.md](.claude/skills/run-app/SKILL.md)) and the script headers.

## Where decisions live

| Kind | Where |
|---|---|
| Domain vocabulary | `CONTEXT.md` |
| Hard-to-reverse architectural | `docs/adr/NNNN-*.md` |
| Repo conventions (this file) | `AGENTS.md` |
| Subtree-specific conventions | `src/<module>/AGENTS.md` (lazily, when warranted) |

Prefer the more specific location: subtree AGENTS.md over root; ADR over AGENTS.md when the decision is structural.
