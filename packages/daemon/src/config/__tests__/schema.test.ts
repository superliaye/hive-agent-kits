import { describe, expect, test } from "bun:test";
import { APP_CONFIG_DEFAULTS, AppConfigSchema } from "../schema.ts";

describe("AppConfigSchema", () => {
  test("APP_CONFIG_DEFAULTS validates against the schema", () => {
    const parsed = AppConfigSchema.parse(APP_CONFIG_DEFAULTS);
    expect(parsed).toEqual(APP_CONFIG_DEFAULTS);
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
