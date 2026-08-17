# Durable `npx-skills` Bundle Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hive durably install, update, verify, and remove explicitly declared `npx-skills` bundles such as Archify for Claude and Codex.

**Architecture:** Normalize the load-bearing bundle metadata into one daemon module, include eligible bundles in the authoritative plan, and persist complete argument-array installer tasks in accepted operations. Execute through the existing injected subprocess port and decide success/recovery from declared filesystem postconditions rather than exit code alone.

**Tech Stack:** TypeScript, Bun, Zod, Hono, React, Vitest/Bun test, `npx skills` CLI.

**Spec:** `docs/superpowers/specs/2026-08-16-durable-npx-skills-design.md`

## Global Constraints

- Automate only `installer.kind: npx-skills`; plugins and `setup-script` bundles remain manual.
- Automatic bundles must declare exact `installer.skills` and per-target `verify_paths`.
- Execute argument arrays without a shell and with the daemon's redirected child environment.
- Install/update require zero exit plus all paths present; removal requires zero exit plus all paths absent.
- Persist bounded, redacted error details and per-target outcomes.
- No test may invoke a real installer or write real agent homes.

---

### Task 1: Ratify and normalize managed bundle metadata

**Files:**
- Modify: `packages/capability-schema/src/kinds/bundle.ts`
- Modify: `packages/capability-schema/src/kinds/bundle.test.ts`
- Create: `packages/daemon/src/kit/deploy/npx-bundle.ts`
- Create: `packages/daemon/src/kit/deploy/npx-bundle.test.ts`
- Modify: `packages/daemon/src/kit/deploy/sources.ts`

**Interfaces:**
- Produces: `ManagedNpxBundleMeta`, `managedNpxBundleMeta(mirrorRoot, name)`, `managedNpxBundleHash(meta, target)`, `probeManagedNpxBundle(targets, meta, target)`.
- Consumes: existing YAML reader, `DeployTargets`, and SHA-256 helper.

- [ ] **Step 1: Write schema tests proving `installer.skills` accepts a non-empty unique string list, `verify_paths` accepts string or non-empty string-list values, and incomplete legacy declarations remain schema-valid but ineligible for automation.**

```ts
expect(BundleFrontmatter.safeParse({
  description: "archify",
  installer: { kind: "npx-skills", package: "tt-a1i/archify@2.10.0", skills: ["archify"] },
  verify_paths: { claude: ["~/.claude/skills/archify"], codex: "~/.agents/skills/archify" },
}).success).toBe(true);
```

- [ ] **Step 2: Run the focused schema test and confirm the new assertions fail.**

Run: `bun test packages/capability-schema/src/kinds/bundle.test.ts`

- [ ] **Step 3: Extend `NpxSkillsInstaller` and bundle-level `verify_paths` validation without making management fields mandatory for Source conformance.**

```ts
skills: z.array(z.string().min(1)).min(1).optional()
verify_paths: z.record(z.enum(["claude", "codex"]), z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
])).optional()
```

- [ ] **Step 4: Write daemon tests for eligible metadata, missing fields, unsafe paths, stable hashes, and all-present/all-absent/mixed probes in redirected homes.**

- [ ] **Step 5: Implement `npx-bundle.ts`; normalize and sort skills/paths, require `~/` paths beneath the target's allowed skill roots, and return `null` for unsupported/incomplete metadata.**

```ts
export type ManagedNpxBundleMeta = {
  package: string;
  skills: string[];
  verifyPaths: Record<DeployTarget, string[]>;
};
```

- [ ] **Step 6: Run focused schema/metadata tests and commit.**

```bash
bun test packages/capability-schema/src/kinds/bundle.test.ts packages/daemon/src/kit/deploy/npx-bundle.test.ts
git add packages/capability-schema/src/kinds/bundle.ts packages/capability-schema/src/kinds/bundle.test.ts packages/daemon/src/kit/deploy/npx-bundle.ts packages/daemon/src/kit/deploy/npx-bundle.test.ts packages/daemon/src/kit/deploy/sources.ts
git commit -m "feat: define managed npx bundle metadata"
```

### Task 2: Plan and display eligible bundle reconciliation

**Files:**
- Modify: `packages/daemon/src/kit/overview.ts`
- Modify: `packages/daemon/src/kit/deploy-plan.ts`
- Modify: `packages/daemon/src/kit/__tests__/overview.test.ts`
- Modify: `packages/daemon/src/kit/__tests__/deploy-plan.test.ts`

