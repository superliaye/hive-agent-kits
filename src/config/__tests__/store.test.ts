import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { type ConfigSvc, configRuntime } from "../effect/config-live.ts";

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
  let config: ConfigSvc<TestConfig>;
  let dispose: () => void;

  beforeEach(() => {
    ({ svc: config, dispose } = configRuntime({
      mode: "memory",
      initial: TEST_DEFAULTS,
      schema: TestSchema,
    }));
  });

  afterEach(() => {
    dispose();
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

  // Regression: two interleaved set() calls each snapshot `current`
  // before either persistence.write lands, so the second writer
  // clobbers the first key. Fixed by the writeQueue chain in store.ts.
  test("concurrent set() calls do not clobber each other", async () => {
    const p1 = config.set("ui", { theme: "light" });
    const p2 = config.set("audit", { retention: { autoRotate: true, days: 30 } });
    await Promise.all([p1, p2]);
    expect(config.get("ui")).toEqual({ theme: "light" });
    expect(config.get("audit")).toEqual({ retention: { autoRotate: true, days: 30 } });
  });

  // The writeQueue must keep draining even after a rejected set(), so
  // a one-off schema failure can't strand subsequent valid writes.
  test("queue drains past a rejected set()", async () => {
    const bad = config.set("audit", {
      retention: { autoRotate: false, days: -1 },
    } as TestConfig["audit"]);
    const good = config.set("ui", { theme: "light" });
    await expect(bad).rejects.toThrow();
    await good;
    expect(config.get("ui")).toEqual({ theme: "light" });
  });

  // setPath: dotted-path setter for granular updates without
  // read-modify-write at the call site.
  describe("setPath (nested setter)", () => {
    test("updates a single nested leaf without touching siblings", async () => {
      await config.setPath("audit.retention.days", 30);
      expect(config.get("audit")).toEqual({
        retention: { autoRotate: false, days: 30 },
      });
    });

    test("validates the FULL merged tree, not just the leaf", async () => {
      await expect(config.setPath("audit.retention.days", -1)).rejects.toThrow();
      // Original value preserved
      expect(config.get("audit").retention.days).toBe(90);
    });

    test("empty path segment rejects", async () => {
      await expect(config.setPath("", 42)).rejects.toThrow();
    });

    test("single-segment path behaves like set(key, value)", async () => {
      await config.setPath("ui", { theme: "light" });
      expect(config.get("ui")).toEqual({ theme: "light" });
    });

    test("emits a single change event keyed by the top-level segment", async () => {
      const seen: Array<{ key: string; current: unknown }> = [];
      config.events.on("change", (e) => {
        seen.push({ key: e.key, current: e.current });
      });
      await config.setPath("audit.retention.days", 60);
      expect(seen.length).toBe(1);
      expect(seen[0]).toEqual({
        key: "audit",
        current: { retention: { autoRotate: false, days: 60 } },
      });
    });

    test("no-op when the value is unchanged", async () => {
      const seen: number[] = [];
      config.events.on("change", () => {
        seen.push(1);
      });
      await config.setPath("audit.retention.days", 90);
      expect(seen.length).toBe(0);
    });

    test("concurrent setPath calls don't clobber (same writeQueue)", async () => {
      const p1 = config.setPath("ui.theme", "light");
      const p2 = config.setPath("audit.retention.days", 30);
      await Promise.all([p1, p2]);
      expect(config.get("ui").theme).toBe("light");
      expect(config.get("audit").retention.days).toBe(30);
    });
  });
});
