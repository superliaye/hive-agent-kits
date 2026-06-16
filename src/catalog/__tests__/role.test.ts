import { describe, expect, test } from "bun:test";
import { isWorkerAgent } from "../role.ts";

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
