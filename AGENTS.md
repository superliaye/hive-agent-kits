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

Two distinct stores, two distinct purposes — don't conflate them.

**Audit** = what users and agents did. Tool calls, permission decisions, secret accesses, harness edits, Run completions. SQLite-backed, retained, queryable. Uses a subscribe pattern: modules emit typed events as side effects; the Audit module subscribes and persists. Audit is never directly called — there is no `audit.record(...)` API. When you write code that does something user-visible (mutates state, makes a decision, invokes a capability), think about whether the relevant event is being emitted from the module's internal write path. Never put sensitive values in event payloads — refs, not values.

**Trace** = system diagnostics. Parse errors, watcher events, daemon startup chatter, performance counters. JSONL via Pino at `~/.hive/logs/daemon.log`. *No* subscribe pattern — modules import the `log()` singleton from `src/lib/log.ts` and write at the call site with full context: `log().warn({ module, path, err }, "skipped malformed manifest")`. `console.log`/`console.warn`/`console.error` in non-test source code is wrong; use the trace logger.

The line: was a user or agent the proximate cause of this event? If yes → audit. If no (the system observed something during normal operation) → trace.

See [ADR-0004](docs/adr/0004-audit-log-design.md) for the full design — "Audit vs trace" section, event types, transaction semantics, redaction backstop, retention.

### Style

- TypeScript strict. **`any` is forbidden.** `as unknown as` and `as any` are forbidden. Ask before silencing a type problem.
- Zod at every external boundary (HTTP body, MCP responses, manifests, audit payloads).
- Terse comments. Default to no comment; write one only when the *why* is non-obvious. Don't explain what the code does — names should.
- No emojis. No excessive praise. Direct and objective.

### Vocabulary discipline

When introducing or sharpening a domain term during design discussion, update `CONTEXT.md` immediately — don't batch. Don't couple `CONTEXT.md` to implementation details (file paths, schemas). Domain-meaningful terms only.

### ADR discipline

Write an ADR only when all three are true: hard to reverse, surprising without context, the result of a real trade-off. Skip otherwise. ADRs live in [docs/adr/](docs/adr/), sequentially numbered, next-number = highest + 1.

## Running the app

Two intended workflows. Agent: **do not** invoke either of these from the Bash tool — see the `run-app` skill at [.claude/skills/run-app/SKILL.md](.claude/skills/run-app/SKILL.md) for the PowerShell-tool path, common failures (`ELECTRON_RUN_AS_NODE`, port orphans, the `&&`-chain bug), and verification snippets.

### Debug (interactive, HMR)

```
bun run dev:full
```

Opens three visible terminals — daemon (`bun --watch`), Vite (UI HMR), Electron (loaded from Vite). Close any window to stop that piece. Daemon writes to `~/.hive/`. To stop everything, close all three windows.

### Ship (production .msi / .dmg / .AppImage)

```
bun run ship
```

Builds UI, compiles daemon to a single binary, runs `electron-builder`. Installer output goes to `shell/release/`. After install, the user double-clicks the Hive icon — Electron spawns the bundled daemon as a hidden child, no terminal involved.

## Git conventions

- One-line subject preferred. No emojis.
- Never `--no-verify`, `--no-edit`, `--no-gpg-sign`. If a hook fails, fix the underlying issue.
- Confirm before destructive ops (`reset --hard`, `push --force`, branch delete) — even in auto mode.

## Where decisions live

| Kind | Where |
|---|---|
| Domain vocabulary | `CONTEXT.md` |
| Hard-to-reverse architectural | `docs/adr/NNNN-*.md` |
| Repo conventions (this file) | `AGENTS.md` |
| Subtree-specific conventions | `src/<module>/AGENTS.md` (lazily, when warranted) |

Prefer the more specific location: subtree AGENTS.md over root; ADR over AGENTS.md when the decision is structural.
