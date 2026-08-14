# Source Locators and Mirrors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize an exact git revision/subpath or allowlisted Daemon-host working tree as a safe, last-good capability-kit Mirror.

**Architecture:** Source identity becomes a normalized locator. Dedicated acquisition ports stage selected trees into temporary directories, validate budgets and links, then atomically replace only the Source's Mirror while preserving previous good content on failure.

**Tech Stack:** TypeScript, Zod, Bun.spawn, Git partial clone/fetch, filesystem staging, Bun test

**Spec:** `docs/superpowers/specs/2026-08-14-arca-remote-capability-control-design.md`

## Global Constraints

- Git commands run directly without a shell, preserve Daemon `HOME`, and add `GIT_TERMINAL_PROMPT=0`.
- Stored git URLs are credential-free HTTPS; track refs are fully qualified; pins are full 40-hex commits.
- Selected subpath is the Mirror root; no full-history fallback, submodules, LFS smudge, checkout hooks, or external filters.
- Working trees must be owned by the Daemon uid and contained in configured allowlisted Git roots.
- Failed acquisition never replaces the last-good Mirror.

---

### Task 1: Locator wire contract, normalization, and registry migration

**Files:**
- Modify: `packages/contract/src/source.ts`
- Test: `packages/contract/src/source.test.ts`
- Modify: `packages/daemon/src/sources/types.ts`
- Modify: `packages/daemon/src/sources/persistence.ts`
- Modify: `packages/daemon/src/sources/store.ts`
- Test: `packages/daemon/src/sources/__tests__/persistence.test.ts`
- Test: `packages/daemon/src/sources/__tests__/store.test.ts`

**Interfaces:**
- Produces: `SourceLocator`, `AddSourceBody = { label; locator }`, `normalizeLocator(locator)`, `locatorIdentity(locator)`.
- Produces persisted `SourcesFile` version `2` with monotonically increasing `revision`.

- [ ] **Step 1: Write failing locator and migration tests**

```ts
expect(SourceLocator.safeParse({ kind: "git", repoUrl, revision: { mode: "track", ref: "main" }, subpath: "." }).success).toBe(false);
expect(locatorIdentity(a)).not.toBe(locatorIdentity({ ...a, subpath: "experimental/leon-ye_data/agent-kits" }));
expect(readSourcesFile(v1)).toEqual({
  version: 2,
  revision: 0,
  sources: [{ ...legacy, label: legacy.origin, locator: { kind: "git", repoUrl: legacy.origin, revision: { mode: "track", ref: "refs/heads/main" }, subpath: "." } }],
});
```

- [ ] **Step 2: Run contract/store tests**

Run: `bun test packages/contract/src/source.test.ts packages/daemon/src/sources/__tests__/persistence.test.ts packages/daemon/src/sources/__tests__/store.test.ts`

Expected: FAIL on missing locator schemas and version migration.

- [ ] **Step 3: Add the discriminated locator schema**

```ts
export const SourceLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starter") }),
  z.object({
    kind: z.literal("git"),
    repoUrl: GitHttpsUrl,
    revision: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("track"), ref: z.string().regex(/^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/) }),
      z.object({ mode: z.literal("pin"), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
    ]),
    subpath: SafeRelativeSubpath,
  }),
  z.object({ kind: z.literal("working-tree"), repoRoot: z.string().min(1), subpath: SafeRelativeSubpath }),
]);
```

- [ ] **Step 4: Migrate and revise registry commits**

Every mutating store commit writes `{ version: 2, revision: previous.revision + 1, sources }`. Duplicate checks compare canonical `locatorIdentity`, not repository URL alone.

- [ ] **Step 5: Run focused tests**

