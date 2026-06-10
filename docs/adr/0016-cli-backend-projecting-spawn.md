# CLI-driven backends: projecting spawn, assembled config, and detect-not-manage

---
status: proposed
---

## What this records

How a `claude-code` / `codex` (CLI-driven) **Agent Backend** Run is composed, how the Agent's bound Capabilities reach the CLI, and how Hive discovers and manages CLI installs. The backend kinds were defined in [ADR-0003](0003-capability-layer-design.md)/[ADR-0005](0005-model-gateway-design.md) and CONTEXT but never built.

## Decision

**Projecting spawn, not thin spawn.** Before spawning the CLI, Hive **projects** the Agent's bound **Skills** into the CLI's native skill format and injects the authored prompt as the CLI's instructions; the CLI's *own* progressive disclosure then matches them — Hive runs no skill disclosure on this path. v1 projects **skills + prompt only**; Tool and MCP projection are deferred. (Thin spawn — bare CLI with only identity + Memory — was rejected: it discards Hive's portable-Capability thesis.)

**Config is assembled, not authored.** A Worker agent authored for `native` has no CLI config block. Hive composes the CLI invocation at Run start from: the conversation's model/effort selection ([ADR-0015](0015-selection-resolution-model.md)), the projected prompt + skills, the CLI's own auth injected from **Secrets**, defaulted knobs (permission mode, env), and the resolved **Working Directory**. Nothing requires the Agent Manager to pre-author a per-backend config.

**Working Directory** resolves per Run: a per-conversation choice → the Agent's default → a per-Agent `~/.hive` workspace. This carries two patterns from one mechanism: *bound-to-a-repo* (Agent default = repo root; a CLI started there inherits that repo's *own* committed skills/MCP/conventions, composing with the projected portable skills) and *aim-per-conversation* (no Agent default; point each Thread at a repo, or a parent dir for cross-repo work).

**No repo pollution.** Projected skills are written to a Hive-owned / user-level location, never into the working directory's repo. So the repo's committed `.claude/` config is inherited in place and *composes* with Hive's projected portable capabilities — two layers that never touch.

**Detect, don't manage.** A backend availability probe (doctor-style, stable reason codes — the OpenClaw pattern) detects installed CLIs and versions at daemon startup and on demand; the picker offers only available backends and shows the detected version. Hive is **not a package manager**: "upgrade" delegates to each CLI's own updater and re-probes; a missing CLI surfaces install guidance. Management lives in a distinct **"Backends"** settings surface — not merged into Secrets (a CLI binary is not a secret, though it may consume one).

## Why

Projecting spawn is the only option consistent with Hive's reason to exist (portable capabilities that travel with the user). Building cross-platform install/upgrade is a large Generic-subdomain surface with little Hive-specific value — delegating to each CLI's updater spends complexity on the seam (projection + assembly) instead. The no-pollution boundary keeps user repos clean and lets repo-local and portable capabilities coexist.
