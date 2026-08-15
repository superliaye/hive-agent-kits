import { describe, expect, test } from "bun:test";
import type { CapabilityKey } from "@hive/capability-schema";
import type { DeploymentSnapshot, DeployPlan } from "../deploy-plan.ts";
import { buildDeployPlan, identityForLedger, tokenForPlan } from "../deploy-plan.ts";

const skill = (name: string): CapabilityKey => ({ kind: "skill", name });

function snapshot(overrides: Partial<DeploymentSnapshot> = {}): DeploymentSnapshot {
  const key = skill("alpha");
  return {
    sources: [{ id: "source-a", label: "A", kind: "git", active: true, rank: 7 }],
    sourceRegistryRevision: 4,
    mirrors: [{ sourceId: "source-a", precedence: 7, identity: "mirror-a" }],
    catalog: {
      entries: [
        {
          ...key,
          description: "Alpha",
          group: "",
          deployable: true,
          shadowed: false,
          sourceIds: ["source-a"],
          contentSha: "content-a",
        },
      ],
      presets: [],
      problems: [],
    },
    selection: { revision: 8, enabled: [{ key, targets: ["claude"] }], removalIntents: [] },
    ledger: {
      revision: null,
      identity: "ledger-a",
      value: {
        kitVersion: "",
        agents: ["claude"],
        skills: [],
        agentDefs: [],
        instructions: [],
        plugins: [],
        bundles: [],
      },
    },
    deploymentState: {
      schemaVersion: 1,
      revision: 2,
      records: [],
      legacyInstructionFingerprints: [],
    },
    wouldDeploy: [
      {
        key,
        target: "claude",
        sourceId: "source-a",
        contentSha: "content-a",
        renderedHash: "render-a",
      },
    ],
    artifacts: [{ key, target: "claude", existence: "missing", hash: null }],
    activeOperation: null,
    lastOperation: null,
    ...overrides,
  };
}

