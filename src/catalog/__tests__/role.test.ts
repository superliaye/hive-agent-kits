import { describe, expect, test } from "bun:test";
import { backendAllowedForAgent, isWorkerAgent } from "../role.ts";

describe("isWorkerAgent", () => {
  test("root and agent-manager are not Workers", () => {
    expect(isWorkerAgent("root")).toBe(false);
    expect(isWorkerAgent("agent-manager")).toBe(false);
  });

  test("any other id is a Worker", () => {
    expect(isWorkerAgent("worker-1")).toBe(true);
    expect(isWorkerAgent("some-agent")).toBe(true);
  });
});

describe("backendAllowedForAgent (worker-only invariant, ADR-0015)", () => {
  test("undefined / null / native are always allowed, even for non-Workers", () => {
    expect(backendAllowedForAgent("root", undefined)).toBe(true);
    expect(backendAllowedForAgent("root", null)).toBe(true);
    expect(backendAllowedForAgent("root", "native")).toBe(true);
    expect(backendAllowedForAgent("agent-manager", "native")).toBe(true);
  });

  test("a non-native backend requires the agent be a Worker", () => {
    expect(backendAllowedForAgent("root", "claude-code")).toBe(false);
    expect(backendAllowedForAgent("agent-manager", "codex")).toBe(false);
    expect(backendAllowedForAgent("worker-1", "claude-code")).toBe(true);
    expect(backendAllowedForAgent("worker-1", "codex")).toBe(true);
  });
});
