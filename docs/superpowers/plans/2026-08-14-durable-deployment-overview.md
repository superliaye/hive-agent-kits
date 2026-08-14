# Durable Selection and Deployment Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Daemon the durable authority for desired capability state, observed deployment state, deploy plans, and asynchronous operations.

**Architecture:** Revisioned JSON stores persist Selection and Hive-private Deployment State independently from the unchanged agent-kit Ledger. One Overview projector produces rows, observations, diff, and a canonical plan token; a serialized coordinator persists an accepted plan before running reconciliation outside the HTTP request.

**Tech Stack:** TypeScript, Zod, atomic JSON files, SHA-256 canonical plans, Effect/Hono, React Query, Bun test

**Spec:** `docs/superpowers/specs/2026-08-14-arca-remote-capability-control-design.md`

## Global Constraints

- Selection uses CapabilityKeys and exact applicable target sets with optimistic `expectedRevision`.
- Ledger schema and bytes remain interoperable with agent-kit.
- Failed attempts never overwrite last successful `applied` provenance.
- Selected unavailable instructions block whole-file reconciliation; unavailable skills/agents are left untouched.
- Deploy accepts only `{ selectionRevision, planToken }`, persists before `202`, and survives request disconnect.

---

### Task 1: Durable revisioned Selection

**Files:**
- Modify: `packages/contract/src/kit.ts`
- Create: `packages/daemon/src/kit/selection-store.ts`
- Test: `packages/daemon/src/kit/__tests__/selection-store.test.ts`
- Modify: `packages/daemon/src/kit/routes.ts`
- Test: `packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`

**Interfaces:**
- Produces: `DesiredSelection`, `SelectionMutation`, `SelectionSnapshot` wire schemas.
- Produces: `SelectionStore.read()`, `SelectionStore.mutate(body)`, `SelectionStore.seedOnce(ledger)`.

- [ ] **Step 1: Write failing persistence/conflict/seeding tests**

```ts
const store = openSelectionStore(path);
expect(store.seedOnce(ledger).revision).toBe(1);
expect(openSelectionStore(path).seedOnce(otherLedger)).toEqual(store.read());
expect(store.mutate({ expectedRevision: 1, changes: [{ key, enabled: false, targets: ["codex"] }] }).revision).toBe(2);
expect(() => store.mutate({ expectedRevision: 1, changes: [] })).toThrow("selection_conflict");
```

- [ ] **Step 2: Run focused tests**

Run: `bun test packages/daemon/src/kit/__tests__/selection-store.test.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`

Expected: FAIL because the durable store and mutation routes do not exist.

- [ ] **Step 3: Define exact durable shape and atomic store**

```ts
const SelectionFile = z.object({
  schemaVersion: z.literal(1),
  initialized: z.literal(true),
  revision: z.number().int().nonnegative(),
  enabled: z.array(z.object({ key: CapabilityKey, targets: z.array(DeployTarget).min(1) })),
  removalIntents: z.array(z.object({ key: CapabilityKey, targets: z.array(DeployTarget).min(1) })),
});
```

Write temp file, fsync it, rename it, then fsync its directory. Missing file may seed once from Ledger; malformed current-version content throws and never seeds.

- [ ] **Step 4: Add GET and revision-checked mutation routes**

`GET /api/kit/selection` returns the snapshot. `PATCH /api/kit/selection` returns `409 { error: "selection_conflict", currentRevision }` on mismatch and otherwise the committed snapshot plus one refs-only audit event.

- [ ] **Step 5: Run focused tests and commit**

Run: `bun test packages/daemon/src/kit/__tests__/selection-store.test.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`

```bash
git add packages/contract/src/kit.ts packages/daemon/src/kit/selection-store.ts packages/daemon/src/kit/__tests__/selection-store.test.ts packages/daemon/src/kit/routes.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts
git commit -m "feat: persist revisioned capability selection"
```

### Task 2: Hive-private Deployment State

**Files:**
- Create: `packages/daemon/src/kit/deployment-state.ts`
- Test: `packages/daemon/src/kit/__tests__/deployment-state.test.ts`
- Modify: `packages/daemon/src/kit/fingerprint.ts`
- Modify: `packages/daemon/src/kit/deploy/engine.ts`

**Interfaces:**
- Produces: `DeploymentStateStore.recordSuccess`, `recordFailure`, `recordRemoval`, `markInterrupted`.
- Produces per-key/per-target `applied` and `lastAttempt` records plus store revision.

- [ ] **Step 1: Write failing outcome preservation tests**

```ts
state.recordSuccess(key, "codex", appliedV1, operationId);
state.recordFailure(key, "codex", { action: "update", code: "io", detail: "write failed" }, operationId2);
expect(state.read(key, "codex")?.applied).toEqual(appliedV1);
expect(state.read(key, "codex")?.lastAttempt.outcome).toBe("failed");
state.recordRemoval(key, "codex", operationId3);
expect(state.read(key, "codex")?.applied).toBeUndefined();
```

