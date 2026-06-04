// Public API for the Config module. See docs/adr/0006-configuration-module-design.md.
//
// Implementation is Effect-native (`ConfigLive`, ADR-0011 Phase 3a): a reactive
// store whose state cell is a SubscriptionRef, owned by a ManagedRuntime. This
// factory is a thin proxy preserving the legacy `Config<S>` surface for
// unmigrated consumers (the server, the audit subscriber).

import { configRuntime } from "./effect/config-live.ts";
import type { Config, CreateConfigOptions } from "./types.ts";

export {
  APP_CONFIG_DEFAULTS,
  type AppConfig,
  AppConfigSchema,
} from "./schema.ts";
export type { Config, ConfigChange, ConfigEvents, CreateConfigOptions } from "./types.ts";

// For `mode: "memory"`, the store is volatile (good for tests). For
// `mode: "file"`, the YAML file at `path` is the source of truth; it is created
// with `defaults` if missing, and external edits hot-reload through a file
// watcher. `dispose()` tears down the ManagedRuntime (closing that watcher).
//
// Retained (§4.3): production resolves `Config` off the root runtime; this proxy
// stays for the plain-async legacy-surface suites (`config/__tests__/store.test.ts`,
// `persistence.test.ts`). Delete it only when those migrate to `ConfigLive`.
export function createConfig<S extends Record<string, unknown>>(
  opts: CreateConfigOptions<S>,
): Config<S> & { dispose(): void } {
  const { svc, dispose } = configRuntime(opts);
  return {
    get: svc.get,
    set: svc.set,
    setPath: svc.setPath,
    watch: svc.watch,
    events: svc.events,
    dispose,
  };
}