Run: `bun test packages/contract/src/source.test.ts packages/daemon/src/sources/__tests__/persistence.test.ts packages/daemon/src/sources/__tests__/store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit locator persistence**

```bash
git add packages/contract/src/source* packages/daemon/src/sources
git commit -m "feat: persist revisioned source locators"
```

### Task 2: Dedicated Git acquisition port

**Files:**
- Create: `packages/daemon/src/kit/acquisition/git-process.ts`
- Create: `packages/daemon/src/kit/acquisition/git-source.ts`
- Create: `packages/daemon/src/kit/acquisition/tree-guard.ts`
- Test: `packages/daemon/src/kit/__tests__/git-source.test.ts`

**Interfaces:**
- Produces: `GitProcess.run(args, opts): Promise<GitResult>` with stable failure codes.
- Produces: `acquireGitSource(locator, destination, limits): Promise<GitProvenance>`.
- Produces: `TreeLimits = { maxFiles: 20_000; maxBytes: 268_435_456; timeoutMs: 120_000 }`.

- [ ] **Step 1: Write failing temporary-repository acquisition tests**

```ts
const provenance = await acquireGitSource(locatorFor(remote, "refs/heads/main", "kits/personal"), destination, TEST_LIMITS);
expect(readFileSync(join(destination, "capabilities/@smoke/skills/arca-smoke/SKILL.md"), "utf8")).toContain("name: arca-smoke");
expect(existsSync(join(destination, "kits"))).toBe(false);
expect(provenance.requestedRevision).toEqual({ mode: "track", ref: "refs/heads/main" });
expect(provenance.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);
```

- [ ] **Step 2: Run the Git acquisition test**

Run: `bun test packages/daemon/src/kit/__tests__/git-source.test.ts`

Expected: FAIL because acquisition modules do not exist.

- [ ] **Step 3: Implement bounded cache and subtree export**

Run these argv arrays through `GitProcess`, serialized per normalized repository URL:

```ts
["init", "--bare", cachePath]
["-C", cachePath, "config", "extensions.partialClone", "origin"]
["-C", cachePath, "fetch", "--filter=blob:none", "--no-tags", "--depth=1", repoUrl, requestedRef]
["-C", cachePath, "rev-parse", "FETCH_HEAD^{commit}"]
["-C", cachePath, "archive", "--format=tar", `${commit}:${subpath}`]
```

Use a controlled tar extractor that rejects absolute paths, `..`, special files, and symlinks escaping the staged root; count bytes/files before accepting. Pin mode fetches the exact commit with the same depth/filter constraints and fails `missing_ref` only after repository access succeeds.

- [ ] **Step 4: Add failure taxonomy and no-fallback tests**

```ts
await expectFailure(missingPrivateRepo, "auth_or_repository_unavailable");
await expectFailure(missingSubpath, "invalid_subpath");
await expectFailure(overBudgetTree, "budget_exceeded");
expect(process.calls.some((call) => call.args.includes("clone"))).toBe(false);
expect(process.calls.every((call) => call.env.HOME === daemonHome)).toBe(true);
```

- [ ] **Step 5: Run focused tests**

Run: `bun test packages/daemon/src/kit/__tests__/git-source.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Git acquisition**

```bash
git add packages/daemon/src/kit/acquisition packages/daemon/src/kit/__tests__/git-source.test.ts
git commit -m "feat: acquire bounded git source subtrees"
```

### Task 3: Allowlisted working-tree snapshots

**Files:**
- Create: `packages/daemon/src/kit/acquisition/working-tree.ts`
- Test: `packages/daemon/src/kit/__tests__/working-tree.test.ts`
- Modify: `packages/daemon/src/config/schema.ts`
- Test: `packages/daemon/src/config/__tests__/schema.test.ts`

**Interfaces:**
- Produces: config `sourceWorkingTreeRoots: string[]`.
- Produces: `acquireWorkingTree(locator, destination, policy): Promise<WorkingTreeProvenance>`.

- [ ] **Step 1: Write failing allowlist and snapshot tests**

```ts
expect(await snapshot(repo, "experimental/leon-ye_data/agent-kits")).toContainPaths(["capabilities/tracked", "capabilities/untracked"]);
await expect(snapshot(outsideAllowlist, ".")).rejects.toMatchObject({ code: "working_tree_not_allowed" });
await expect(snapshotWithMutation(repo)).rejects.toMatchObject({ code: "working_tree_changed" });
```

