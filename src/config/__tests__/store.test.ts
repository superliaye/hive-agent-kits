import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createConfig } from "../index.ts";
import type { Config } from "../types.ts";

const TestSchema = z.object({
  audit: z.object({
    retention: z.object({
      autoRotate: z.boolean(),
      days: z.number().int().positive(),
    }),
  }),
  ui: z.object({
    theme: z.enum(["light", "dark"]),
  }),
});

type TestConfig = z.infer<typeof TestSchema>;

const TEST_DEFAULTS: TestConfig = {
  audit: { retention: { autoRotate: false, days: 90 } },
  ui: { theme: "dark" },
};

describe("Config store (memory mode)", () => {
  let config: Config<TestConfig> & { dispose(): void };

  beforeEach(() => {
    config = createConfig({ mode: "memory", initial: TEST_DEFAULTS, schema: TestSchema });
  });

  test("get returns the current value", () => {
    expect(config.get("audit")).toEqual({ retention: { autoRotate: false, days: 90 } });
    expect(config.get("ui")).toEqual({ theme: "dark" });
  });

  test("set updates the in-memory value", async () => {
    await config.set("ui", { theme: "light" });
    expect(config.get("ui")).toEqual({ theme: "light" });
  });

  test("set rejects invalid values via schema", async () => {
    await expect(
      config.set("audit", { retention: { autoRotate: false, days: -1 } } as TestConfig["audit"]),
    ).rejects.toThrow();
    // Original value preserved
    expect(config.get("audit").retention.days).toBe(90);
  });

  test("set rejects invalid enum values", async () => {
    await expect(
      config.set("ui", { theme: "neon" as never } as TestConfig["ui"]),
    ).rejects.toThrow();
    expect(config.get("ui").theme).toBe("dark");
  });

  test("set with same value is a no-op (no change event)", async () => {
    const seen: TestConfig["ui"][] = [];
    const dispose = config.watch("ui", (v) => seen.push(v));
    seen.length = 0; // drop the initial-fire value
    await config.set("ui", { theme: "dark" }); // same as current
    expect(seen).toEqual([]);
    dispose();
  });

  test("watch fires immediately with current value", () => {
    const seen: TestConfig["ui"][] = [];
    config.watch("ui", (v) => seen.push(v));
    expect(seen).toEqual([{ theme: "dark" }]);
  });

  test("watch fires on set", async () => {
    const seen: TestConfig["ui"][] = [];
    config.watch("ui", (v) => seen.push(v));
    await config.set("ui", { theme: "light" });
    expect(seen).toEqual([{ theme: "dark" }, { theme: "light" }]);
  });

  test("watch only fires for its own key", async () => {
    const auditSeen: TestConfig["audit"][] = [];
    const uiSeen: TestConfig["ui"][] = [];
    config.watch("audit", (v) => auditSeen.push(v));
    config.watch("ui", (v) => uiSeen.push(v));
    auditSeen.length = 0;
    uiSeen.length = 0;
    await config.set("ui", { theme: "light" });
    expect(uiSeen).toHaveLength(1);
    expect(auditSeen).toHaveLength(0);
  });

  test("watch dispose stops further callbacks", async () => {
    const seen: TestConfig["ui"][] = [];
    const dispose = config.watch("ui", (v) => seen.push(v));
    seen.length = 0;
    dispose();
    await config.set("ui", { theme: "light" });
    expect(seen).toEqual([]);
  });

  test("listener throw propagates through set (block-on-failure)", async () => {
    // Listener throws on any value other than the initial "dark" — so the
    // initial fire passes cleanly, and the first set() that switches to
    // "light" triggers the throw.
    config.watch("ui", (v) => {
      if (v.theme !== "dark") throw new Error("listener veto");
    });
    await expect(config.set("ui", { theme: "light" })).rejects.toThrow("listener veto");
  });
});
