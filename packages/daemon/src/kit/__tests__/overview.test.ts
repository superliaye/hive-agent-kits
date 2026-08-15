import { describe, expect, test } from "bun:test";
import type { CapabilityKey } from "@hive/capability-schema";
import type { OverviewRow } from "@hive/contract";
import type { DeploymentSnapshot } from "../deploy-plan.ts";
import { buildOverview } from "../overview.ts";

const key = (kind: CapabilityKey["kind"], name: string): CapabilityKey => ({ kind, name });

function fixture(overrides: Partial<DeploymentSnapshot> = {}): DeploymentSnapshot {
  return {
    sources: [],
    sourceRegistryRevision: 1,
    mirrors: [],
    catalog: { entries: [], presets: [], problems: [] },
    selection: { revision: 1, enabled: [], removalIntents: [] },
    ledger: {
      revision: null,
      identity: "ledger-empty",
      value: {
        kitVersion: "",
        agents: ["claude", "codex"],
        skills: [],
        agentDefs: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
    },
    deploymentState: {
      schemaVersion: 1,
      revision: 0,
      records: [],
      legacyInstructionFingerprints: [],
    },
    wouldDeploy: [],
    artifacts: [],
    activeOperation: null,
    lastOperation: null,
    ...overrides,
  };
}

function row(overview: ReturnType<typeof buildOverview>, wanted: CapabilityKey): OverviewRow {
  const found = overview.rows.find(
    (candidate) => candidate.key.kind === wanted.kind && candidate.key.name === wanted.name,
  );
  if (!found) throw new Error(`missing row ${wanted.kind}:${wanted.name}`);
  return found;
}

function target(rowValue: OverviewRow, wanted: "claude" | "codex") {
  const found = rowValue.targets.find((candidate) => candidate.target === wanted);
  if (!found) throw new Error(`missing target ${wanted}`);
  return found;
}

function variant(
  capabilityKey: CapabilityKey,
  over: { deployable?: boolean; shadowed?: boolean } = {},
) {
  return {
    ...capabilityKey,
    description: capabilityKey.name,
    group: "",
    deployable: over.deployable ?? true,
    shadowed: over.shadowed ?? false,
    sourceIds: [over.shadowed ? "source-shadow" : "source-win"],
    contentSha: `${capabilityKey.name}-sha`,
    ...(over.deployable === false && !over.shadowed ? { blockedReason: "malformed" } : {}),
    ...(over.shadowed ? { shadowedBy: "source-win" } : {}),
  };
}

function applied(capabilityKey: CapabilityKey, renderedHash: string, targetName = "claude") {
  return {
    key: capabilityKey,
    target: targetName as "claude" | "codex",
    applied: {
      sourceId: "source-win",
      contentSha: `${capabilityKey.name}-sha`,
      renderedHash,
      appliedAt: 1,
    },
    lastAttempt: {
      action: "update" as const,
      outcome: "succeeded" as const,
      attemptedAt: 1,
      operationId: `op-${capabilityKey.name}-${targetName}`,
    },
  };
}

describe("authoritative Overview union and state matrix", () => {
  test("unions every authority and keeps shadows/catalog/desired orthogonal", () => {
    const catalogKey = key("skill", "catalog");
    const selectedKey = key("agent", "selected");
    const intentKey = key("instruction", "intent");
    const stateKey = key("bundle", "state");
    const blocked = key("agent", "blocked");
    const shadowOnly = key("skill", "shadow-only");
    const overview = buildOverview(
      fixture({
        catalog: {
          entries: [
            variant(catalogKey),
            variant(catalogKey, { deployable: false, shadowed: true }),
            variant(blocked, { deployable: false }),
            variant(shadowOnly, { deployable: false, shadowed: true }),
          ],
          presets: [],
          problems: [],
        },
        selection: {
          revision: 2,
          enabled: [{ key: selectedKey, targets: ["codex"] }],
          removalIntents: [{ key: intentKey, targets: ["claude"] }],
        },
        ledger: {
          revision: null,
          identity: "ledger-union",
          value: {
            kitVersion: "",
            agents: ["claude"],
            skills: [],
            agentDefs: [],
            instructions: [],
            plugins: [{ name: "ledger" }],
            bundles: [],
          },
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 1,
          legacyInstructionFingerprints: [],
          records: [
            {
              key: stateKey,
              target: "codex",
              lastAttempt: {
                action: "add",
                outcome: "failed",
                attemptedAt: 9,
                operationId: "op-state",
                code: "io",
              },
            },
          ],
        },
      }),
    );
    expect(overview.rows.map((value) => `${value.key.kind}:${value.key.name}`).sort()).toEqual([
      "agent:blocked",
      "agent:selected",
      "bundle:state",
      "instruction:intent",
      "plugin:ledger",
      "skill:catalog",
      "skill:shadow-only",
    ]);
    expect(row(overview, stateKey).lastAttempt).toMatchObject({ state: "failed", code: "io" });
    expect(row(overview, catalogKey)).toMatchObject({ catalog: "deployable", desired: "off" });
    expect(row(overview, catalogKey).variants.map((entry) => entry.catalog)).toEqual([
      "deployable",
      "shadowed",
    ]);
    expect(row(overview, blocked).catalog).toBe("blocked");
    expect(row(overview, shadowOnly).catalog).toBe("shadowed");
    expect(overview.planToken).toMatch(/^[0-9a-f]{64}$/);
  });

  test("projects every reconciliation state and preserves failed-attempt context", () => {
    const states = {
      inSync: key("skill", "in-sync"),
      add: key("skill", "add"),
      update: key("skill", "update"),
      remove: key("agent", "remove"),
      waiting: key("skill", "waiting"),
      orphan: key("agent", "orphan"),
      unmanaged: key("skill", "unmanaged"),
      manual: key("plugin", "manual"),
    };
    const updateRecord = {
      ...applied(states.update, "old-hash"),
      lastAttempt: {
        action: "update" as const,
        outcome: "failed" as const,
        attemptedAt: 8,
        operationId: "op-failed",
        code: "io" as const,
        detail: "write failed",
      },
    };
    const overview = buildOverview(
      fixture({
        catalog: {
          entries: [states.inSync, states.add, states.update, states.remove, states.manual].map(
            (item) => variant(item),
          ),
          presets: [],
          problems: [],
        },
        selection: {
          revision: 3,
          enabled: [states.inSync, states.add, states.update, states.waiting, states.orphan].map(
            (item) => ({ key: item, targets: ["claude"] }),
          ),
          removalIntents: [
            { key: states.remove, targets: ["claude"] },
            { key: states.manual, targets: ["claude"] },
          ],
        },
        ledger: {
          revision: null,
          identity: "ledger-states",
          value: {
            kitVersion: "",
            agents: ["claude"],
            skills: [{ name: states.unmanaged.name }],
            agentDefs: [{ name: states.orphan.name }],
            instructions: [],
            plugins: [{ name: states.manual.name }],
            bundles: [],
          },
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 4,
          legacyInstructionFingerprints: [],
          records: [
            applied(states.inSync, "same-hash"),
            updateRecord,
            applied(states.remove, "remove-hash"),
            applied(states.orphan, "orphan-hash"),
          ],
        },
        wouldDeploy: [
          [states.inSync, "same-hash"],
          [states.add, "add-hash"],
          [states.update, "new-hash"],
        ].map(([item, renderedHash]) => ({
          key: item as CapabilityKey,
          target: "claude",
          sourceId: "source-win",
          contentSha: `${(item as CapabilityKey).name}-sha`,
          renderedHash: renderedHash as string,
        })),
        artifacts: [
          { key: states.inSync, target: "claude", existence: "present", hash: "same-hash" },
          { key: states.add, target: "claude", existence: "missing", hash: null },
          { key: states.update, target: "claude", existence: "present", hash: "old-hash" },
          { key: states.remove, target: "claude", existence: "present", hash: "remove-hash" },
          { key: states.orphan, target: "claude", existence: "present", hash: "orphan-hash" },
          { key: states.unmanaged, target: "claude", existence: "present", hash: null },
          { key: states.manual, target: "claude", existence: "present", hash: null },
        ],
      }),
    );
    const expected = new Map<CapabilityKey, OverviewRow["reconciliation"]>([
      [states.inSync, "in_sync"],
      [states.add, "pending_add"],
      [states.update, "pending_update"],
      [states.remove, "pending_remove"],
      [states.waiting, "waiting_for_source"],
      [states.orphan, "orphaned"],
      [states.unmanaged, "unmanaged_owned"],
      [states.manual, "manual_removal_required"],
    ]);
    for (const [item, reconciliation] of expected) {
      expect(row(overview, item).reconciliation).toBe(reconciliation);
    }
    expect(row(overview, states.update).lastAttempt).toMatchObject({
      state: "failed",
      code: "io",
      operationId: "op-failed",
    });
  });

  test("distinguishes every observation and never maps read errors to missing", () => {
    const rows = {
      verified: key("skill", "verified"),
      unverified: key("skill", "unverified"),
      missing: key("skill", "missing"),
      drifted: key("skill", "drifted"),
      recorded: key("bundle", "recorded"),
      error: key("agent", "error"),
    };
    const overview = buildOverview(
      fixture({
        catalog: {
          entries: Object.values(rows).map((item) => variant(item)),
          presets: [],
          problems: [],
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 5,
          records: [rows.verified, rows.missing, rows.drifted, rows.recorded, rows.error].map(
            (item) => applied(item, "expected"),
          ),
          legacyInstructionFingerprints: [],
        },
        ledger: {
          revision: null,
          identity: "ledger-observations",
          value: {
            kitVersion: "",
            agents: ["claude"],
            skills: [],
            agentDefs: [],
            instructions: [],
            plugins: [],
            bundles: [{ name: "recorded", pin: null }],
          },
        },
        artifacts: [
          { key: rows.verified, target: "claude", existence: "present", hash: "expected" },
          { key: rows.unverified, target: "claude", existence: "present", hash: "some-hash" },
          { key: rows.missing, target: "claude", existence: "missing", hash: null },
          { key: rows.drifted, target: "claude", existence: "present", hash: "edited" },
          { key: rows.recorded, target: "claude", existence: "present", hash: null },
          { key: rows.error, target: "claude", existence: "error", hash: null, error: "read" },
        ],
      }),
    );
    const expected = [
      [rows.verified, "verified"],
      [rows.unverified, "present_unverified"],
      [rows.missing, "missing"],
      [rows.drifted, "drifted"],
      [rows.recorded, "recorded_unverified"],
      [rows.error, "verification_error"],
    ] as const;
    for (const [item, observation] of expected) {
      expect(target(row(overview, item), "claude").observation).toBe(observation);
    }
  });

  test("uses exact applicability and target-specific pending_update", () => {
    const plugin = key("plugin", "claude-only");
    const dual = key("skill", "dual");
    const overview = buildOverview(
      fixture({
        catalog: { entries: [variant(plugin), variant(dual)], presets: [], problems: [] },
        selection: {
          revision: 5,
          enabled: [
            { key: plugin, targets: ["claude"] },
            { key: dual, targets: ["claude", "codex"] },
          ],
          removalIntents: [],
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 2,
          legacyInstructionFingerprints: [],
          records: [applied(dual, "old", "claude"), applied(dual, "same", "codex")],
        },
        wouldDeploy: [
          {
            key: plugin,
            target: "claude",
            sourceId: "source-win",
            contentSha: "claude-only-sha",
            renderedHash: null,
          },
          ...["claude", "codex"].map((targetName) => ({
            key: dual,
            target: targetName as "claude" | "codex",
            sourceId: "source-win",
            contentSha: "dual-sha",
            renderedHash: targetName === "claude" ? "new" : "same",
          })),
        ],
        artifacts: [
          { key: dual, target: "claude", existence: "present", hash: "old" },
          { key: dual, target: "codex", existence: "present", hash: "same" },
        ],
      }),
    );
    expect(row(overview, plugin).applicableTargets).toEqual(["claude"]);
    expect(row(overview, plugin).targets.map((value) => value.target)).toEqual(["claude"]);
    expect(target(row(overview, dual), "claude").reconciliation).toBe("pending_update");
    expect(target(row(overview, dual), "codex").reconciliation).toBe("in_sync");
  });

  test("keeps targetless Ledger-only ownership unmanaged and selected unavailable ownership orphaned", () => {
    const unmanaged = key("skill", "ledger-only");
    const orphan = key("agent", "selected-ledger-only");
    const overview = buildOverview(
      fixture({
        selection: {
          revision: 7,
          enabled: [{ key: orphan, targets: ["claude"] }],
          removalIntents: [],
        },
        ledger: {
          revision: null,
          identity: "targetless-ledger",
          value: {
            kitVersion: "",
            agents: [],
            skills: [{ name: unmanaged.name }],
            agentDefs: [{ name: orphan.name }],
            instructions: [],
            plugins: [],
            bundles: [],
          },
        },
      }),
    );
    expect(row(overview, unmanaged).reconciliation).toBe("unmanaged_owned");
    expect(row(overview, orphan).reconciliation).toBe("orphaned");
  });
});