- [ ] **Step 2: Run focused tests**

Run: `bun test packages/daemon/src/kit/__tests__/working-tree.test.ts packages/daemon/src/config/__tests__/schema.test.ts`

Expected: FAIL because the config and snapshot adapter are missing.

- [ ] **Step 3: Implement canonical ownership and allowlist checks**

Resolve `git rev-parse --show-toplevel`, `realpath` the result, require `stat.uid === process.getuid()`, and require it to equal or be nested below one configured canonical root. Enumerate `git ls-files -z --cached --others --exclude-standard -- <subpath>`; stage only those paths.

- [ ] **Step 4: Detect concurrent edits and preserve modes/links**

Capture `{head,status}` with `git rev-parse HEAD` and `git status --porcelain=v2 -z -- <subpath>` before and after staging. Retry once; on a second mismatch return `working_tree_changed`. Reject any resolved link outside the selected root and enforce the shared tree limits.

- [ ] **Step 5: Run focused tests**

Run: `bun test packages/daemon/src/kit/__tests__/working-tree.test.ts packages/daemon/src/config/__tests__/schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit working-tree acquisition**

```bash
git add packages/daemon/src/kit/acquisition/working-tree.ts packages/daemon/src/kit/__tests__/working-tree.test.ts packages/daemon/src/config
git commit -m "feat: snapshot allowlisted working tree sources"
```

### Task 4: Atomic transport dispatch and last-good Mirror retention

**Files:**
- Modify: `packages/daemon/src/kit/sync.ts`
- Modify: `packages/daemon/src/kit/types.ts`
- Modify: `packages/daemon/src/kit/sync-status.ts`
- Test: `packages/daemon/src/kit/__tests__/sync.test.ts`
- Test: `packages/daemon/src/kit/__tests__/mirror-recovery.test.ts`

**Interfaces:**
- Consumes: `Source.locator`, `acquireGitSource`, `acquireWorkingTree`.
- Produces: locator-specific `MirrorProvenance` and stable redacted sync errors.

- [ ] **Step 1: Write failing dispatch/retention tests**

```ts
await syncSource(gitSource);
const goodIdentity = readMirrorProvenance(gitSource.id).treeIdentity;
transport.failNext({ code: "offline", detail: "https://user:secret@example/repo" });
await syncSource(gitSource);
expect(readMirrorProvenance(gitSource.id).treeIdentity).toBe(goodIdentity);
expect(readSyncError(gitSource.id)).toEqual({ code: "offline", detail: "repository fetch failed" });
```

- [ ] **Step 2: Run focused sync tests**

Run: `bun test packages/daemon/src/kit/__tests__/sync.test.ts packages/daemon/src/kit/__tests__/mirror-recovery.test.ts`

Expected: FAIL because sync still dispatches on legacy kind/origin.

- [ ] **Step 3: Stage, validate, and atomically swap by locator kind**

```ts
const staged = mkdtempSync(join(mirrorParent, `.sync-${source.id}-`));
try {
  const provenance = await acquisition[source.locator.kind](source.locator, staged);
  await validateCapabilityTree(staged);
  atomicReplaceMirror(staged, mirrorRoot(source.id), provenance);
} catch (error) {
  recordSyncFailure(source.id, redactAcquisitionError(error));
}
```

An existing selected subpath without `capabilities/` succeeds with `capabilityCount: 0` and an explicit non-capability-kit status.

- [ ] **Step 4: Run all Source and sync tests**

Run: `bun test packages/contract/src/source.test.ts packages/daemon/src/sources packages/daemon/src/kit/__tests__/git-source.test.ts packages/daemon/src/kit/__tests__/working-tree.test.ts packages/daemon/src/kit/__tests__/sync.test.ts packages/daemon/src/kit/__tests__/mirror-recovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit transport dispatch**

```bash
git add packages/daemon/src/kit
git commit -m "feat: sync source locators into last-good mirrors"
```

