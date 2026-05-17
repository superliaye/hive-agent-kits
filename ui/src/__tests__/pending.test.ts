/**
 * Pending-changes diff math — pure, sub-second under bun test.
 */

import { describe, expect, test } from "bun:test";
import type { AgentDetail } from "../api.ts";
import {
  type BindingKind,
  computePending,
  initialSelected,
  togglePresent,
} from "../pending.ts";

function makeAgent(overrides: Partial<AgentDetail["bindings"]> = {}): AgentDetail {
  return {
    agentId: "root",
    backend: "native",
    domain: "test",
    layer: "bundled",
    hasFork: false,
    bindingCounts: { skills: 0, snippets: 0, tools: 0, mcp: 0 },
    bindings: {
      skills: ["alpha", "beta"],
      snippets: [],
      tools: ["ask_user"],
      mcp: [],
      ...overrides,
    },
    config: {},
    promptBody: "",
  };
}

describe("pending changes", () => {
  test("no changes when selection matches baseline", () => {
    const agent = makeAgent();
    const sel = initialSelected(agent);
    expect(computePending(agent, sel)).toEqual([]);
  });

  test("unbind emitted when a name is removed", () => {
    const agent = makeAgent();
    const sel = initialSelected(agent);
    sel.skill = togglePresent(sel.skill, "alpha");
    expect(computePending(agent, sel)).toEqual([
      { kind: "skill", name: "alpha", action: "unbind" },
    ]);
  });

  test("bind emitted when a name is added", () => {
    const agent = makeAgent();
    const sel = initialSelected(agent);
    sel.tool = togglePresent(sel.tool, "memory_read");
    expect(computePending(agent, sel)).toEqual([
      { kind: "tool", name: "memory_read", action: "bind" },
    ]);
  });

  test("multiple kinds at once", () => {
    const agent = makeAgent();
    const sel = initialSelected(agent);
    sel.skill = togglePresent(sel.skill, "beta");
    sel.tool = togglePresent(sel.tool, "ask_user");
    sel.tool = togglePresent(sel.tool, "save_artifact");
    const patches = computePending(agent, sel);
    const kinds = patches.map((p) => `${p.kind}:${p.action}:${p.name}`);
    expect(kinds).toContain("skill:unbind:beta");
    expect(kinds).toContain("tool:unbind:ask_user");
    expect(kinds).toContain("tool:bind:save_artifact");
    expect(patches).toHaveLength(3);
  });

  test("togglePresent is pure (returns a new set)", () => {
    const set = new Set(["a", "b"]);
    const next = togglePresent(set, "c");
    expect(set.has("c")).toBe(false);
    expect(next.has("c")).toBe(true);
    expect(next.has("a")).toBe(true);
  });

  test("toggling all kinds works symmetrically", () => {
    const agent = makeAgent();
    const sel = initialSelected(agent);
    const allKinds: BindingKind[] = ["skill", "snippet", "tool", "mcp"];
    for (const k of allKinds) {
      sel[k] = togglePresent(sel[k], "x");
    }
    const patches = computePending(agent, sel);
    expect(patches.every((p) => p.action === "bind" && p.name === "x")).toBe(true);
    expect(patches).toHaveLength(4);
  });
});
