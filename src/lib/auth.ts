// Provider auth input — what Secrets resolves and a backend adapter authenticates
// with. A cross-cutting primitive (Secrets produces it, the backend adapters
// consume it) homed in `lib/` so it survives the ModelGateway deletion.

export type AuthInput =
  | { kind: "apiKey"; apiKey: string }
  | {
      kind: "oauth";
      credentials: { access: string; refresh: string; expires: number };
      /**
       * Token-refresh contract — load-bearing for any consumer that handles
       * `kind: "oauth"`.
       *
       * When the consumer refreshes the access token (typically because it was
       * expired before the call), it MUST `await onRefresh(newCreds)` before
       * using the new apiKey. The caller (Secrets module) persists `newCreds` so
       * the next Run starts with an unexpired token. Consumers that skip this
       * call will appear to work in-memory but force re-login on every daemon
       * restart.
       *
       * See ADR-0008 (§OAuth refresh).
       */
      onRefresh: (newCreds: { access: string; refresh: string; expires: number }) => Promise<void>;
    };
