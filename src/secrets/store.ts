// In-memory store + event emitter for the Secrets module.
//
// The store holds the deployment-level secrets map. Persistence (when in
// "file" mode) is injected — the store calls `persist.write(...)` after
// every mutation. Read events fire even when the value is served from
// memory; audit needs to see all reads, not just disk hits.

import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { SecretsPersistence } from "./persistence.ts";
import {
  type ConfiguredProvider,
  type OAuthCredentials,
  SECRETS_FILE_VERSION,
  type SecretEntry,
  type SecretEvents,
  type SecretsFile,
} from "./types.ts";

export type SecretsStore = {
  /**
   * Get the stored entry for a provider, or undefined. Emits `secret.read`.
   * Returns the raw entry — callers needing an `AuthInput` (e.g. the
   * ModelGateway) should use `index.ts:getAuth(provider)` instead, which
   * handles the OAuth `onRefresh` callback binding.
   */
  get(provider: string): SecretEntry | undefined;

  /**
   * Store a new entry or replace an existing one. Emits `secret.write`
   * with `op: "create" | "update"`. Persists to disk in file mode.
   */
  set(provider: string, entry: SecretEntry): void;

  /**
   * Replace the credentials of an OAuth entry. Preserves `addedAt`, bumps
   * `refreshedAt` to now. Emits `secret.refresh`. Persists. Throws if the
   * entry doesn't exist or isn't OAuth — refreshing a missing/apiKey entry
   * is a caller bug.
   */
  refresh(provider: string, newCredentials: OAuthCredentials): void;

  /**
   * Delete an entry. Emits `secret.remove`. Persists. No-op if absent
   * (idempotent — a remove on a missing provider isn't worth surfacing).
   */
  remove(provider: string): void;

  /**
   * List every stored provider with its status. For Settings UI.
   * Note: status === "missing" is never returned here — that's only
   * surfaced from `getStatus(provider)` for providers with no entry.
   */
  list(): ConfiguredProvider[];

  /**
   * Status of a single provider — including "missing" when absent.
   */
  getStatus(provider: string): ConfiguredProvider["status"];

  /**
   * Snapshot of the underlying map. Used for round-trip tests and
   * future migrations. Not for normal callers.
   */
  snapshot(): SecretsFile;

  /**
   * Event stream — Audit subscribes via the standard pattern.
   */
  events: TypedEmitter<SecretEvents>;
};

export function createSecretsStore(
  initial: SecretsFile,
  persist?: SecretsPersistence,
  now: () => number = Date.now,
): SecretsStore {
  const map = new Map<string, SecretEntry>(Object.entries(initial.secrets));
  const events = new TypedEmitter<SecretEvents>();

  function snapshot(): SecretsFile {
    return {
      version: SECRETS_FILE_VERSION,
      secrets: Object.fromEntries(map),
    };
  }

  function flush(): void {
    if (persist) persist.write(snapshot());
  }

  function statusOf(entry: SecretEntry): ConfiguredProvider["status"] {
    if (entry.kind === "apiKey") return "ok";
    return entry.credentials.expires <= now() ? "expired" : "ok";
  }

  return {
    events,

    get(provider) {
      const entry = map.get(provider);
      if (entry) {
        void events.emit("secret.read", { provider, kind: entry.kind });
      }
      return entry;
    },

    set(provider, entry) {
      const op = map.has(provider) ? "update" : "create";
      map.set(provider, entry);
      flush();
      void events.emit("secret.write", { provider, kind: entry.kind, op });
    },

    refresh(provider, newCredentials) {
      const existing = map.get(provider);
      if (!existing) {
        throw new Error(`secrets: cannot refresh missing provider "${provider}"`);
      }
      if (existing.kind !== "oauth") {
        throw new Error(`secrets: cannot refresh non-oauth provider "${provider}"`);
      }
      map.set(provider, {
        kind: "oauth",
        credentials: newCredentials,
        addedAt: existing.addedAt,
        refreshedAt: now(),
      });
      flush();
      void events.emit("secret.refresh", { provider });
    },

    remove(provider) {
      if (!map.has(provider)) return;
      map.delete(provider);
      flush();
      void events.emit("secret.remove", { provider });
    },

    list() {
      const out: ConfiguredProvider[] = [];
      for (const [provider, entry] of map) {
        out.push({
          provider,
          kind: entry.kind,
          status: statusOf(entry),
          addedAt: entry.addedAt,
          ...(entry.kind === "oauth" && entry.refreshedAt !== undefined
            ? { refreshedAt: entry.refreshedAt }
            : {}),
        });
      }
      // Stable ordering by provider name — Settings UI uses this directly.
      out.sort((a, b) => a.provider.localeCompare(b.provider));
      return out;
    },

    getStatus(provider) {
      const entry = map.get(provider);
      if (!entry) return "missing";
      return statusOf(entry);
    },

    snapshot,
  };
}
