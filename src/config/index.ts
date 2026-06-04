// Public API for the Config module. See docs/adr/0006-configuration-module-design.md.
//
// Implementation is Effect-native (`ConfigLive`, ADR-0011 Phase 3a): a reactive
// store whose state cell is a SubscriptionRef, owned by a ManagedRuntime.
// Production resolves the `Config` service off the root `ManagedRuntime`
// (`createServer()`); the generic-schema test suites build it via
// `configRuntime()`. This barrel re-exports the legacy `Config<S>` surface type
// (which `server/`/`routes.ts` type on), the AppConfig schema, and the module's
// types. The legacy `createConfig()` proxy was deleted in §4.3.

export {
  APP_CONFIG_DEFAULTS,
  type AppConfig,
  AppConfigSchema,
} from "./schema.ts";
export type { Config, ConfigChange, ConfigEvents, CreateConfigOptions } from "./types.ts";
