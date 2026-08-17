# Durable `npx-skills` bundle deployment

## Goal

Hive installs, updates, verifies, and removes `npx-skills` bundles through its durable Deploy flow. Archify must work for Claude and Codex when Hive runs on the daemon machine, including the Arca topology. Plugins and `setup-script` bundles remain manual.

## Why this is a separate deployment kind

File-backed capabilities have bytes that Hive can stage and hash. An `npx-skills` bundle instead delegates ownership to the `skills` CLI, which maintains a canonical skill copy plus per-agent registrations. Hive therefore cannot safely model removal as deleting `verify_paths`: removing one target that way could damage another target or leave the CLI's lock state stale.

Hive already has the subprocess port, bundle metadata reader, and legacy `npx skills add` implementation. The durable planner currently omits every plugin and bundle, and its staged-operation schema keeps installer tasks only as rejected legacy records. This change promotes only the deterministic `npx-skills` subset into durable tasks.

## Considered approaches

1. **Invoke `agent-kit` from Hive.** This reuses behavior but creates two competing deployment ledgers and bypasses Hive's accepted-plan, per-target outcome, and recovery boundaries.
2. **Copy or delete the declared paths directly.** This is simple but breaks `skills` CLI ownership and cannot correctly remove one agent registration while retaining another.
3. **Stage typed `npx-skills` operations and invoke the `skills` CLI through Hive's existing exec port.** This preserves one authority, snapshots reviewed inputs, and permits postcondition-based recovery. This is the selected approach.

## Capability contract

An automatically managed `npx-skills` bundle declares the exact upstream source and exact installed skill names:

```yaml
installer:
  kind: npx-skills
  package: tt-a1i/archify@2.10.0
  skills:
    - archify
verify_paths:
  claude:
    - ~/.claude/skills/archify
  codex:
    - ~/.agents/skills/archify
```

`installer.skills` is the list passed to both `skills add --skill` and `skills remove`. `verify_paths` is normalized to a per-target list and supplies the postcondition. Both are required for automatic management; an older or incomplete declaration stays visible as manual instead of guessing ownership.

The schema remains a lenient superset outside these load-bearing fields. Package, skill names, and paths are data arguments passed without a shell. Paths must be absolute-home paths under the selected agent homes after expansion; traversal and paths outside those homes are rejected.

The three `npx-skills` bundles in `my-agent-kits`—Archify, HyperFrames, and Slidev—will adopt this explicit contract. Their package references and vendored upstream capabilities will be refreshed independently in `my-agent-kits` before Hive integration is verified.

## Planning and staging

The authoritative Overview observes each declared verification path per target. A managed bundle is:

- `add` when selected and Hive has no successful applied record;
- `update` when its source content or normalized installer metadata changed, or any expected path is missing;
- `remove` when a removal intent exists and Hive Deployment State or the interoperable Ledger records ownership for that target;
- `in_sync` only when its applied metadata matches and all expected paths exist.

The canonical plan token covers the action, target, Source/ContentSha, normalized package, skill names, verification paths, and pre-deploy observation. Staging re-reads the winning Mirror, validates that metadata against the plan, and persists a typed task containing all execution inputs. Execution never re-reads a mutable Source.

Plugins, `setup-script` bundles, and malformed/incomplete `npx-skills` bundles remain excluded from plan actions and retain the current manual status.

## Execution

For each target, Hive invokes the existing argument-array exec port with the daemon's redirected child environment:

```text
npx -y skills add <package> --global --agent <claude-code|codex>
  --skill <name> [--skill <name> ...] --yes

npx -y skills remove <name> [<name> ...] --global
  --agent <claude-code|codex> --yes
```

Install and update succeed only when the command exits zero and every target verification path exists. Removal succeeds only when the command exits zero and every target verification path is absent. A missing `npx`, nonzero exit, or failed postcondition produces a per-target failure while unrelated file-backed tasks continue.

The successful normalized metadata hash is stored as the applied `renderedHash`; the package spec is stored as the bundle pin in the interoperable Ledger. A successful removal clears that target's private record/removal intent and removes the bundle from the Ledger only when no owned target remains.

Installer output is bounded and sanitized before any failure detail is persisted. Hive never invokes a shell and never interpolates Source metadata into a command string.

## Crash recovery

`skills add` and targeted `skills remove` are treated as convergent operations. Before invoking either command, and again after a daemon restart, Hive checks the staged postcondition:

- an unfinished add/update whose paths are already present is completed without rerunning;
- an unfinished removal whose paths are already absent is completed without rerunning;
- otherwise Hive reruns the exact staged command and verifies again.

Already journaled successes are revalidated before Ledger recovery just like file tasks. A changed postcondition becomes `recovery_state_changed`, preserving the prior successful deployment fact while recording the failed recovery attempt. No operation is declared successful from an exit code alone.

## User experience

Eligible `npx-skills` rows participate in the normal reviewed Deploy diff and destructive-removal confirmation. Their status uses the existing pending, in-sync, and failed states. The manual-install/removal banners continue to list only unsupported plugins, `setup-script` bundles, and incomplete legacy metadata.

## Verification

Tests use the injectable exec and filesystem ports; they never contact npm or GitHub and never modify real agent homes.

- Capability schema: valid explicit metadata, multiple skills/paths, unsafe or incomplete declarations.
- Planner: add, metadata update, missing-path repair, per-target removal, and manual fallback for unsupported installers.
- Coordinator: exact argv/environment, postcondition checks, bounded failures, Ledger/Deployment State updates, mixed file-plus-bundle best effort.
- Recovery: crash before command, crash after effect but before journal, and changed postcondition before Ledger finalization.
- Route/UI: Archify is deployable for Claude and Codex, no manual banner when eligible, and removal is reviewed/destructive.
- Integration fixture: a fake `npx` creates/removes the declared Archify paths for both redirected homes and proves install → in-sync → remove.

Production readiness is the normal Hive release workflow after merge. The user will validate the released Mac app against the external Arca daemon.
