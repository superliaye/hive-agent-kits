// Typed error channel for the Sources module (AGENTS.md: errors are values in
// `E`). `Data.TaggedError`, mirroring `kit/effect/errors.ts`.

import { Data } from "effect";

// The registry holds no Source with this id.
export class SourceNotFound extends Data.TaggedError("SourceNotFound")<{
  readonly id: string;
}> {}

// A Source with this (normalized) origin already exists (active or not).
export class DuplicateOrigin extends Data.TaggedError("DuplicateOrigin")<{
  readonly origin: string;
}> {}

// A persistence fault while reading/writing the registry file.
export class SourceIoError extends Data.TaggedError("SourceIoError")<{
  readonly message: string;
}> {}
