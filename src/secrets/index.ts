// Public API for the Secrets module.
//
// Hive owns its own Secrets primitive. This module persists provider API keys at
// the deployment level — `~/.hive/secrets.json` — and exposes:
//
//   - `getAuth(provider)`: the `AuthInput` shape the SDK adapters consume (the
//     `apiKey` branch). When no Secret resolves, the SDK falls back to its own
//     ambient OS login (`~/.claude` from `claude login`, `~/.codex/auth.json`).
//   - `set` / `remove` / `list` for direct CRUD by the Settings UI.
//
// Implementation is Effect-native (`SecretsLive`, ADR-0011 Phase 3a); consumers
// resolve the `Secrets` service off the root `ManagedRuntime` (`createServer()`).
// This barrel re-exports the legacy `Secrets` surface type (which `server/`
// projects the resolved `SecretsSvc` onto) plus the module's types.

import type { AuthInput } from "../lib/auth.ts";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { ConfiguredProvider, SecretEvents } from "./types.ts";

// The legacy `Secrets` surface: `SecretsSvc` minus the Effect-native typed-error
// verbs (`requireAuth`, `refresh`), plus a `dispose()`. `server/` projects the
// root-runtime-resolved `SecretsSvc` onto this shape; `routes.ts` types on it.
export type Secrets = {
  getAuth(provider: string): Promise<AuthInput | undefined>;
  setApiKey(provider: string, apiKey: string): Promise<void>;
  remove(provider: string): Promise<void>;
  list(): ConfiguredProvider[];
  status(provider: string): ConfiguredProvider["status"];
  events: TypedEmitter<SecretEvents>;
  dispose(): void;
};

export type { CreateSecretsOptions } from "./effect/secrets-live.ts";
export type { ConfiguredProvider, SecretEntry, SecretEvents, SecretsFile } from "./types.ts";
