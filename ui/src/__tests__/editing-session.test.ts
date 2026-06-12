/**
 * Editing session state machine — pure, sub-second under bun test. The
 * React/Query wiring on top (useAgentEditor) is exercised end-to-end by
 * the Playwright e2e.
 */

import { describe, expect, test } from "bun:test";
import type { AgentDetail } from "../api.ts";
import {
  type BindingKind,
  computePending,
  hasPending,
  initialSession,
  sessionReducer,
} from "../editing-session.ts";

function makeAgent(overrides: Partial<AgentDetail["bindings"]> = {}): AgentDetail {
  return {
    agentId: "root",
    backend: "native",
    domain: "test",
    layer: "bundled",
    hasFork: false,
    isWorker: false,
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

describe("editing session", () => {
  test("fresh session has selected = baseline and no pending", () => {
    const s = initialSession(makeAgent());
    expect(computePending(s)).toEqual([]);
    expect(hasPending(s)).toBe(false);
  });

  test("toggle removes a name → unbind emitted", () => {
    let s = initialSession(makeAgent());
    s = sessionReducer(s, { type: "toggle", kind: "skill", name: "alpha" });
    expect(computePending(s)).toEqual([
      { kind: "skill", name: "alpha", action: "unbind" },
    ]);
    expect(hasPending(s)).toBe(true);
  });

  test("toggle adds a name → bind emitted", () => {
    let s = initialSession(makeAgent());
    s = sessionReducer(s, { type: "toggle", kind: "tool", name: "memory_read" });
    expect(computePending(s)).toEqual([
      { kind: "tool", name: "memory_read", action: "bind" },
    ]);
  });

  test("toggle twice returns to baseline (idempotent)", () => {
    let s = initialSession(makeAgent());
    s = sessionReducer(s, { type: "toggle", kind: "skill", name: "alpha" });
    s = sessionReducer(s, { type: "toggle", kind: "skill", name: "alpha" });
    expect(computePending(s)).toEqual([]);
  });

  test("discard clears pending without changing baseline", () => {
    let s = initialSession(makeAgent());
    s = sessionReducer(s, { type: "toggle", kind: "skill", name: "alpha" });
    s = sessionReducer(s, { type: "toggle", kind: "tool", name: "memory_read" });
    s = sessionReducer(s, { type: "discard" });
    expect(computePending(s)).toEqual([]);
    expect(s.baseline.skill.has("alpha")).toBe(true);
  });

  test("rebaseline replaces both baseline and selected (post-save reset)", () => {
    let s = initialSession(makeAgent());
    s = sessionReducer(s, { type: "toggle", kind: "skill", name: "alpha" });
    expect(hasPending(s)).toBe(true);

    const updated = makeAgent({ skills: ["beta"], tools: ["ask_user", "save_artifact"] });
    s = sessionReducer(s, { type: "rebaseline", agent: updated });
    expect(s.agentId).toBe("root");
    expect(s.baseline.skill).toEqual(new Set(["beta"]));
    expect(s.selected.skill).toEqual(new Set(["beta"]));
    expect(hasPending(s)).toBe(false);
  });

  test("rebaseline to a different agent retargets the session", () => {
    let s = initialSession(makeAgent());
    const other = makeAgent({ skills: ["x"] });
    other.agentId = "other-agent";
    s = sessionReducer(s, { type: "rebaseline", agent: other });
    expect(s.agentId).toBe("other-agent");
  });

  test("multi-kind batched diff", () => {
    let s = initialSession(makeAgent());
    s = sessionReducer(s, { type: "toggle", kind: "skill", name: "beta" });
    s = sessionReducer(s, { type: "toggle", kind: "tool", name: "ask_user" });
    s = sessionReducer(s, { type: "toggle", kind: "tool", name: "save_artifact" });
    const patches = computePending(s);
    const kinds = patches.map((p) => `${p.kind}:${p.action}:${p.name}`);
    expect(kinds).toContain("skill:unbind:beta");
    expect(kinds).toContain("tool:unbind:ask_user");
    expect(kinds).toContain("tool:bind:save_artifact");
    expect(patches).toHaveLength(3);
  });

  test("toggling all kinds works symmetrically", () => {
    let s = initialSession(makeAgent());
    const allKinds: BindingKind[] = ["skill", "snippet", "tool", "mcp"];
    for (const k of allKinds) {
      s = sessionReducer(s, { type: "toggle", kind: k, name: "x" });
    }
    const patches = computePending(s);
    expect(patches.every((p) => p.action === "bind" && p.name === "x")).toBe(true);
    expect(patches).toHaveLength(4);
  });

  test("sessionReducer is pure (does not mutate input state)", () => {
    const s = initialSession(makeAgent());
    const before = s.selected.skill;
    sessionReducer(s, { type: "toggle", kind: "skill", name: "alpha" });
    // Input state's set must be unchanged.
    expect(before.has("alpha")).toBe(true);
    expect(before.size).toBe(2);
  });
});
