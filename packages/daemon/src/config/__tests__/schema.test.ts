import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configRuntime } from "../effect/config-live.ts";
import { ConfigPersistence } from "../persistence.ts";
import { APP_CONFIG_DEFAULTS, AppConfigSchema } from "../schema.ts";

describe("AppConfigSchema", () => {
  test("APP_CONFIG_DEFAULTS validates against the schema", () => {
    const parsed = AppConfigSchema.parse(APP_CONFIG_DEFAULTS);
    expect(parsed).toEqual(APP_CONFIG_DEFAULTS);
  });

  test("developer.allowRealHomeDeploy defaults to false", () => {
    expect(APP_CONFIG_DEFAULTS.developer.allowRealHomeDeploy).toBe(false);
    const parsed = AppConfigSchema.parse(APP_CONFIG_DEFAULTS);
    expect(parsed.developer.allowRealHomeDeploy).toBe(false);
  });

  test("working-tree Source roots default to an empty allowlist", () => {
    expect(APP_CONFIG_DEFAULTS.sources.workingTreeRoots).toEqual([]);
    expect(
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        sources: { workingTreeRoots: ["/home/leon.ye/universe"] },
      }).sources.workingTreeRoots,
    ).toEqual(["/home/leon.ye/universe"]);
  });

  // Forward-compat: an existing on-disk config written before `developer`
  // existed must backfill from defaults, not be rejected. The file-mode load
  // path (loadOrSeed → deepMerge(defaults, raw) → schema.parse) is what
  // guarantees this, so exercise it end to end.
  describe("forward-compatible load (missing developer key)", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "hive-config-fwd-"));
      path = join(dir, "config.yaml");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("an on-disk config without `developer` loads with the default backfilled", () => {
      // Write a config that pre-dates the developer slice — every other key
      // present, `developer` absent.
      const { developer: _omitted, ...legacy } = APP_CONFIG_DEFAULTS;
      new ConfigPersistence(path).write(legacy);

      const { svc, dispose } = configRuntime({
        mode: "file",
        path,
        defaults: APP_CONFIG_DEFAULTS,
        schema: AppConfigSchema,
      });
      try {
        // Loaded, not rejected; the missing slice is backfilled to the default.
        expect(svc.get("developer")).toEqual({ allowRealHomeDeploy: false });
      } finally {
        dispose();
      }
    });
  });

  test("rejects invalid retention.days (zero, negative, float)", () => {
    expect(() =>
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        audit: { retention: { autoRotate: false, days: 0, archiveTo: "rotate" } },
      }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        audit: { retention: { autoRotate: false, days: -5, archiveTo: "rotate" } },
      }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        audit: { retention: { autoRotate: false, days: 1.5, archiveTo: "rotate" } },
      }),
    ).toThrow();
  });

  test("rejects unknown enum values", () => {
    expect(() =>
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        audit: { retention: { autoRotate: false, days: 90, archiveTo: "purge" } },
      }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        appearance: { ...APP_CONFIG_DEFAULTS.appearance, mode: "neon" },
      }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({
        ...APP_CONFIG_DEFAULTS,
        daemon: { httpPort: 3117, logLevel: "verbose" },
      }),
    ).toThrow();
  });

  test("rejects missing required keys", () => {
    expect(() => AppConfigSchema.parse({ audit: APP_CONFIG_DEFAULTS.audit })).toThrow();
  });

  // The HTTP route at /api/appearance Zod-checks its body before calling
  // config.set; a hand-edited config.yaml however hits the inner schema
  // directly via reloadFromDisk → schema.parse. These cover that path.
  describe("appearance subtree", () => {
    test("rejects fontUiSize above 48 (hand-edited config)", () => {
      expect(() =>
        AppConfigSchema.parse({
          ...APP_CONFIG_DEFAULTS,
          appearance: {
            ...APP_CONFIG_DEFAULTS.appearance,
            light: { fontUiSize: 999 },
          },
        }),
      ).toThrow();
    });

    test("rejects negative contrast", () => {
      expect(() =>
        AppConfigSchema.parse({
          ...APP_CONFIG_DEFAULTS,
          appearance: {
            ...APP_CONFIG_DEFAULTS.appearance,
            dark: { contrast: -5 },
          },
        }),
      ).toThrow();
    });

    test("rejects contrast above 100", () => {
      expect(() =>
        AppConfigSchema.parse({
          ...APP_CONFIG_DEFAULTS,
          appearance: {
            ...APP_CONFIG_DEFAULTS.appearance,
            dark: { contrast: 101 },
          },
        }),
      ).toThrow();
    });

    test("rejects unknown ThemeConfig fields (strict schema)", () => {
      expect(() =>
        AppConfigSchema.parse({
          ...APP_CONFIG_DEFAULTS,
          appearance: {
            ...APP_CONFIG_DEFAULTS.appearance,
            light: { surprise: true },
          },
        }),
      ).toThrow();
    });

    test("rejects unknown reduceMotion value", () => {
      expect(() =>
        AppConfigSchema.parse({
          ...APP_CONFIG_DEFAULTS,
          appearance: { ...APP_CONFIG_DEFAULTS.appearance, reduceMotion: "always" },
        }),
      ).toThrow();
    });
  });
});
