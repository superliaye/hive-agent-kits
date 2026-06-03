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
// Implementation is Effect-native (`SecretsLive`, ADR-0011 Phase 3a); this
// factory is a thin `ManagedRuntime` proxy preserving the legacy surface for
// unmigrated consumers. The Effect-native typed-error verbs (`requireAuth`,
// `refresh`) are on the `Secrets` service, not this proxy.

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import { ManagedRuntime } from "effect";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { AuthInput } from "../model-gateway/types.ts";
import {
  type CreateSecretsOptions,
  SecretsLive,
  Secrets as SecretsTag,
} from "./effect/secrets-live.ts";
import type { ConfiguredProvider, SecretEntry, SecretEvents } from "./types.ts";

export type Secrets = {
  getAuth(provider: string): AuthInput | undefined;
  setApiKey(provider: string, apiKey: string): void;
  startOAuthLogin(provider: string, callbacks: OAuthLoginCallbacks): Promise<SecretEntry>;
  remove(provider: string): void;
  list(): ConfiguredProvider[];
  status(provider: string): ConfiguredProvider["status"];
  events: TypedEmitter<SecretEvents>;
  /** Tear down the underlying ManagedRuntime. Additive; the server doesn't call it today. */
  dispose(): void;
};

export function createSecrets(opts: CreateSecretsOptions): Secrets {
  const runtime = ManagedRuntime.make(SecretsLive(opts));
  // The layer's acquire is synchronous (in-memory store + sync persistence
  // read), so the service resolves synchronously — the legacy surface stays sync.
  const svc = runtime.runSync(SecretsTag);
  return {
    events: svc.events,
    getAuth: (provider) => svc.getAuth(provider),
    setApiKey: (provider, apiKey) => svc.setApiKey(provider, apiKey),
    startOAuthLogin: (provider, callbacks) => svc.startOAuthLogin(provider, callbacks),
    remove: (provider) => svc.remove(provider),
    list: () => svc.list(),
    status: (provider) => svc.status(provider),
    dispose: () => {
      void runtime.dispose();
    },
  };
}

export type { CreateSecretsOptions } from "./effect/secrets-live.ts";
export type { ConfiguredProvider, SecretEntry, SecretEvents, SecretsFile } from "./types.ts";
