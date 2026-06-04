// Public API for the Secrets module.
//
// Hive owns its own Secrets primitive (pi-ai is stateless for credentials at
// the library boundary). This module persists API keys and OAuth credential
// triples at the deployment level — `~/.hive/secrets.json` — and exposes:
//
//   - `getAuth(provider)`: the ADR-0005 `AuthInput` shape ready to drop into a
//     `CompletionInput`. For OAuth providers the returned `onRefresh` callback
//     is bound to the store, so mid-call refreshes persist transparently.
//   - `startOAuthLogin(provider, callbacks)`: drives a pi-ai login flow.
//   - `set` / `remove` / `list` for direct CRUD by the Settings UI.
//
// Implementation is Effect-native (`SecretsLive`, ADR-0011 Phase 3a); consumers
// resolve the `Secrets` service off the root `ManagedRuntime` (`createServer()`).
// This barrel re-exports the legacy `Secrets` surface type (which `server/`
// projects the resolved `SecretsSvc` onto) plus the module's types. The legacy
// `createSecrets()` proxy was deleted in §4.3 — its test suites now build the
// service via `SecretsLive` + a `ManagedRuntime`.

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { AuthInput } from "../model-gateway/types.ts";
import type { ConfiguredProvider, SecretEntry, SecretEvents } from "./types.ts";

// The legacy `Secrets` surface: `SecretsSvc` minus the Effect-native typed-error
// verbs (`requireAuth`, `refresh`), plus a `dispose()`. `server/` projects the
// root-runtime-resolved `SecretsSvc` onto this shape; `routes.ts` types on it.
export type Secrets = {
  getAuth(provider: string): Promise<AuthInput | undefined>;
  setApiKey(provider: string, apiKey: string): Promise<void>;
  startOAuthLogin(provider: string, callbacks: OAuthLoginCallbacks): Promise<SecretEntry>;
  remove(provider: string): Promise<void>;
  list(): ConfiguredProvider[];
  status(provider: string): ConfiguredProvider["status"];
  events: TypedEmitter<SecretEvents>;
  dispose(): void;
};

export type { CreateSecretsOptions } from "./effect/secrets-live.ts";
export type { ConfiguredProvider, SecretEntry, SecretEvents, SecretsFile } from "./types.ts";