- [ ] **Step 2: Run focused test**

Run: `bun test packages/daemon/src/kit/__tests__/deployment-state.test.ts`

Expected: FAIL because the store is missing.

- [ ] **Step 3: Implement bounded semantic records**

Persist source id, content SHA, rendered hash, applied time, and operation id only after the corresponding filesystem and Ledger action succeeds. Normalize errors to stable codes and a redacted 512-character detail. Increment the store revision on each committed outcome.

- [ ] **Step 4: Integrate per-target engine outcomes**

Record success/failure around each target action; never clear `applied` in a catch path. Clear only removal intents whose target removal succeeded. Continue other kinds after an isolated failure.

- [ ] **Step 5: Run deployment tests and commit**

Run: `bun test packages/daemon/src/kit/__tests__/deployment-state.test.ts packages/daemon/src/kit/__tests__/deploy.test.ts packages/daemon/src/kit/__tests__/ledger.test.ts`

```bash
git add packages/daemon/src/kit/deployment-state.ts packages/daemon/src/kit/__tests__/deployment-state.test.ts packages/daemon/src/kit/fingerprint.ts packages/daemon/src/kit/deploy/engine.ts
git commit -m "feat: retain deployment provenance and attempts"
```

### Task 3: Authoritative Overview and canonical plan token

**Files:**
- Modify: `packages/contract/src/kit.ts`
- Create: `packages/daemon/src/kit/deploy-plan.ts`
- Create: `packages/daemon/src/kit/overview.ts`
- Test: `packages/daemon/src/kit/__tests__/overview.test.ts`
- Test: `packages/daemon/src/kit/__tests__/deploy-plan.test.ts`
- Modify: `packages/daemon/src/kit/effect/kit-live.ts`
- Modify: `packages/daemon/src/kit/routes.ts`

**Interfaces:**
- Produces: `DeploymentOverview`, `OverviewRow`, `TargetObservation`, `AcceptedDeployRequest` wire schemas.
- Produces: `buildDeployPlan(snapshot): DeployPlan`, `tokenForPlan(plan): string`, `buildOverview(snapshot): DeploymentOverview`.

- [ ] **Step 1: Write failing union/state matrix tests**

```ts
const overview = buildOverview(fixture({ catalog: [], selected: [orphan], ledger: [owned], deploymentState: [failed] }));
expect(row(overview, orphan).reconciliation).toBe("orphaned");
expect(row(overview, owned).reconciliation).toBe("unmanaged_owned");
expect(row(overview, failed).lastAttempt).toMatchObject({ state: "failed", code: "io" });
expect(overview.planToken).toMatch(/^[0-9a-f]{64}$/);
```

- [ ] **Step 2: Run Overview tests**

Run: `bun test packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts`

Expected: FAIL because projection and canonical plan modules are missing.

- [ ] **Step 3: Implement the union projection and target observations**

Form keys from catalog, Selection, removal intents, Ledger, and Deployment State. Compute `catalog`, `desired`, `reconciliation`, `lastAttempt`, and each target observation independently. Use would-deploy rendered hashes for `pending_update`; map read failures to `verification_error`, not `missing`.

- [ ] **Step 4: Canonicalize the resolved plan**

```ts
export function tokenForPlan(plan: DeployPlan): string {
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}
```

The canonical object includes Selection and Source revisions, active Mirror identities/precedence, per-target actions and rendered hashes, Ledger/Deployment State revisions, and current existence/hash observations. Sort object keys, capability keys, targets, and actions before hashing.

- [ ] **Step 5: Expose one Overview route**

Add `KitSvc.overview(): DeploymentOverview` and `GET /api/kit/overview`. Keep legacy catalog/state/diff reads until UI migration completes, but the new page must use only Overview.

- [ ] **Step 6: Run focused tests and commit**

Run: `bun test packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts packages/daemon/src/kit/effect/__tests__/kit-live.test.ts`

```bash
git add packages/contract/src/kit.ts packages/daemon/src/kit/deploy-plan.ts packages/daemon/src/kit/overview.ts packages/daemon/src/kit/__tests__/overview.test.ts packages/daemon/src/kit/__tests__/deploy-plan.test.ts packages/daemon/src/kit/effect/kit-live.ts packages/daemon/src/kit/routes.ts
git commit -m "feat: project authoritative deployment overview"
```

### Task 4: Persisted asynchronous deploy coordinator

