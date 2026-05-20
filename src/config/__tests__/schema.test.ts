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
});
