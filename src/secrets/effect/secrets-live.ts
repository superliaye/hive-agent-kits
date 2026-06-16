// Effect-native Secrets module (ADR-0011, Phase 3a).
//
// `Secrets` is the Context.Service tag; `SecretsLive(opts)` a layer that owns
// the in-memory store (reading persistence at build in file mode). Consumers
// resolve this service off a `ManagedRuntime` (the root one in production, a
// per-test one in the suites).
//
// The audited store verbs (get/set/refresh/remove) are async + block-on-failure
// (4.2-A1): each awaits its event emit so an audit-persist failure fails the
// originating op, with mutating verbs emitting BEFORE committing. The typed
// `E` channel (errors.ts) covers the genuine domain failures — `requireAuth`
// (no credentials) and `refresh` (bad target); an audit-persist failure surfaces
// as an Effect defect (die), not a typed `E`.

import { Context, Effect, Layer } from "effect";
import type { AuthInput } from "../../lib/auth.ts";
import type { TypedEmitter } from "../../lib/typed-emitter.ts";
import { SecretsPersistence } from "../persistence.ts";
import { createSecretsStore, type SecretsStore } from "../store.ts";
import {
  type ConfiguredProvider,
  type OAuthCredentials,
  SECRETS_FILE_VERSION,
  type SecretEvents,
  type SecretsFile,
} from "../types.ts";
import { SecretsNoCredentials, SecretsRefreshTarget } from "./errors.ts";

export type CreateSecretsOptions =
  | { mode: "memory"; initial?: SecretsFile }
  | { mode: "file"; path: string };

export type SecretsSvc = {
  getAuth(provider: string): Promise<AuthInput | undefined>;
  setApiKey(provider: string, apiKey: string): Promise<void>;
  remove(provider: string): Promise<void>;
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
  const getAuth = async (provider: string): Promise<AuthInput | undefined> => {
    const entry = await store.get(provider);
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
        await store.refresh(provider, {
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
    requireAuth: (provider) =>
      Effect.flatMap(
        // getAuth awaits the `secret.read` emit; an audit-persist failure on
        // the read rejects this promise and surfaces as an Effect defect
        // (block-on-failure on reads too, 4.2-A1 / ADR-0004).
        Effect.promise(() => getAuth(provider)),
        (auth) =>
          auth ? Effect.succeed(auth) : Effect.fail(new SecretsNoCredentials({ provider })),
      ),
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
        // `store.refresh` is async now; an audit-persist failure rejects it.
        // Effect.promise (not Effect.sync — async; not tryPromise — the only
        // rejection is the loud audit-persist defect we intend to surface as a
        // die, keeping the typed `E` SecretsRefreshTarget-only). 4.2-A1, Q2.
        return Effect.promise(() => store.refresh(provider, credentials));
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
