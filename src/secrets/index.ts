// Public API for the Secrets module.
//
// Per ADR-0002 §"Deferred decisions": Hive owns its own Secrets primitive
// (pi-ai is stateless for credentials at the library boundary). This
// module persists API keys and OAuth credential triples at the deployment
// level — `~/.hive/secrets.json` — and exposes:
//
//   - `getAuth(provider)`: returns the ADR-0005 `AuthInput` shape ready
//     to drop into a `CompletionInput`. For OAuth providers the returned
//     `onRefresh` callback is bound to this store, so mid-call refreshes
//     persist transparently.
//   - `startOAuthLogin(provider, callbacks)`: drives a pi-ai login flow,
//     stores the resulting credentials, and returns the stored entry.
//   - `set` / `remove` / `list` for direct CRUD by the Settings UI.
//
// The model adapter never imports this module; it consumes `AuthInput`
// through ModelGateway's `CompletionInput`. The Run module (Part 3) is
// the bridge: it asks the Secrets module for an `AuthInput`, drops it
// into the `complete()` call.

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import type { TypedEmitter } from "../lib/typed-emitter.ts";
import type { AuthInput } from "../model-gateway/types.ts";
import { loginOAuth } from "./oauth.ts";
import { SecretsPersistence } from "./persistence.ts";
import { type SecretsStore, createSecretsStore } from "./store.ts";
import {
  type ConfiguredProvider,
  SECRETS_FILE_VERSION,
  type SecretEntry,
  type SecretEvents,
  type SecretsFile,
} from "./types.ts";

export type CreateSecretsOptions =
  | { mode: "memory"; initial?: SecretsFile }
  | { mode: "file"; path: string };

export type Secrets = {
  /**
   * Resolve a provider to an ADR-0005 `AuthInput`. Returns `undefined` if
   * no entry is stored. For OAuth providers the embedded `onRefresh`
   * callback persists refreshed credentials back to the store.
   */
  getAuth(provider: string): AuthInput | undefined;

  /**
   * Store an apiKey for `provider`. Replaces any existing entry.
   */
  setApiKey(provider: string, apiKey: string): void;

  /**
   * Run a provider's OAuth login flow via pi-ai's primitives. Persists
   * the resulting credentials and returns the stored entry. Throws if
   * `provider` is not registered with pi-ai's OAuth registry.
   */
  startOAuthLogin(provider: string, callbacks: OAuthLoginCallbacks): Promise<SecretEntry>;

  /**
   * Delete the entry for `provider`. No-op if absent.
   */
  remove(provider: string): void;

  /**
   * List every configured provider with status. For Settings UI.
   */
  list(): ConfiguredProvider[];

  /**
   * Status of a single provider — including "missing" when no entry exists.
   */
  status(provider: string): ConfiguredProvider["status"];

  /**
   * Module event stream. Audit subscribes here.
   */
  events: TypedEmitter<SecretEvents>;
};

export function createSecrets(opts: CreateSecretsOptions): Secrets {
  let persist: SecretsPersistence | undefined;
  let initial: SecretsFile;
  if (opts.mode === "memory") {
    initial = opts.initial ?? { version: SECRETS_FILE_VERSION, secrets: {} };
  } else {
    persist = new SecretsPersistence(opts.path);
    initial = persist.read();
  }
  const store: SecretsStore = createSecretsStore(initial, persist);

  return {
    events: store.events,

    getAuth(provider) {
      const entry = store.get(provider);
      if (!entry) return undefined;
      if (entry.kind === "apiKey") {
        return { kind: "apiKey", apiKey: entry.apiKey };
      }
      // OAuth: bind `onRefresh` to this store so refreshed credentials
      // persist transparently. ADR-0005 §AuthInput defines this contract.
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
    },

    setApiKey(provider, apiKey) {
      store.set(provider, { kind: "apiKey", apiKey, addedAt: Date.now() });
    },

    async startOAuthLogin(provider, callbacks) {
      const credentials = await loginOAuth(provider, callbacks);
      const entry: SecretEntry = {
        kind: "oauth",
        credentials,
        addedAt: Date.now(),
      };
      store.set(provider, entry);
      return entry;
    },

    remove(provider) {
      store.remove(provider);
    },

    list() {
      return store.list();
    },

    status(provider) {
      return store.getStatus(provider);
    },
  };
}

export type { ConfiguredProvider, SecretEntry, SecretEvents, SecretsFile } from "./types.ts";
