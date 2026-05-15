# AGENTS.md

Repo conventions for AI coding agents (Codex, Claude Code, Cursor, Aider, Windsurf, …) and humans. Model-agnostic — the canonical source. `CLAUDE.md` is a copy for Claude Code compatibility; if you edit one, sync both.

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

### Audit awareness

Hive's Audit Log records operations across modules — tool calls, permission decisions, secrets access, MCP lifecycle, memory writes, agent lifecycle, backend invocations. **Audit uses a subscribe pattern: modules emit typed events as side effects; the Audit module subscribes and persists. Audit is never directly called — there is no `audit.record(...)` API.**

When you write code that does something auditable (mutates state, makes a decision, invokes a capability), think about whether the relevant event is being emitted from the module's internal write path. If a module doesn't yet expose an event stream for the kind of thing you're doing, add one.

Never put sensitive values in event payloads. Refs, not values. Keys, not values. See [ADR-0004](docs/adr/0004-audit-log-design.md) for the full design — event types, transaction semantics, redaction backstop, retention.

### Style

- TypeScript strict. **`any` is forbidden.** `as unknown as` and `as any` are forbidden. Ask before silencing a type problem.
- Zod at every external boundary (HTTP body, MCP responses, manifests, audit payloads).
- Terse comments. Default to no comment; write one only when the *why* is non-obvious. Don't explain what the code does — names should.
- No emojis. No excessive praise. Direct and objective.

### Vocabulary discipline

When introducing or sharpening a domain term during design discussion, update `CONTEXT.md` immediately — don't batch. Don't couple `CONTEXT.md` to implementation details (file paths, schemas). Domain-meaningful terms only.

### ADR discipline

Write an ADR only when all three are true: hard to reverse, surprising without context, the result of a real trade-off. Skip otherwise. ADRs live in [docs/adr/](docs/adr/), sequentially numbered, next-number = highest + 1.

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