**Files:**
- Create: `packages/daemon/src/kit/deploy-operations.ts`
- Create: `packages/daemon/src/kit/deploy-coordinator.ts`
- Test: `packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts`
- Modify: `packages/daemon/src/kit/effect/kit-live.ts`
- Modify: `packages/daemon/src/kit/routes.ts`
- Test: `packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`

**Interfaces:**
- Produces: `DeployCoordinator.accept({ selectionRevision, planToken }): Promise<{ operationId: string }>`.
- Produces operation states `queued | running | completed | failed | interrupted`.

- [ ] **Step 1: Write failing stale/in-progress/disconnect tests**

```ts
expect(await coordinator.accept(currentRequest)).toEqual({ operationId: expect.any(String) });
await expect(coordinator.accept(currentRequest)).rejects.toMatchObject({ code: "deploy_in_progress" });
await expect(freshCoordinator.accept(staleRequest)).rejects.toMatchObject({ code: "plan_stale" });
disconnectHttpClient();
await operationDone(operationId);
expect(readOperation(operationId).state).toBe("completed");
```

- [ ] **Step 2: Run coordinator tests**

Run: `bun test packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`

Expected: FAIL because coordinator/operation persistence are missing.

- [ ] **Step 3: Serialize acceptance and persist before execution**

Within one mutex: reject an active operation, rebuild the current canonical plan, compare revision/token, write the immutable plan and queued operation atomically, then schedule execution. The route returns `202 { operationId }` immediately after persistence.

Persisting the accepted plan emits exactly one refs-only Deploy audit event containing operation id, Selection revision, per-kind action counts, and targets. State transitions and diagnostics remain in Deployment State and Trace.

- [ ] **Step 4: Recover interrupted operations**

On store open, convert persisted `queued` or `running` to `interrupted`. Do not auto-resume; the next explicit idempotent Deploy builds a new plan.

- [ ] **Step 5: Map exact conflict responses**

Return `409 { error: "plan_stale" }` for mismatches and `409 { error: "deploy_in_progress", operationId }` for an active operation. Selection mutations after acceptance do not alter the accepted plan.

- [ ] **Step 6: Run focused tests and commit**

Run: `bun test packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts`

```bash
git add packages/daemon/src/kit/deploy-operations.ts packages/daemon/src/kit/deploy-coordinator.ts packages/daemon/src/kit/__tests__/deploy-coordinator.test.ts packages/daemon/src/kit/effect/kit-live.ts packages/daemon/src/kit/routes.ts packages/daemon/src/server/__tests__/routes-kit-e2e.test.ts
git commit -m "feat: persist asynchronous deploy operations"
```

### Task 5: Overview-driven toggle and deploy UI

**Files:**
- Modify: `packages/ui/src/api.ts`
- Modify: `packages/ui/src/pages/KitDeployPage.tsx`
- Test: `packages/ui/src/__tests__/kit-selection-state.test.tsx`
- Test: `packages/ui/src/__tests__/kit-deploy-confirm.test.tsx`
- Create: `packages/ui/src/__tests__/kit-overview-states.test.tsx`
- Modify: `packages/ui/src/styles.css`

**Interfaces:**
- Consumes: `GET /api/kit/overview`, revisioned Selection mutation, `POST /api/kit/deploy` accepted operation.
- Produces: Daemon-authoritative rows, connection label/status, explicit refresh/retry behavior.

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(await screen.findByText("Waiting for source")).toBeVisible();
await user.click(screen.getByRole("switch", { name: /arca-smoke/i }));
expect(patchSelection).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }));
await user.click(screen.getByRole("button", { name: "Deploy" }));
expect(acceptDeploy).toHaveBeenCalledWith({ selectionRevision: 8, planToken: "plan-8" });
```

- [ ] **Step 2: Run focused UI tests**

Run: `bun test packages/ui/src/__tests__/kit-selection-state.test.tsx packages/ui/src/__tests__/kit-deploy-confirm.test.tsx packages/ui/src/__tests__/kit-overview-states.test.tsx`

Expected: FAIL because the page still owns Selection and joins legacy reads.

- [ ] **Step 3: Replace local Selection with Overview queries/mutations**

Render catalog, desired, reconciliation, last attempt, and per-target observation as separate fields. Disable shadowed variants. Show selected unavailable rows and Ledger-only rows. Refetch on `selection_conflict`, `plan_stale`, reconnect, and accepted operation polling.

- [ ] **Step 4: Represent plugin/bundle removal honestly**

Use `manual_removal_required` copy and omit any claim that Deploy will uninstall those artifacts. Continue to show the Deploy review for actionable skill/agent/instruction changes.

- [ ] **Step 5: Run UI and full Hive verification**

Run: `bun test packages/ui/src && bun run verify`

Expected: PASS.

- [ ] **Step 6: Commit the UI migration**

```bash
git add packages/ui
git commit -m "feat: manage deployment from daemon overview"
```
