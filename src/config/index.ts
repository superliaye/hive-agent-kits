// Public API for the Config module. See docs/adr/0006-configuration-module-design.md.

import type { ZodType } from "zod";
import { ConfigPersistence } from "./persistence.ts";
import { createConfigStore } from "./store.ts";
import type { Config, CreateConfigOptions } from "./types.ts";
import { deepMerge } from "./utils.ts";

export type { Config, ConfigChange, ConfigEvents, CreateConfigOptions } from "./types.ts";
export {
  APP_CONFIG_DEFAULTS,
  AppConfigSchema,
  type AppConfig,
} from "./schema.ts";

// Factory. For `mode: "memory"`, the store is volatile (good for tests).
// For `mode: "file"`, the YAML file at `path` is the source of truth; it is
// created with `defaults` if missing, and external edits hot-reload through
// a file watcher.
export function createConfig<S extends Record<string, unknown>>(
  opts: CreateConfigOptions<S>,
): Config<S> & { dispose(): void } {
  if (opts.mode === "memory") {
    return createConfigStore(opts.initial, opts.schema);
  }
  const persistence = new ConfigPersistence(opts.path);
  const initial = loadOrSeed(persistence, opts.defaults, opts.schema);
  return createConfigStore(initial, opts.schema, persistence);
}

function loadOrSeed<S>(persistence: ConfigPersistence, defaults: S, schema: ZodType<S>): S {
  if (!persistence.exists()) {
    persistence.write(defaults);
    return defaults;
  }
  const raw = persistence.read();
  const merged = deepMerge(defaults, raw);
  return schema.parse(merged);
}
