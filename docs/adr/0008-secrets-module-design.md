# Secrets Module Design

## What this ADR records

How the **Secrets** module works in Hive v1: a deployment-level credential store at `~/.hive/secrets.json` that holds both API keys and OAuth credential triples, exposes ADR-0005-shaped `AuthInput` to callers (Run executor, model adapters), and orchestrates initial OAuth login via pi-ai's protocol primitives. Establishes the boundary between Secrets, Configuration, the Agent Harness, and the model adapter.

## Scope

In scope:

- Persisted credential store (apiKey + OAuth) at deployment level.
- OAuth login orchestration — Hive supplies UI callbacks; pi-ai owns the PKCE / token-exchange protocol.
- Wiring of pi-ai's `kind: "oauth"` branch in the model adapter — refresh-on-resolve via `getOAuthApiKey`, persistence via the `AuthInput.onRefresh` callback.
- Audit subscription for read / write / refresh / remove events.

Explicitly out of scope:

- Settings UI for entering keys or driving login flows. Part 5.
- Per-Agent secret overrides (OpenClaw's `copyToAgents` + `main` fallback). v2.
- True mid-stream OAuth refresh (a stream that runs past the *new* access token's lifetime). v1 surfaces the resulting pi-ai error; callers retry.

## Storage location: `~/.hive/secrets.json` (deployment-level)

A single JSON file at `~/.hive/secrets.json`. **Not** the per-agent `~/.hive/agents/<id>/auth-profiles.json` that ADR-0002's directory layout originally listed.

Why deployment-level for v1:

- Single-author, single-Anthropic-account is the dominant case. Replicating the same OAuth triple into N per-agent files is overhead users would actively work around.
- Per-agent overrides are still possible later: add `~/.hive/agents/<id>/secrets.json` that, when present, shadows the deployment file for that agent. The deployment-level file becomes OpenClaw's `main` fallback. Migrating into that future is additive — existing callers keep using `secrets.getAuth(provider)` and the lookup gains an agent-id parameter.
- ADR-0002's per-agent path was speculative; this ADR amends it. The path in the directory layout now refers to the future v2 override file.

## Encryption at rest: plaintext + `chmod 0600`

Same approach as `~/.hive/.token` (ADR-0002 §"User data location"). Threat model:

- An attacker with read access to the user's home directory already controls the authed Claude Code installation living next to it (`~/.claude/`). Encrypting Hive's copy is theater against that attacker.
- An attacker without that access reads neither.

Rejected:

- **OS keychain (macOS Keychain / Windows Credential Manager / libsecret).** Breaks the unified `~/.hive/` story (ADR-0002 line 178). Three per-platform code paths. Secrets become un-syncable across machines for a user who runs Hive on a desktop and a server. The portability mission (CONTEXT.md → "portable personal AI") loses.
- **File-encrypted with a master key.** Master-key derivation is itself a secret-storage problem (password? machine ID? TPM?). For a single-user personal-scale system that the user already has full-disk encryption around, the layering is net-negative.

`chmod 0600` is best-effort on Windows (the call succeeds but the ACL is not narrowed; per-user home is the boundary). Documented in the file.

## On-disk format: Zod-validated JSON with a `version` field

```jsonc
{
  "version": 1,
  "secrets": {
    "anthropic": {
      "kind": "oauth",
      "credentials": { "access": "...", "refresh": "...", "expires": 1730000000000 },
      "addedAt": 1730000000000,
      "refreshedAt": 1730003600000
    },
    "openai": {
      "kind": "apiKey",
      "apiKey": "sk-...",
      "addedAt": 1730000000000
    }
  }
}
```

Validated with a discriminated-union Zod schema at every read. AGENTS.md: "Zod at every external boundary"; the on-disk file is an external boundary (another tool, a manual edit, a future migration may produce it). Shape violations throw — silent drop would hide corruption.

`version` is for schema migrations. Bumping requires writing a migration function; no migration is required for v1.

## Atomic write

`write(file)` writes `secrets.json.tmp` → `chmod 0600` → `rename()` to `secrets.json`. A crash between steps cannot leave a partial file. The refresh path runs through the same atomic path — a network interruption mid-refresh cannot corrupt the on-disk state.

## Public API

```ts
type Secrets = {
  // Resolve a provider to an ADR-0005 AuthInput. The Run executor (Part 3)
  // calls this once per Run start, hands the AuthInput to the gateway.
  getAuth(provider: string): AuthInput | undefined;

  // CRUD for the Settings UI (Part 5).
  setApiKey(provider: string, apiKey: string): void;
  startOAuthLogin(provider: string, callbacks: OAuthLoginCallbacks): Promise<SecretEntry>;
  remove(provider: string): void;

  // For Settings UI presentation.
  list(): ConfiguredProvider[];
  status(provider: string): "ok" | "expired" | "missing";

  // Audit subscribes here.
  events: TypedEmitter<SecretEvents>;
};
```

The single `getAuth` verb hides the kind-specific resolution from callers: an apiKey provider returns `{kind: "apiKey", apiKey}`, an OAuth provider returns `{kind: "oauth", credentials, onRefresh}` with the `onRefresh` callback already bound to the store's atomic-write path. Adapters never see the persistence layer directly.

> Superseded by 4.2-A1 (read block-on-failure): `getAuth`, `setApiKey`, and `remove` are now async (`Promise<…>`). The audited read/write/refresh/remove verbs await their audit emit so a persist failure fails the originating op (ADR-0004); `getAuth` still returns entry-or-`undefined`, now wrapped in a Promise.

## OAuth login: wrap pi-ai's primitives

`@earendil-works/pi-ai/oauth` exports `getOAuthProvider(id)` which returns an `OAuthProviderInterface` with `login(callbacks)`, `refreshToken(credentials)`, `getApiKey(credentials)`. pi-ai already knows Anthropic's OAuth flow, OpenAI Codex's flow, GitHub Copilot's flow.

`loginOAuth(provider, callbacks)` in `src/secrets/oauth.ts` is a thin wrapper:

1. Look up the provider via `getOAuthProvider(id)`.
2. Call `piProvider.login(callbacks)`. Hive's callbacks supply UI behavior (open browser, prompt for code, etc.).
3. Validate the resulting credentials with Zod.
4. Return them. The Secrets index persists via `store.set(...)`.

`startOAuthLogin` on the public `Secrets` type composes that with persistence. Tests inject stub callbacks; the production Settings UI (Part 5) wires native dialogs.

Rejected: implementing OAuth protocols ourselves. pi-ai's coverage is broad and battle-tested; reinvention costs us provider parity at zero benefit.

## OAuth refresh: per-request, in the model adapter

The model adapter calls `resolveOAuthApiKey(provider, credentials, onRefresh)` (defined in `src/model-gateway/adapters/pi-ai.ts`) before each `streamSimple` call. That function:

1. Invokes pi-ai's `getOAuthApiKey(provider, {[provider]: credentials})`. pi-ai auto-refreshes if the access token is expired.
2. Detects refresh by comparing `access` strings — `newCredentials.access !== credentials.access` ⟹ refreshed.
3. If refreshed, awaits `onRefresh(newCredentials)`. The bound callback calls `store.refresh(provider, newCredentials)` which preserves `addedAt`, bumps `refreshedAt = now()`, and atomic-writes to disk.
4. Returns the apiKey for the call.

The function lives in the model adapter (not in `src/secrets/`) because the credentials→apiKey translation is pi-ai-API-specific. The Secrets module is provider-agnostic; making it pi-ai-aware would couple in the wrong direction.

**Mid-stream refresh** (the new access token also expires before the stream completes) is not handled in v1. Anthropic OAuth tokens last 1 hour; v1 streams complete in well under that. When this becomes a real problem, the fix lives in pi-ai (adding a refresh hook to its stream loop) or in the adapter (catching mid-stream auth errors and restarting).

## Audit events

Module-event names mirror the audit convention:

- `secret.read` — emitted by `store.get(provider)` when an entry exists.
- `secret.write` — emitted by `store.set(provider, entry)`. Payload: `{provider, kind, op: "create" | "update"}`.
- `secret.refresh` — emitted by `store.refresh(provider, newCredentials)`.
- `secret.remove` — emitted by `store.remove(provider)`.

**Payloads carry the provider key only — never the credential value or any ref to it.** ADR-0004's redaction backstop is satisfied because no payload ever contains the access token, refresh token, or apiKey string. The provider key (e.g. `"anthropic"`) is a public-ish identifier — knowing a user has Anthropic configured is not a secret.

Audit's subscribe pattern attaches in `wireSubscriptions` next to `config`, `gateway`, `registry`, `catalog`. The Secrets module never calls `audit.record(...)`.

## Module layout

```
src/secrets/
├── index.ts            # public API: createSecrets({mode})
├── persistence.ts      # atomic write + Zod-validated read
├── store.ts            # in-memory map + event emitter
├── oauth.ts            # loginOAuth wrapper around pi-ai's providers
├── types.ts            # Zod schemas, SecretEntry, SecretEvents
└── __tests__/
    ├── store.test.ts
    ├── persistence.test.ts
    └── index.test.ts
```

`resolveOAuthApiKey` lives in `src/model-gateway/adapters/pi-ai.ts` per the rationale above.

## Verification

This module is correct if, after implementation:

1. `createSecrets({mode: "memory"})` provides full CRUD without touching disk — used by every server test.
2. `createSecrets({mode: "file", path})` round-trips a written state through a fresh instance.
3. `getAuth(provider)` for an apiKey entry returns `{kind: "apiKey", apiKey}`; for an OAuth entry returns `{kind: "oauth", credentials, onRefresh}` where `onRefresh(newCreds)` persists.
4. The model adapter's `kind: "oauth"` branch resolves to a usable apiKey through `resolveOAuthApiKey`, and a refresh produced by pi-ai writes through to the on-disk file.
5. Audit captures every read / write / refresh / remove with provider keys but never with credential values.
6. A schema-violating `secrets.json` causes a clean throw at module construction — not a silent default.
7. The atomic-write path leaves no `secrets.json.tmp` on disk after a successful write.

## What this defers

- **Per-Agent secret overrides.** Open path: `~/.hive/agents/<id>/secrets.json` as an additive shadow file. API gains an agent-id parameter; the deployment-level file becomes the fallback.
- **OS keychain integration.** Open path: a swappable `SecretsPersistence` implementation (`KeychainPersistence` on macOS, `CredentialManagerPersistence` on Windows). The `Secrets` interface and `SecretEntry` shape don't change.
- **Mid-stream OAuth refresh.** Tracked above; v1 surfaces pi-ai's error.
- **Secret import from existing Claude Code auth.** Rejected for v1 — Hive owns its own OAuth state. A future "Import from Claude Code" Settings action could read `~/.claude/`'s credential store, but it requires committing to the cross-tool coupling.
- **`copyToAgents` portability flag** (OpenClaw shape). Surfaces when per-Agent overrides land.

## What this rejects (and why)

- **Per-agent storage from day one.** ADR-0002 listed the path but the design is `deferred (open)`. v1 doesn't need it; adding it now is over-engineering against a clear single-user model.
- **OS keychain.** Three-platform code paths + un-syncable secrets, for a threat model that doesn't shift after encrypting our own copy.
- **Implementing OAuth protocols ourselves.** pi-ai's coverage is broad; reinvention buys nothing.
- **Making the model adapter call into `src/secrets/`.** Dependency direction wrong. Adapter consumes `AuthInput`; the Run executor (Part 3) is the bridge that asks Secrets for the AuthInput.
- **Emitting credential values (or any ref to them) in audit events.** Even the provider key is the loosest payload we'll accept; the redaction backstop is enforced by code, not just convention.