**Interfaces:**
- Consumes: Task 1 metadata/hash/probe functions.
- Produces: add/update/remove `DeployPlanAction` entries for eligible bundles; unsupported installer rows retain manual states.

- [ ] **Step 1: Add failing Overview/plan tests for Archify add, in-sync, missing-path repair, metadata update, one-target removal, and manual fallback.**

```ts
expect(plan.actions).toContainEqual(expect.objectContaining({
  action: "add",
  key: { kind: "bundle", name: "archify" },
  target: "claude",
}));
```

- [ ] **Step 2: Run the focused tests and confirm eligible bundles remain manual.**

Run: `bun test packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts`

- [ ] **Step 3: Capture real path observations and metadata hashes for eligible bundles in `wouldDeployArtifacts`; retain recorded/unverified observations for unsupported installers.**

- [ ] **Step 4: Include eligible bundle selections/removal intents in `buildDeployPlan`; require private or Ledger ownership for removal and keep plugins/setup-script bundles filtered.**

- [ ] **Step 5: Update Overview reconciliation so eligible bundles use normal pending/in-sync/failed states and only unsupported rows use manual labels.**

- [ ] **Step 6: Run focused tests and commit.**

```bash
bun test packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts
git add packages/daemon/src/kit/overview.ts packages/daemon/src/kit/deploy-plan.ts packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts
git commit -m "feat: plan managed npx bundle reconciliation"
```

### Task 3: Execute and recover durable installer tasks

**Files:**
- Modify: `packages/daemon/src/kit/deploy-operations.ts`
- Modify: `packages/daemon/src/kit/deploy-coordinator.ts`
- Modify: `packages/daemon/src/kit/deployment-state.ts`
- Modify: `packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts`

**Interfaces:**
- Consumes: eligible plan actions and Task 1 normalized metadata.
- Produces: persisted `StagedNpxBundleTask`, exact add/remove argv, postcondition verification, Ledger pins, and restart reconciliation.

- [ ] **Step 1: Add failing staged-schema and coordinator tests for exact add/remove argv, missing `npx`, nonzero exit, failed postcondition, mixed deploy continuation, and successful Ledger/Deployment State finalization.**

```ts
expect(exec).toHaveBeenCalledWith({
  command: "npx",
  args: ["-y", "skills", "add", "tt-a1i/archify@2.10.0", "--global", "--agent", "claude-code", "--skill", "archify", "--yes"],
}, expect.any(Object));
```

- [ ] **Step 2: Run focused coordinator/store tests and confirm staging rejects the bundle.**

Run: `bun test packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts`

- [ ] **Step 3: Replace the legacy skipped bundle task with a versioned persisted task containing action, package, skills, paths, pin, source/content hashes, and metadata hash; preserve parsing of old skipped tasks.**

```ts
const StagedManagedNpxBundleTask = z.object({
  type: z.literal("npx-bundle"),
  action: z.enum(["add", "update", "remove"]),
  key: z.object({ kind: z.literal("bundle"), name: z.string() }),
  target: DeployTarget,
  package: z.string(),
  skills: z.array(z.string()).min(1),
  verifyPaths: z.array(z.string()).min(1),
  pin: z.string(),
  sourceId: z.string().nullable(),
  contentSha: z.string().nullable(),
  renderedHash: z.string(),
});
```

- [ ] **Step 4: Stage eligible tasks from immutable Mirror metadata and execute via `execInstaller`; probe before and after, cap/redact stderr, and journal each target outcome.**

- [ ] **Step 5: Teach recovery validation and Ledger/Deployment State finalization about the new task; an already-satisfied postcondition succeeds without rerunning, otherwise recovery retries exact staged argv.**

- [ ] **Step 6: Run focused tests and commit.**

```bash
bun test packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts packages/daemon/src/kit/deployment-state.test.ts
git add packages/daemon/src/kit/deploy-operations.ts packages/daemon/src/kit/deploy-coordinator.ts packages/daemon/src/kit/deployment-state.ts packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts
git commit -m "feat: execute durable npx bundle operations"
```

### Task 4: Prove route and UI behavior with Archify-shaped fixtures

**Files:**
- Modify: `packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`
- Modify: `packages/ui/src/pages/KitDeployPage.tsx`
- Modify: `packages/ui/src/__tests__/kit-deploy-confirm.test.tsx`

