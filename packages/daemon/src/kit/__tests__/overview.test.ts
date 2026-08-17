import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityKey } from "@hive/capability-schema";
import type { OverviewRow, Source } from "@hive/contract";
import type { DeploymentSnapshot } from "../deploy-plan.ts";
import {
  buildOverview,
  captureCoherentDeploymentSnapshot,
  captureDeploymentSnapshot,
  DeploymentSnapshotChangedError,
} from "../overview.ts";
import type { DeployTargets } from "../targets.ts";

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
      operationId: `op-${capabilityKey.name}-${targetName}`,
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
  test("omits fully reconciled unavailable history without hiding failed removals", () => {
    const removed = key("skill", "removed");
    const inertIntent = key("skill", "inert-intent");
    const failed = key("skill", "failed-remove");
    const overview = buildOverview(
      fixture({
        selection: {
          revision: 2,
          enabled: [],
          removalIntents: [{ key: inertIntent, targets: ["codex"] }],
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 2,
          legacyInstructionFingerprints: [],
          records: [
            {
              key: removed,
              target: "claude",
              lastAttempt: {
                action: "remove",
                outcome: "succeeded",
                attemptedAt: 2,
                operationId: "op-removed",
              },
            },
            {
              key: failed,
              target: "claude",
              lastAttempt: {
                action: "remove",
                outcome: "failed",
                attemptedAt: 3,
                operationId: "op-failed-remove",
                code: "io",
              },
            },
          ],
        },
      }),
    );

    expect(overview.rows.map((value) => `${value.key.kind}:${value.key.name}`)).toEqual([
      "skill:failed-remove",
    ]);
    expect(row(overview, failed).lastAttempt).toMatchObject({ state: "failed", code: "io" });
  });

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

  test("keeps targetless Ledger-only ownership unmanaged without claiming target ownership", () => {
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
    expect(row(overview, orphan).reconciliation).toBe("waiting_for_source");
  });

  test("uses target-scoped Ledger ownership for available and unavailable Codex selections", () => {
    const available = key("skill", "available-on-codex");
    const unavailable = key("agent", "missing-on-codex");
    const overview = buildOverview(
      fixture({
        catalog: { entries: [variant(available)], presets: [], problems: [] },
        selection: {
          revision: 8,
          enabled: [available, unavailable].map((selected) => ({
            key: selected,
            targets: ["codex"],
          })),
          removalIntents: [],
        },
        ledger: {
          revision: null,
          identity: "claude-only-ledger",
          value: {
            kitVersion: "",
            agents: ["claude"],
            skills: [{ name: available.name }],
            agentDefs: [{ name: unavailable.name }],
            instructions: [],
            plugins: [],
            bundles: [],
          },
        },
        wouldDeploy: [
          {
            key: available,
            target: "codex",
            sourceId: "source-win",
            contentSha: "available-on-codex-sha",
            renderedHash: "codex-render",
          },
        ],
        artifacts: [
          { key: available, target: "codex", existence: "missing", hash: null },
          { key: unavailable, target: "codex", existence: "missing", hash: null },
        ],
      }),
    );

    expect(target(row(overview, available), "codex").reconciliation).toBe("pending_add");
    expect(target(row(overview, unavailable), "codex").reconciliation).toBe("waiting_for_source");
  });
});

function testTargets(root: string): DeployTargets {
  return {
    claudeHome: () => join(root, ".claude"),
    codexHome: () => join(root, ".codex"),
    agentsHome: () => join(root, ".agents"),
    ledgerPath: () => join(root, "manifest.json"),
    mirrorRoot: (sourceId) => join(root, "mirrors", sourceId),
    fingerprintPath: () => join(root, "fingerprints.json"),
    deploymentStatePath: () => join(root, "deployment-state.json"),
    kitTmpRoot: () => join(root, "tmp"),
    starterRoot: () => join(root, "starter"),
    childEnv: (base) => ({ ...base }),
    isChildEnvRedirected: () => true,
  };
}

const coherentSource: Source = {
  id: "source-a",
  label: "A",
  locator: {
    kind: "git",
    repoUrl: "https://github.com/owner/a",
    revision: { mode: "track", ref: "refs/heads/main" },
    subpath: ".",
  },
  origin: "https://github.com/owner/a",
  kind: "git",
  active: true,
  createdAt: 1,
  rank: 1,
};

