import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CatalogLive } from "../../../catalog/effect/catalog-live.ts";
import { HiveDbLive } from "../../../db/effect/hive-db-live.ts";
import { SecretsLive } from "../../../secrets/effect/secrets-live.ts";
import { APP_CONFIG_DEFAULTS, AppConfigSchema } from "../../schema.ts";
import { Config, ConfigLive } from "../config-live.ts";

// Receipt for issue 4.1a: the four migrated module layers merge into one root
// Layer with no unsatisfied R, and the shared Config tag resolves typed to
// AppConfig through the merged runtime.
describe("root composition (4.1a)", () => {
  test("merges all four module layers and resolves a typed Config", async () => {
    const root = Layer.mergeAll(
      ConfigLive({ mode: "memory", initial: APP_CONFIG_DEFAULTS, schema: AppConfigSchema }),
      HiveDbLive(":memory:"),
      SecretsLive({ mode: "memory" }),
      CatalogLive(),
    );
    const runtime = ManagedRuntime.make(root);
    try {
      const httpPort = await runtime.runPromise(
        Effect.gen(function* () {
          const cfg = yield* Config;
          // `daemon` is typed (generic carried, not erased); httpPort is number.
          return cfg.get("daemon").httpPort;
        }),
      );
      expect(httpPort).toBe(3117);
    } finally {
      await runtime.dispose();
    }
  });
});
