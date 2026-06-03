// Effect-native Secrets module (ADR-0011, Phase 3a).
//
// `Secrets` is the Context.Service tag; `SecretsLive(opts)` a layer that owns
// the in-memory store (reading persistence at build in file mode). The legacy
// `createSecrets()` (index.ts) is a thin ManagedRuntime proxy over this service.
//
// The store is synchronous, so most verbs stay sync on the service; the typed
// `E` channel (errors.ts) covers the genuine failures — `requireAuth` (no
// credentials) and `refresh` (bad target). The OAuth `onRefresh` callback stays
// plain-async at the pi-ai boundary (ADR-0010): pi-ai calls it mid-completion
// and it must persist synchronously via the store.

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import { Context, Effect, Layer } from "effect";
import type { TypedEmitter } from "../../lib/typed-emitter.ts";
import type { AuthInput } from "../../model-gateway/types.ts";
import { loginOAuth } from "../oauth.ts";
import { SecretsPersistence } from "../persistence.ts";
import { type SecretsStore, createSecretsStore } from "../store.ts";
import {
  type ConfiguredProvider,
  type OAuthCredentials,
  SECRETS_FILE_VERSION,
  type SecretEntry,
  type SecretEvents,
  type SecretsFile,
} from "../types.ts";
import { SecretsNoCredentials, SecretsRefreshTarget } from "./errors.ts";

export type CreateSecretsOptions =
  | { mode: "memory"; initial?: SecretsFile }
  | { mode: "file"; path: string };

export type SecretsSvc = {
  getAuth(provider: string): AuthInput | undefined;
  setApiKey(provider: string, apiKey: string): void;
  startOAuthLogin(provider: string, callbacks: OAuthLoginCallbacks): Promise<SecretEntry>;
  remove(provider: string): void;
  list(): ConfiguredProvider[];
  status(provider: string): ConfiguredProvider["status"];
  events: TypedEmitter<SecretEvents>;
  // Effect surface (typed `E`):
  requireAuth(provider: string): Effect.Effect<AuthInput, SecretsNoCredentials>;
  refresh(
    provider: string,
    credentials: OAuthCredentials,
  ): Effect.Effect<void, SecretsRefreshTarget>;
};

export class Secrets extends Context.Service<Secrets, SecretsSvc>()("secrets/Secrets") {}

function openStore(opts: CreateSecretsOptions): SecretsStore {
  if (opts.mode === "memory") {
    return createSecretsStore(opts.initial ?? { version: SECRETS_FILE_VERSION, secrets: {} });
  }
  const persist = new SecretsPersistence(opts.path);
  return createSecretsStore(persist.read(), persist);
}

function buildSvc(store: SecretsStore): SecretsSvc {
  const getAuth = (provider: string): AuthInput | undefined => {
    const entry = store.get(provider);
    if (!entry) return undefined;
    if (entry.kind === "apiKey") return { kind: "apiKey", apiKey: entry.apiKey };
    return {
      kind: "oauth",
      credentials: {
        access: entry.credentials.access,
        refresh: entry.credentials.refresh,
        expires: entry.credentials.expires,
      },
      onRefresh: async (newCreds) => {
        store.refresh(provider, {
          access: newCreds.access,
          refresh: newCreds.refresh,
          expires: newCreds.expires,
        });
      },
    };
  };

  return {
    events: store.events,
    getAuth,
    setApiKey: (provider, apiKey) =>
      store.set(provider, { kind: "apiKey", apiKey, addedAt: Date.now() }),
    remove: (provider) => store.remove(provider),
    list: () => store.list(),
    status: (provider) => store.getStatus(provider),
    startOAuthLogin: async (provider, callbacks) => {
      const credentials = await loginOAuth(provider, callbacks);
      const entry: SecretEntry = { kind: "oauth", credentials, addedAt: Date.now() };
      store.set(provider, entry);
      return entry;
    },
    requireAuth: (provider) => {
      const auth = getAuth(provider);
      return auth ? Effect.succeed(auth) : Effect.fail(new SecretsNoCredentials({ provider }));
    },
    refresh: (provider, credentials) =>
      Effect.suspend(() => {
        // `snapshot()` reads without emitting a `secret.read` (that belongs to
        // genuine auth reads, not a refresh precondition check).
        const existing = store.snapshot().secrets[provider];
        if (!existing)
          return Effect.fail(new SecretsRefreshTarget({ provider, reason: "missing" }));
        if (existing.kind !== "oauth") {
          return Effect.fail(new SecretsRefreshTarget({ provider, reason: "not-oauth" }));
        }
        return Effect.sync(() => store.refresh(provider, credentials));
      }),
  };
}

export function SecretsLive(opts: CreateSecretsOptions): Layer.Layer<Secrets> {
  // The store + sync persistence own no long-lived handle, so release is a
  // no-op; `Layer.effect` over `acquireRelease` keeps the pattern uniform with
  // HiveDbLive and gives a future root one place to tear the runtime down.
  return Layer.effect(
    Secrets,
    Effect.acquireRelease(
      Effect.sync(() => buildSvc(openStore(opts))),
      () => Effect.void,
    ),
  );
}