describe("managed npx bundle snapshot capture", () => {
  test("observes declared paths and emits target-scoped metadata hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "overview-managed-bundle-"));
    try {
      const targets = testTargets(root);
      const bundlePath = join(
        targets.mirrorRoot("source-win"),
        "capabilities",
        "bundles",
        "archify.bundle.md",
      );
      mkdirSync(join(bundlePath, ".."), { recursive: true });
      writeFileSync(
        bundlePath,
        `---\ndescription: Archify\ninstaller:\n  kind: npx-skills\n  package: https://github.com/tt-a1i/archify/tree/${"a".repeat(40)}\n  skills: [archify]\nverify_paths:\n  claude: ~/.claude/skills/archify\n  codex: ~/.codex/skills/archify\n---\n`,
      );
      mkdirSync(join(targets.claudeHome(), "skills", "archify"), { recursive: true });
      const archify = key("bundle", "archify");
      const captured = captureDeploymentSnapshot(
        targets,
        {
          sourceRegistry: {
            revision: 1,
            sources: [{ ...coherentSource, id: "source-win" }],
          },
          catalog: {
            entries: [variant(archify)],
            presets: [],
            problems: [],
          },
          selection: {
            revision: 1,
            enabled: [{ key: archify, targets: ["claude", "codex"] }],
            removalIntents: [],
          },
          ledger: null,
          deploymentState: {
            schemaVersion: 1,
            revision: 0,
            records: [],
            legacyInstructionFingerprints: [],
          },
        },
        [],
      );
      const claude = captured.wouldDeploy.find((item) => item.target === "claude");
      const codex = captured.wouldDeploy.find((item) => item.target === "codex");

      expect(claude?.renderedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(codex?.renderedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(claude?.renderedHash).not.toBe(codex?.renderedHash);
      if (!claude?.renderedHash) throw new Error("missing Claude managed bundle hash");
      expect(captured.artifacts).toContainEqual({
        key: archify,
        target: "claude",
        existence: "present",
        hash: claude?.renderedHash,
      });
      expect(captured.artifacts).toContainEqual({
        key: archify,
        target: "codex",
        existence: "missing",
        hash: null,
      });
      expect(target(row(buildOverview(captured), archify), "claude").reconciliation).toBe(
        "pending_add",
      );

      const inSync = buildOverview({
        ...captured,
        deploymentState: {
          ...captured.deploymentState,
          records: [applied(archify, claude?.renderedHash ?? "", "claude")],
        },
      });
      expect(target(row(inSync, archify), "claude")).toMatchObject({
        reconciliation: "in_sync",
        observation: "verified",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function coherentReaders(onCatalog: () => void) {
  return {
    readSourceRegistry: () => ({ version: 4 as const, revision: 3, sources: [coherentSource] }),
    readCatalog: () => {
      onCatalog();
      return { entries: [], presets: [], problems: [] };
    },
    readLedger: () => null,
    readSelection: () => ({ revision: 1, enabled: [], removalIntents: [] }),
    readDeploymentState: () => ({
      schemaVersion: 1 as const,
      revision: 0,
      records: [],
      legacyInstructionFingerprints: [],
    }),
  };
}

function swapMirrorGeneration(root: string, content: string, generation: number): void {
  const stage = `${root}.stage-${generation}`;
  const previous = `${root}.previous-${generation}`;
  const marker = join(stage, "capabilities", "skills", "alpha", "SKILL.md");
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, content);
  renameSync(root, previous);
  renameSync(stage, root);
  rmSync(previous, { recursive: true });
}

describe("coherent runtime snapshot capture", () => {
  test("retries when the Source revision changes during capture", () => {
    const root = mkdtempSync(join(tmpdir(), "overview-snapshot-"));
    try {
      const targets = testTargets(root);
      let registryReads = 0;
      let catalogReads = 0;
      const stable = captureCoherentDeploymentSnapshot(
        targets,
        {
          ...coherentReaders(() => {
            catalogReads += 1;
          }),
          readSourceRegistry: () => {
            registryReads += 1;
            return {
              version: 4 as const,
              revision: registryReads === 1 ? 3 : 4,
              sources: [coherentSource],
            };
          },
        },
        2,
      );

      expect(catalogReads).toBe(2);
      expect(stable.sourceRegistryRevision).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retries when a Mirror swaps during capture and returns only the stable generation", () => {
    const root = mkdtempSync(join(tmpdir(), "overview-snapshot-"));
    try {
      const targets = testTargets(root);
      const marker = join(
        targets.mirrorRoot("source-a"),
        "capabilities",
        "skills",
        "alpha",
        "SKILL.md",
      );
      mkdirSync(join(marker, ".."), { recursive: true });
      writeFileSync(marker, "old");
      let catalogReads = 0;
      const stable = captureCoherentDeploymentSnapshot(
        targets,
        coherentReaders(() => {
          catalogReads += 1;
          if (catalogReads === 1) {
            swapMirrorGeneration(targets.mirrorRoot("source-a"), "new", catalogReads);
          }
        }),
        2,
      );

      expect(catalogReads).toBe(2);
      expect(stable.mirrors[0]?.identity).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails with a stable error after bounded retries instead of tokening a mixed snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "overview-snapshot-"));
    try {
      const targets = testTargets(root);
      const marker = join(
        targets.mirrorRoot("source-a"),
        "capabilities",
        "skills",
        "alpha",
        "SKILL.md",
      );
      mkdirSync(join(marker, ".."), { recursive: true });
      writeFileSync(marker, "zero");
      let generation = 0;
      let observed: unknown;
      try {
        captureCoherentDeploymentSnapshot(
          targets,
          coherentReaders(() => {
            generation += 1;
            swapMirrorGeneration(
              targets.mirrorRoot("source-a"),
              `generation-${generation}`,
              generation,
            );
          }),
          2,
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(DeploymentSnapshotChangedError);
      if (!(observed instanceof DeploymentSnapshotChangedError)) {
        throw new Error("expected DeploymentSnapshotChangedError");
      }
      expect(observed.code).toBe("deployment_snapshot_changed");
      expect(observed.message).toBe("deployment_snapshot_changed");
      expect(generation).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