describe("buildDeployPlan", () => {
  test("produces the exact target action with would-deploy and artifact observations", () => {
    expect(buildDeployPlan(snapshot()).actions).toEqual([
      {
        action: "add",
        key: skill("alpha"),
        target: "claude",
        sourceId: "source-a",
        contentSha: "content-a",
        renderedHash: "render-a",
        artifact: { existence: "missing", hash: null },
      },
    ]);
  });

  test("never plans unavailable selected copied kinds or unmanaged Ledger-only keys", () => {
    const unavailable = skill("waiting");
    const unmanaged = skill("external");
    const plan = buildDeployPlan(
      snapshot({
        catalog: { entries: [], presets: [], problems: [] },
        selection: {
          revision: 9,
          enabled: [{ key: unavailable, targets: ["claude"] }],
          removalIntents: [],
        },
        ledger: {
          revision: null,
          identity: "ledger-b",
          value: {
            kitVersion: "",
            agents: ["claude"],
            skills: [{ name: "external" }],
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
        artifacts: [
          { key: unavailable, target: "claude", existence: "missing", hash: null },
          { key: unmanaged, target: "claude", existence: "present", hash: "disk" },
        ],
      }),
    );
    expect(plan.actions).toEqual([]);
  });

  test("plans an explicit unavailable removal but never plugin or bundle uninstall", () => {
    const unavailable = skill("old-skill");
    const plugin = { kind: "plugin" as const, name: "old-plugin" };
    const bundle = { kind: "bundle" as const, name: "old-bundle" };
    const plan = buildDeployPlan(
      snapshot({
        catalog: { entries: [], presets: [], problems: [] },
        selection: {
          revision: 10,
          enabled: [],
          removalIntents: [
            { key: unavailable, targets: ["claude"] },
            { key: plugin, targets: ["claude"] },
            { key: bundle, targets: ["codex"] },
          ],
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 3,
          legacyInstructionFingerprints: [],
          records: [
            {
              key: unavailable,
              target: "claude",
              applied: {
                sourceId: "gone",
                contentSha: "old",
                renderedHash: "old",
                appliedAt: 1,
              },
              lastAttempt: {
                action: "add",
                outcome: "succeeded",
                attemptedAt: 1,
                operationId: "op-old",
              },
            },
          ],
        },
        wouldDeploy: [],
        artifacts: [
          { key: unavailable, target: "claude", existence: "present", hash: "old" },
          { key: plugin, target: "claude", existence: "present", hash: null },
          { key: bundle, target: "codex", existence: "present", hash: null },
        ],
      }),
    );
    expect(plan.actions.map((action) => [action.key.kind, action.action])).toEqual([
      ["skill", "remove"],
    ]);
  });

  test("blocks the whole instruction target while other kinds continue best-effort", () => {
    const missingInstruction = { kind: "instruction" as const, name: "missing-rules" };
    const availableInstruction = { kind: "instruction" as const, name: "rules" };
    const availableSkill = skill("alpha");
    const plan = buildDeployPlan(
      snapshot({
        catalog: {
          entries: [
            {
              ...availableInstruction,
              description: "Rules",
              group: "",
              deployable: true,
              shadowed: false,
              sourceIds: ["source-a"],
              contentSha: "rules-content",
            },
            {
              ...availableSkill,
              description: "Alpha",
              group: "",
              deployable: true,
              shadowed: false,
              sourceIds: ["source-a"],
              contentSha: "skill-content",
            },
          ],
          presets: [],
          problems: [],
        },
        selection: {
          revision: 11,
          enabled: [
            { key: missingInstruction, targets: ["claude"] },
            { key: availableInstruction, targets: ["claude"] },
            { key: availableSkill, targets: ["claude"] },
          ],
          removalIntents: [],
        },
        wouldDeploy: [
          {
            key: availableInstruction,
            target: "claude",
            sourceId: "source-a",
            contentSha: "rules-content",
            renderedHash: "whole-instruction-hash",
          },
          {
            key: availableSkill,
            target: "claude",
            sourceId: "source-a",
            contentSha: "skill-content",
            renderedHash: "skill-hash",
          },
        ],
        artifacts: [
          { key: availableInstruction, target: "claude", existence: "missing", hash: null },
          { key: availableSkill, target: "claude", existence: "missing", hash: null },
        ],
      }),
    );
    expect(plan.blocked).toEqual([
      { kind: "instruction", target: "claude", keys: [missingInstruction] },
    ]);
    expect(plan.actions.map((action) => action.key)).toEqual([availableSkill]);
  });

  test("captures the complete ordered instruction write when only one contribution needs action", () => {
    const first = { kind: "instruction" as const, name: "first" };
    const interrupted = { kind: "instruction" as const, name: "interrupted" };
    const wholeHash = "whole-instruction-hash";
    const plan = buildDeployPlan(
      snapshot({
        catalog: {
          entries: [first, interrupted].map((key, index) => ({
            ...key,
            description: key.name,
            group: "",
            deployable: true,
            shadowed: false,
            sourceIds: [`source-${index}`],
            contentSha: `content-${index}`,
          })),
          presets: [],
          problems: [],
        },
        selection: {
          revision: 12,
          enabled: [
            { key: first, targets: ["claude"] },
            { key: interrupted, targets: ["claude"] },
          ],
          removalIntents: [],
        },
        deploymentState: {
          schemaVersion: 1,
          revision: 5,
          legacyInstructionFingerprints: [],
          records: [
            {
              key: first,
              target: "claude",
              applied: {
                sourceId: "source-0",
                contentSha: "content-0",
                renderedHash: wholeHash,
                appliedAt: 1,
              },
              lastAttempt: {
                action: "update",
                outcome: "succeeded",
                attemptedAt: 1,
                operationId: "op-first",
              },
            },
            {
              key: interrupted,
              target: "claude",
              lastAttempt: {
                action: "add",
                outcome: "interrupted",
                attemptedAt: 2,
                operationId: "op-interrupted",
              },
            },
          ],
        },
        wouldDeploy: [
          {
            key: first,
            target: "claude",
            sourceId: "source-0",
            contentSha: "content-0",
            renderedHash: wholeHash,
          },
          {
            key: interrupted,
            target: "claude",
            sourceId: "source-1",
            contentSha: "content-1",
            renderedHash: wholeHash,
          },
        ],
        artifacts: [
          { key: first, target: "claude", existence: "present", hash: wholeHash },
          { key: interrupted, target: "claude", existence: "present", hash: wholeHash },
        ],
      }),
    );

    expect(plan.actions.map((action) => [action.key.name, action.action])).toEqual([
      ["interrupted", "add"],
    ]);
    expect(plan.instructionWrites).toEqual([
      {
        target: "claude",
        contributions: [
          { key: first, sourceId: "source-0", contentSha: "content-0" },
          { key: interrupted, sourceId: "source-1", contentSha: "content-1" },
        ],
        renderedHash: wholeHash,
        artifact: { existence: "present", hash: wholeHash },
      },
    ]);
  });

  test("Ledger ownership is target-scoped when planning a missing target", () => {
    const key = skill("alpha");
    const plan = buildDeployPlan(
      snapshot({
        selection: {
          revision: 13,
          enabled: [{ key, targets: ["codex"] }],
          removalIntents: [],
        },
        ledger: {
          revision: null,
          identity: "claude-only-ledger",
          value: {
            kitVersion: "",
            agents: ["claude"],
            skills: [{ name: key.name }],
            agentDefs: [],
            instructions: [],
            plugins: [],
            bundles: [],
          },
        },
        wouldDeploy: [
          {
            key,
            target: "codex",
            sourceId: "source-a",
            contentSha: "content-a",
            renderedHash: "render-a",
          },
        ],
        artifacts: [{ key, target: "codex", existence: "missing", hash: null }],
      }),
    );

    expect(plan.actions).toContainEqual({
      action: "add",
      key,
      target: "codex",
      sourceId: "source-a",
      contentSha: "content-a",
      renderedHash: "render-a",
      artifact: { existence: "missing", hash: null },
    });
  });
});

describe("canonical plan token", () => {
  test("is stable across semantically identical array order and object insertion order", () => {
    const first = buildDeployPlan(
      snapshot({
        mirrors: [
          { sourceId: "source-b", precedence: 3, identity: "mirror-b" },
          { sourceId: "source-a", precedence: 7, identity: "mirror-a" },
        ],
        artifacts: [
          { key: skill("zulu"), target: "codex", existence: "missing", hash: null },
          { key: skill("alpha"), target: "claude", existence: "missing", hash: null },
        ],
      }),
    );
    const second: DeployPlan = {
      blocked: [...first.blocked].reverse(),
      actions: [...first.actions].reverse(),
      instructionWrites: [...first.instructionWrites].reverse(),
      deploymentStateRevision: first.deploymentStateRevision,
      ledger: { identity: first.ledger.identity, revision: first.ledger.revision },
      mirrors: [...first.mirrors].reverse(),
      sourceRegistryRevision: first.sourceRegistryRevision,
      selectionRevision: first.selectionRevision,
    };
    expect(tokenForPlan(first)).toBe(tokenForPlan(second));
    expect(tokenForPlan(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonicalizes Ledger set arrays and same-key target action ties", () => {
    const firstLedger = {
      kitVersion: "v1",
      agents: ["codex", "claude"],
      skills: [{ name: "beta" }, { name: "alpha" }],
      agentDefs: [{ name: "reviewer" }, { name: "builder" }],
      instructions: [{ name: "z-rules" }, { name: "a-rules" }],
      plugins: [{ name: "plugin-b" }, { name: "plugin-a" }],
      bundles: [
        { name: "bundle-b", pin: "bbb" },
        { name: "bundle-a", pin: null },
      ],
    };
    const secondLedger = {
      ...firstLedger,
      agents: [...firstLedger.agents].reverse(),
      skills: [...firstLedger.skills].reverse(),
      agentDefs: [...firstLedger.agentDefs].reverse(),
      instructions: [...firstLedger.instructions].reverse(),
      plugins: [...firstLedger.plugins].reverse(),
      bundles: [...firstLedger.bundles].reverse(),
    };
    expect(identityForLedger(firstLedger)).toBe(identityForLedger(secondLedger));

    const base = buildDeployPlan(snapshot());
    const action = base.actions[0];
    if (!action) throw new Error("fixture did not produce an action");
    const tied = [
      { ...action, contentSha: "content-b" },
      { ...action, contentSha: "content-a" },
    ];
    expect(tokenForPlan({ ...base, actions: tied })).toBe(
      tokenForPlan({ ...base, actions: [...tied].reverse() }),
    );
    const tiedInstructionWrites = [
      {
        target: "claude" as const,
        contributions: [
          {
            key: { kind: "instruction" as const, name: "rules-a" },
            sourceId: "source-a",
            contentSha: "content-a",
          },
        ],
        renderedHash: "whole-a",
        artifact: { existence: "present" as const, hash: "disk" },
      },
      {
        target: "claude" as const,
        contributions: [
          {
            key: { kind: "instruction" as const, name: "rules-b" },
            sourceId: "source-b",
            contentSha: "content-b",
          },
        ],
        renderedHash: "whole-b",
        artifact: { existence: "present" as const, hash: "disk" },
      },
    ];
    expect(tokenForPlan({ ...base, instructionWrites: tiedInstructionWrites })).toBe(
      tokenForPlan({ ...base, instructionWrites: [...tiedInstructionWrites].reverse() }),
    );
    expect(identityForLedger({ ...firstLedger, kitVersion: "v2" })).not.toBe(
      identityForLedger(firstLedger),
    );
  });

  test("changes for every material plan dimension", () => {
    const base = buildDeployPlan(snapshot());
    const firstMirror = base.mirrors[0];
    const firstAction = base.actions[0];
    if (!firstMirror || !firstAction) throw new Error("fixture did not produce a material plan");
    const mutations: DeployPlan[] = [
      { ...base, selectionRevision: base.selectionRevision + 1 },
      { ...base, sourceRegistryRevision: base.sourceRegistryRevision + 1 },
      { ...base, deploymentStateRevision: base.deploymentStateRevision + 1 },
      { ...base, ledger: { ...base.ledger, revision: 3 } },
      { ...base, ledger: { ...base.ledger, identity: "ledger-b" } },
      { ...base, mirrors: [{ ...firstMirror, sourceId: "source-b" }] },
      { ...base, mirrors: [{ ...firstMirror, identity: "mirror-b" }] },
      { ...base, mirrors: [{ ...firstMirror, precedence: 8 }] },
      { ...base, mirrors: [{ ...firstMirror, identity: null, error: "unavailable" }] },
      { ...base, actions: [{ ...firstAction, action: "update" }] },
      { ...base, actions: [{ ...firstAction, key: skill("beta") }] },
      { ...base, actions: [{ ...firstAction, target: "codex" }] },
      { ...base, actions: [{ ...firstAction, sourceId: "source-b" }] },
      { ...base, actions: [{ ...firstAction, contentSha: "content-b" }] },
      {
        ...base,
        actions: [{ ...firstAction, renderedHash: "render-b" }],
      },
      {
        ...base,
        actions: [
          {
            ...firstAction,
            artifact: { ...firstAction.artifact, existence: "present" },
          },
        ],
      },
      {
        ...base,
        actions: [
          {
            ...firstAction,
            artifact: { ...firstAction.artifact, hash: "disk-b" },
          },
        ],
      },
      {
        ...base,
        actions: [{ ...firstAction, artifact: { existence: "error", hash: null, error: "read" } }],
      },
      {
        ...base,
        blocked: [
          {
            kind: "instruction",
            target: "claude",
            keys: [{ kind: "instruction", name: "missing" }],
          },
        ],
      },
      {
        ...base,
        instructionWrites: [
          {
            target: "claude",
            contributions: [
              {
                key: { kind: "instruction", name: "rules" },
                sourceId: "source-a",
                contentSha: "rules-content",
              },
            ],
            renderedHash: "whole-hash",
            artifact: { existence: "missing", hash: null },
          },
        ],
      },
    ];
    const token = tokenForPlan(base);
    for (const mutation of mutations) expect(tokenForPlan(mutation)).not.toBe(token);

    const instructionWrite = {
      target: "claude" as const,
      contributions: [
        {
          key: { kind: "instruction" as const, name: "rules" },
          sourceId: "source-a",
          contentSha: "rules-content",
        },
      ],
      renderedHash: "whole-hash",
      artifact: { existence: "present" as const, hash: "disk-hash" },
    };
    const instructionPlan = { ...base, instructionWrites: [instructionWrite] };
    const contribution = instructionWrite.contributions[0];
    if (!contribution) throw new Error("fixture did not produce an instruction contribution");
    const instructionMutations: DeployPlan[] = [
      {
        ...instructionPlan,
        instructionWrites: [{ ...instructionWrite, target: "codex" }],
      },
      {
        ...instructionPlan,
        instructionWrites: [
          {
            ...instructionWrite,
            contributions: [
              {
                ...contribution,
                key: { kind: "instruction", name: "other-rules" },
              },
            ],
          },
        ],
      },
      {
        ...instructionPlan,
        instructionWrites: [
          {
            ...instructionWrite,
            contributions: [{ ...contribution, sourceId: "source-b" }],
          },
        ],
      },
      {
        ...instructionPlan,
        instructionWrites: [
          {
            ...instructionWrite,
            contributions: [{ ...contribution, contentSha: "other-content" }],
          },
        ],
      },
      {
        ...instructionPlan,
        instructionWrites: [{ ...instructionWrite, renderedHash: "other-whole-hash" }],
      },
      {
        ...instructionPlan,
        instructionWrites: [
          { ...instructionWrite, artifact: { existence: "missing", hash: null } },
        ],
      },
      {
        ...instructionPlan,
        instructionWrites: [
          { ...instructionWrite, artifact: { existence: "present", hash: "other-disk" } },
        ],
      },
      {
        ...instructionPlan,
        instructionWrites: [
          {
            ...instructionWrite,
            artifact: { existence: "error", hash: null, error: "read" },
          },
        ],
      },
    ];
    const instructionToken = tokenForPlan(instructionPlan);
    for (const mutation of instructionMutations) {
      expect(tokenForPlan(mutation)).not.toBe(instructionToken);
    }
  });
});