**Interfaces:**
- Consumes: normal plan and reconciliation states from Tasks 2–3.
- Produces: reviewed install/removal UX without manual banners for eligible bundles.

- [ ] **Step 1: Replace the blanket-manual fixture assertion with tests that an explicit Archify-shaped bundle installs for redirected Claude/Codex homes, becomes in-sync, then removes one target through fake `npx`.**

- [ ] **Step 2: Add UI tests that eligible bundle actions appear in Deploy confirmation, removal uses the destructive confirmation, and unsupported installers remain in manual banners.**

- [ ] **Step 3: Run tests and confirm they fail against the current banner logic.**

Run: `bun test packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts packages/ui/src/__tests__/kit-deploy-confirm.test.tsx`

- [ ] **Step 4: Filter manual banners by reconciliation state and render eligible rows through existing diff/action components without a new UI state.**

- [ ] **Step 5: Run focused route/UI tests and commit.**

```bash
bun test packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts packages/ui/src/__tests__/kit-deploy-confirm.test.tsx
git add packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts packages/ui/src/pages/KitDeployPage.tsx packages/ui/src/__tests__/kit-deploy-confirm.test.tsx
git commit -m "test: verify managed npx bundles end to end"
```

### Task 5: Refresh `my-agent-kits` metadata and upstream content

**Files:**
- Modify: `/home/leon.ye/my-agent-kits/capabilities/bundles/{archify,hyperframes,slidev,gstack}.bundle.md`
- Modify: upstream-tracked `SKILL.md`/`SOURCE.md` files whose recorded revision differs from current upstream.
- Modify: `/home/leon.ye/my-agent-kits/package.json`
- Modify: `/home/leon.ye/my-agent-kits/CHANGELOG.md`
- Test: `/home/leon.ye/my-agent-kits/test/cases/{archify,hyperframes,slidev,gstack}-bundle.sh`

**Interfaces:**
- Produces: pinned current upstream references and explicit `installer.skills`/list-valued `verify_paths` consumed by Hive.

- [ ] **Step 1: Create a clean branch from `origin/main`; enumerate every capability with `upstream:`/`SOURCE.md` and every bundle source, compare recorded refs with upstream default-branch/release refs, and record the exact before/after table in the commit message.**

- [ ] **Step 2: Refresh only changed upstream bodies while preserving local frontmatter, names, includes, and documented adaptations; update `upstream_version`, dates, package specs, and gstack commit pin.**

- [ ] **Step 3: Add explicit metadata to all `npx-skills` bundles.**

```yaml
installer:
  kind: npx-skills
  package: tt-a1i/archify@2.10.0
  skills: [archify]
verify_paths:
  claude: [~/.claude/skills/archify]
  codex: [~/.agents/skills/archify]
```

- [ ] **Step 4: Bump the kit patch version and changelog, then run each changed capability's isolated case and the deploy/roundtrip suite required by `AGENTS.md`.**

Run: `AGENT_KIT_TEST_HOST=1 bash test/run-tests.sh`

- [ ] **Step 5: Commit, push a branch, create/merge a PR into remote main after checks, and capture the merge SHA.**

### Task 6: Final verification, merge, and release readiness

**Files:**
- Modify only files required by failures found in the focused verification.

**Interfaces:**
- Consumes: refreshed public `my-agent-kits` main and completed Hive implementation.
- Produces: merged Hive main and a production release containing the fix.

- [ ] **Step 1: Point the Archify route fixture at the final metadata shape and run schema, daemon, route, UI, lint/typecheck, and ship gates relevant to changed packages.**

```bash
bun test packages/capability-schema/src/kinds/bundle.test.ts
bun test packages/daemon/src/kit/deploy/npx-bundle.test.ts packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts
bun test packages/ui/src/__tests__/kit-deploy-confirm.test.tsx
bun run check
bun run check:no-float
```

- [ ] **Step 2: Inspect the complete diff against `origin/main`, run `git diff --check`, and verify no fixture, generated artifact, dependency directory, or unrelated change is tracked.**

- [ ] **Step 3: Push the branch, create a PR, wait for required checks, merge to main, and record the merge SHA.**

- [ ] **Step 4: Monitor the public production release workflow until the merge SHA has a published stable artifact or report the exact external blocker.**

- [ ] **Step 5: Provide the user the production `hive-arca` command and an Archify install → in-sync → remove smoke sequence for the released build.**
