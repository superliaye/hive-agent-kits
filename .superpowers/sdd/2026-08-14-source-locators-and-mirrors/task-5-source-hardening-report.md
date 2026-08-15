# Task 5 addendum — Source acquisition hardening report

Date: 2026-08-15

Branch: `feat/arca-remote-capability-control`

Baseline: `d42b568`

## Result

All four parked acquisition/Mirror findings are closed with independent behavioral regressions. Git timeout escalation survives early leader/pipe completion, selected-subpath lazy hydration is HTTPS-only, working-tree parent directories are pinned by filesystem identity, and startup cleanup preserves stages owned by another live Daemon while reclaiming abandoned remnants.

## Root-cause traces and TDD evidence

### 1. Post-grace process-group KILL

Root cause: `git-process.ts` scheduled `SIGKILL` after timeout `SIGTERM`, but its `finally` block cleared that timer. A TERM-handling leader could exit while a TERM-resistant descendant closed inherited stdout/stderr; `child.exited` and both pipe reads then completed before the grace period, canceling the only group escalation.

Regression: a direct-argv `git` fixture exits its leader on TERM while a descendant ignores TERM and closes both captured pipes. The assertion waits beyond the 100 ms grace and requires the descendant PID to be gone.

RED:

```text
bun test packages/daemon/src/kit/__tests__/git-source.test.ts --test-name-pattern 'still kills a TERM-resistant descendant after the Git leader and pipes exit'

Expected function to throw; Received value: true
0 pass, 1 fail, 27 filtered out
```

Fix: keep the scheduled group KILL alive after normal collection/failure settlement. Stream-reader faults still send an immediate KILL and cancel the redundant timer. The timer remains referenced for its bounded 100 ms lifetime, while successful commands never create it and are not delayed.

GREEN:

```text
1 pass, 0 fail, 27 filtered out
```

The first implementation awaited the grace timer before rejecting; focused coverage caught that this weakened the existing closed-stdout deadline. The final implementation lets the timeout promise reject promptly while retaining the independent KILL timer. Both related regressions are green (`2 pass, 0 fail`).

### 2. HTTPS-only selected-subpath lazy hydration

Root cause: raw blob `cat-file` calls already carried `protocol.allow=never`, `protocol.https.allow=always`, and `GIT_ALLOW_PROTOCOL=https`, but selected-object `cat-file -t` used the generic Git runner with only the Daemon environment. In a partial clone, that lookup may lazily contact the promisor remote and honor an ambient `url.*.insteadOf` rewrite.

Regression: capture the exact selected-subpath type lookup and require both command-line protocol overrides plus the environment allowlist.

RED:

```text
bun test packages/daemon/src/kit/__tests__/git-source.test.ts --test-name-pattern 'protects selected-subpath lazy hydration with the HTTPS-only Git policy'

Expected to contain: "protocol.allow=never"
Received: ["-C", "<cache>", "cat-file", "-t", "<commit>:capabilities"]
0 pass, 1 fail, 28 filtered out
```

Fix: lift the existing HTTPS-only argv/environment construction into shared helpers and opt the selected `cat-file -t` call into the same network-capable policy. Daemon `HOME` remains inherited and `productionGitProcess` still adds `GIT_TERMINAL_PROMPT=0` without a shell.

GREEN:

```text
1 pass, 0 fail, 28 filtered out
```

### 3. Same-path working-tree parent replacement

Root cause: `validateSourcePath` recorded only `realpathSync(dirname(source))`; `unchangedParent` later compared canonical strings. Replacing a directory with byte-identical contents at the same path preserved Git status, entry fingerprints, and the string identity, so acquisition accepted the new inode.

Regression: after the capture read, atomically rename the original parent away and put a byte-identical directory at the same path. The acquisition must fail with stable `working_tree_changed` rather than commit the replacement.

RED:

```text
bun test packages/daemon/src/kit/__tests__/working-tree.test.ts --test-name-pattern 'rejects a same-path parent directory inode replacement during capture'

Expected WorkingTreeAcquireError; Received value: undefined
0 pass, 1 fail, 12 filtered out
```

Fix: record canonical path plus `dev`/`ino`, compare that identity after each entry read, and retain the first identity for every encountered parent across capture verification and the bounded retry. A replaced parent therefore reaches the existing race mapping and ends as `working_tree_changed`; ownership and allowlisted-root checks remain unchanged.

GREEN:

```text
1 pass, 0 fail, 12 filtered out
```

### 4. Cross-Daemon extraction-stage cleanup

Root cause: `sweepStaleTmp` recursively removed every `extract-*` entry at startup. Stage names carried no owner/liveness identity, so a second Daemon sharing the runtime root deleted another live Daemon's acquisition stage.

Regression: a separate live Bun process owns an extraction-stage name. Startup cleanup must retain that stage while removing a legacy abandoned stage and a malformed owner remnant.

RED:

```text
bun test packages/daemon/src/kit/__tests__/mirror-recovery.test.ts --test-name-pattern "startup cleanup preserves another live Daemon's stage and removes abandoned remnants"

Expected live stage existence: true
Received: false
0 pass, 1 fail, 4 filtered out
```

Fix: centralize all tar, local, Git, and working-tree stage creation under `extract-owner-<pid>-<random>` names. Startup cleanup performs a constant-time PID liveness probe per owned entry, treats `EPERM` as alive, preserves live-owner stages, and best-effort removes dead-owner, legacy, or malformed remnants without parsing unbounded metadata.

GREEN:

```text
1 pass, 0 fail, 4 filtered out
```

## Focused suites

```text
bun test packages/daemon/src/kit/__tests__/git-source.test.ts packages/daemon/src/kit/__tests__/working-tree.test.ts packages/daemon/src/kit/__tests__/mirror-recovery.test.ts

47 pass, 0 fail, 124 expect() calls; 3 files
```

## Full verification

The first `bun run verify` invocation stopped at Biome before typecheck/tests because two new expressions needed formatter-only line wrapping. Those exact formatting changes were applied; the complete rerun was green:

```text
bun run verify

check:no-float: exit 0
biome check: Checked 208 files. No fixes applied.
typecheck: all 9 workspace packages exited 0
test:manifest-interop: exit 0
bun test: 1092 pass, 3 skip, 0 fail, 3888 expect() calls; 117 files
```

## Files changed

- `packages/daemon/src/kit/acquisition/git-process.ts`
- `packages/daemon/src/kit/acquisition/git-source.ts`
- `packages/daemon/src/kit/acquisition/working-tree.ts`
- `packages/daemon/src/kit/mirror.ts`
- `packages/daemon/src/kit/__tests__/git-source.test.ts`
- `packages/daemon/src/kit/__tests__/working-tree.test.ts`
- `packages/daemon/src/kit/__tests__/mirror-recovery.test.ts`
- `.superpowers/sdd/2026-08-14-source-locators-and-mirrors/task-5-source-hardening-report.md`

## Self-review and concerns

- Reviewed every production/test hunk and confirmed the changes stay inside Git process/acquisition, working-tree identity, and Mirror-stage cleanup.
- Confirmed successful Git processes create no escalation timer; timed/budget failures keep the 100 ms KILL guarantee without weakening the existing fast settlement regression.
- Confirmed every production extraction-stage creator uses the new owned-stage helper; manually pre-populated stages accepted by `commitStagedMirror` remain supported.
- Confirmed same-path replacements fail through the existing stable retry/error taxonomy and last-good Mirror commit point is unchanged.
- Owner PID reuse can conservatively retain an abandoned stage while an unrelated process holds the reused PID. This biases cleanup toward preserving possibly-live data; a later startup after that PID exits reclaims it.
