# Pivot to a capability deploy-manager for my-agent-kits

status: accepted
supersedes: ADR-0019, ADR-0009, ADR-0013, ADR-0014, ADR-0015
supersedes-in-part: ADR-0007

## What this ADR records

Hive is re-founded from a personal AI **agent** system into a **capability
deploy-manager** for the [my-agent-kits](https://github.com/superliaye/my-agent-kits)
upstream repo (the **Kit**). The app no longer vendors a stale copy of upstream
skills and runs its own Agents; it **syncs** the latest Kit at runtime and
**deploys** selected **Capabilities** into the **CLI homes** (`~/.claude/`,
`~/.codex/`, `~/.agents/`) exactly the way the `agent-kit` wizard does — adding
control, visibility, and easy reconfigure on top.

Priority #1 (this change): manage + deploy my-agent-kits Capabilities at scale.
Priority #2 (deferred, rebuilds from zero): Hive's own AI conversations whose
Harness is composed from these Capabilities. The agent-running stack is **deleted**,
not migrated — parked as #2 in `CONTEXT.md`'s deferred section.

## The deploy-manager design

**Sync (tarball, by full SHA).** The latest `main` SHA is resolved via the GitHub
commits API, then the archive is downloaded **by that full 40-hex SHA** from
codeload (never `/main`) so the recorded provenance and the extracted tree are
byte-identical. Extraction strips the single top-level archive entry by reading
its first path component (content-derived, not hard-coded), then atomically
rename-swaps into a private **Mirror** under the Hive home, retaining the prior
mirror until the new one is in place. Sync failures are a typed error channel
(`offline` / `rate_limited` / `parse` / `io`) and keep last-good; a failed check
surfaces as "check failed" / "rate-limited," never "up to date." Chosen over a
`git clone`: byte-exact, atomic, no git dependency. Upstream has no usable
release/tag — `main` tip is the only source, so there is no SHA/tag pinning at the
app level (out of scope).

**Deploy (native, full fidelity).** The deploy engine reproduces the upstream
contract verified against a pinned my-agent-kits clone (see AGENTS.md "Reference
projects"): skills recursive-copied to both CLI homes (filtering `_unshipped/` +
`SOURCE.md`, expanding snippet includes, emitting the Codex manual-only sidecar);
agents written verbatim for Claude and translated to Codex TOML (model + tools
dropped); instructions concatenated into a **whole-file overwrite** of
`CLAUDE.md` / `AGENTS.md`; plugins + bundles installed via external CLIs.

**Deliberate trade-offs:**

- **CLAUDE.md whole-file ownership.** Instructions overwrite the entire
  `CLAUDE.md` / `AGENTS.md` (full upstream fidelity). To soften the blast radius,
  the engine backs up any existing file to `<file>.hive-bak` before overwrite,
  and the **Deploy Diff** flags replacement of a non-Kit (user-authored)
  instruction file before the user applies.
- **External-installer exec.** Plugin (`claude plugin …`) and bundle
  (`git clone`/`./setup`, `npx skills add …`) deploys shell out to external
  package managers — the pivot explicitly contradicts ADR-0007's "Hive is not a
  package manager." The blast radius is contained behind a consumer-owned
  **deploy-target port** that produces a **redirected child-process environment**
  for every exec (`CLAUDE_CONFIG_DIR`, `HOME`/`USERPROFILE`, npm prefix), with a
  guard that refuses to run a real installer unless the child env is redirected or
  a skip-env hatch is set. The real `~/.claude` is never touched under test.
- **Partial-deploy best-effort.** Kinds apply in order; each collects a per-kind
  result; the Ledger is written to reflect **what actually landed**, not the
  intended Selection. Re-deploy is idempotent.
- **Two-writer Ledger.** The **Deployment Ledger** (`~/.agent-kit/manifest.json`)
  is a shared interop file (Hive + the `agent-kit` CLI), reused at the CLI's exact
  schema. Writes are concurrency-safe read-modify-merge; reconcile-prune re-reads
  the on-disk ledger immediately before deciding, and prunes only freshly-confirmed
  Hive-owned skill/agent names. Plugins and bundles are **never** auto-removed
  (hint only).

**Audit posture.** A deploy is a user action → one audit row, `source: 'deploy'`,
`run_id`/`agent_id` null, payload a refs-only allow-list `{kitSha, perKindCounts,
targetClis}` (ADR-0004 redaction). Sync diagnostics are system observations →
trace (`~/.hive/logs/daemon.log`). Governance stays deferred — the deploy runs
under no permission enforcement (retained posture from ADR-0019).

## Supersession

- **Supersedes ADR-0019** — the CLI-only agent runtime (Run-runtime / SDK-adapter
  / capability-MCP / skill-projection) is removed. The chain 0019 already owns
  (0005, 0010, 0016, 0017, and 0015-in-part) stays dead; **0016 is not re-marked**
  (already Superseded by 0019).
- **Supersedes ADR-0009, 0013, 0014, 0015** — the now-codeless Run pipeline,
  per-agent model defaults, conversation lifecycle, and selection-resolution
  decisions.
- **Supersedes-in-part ADR-0007** — the two-tier bundled storage, the "Inclusion
  principle" of vendoring into `bundled/`, and "No CLI install path / Hive is not
  a package manager." The pivot syncs an upstream at runtime and execs external
  package managers. The Capability **lifecycle** vocabulary 0007 introduced is
  otherwise retained conceptually.
- **ADR-0003 is marked Deferred** (not Superseded) — its Capability-layer vision
  returns with #2.

**Retained from ADR-0019:** `AgentBackend = claude-code | codex` (now the deploy
targets) and the governance-deferred posture.

**Survivors untouched:** 0002, 0004, 0006, 0008, 0011, 0012, 0020.

## Out of scope (deferred)

User-authored / downloaded Capabilities (customization); Hive's own agent
conversations consuming Capabilities (#2); SHA/tag pinning (always `main` tip);
periodic background polling / auto-deploy (auto *check* only); a preset editor.
