import { describe, expect, test } from "bun:test";
import { BackendReadiness } from "../backend.ts";
import { Catalog, DeployResult, KitStateSchema, SelectionSchema } from "../kit.ts";

describe("kit contract", () => {
  test("a sample Catalog parses", () => {
    const sample = {
      entries: [
        {
          kind: "skill",
          name: "diagnose",
          description: "debug loop",
          group: "@loop",
          deployable: true,
        },
      ],
      presets: [
        {
          name: "default",
          description: "starter",
          defaultAgents: ["claude"],
          capabilities: {
            instructions: [],
            skills: ["diagnose"],
            agents: [],
            plugins: [],
            bundles: [],
          },
        },
      ],
      problems: [],
    };
    expect(() => Catalog.parse(sample)).not.toThrow();
  });

  test("a sample DeployResult parses", () => {
    const sample = {
      kitSha: "abc123",
      perKind: [{ kind: "skill", applied: ["diagnose"], failed: [] }],
      pruned: [{ kind: "agent", name: "stale" }],
      targets: ["claude", "codex"],
    };
    expect(() => DeployResult.parse(sample)).not.toThrow();
  });

  test("SelectionSchema requires at least one target", () => {
    const bad = { presets: [], add: {}, remove: {}, targets: [] };
    expect(SelectionSchema.safeParse(bad).success).toBe(false);
  });

  test("KitState accepts a null ledger", () => {
    const sample = {
      sync: { state: "up_to_date", sha: "abc", fetchedAt: 1 },
      ledger: null,
    };
    expect(() => KitStateSchema.parse(sample)).not.toThrow();
  });
});

describe("backend contract", () => {
  test("BackendReadiness composes BackendStatus", () => {
    const sample = {
      backend: "claude-code",
      installed: true,
      version: "1.2.3",
      reason: "ok",
      checkedAt: 1,
      provider: "anthropic",
      auth: { state: "cli-managed" },
    };
    expect(() => BackendReadiness.parse(sample)).not.toThrow();
  });
});
