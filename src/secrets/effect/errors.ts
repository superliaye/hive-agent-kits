// Typed errors for the Secrets `E` channel (ADR-0011, Phase 3a). Narrow by
// `_tag`. The legacy `createSecrets()` surface keeps its sync/throw contract;
// these are for the Effect-native `SecretsLive` verbs.

import { Data } from "effect";

// A provider has no stored credentials. Surfaced by the Effect-native
// `requireAuth`. NOTE: the sync `getAuth` / `SecretsResolver` port still return
// `undefined` for absence — the Run executor treats that as a `no_credentials`
// RunEvent, a domain outcome, not an `E` failure.
export class SecretsNoCredentials extends Data.TaggedError("SecretsNoCredentials")<{
  readonly provider: string;
}> {}

// A refresh targeted a provider that is missing or not OAuth — replaces the two
// `throw new Error` in store.refresh on the Effect surface.
export class SecretsRefreshTarget extends Data.TaggedError("SecretsRefreshTarget")<{
  readonly provider: string;
  readonly reason: "missing" | "not-oauth";
}> {}
