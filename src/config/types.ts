// Config module types per ADR-0006.

import type { ZodType } from "zod";

// Public Config interface — three verbs per ADR-0006.
// Generic over the shape `S`; the production schema is `AppConfig` in schema.ts.
export type Config<S extends Record<string, unknown>> = {
  // Current value, synchronous, no I/O.
  get<K extends keyof S & string>(key: K): S[K];

  // Validate + persist + broadcast. Rejects on schema failure or persistence error.
  set<K extends keyof S & string>(key: K, value: S[K]): Promise<void>;

  // Fires immediately with the current value, then again on every change.
  // Returns a disposer.
  watch<K extends keyof S & string>(key: K, listener: (value: S[K]) => void): () => void;
};

// Per-key change record carried on the internal event stream and consumed by
// the audit subscriber (when wired) and by `watch()` listeners.
export type ConfigChange<
  S extends Record<string, unknown>,
  K extends keyof S & string = keyof S & string,
> = {
  key: K;
  previous: S[K];
  current: S[K];
  // Where the change came from. UI/CLI -> "set"; external editor -> "external".
  source: "set" | "external";
};

export type ConfigEvents<S extends Record<string, unknown>> = {
  change: ConfigChange<S>;
};

export type CreateConfigOptions<S extends Record<string, unknown>> =
  | { mode: "memory"; initial: S; schema: ZodType<S> }
  | { mode: "file"; path: string; defaults: S; schema: ZodType<S> };
