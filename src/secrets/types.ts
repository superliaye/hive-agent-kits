// Secrets module — types + Zod schemas.
//
// Disk shape (`~/.hive/secrets.json`):
//
//   {
//     "version": 1,
//     "secrets": {
//       "anthropic": {
//         "kind": "oauth",
//         "credentials": { "access": "...", "refresh": "...", "expires": 1730000000000 },
//         "addedAt": 1730000000000,
//         "refreshedAt": 1730003600000
//       },
//       "openai": {
//         "kind": "apiKey",
//         "apiKey": "sk-...",
//         "addedAt": 1730000000000
//       }
//     }
//   }
//
// Zod-validated at the disk boundary (AGENTS.md: "Zod at every external boundary").
// `version` is for schema migrations; bump + add a migration function if the
// shape changes incompatibly.

import { z } from "zod";

export const OAuthCredentialsSchema = z
  .object({
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
  })
  .passthrough(); // pi-ai's OAuthCredentials allows extra fields; preserve them.

export type OAuthCredentials = z.infer<typeof OAuthCredentialsSchema>;

export const OAuthSecretEntrySchema = z.object({
  kind: z.literal("oauth"),
  credentials: OAuthCredentialsSchema,
  addedAt: z.number(),
  refreshedAt: z.number().optional(),
});

export const ApiKeySecretEntrySchema = z.object({
  kind: z.literal("apiKey"),
  apiKey: z.string().min(1),
  addedAt: z.number(),
});

export const SecretEntrySchema = z.discriminatedUnion("kind", [
  OAuthSecretEntrySchema,
  ApiKeySecretEntrySchema,
]);

export type SecretEntry = z.infer<typeof SecretEntrySchema>;

// Discriminated-union helpers so callers narrow without remembering the
// `kind` strings.
export type OAuthSecretEntry = z.infer<typeof OAuthSecretEntrySchema>;
export type ApiKeySecretEntry = z.infer<typeof ApiKeySecretEntrySchema>;

export const SECRETS_FILE_VERSION = 1;

export const SecretsFileSchema = z.object({
  version: z.literal(SECRETS_FILE_VERSION),
  secrets: z.record(z.string(), SecretEntrySchema),
});

export type SecretsFile = z.infer<typeof SecretsFileSchema>;

// Events emitted by the Secrets module. Audit subscribes via the standard
// subscribe pattern (ADR-0004). Payloads never carry credential values —
// only the provider key (which is itself a public-ish identifier) and
// minimal metadata.
export type SecretEvents = {
  "secret.read": { provider: string; kind: SecretEntry["kind"] };
  "secret.write": {
    provider: string;
    kind: SecretEntry["kind"];
    op: "create" | "update";
  };
  "secret.refresh": { provider: string };
  "secret.remove": { provider: string };
};

// Public status for the Settings UI's "Configured providers" list. The
// adapter that resolves auth uses `getAuth(provider)` directly — this is
// for human-facing presentation.
export type ConfiguredProvider = {
  provider: string;
  kind: SecretEntry["kind"];
  // "ok"      — credentials present and (for OAuth) not yet expired
  // "expired" — OAuth credentials past `expires` timestamp; needs refresh
  // "missing" — no entry stored for this provider (used when caller asks
  //             about a provider with no entry; not emitted by `list()`)
  status: "ok" | "expired" | "missing";
  addedAt: number;
  refreshedAt?: number;
};
