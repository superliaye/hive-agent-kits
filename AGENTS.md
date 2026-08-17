# AGENTS.md

Repo conventions for AI coding agents working in this repo.

## Read first (in this order)

1. [CONTEXT.md](CONTEXT.md) — domain vocabulary. Every term used in design discussion is defined there. **Use these terms exactly.** Don't substitute "AI assistant", "service", "boundary", etc.
2. [docs/adr/](docs/adr/) — architectural decisions, numbered chronologically. Read the highest-numbered ones first.

## What Hive is

A capability deploy-manager over **N user-added Sources**: git repositories of Capabilities that conform to Hive's capability format (ADR-0024). The user adds a Source by URL, toggles it on/off, or deletes it; Hive syncs each active Source at runtime and deploys selected Capabilities into the CLI homes of Claude Code and Codex (`~/.claude/`, `~/.codex/`, `~/.agents/`), with control + visibility on top (ADR-0023). The capability **format** SSOT is the `capability-schema` package (ADR-0024) — not a single library. The deploy **contract** (how bytes land in those homes) still matches `agent-kit`, validated against a pinned reference clone. Hive's own AI-conversation scenarios are deferred (#2 — ADR-0021). Full vocabulary in CONTEXT.md.

## Repo layout

A Bun workspace: deployable units live under `packages/*` — `daemon` (`@hive/daemon`, source in `packages/daemon/src/`; the capability deploy-manager lives in `packages/daemon/src/kit/`), `ui` (`@hive/ui`), `shell` (`@hive/shell`), `contract` (`@hive/contract`, shared kit + backend + source wire schemas — Zod, daemon-independent), `capability-schema` (`@hive/capability-schema`, the pure zod-only SSOT for Hive's capability format — types + Zod schemas + format-version, no fs/http/exec/Effect — ADR-0024), and `theming` (`@hive/theming`, the portable React theming module that owns the appearance schema; its React-free `@hive/theming/schema` subpath is what the daemon consumes — ADR-0022). There is no longer a `packages/daemon/bundled/` (the app syncs each Source at runtime) and no `capabilities/`, `catalog/`, `runs/`, or `threads/` daemon modules (the agent-running stack is parked as deferred #2 — ADR-0021). Root `package.json` is orchestration-only; one root `bun.lock`. See [ADR-0020](docs/adr/0020-monorepo-workspace-layout.md).

## Reference projects (architecture sources, not clones)

- **my-agent-kits** — `github.com/superliaye/my-agent-kits`, local clone `D:\GitRepos\my-agent-kits`. Reference **content** — a Source like any other, pasteable by URL (ADR-0024). It is **not** the capability-format authority: the format SSOT is the `capability-schema` package. What is still validated against this clone is the deploy **contract** — how bytes land in the CLI homes (`lib/deploy.js`, `lib/agents.js`, `lib/manifest.js`), plus the catalog/preset *shapes* the `kit` module parses from `lib/capabilities.js` / `lib/presets.js`. **Verified against pinned SHA `525479f29322d3d3b872d47f6cc2ef130add02e7`** (upstream has no usable release/tag — only `main` — so always re-validate the contract against this pinned clone, never from memory). Re-pin the SHA here whenever the deploy contract is re-checked.
- **OpenClaw** — `github.com/openclaw/openclaw`, local clone `E:\dev\GitRepos\openclaw` (mostly informs deferred #2).
- **Hermes Agent** — `github.com/NousResearch/hermes-agent`, local clone `E:\dev\GitRepos\hermes-agent` (mostly informs deferred #2).
- **work-claw** — internal Microsoft project; `docs/inventory-workclaw.md` is a *feature wishlist*, not an architectural source.

## Always keep in mind

### Audit vs trace awareness

Two distinct stores; don't conflate them.

**Audit** = what the user did. In the deploy-manager (#1) the user action is a **Deploy**: one `source:'deploy'` row per Deploy, `run_id`/`agent_id` null, payload a refs-only allow-list (`{kitSha, perKindCounts, targetClis}`) — never file contents or secrets. SQLite-backed, retained, queryable. Subscribe pattern — the deploy path emits a typed event as a side effect; the Audit module subscribes and persists. (The old Run-path SDK-adapter emitter is gone with the agent-running stack — ADR-0021; the **deploy** path is the live audit emitter now.) Never called directly (no `audit.record(...)` API). When your code does something user-visible, check the relevant event is emitted from the module's internal write path. Refs, not values. (Governance/permission enforcement is deferred — ADR-0019, retained by ADR-0021.)

**Trace** = system diagnostics: parse errors, watcher events, daemon startup chatter, perf counters. JSONL via Pino at `~/.hive/logs/daemon.log`. *No* subscribe pattern — import the `log()` singleton from `packages/daemon/src/lib/log.ts` and write at the call site with full context: `log().warn({ module, path, err }, "skipped malformed manifest")`. `console.log`/`.warn`/`.error` in non-test source is wrong; use the trace logger.

Decision: was a user or agent the proximate cause? Yes → audit. No (system observed it during normal operation) → trace.

See [ADR-0004](docs/adr/0004-audit-log-design.md) for the full design: event types, transaction semantics, redaction backstop, retention.

### Style

- TypeScript strict. **`any` is forbidden.** `as unknown as` and `as any` are forbidden. Ask before silencing a type problem.
- Zod at every external boundary (HTTP body, MCP responses, manifests, audit payloads).
- Terse comments. Default to no comment; write one only when the *why* is non-obvious. Don't explain what the code does — names should.
- No emojis. No excessive praise. Direct and objective.

### Architecture defaults

Apply without asking when writing or reviewing daemon code; deviations need a stated reason. Guiding rule: spend complexity on **seams and contracts** (the expensive-to-reverse lines); keep the boxes thin.

**Effect-TS is the default substrate** for all daemon source (`packages/daemon/src/`).

- **Typed error channel.** Errors are values in `E`. No `throw` of untyped errors, no stringly-typed handling. Effect gives the channel, not the meaning — own the *semantic* error taxonomy at your ports (e.g. the gateway's `GatewayErrorCode`); edges map into it.
- **DI via `Layer`/`Context`.** No hidden globals, no wide constructor-threading.
- **Discharge DI at the module boundary.** A module's public service (`Context.Tag`) exposes a clean interface and provides its own dependencies when building its `Layer`. Never leak `Requirements` (`R`) to the composition root for deps a module can satisfy itself.
- **Plain async only at I/O edges.** Thin interop adapters at true external boundaries (Hono, Drizzle, pi-ai, filesystem, Electron) wrap with `Effect.tryPromise` / `Stream.fromAsyncIterable` and return Effect/Stream inward. Domain and application code is never plain async.
- **Adopt incrementally.** Default for new code; migrate existing modules one at a time, never big-bang. (A large plain-async test suite remains — don't break it in one sweep.)

**Deep, hexagonal, modular — not academic DDD.**

- **Ports-and-adapters with deep modules.** Narrow, *consumer-owned* ports shaped to the consumer's need; the providing module / Config / external system is the adapter. Configuration is infrastructure behind a port — not a wide dependency, not a global.
- **Modular monolith, functional core.** Vertical slices under `packages/daemon/src/<module>/`; hexagonal layers are *roles* (domain / application / adapter / infrastructure), not folders. A data record plus its module's factory verbs is a healthy functional core.
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

## Checks

- **Type-check:** `bun run typecheck` — fans out `tsc --noEmit` across every workspace member with a `typecheck` script (`daemon`, `ui`, `shell`, `contract`, `theming`) via Bun-workspace `--filter`. `contract` and `theming` ship runtime Zod schemas (a `zod` dependency) and own their own type-checks and `bun test` suites — they are not types-only. Run a single package with `bun run typecheck` inside it.
- **Test:** `bun test`. **Lint:** `bun run check` (Biome). **Format:** `bun run format` (Biome, writes).

## Where decisions live

| Kind | Where |
|---|---|
| Domain vocabulary | `CONTEXT.md` |
| Hard-to-reverse architectural | `docs/adr/NNNN-*.md` |
| Repo conventions (this file) | `AGENTS.md` |
| Subtree-specific conventions | `packages/daemon/src/<module>/AGENTS.md` (lazily, when warranted) |

Prefer the more specific location: subtree AGENTS.md over root; ADR over AGENTS.md when the decision is structural.
