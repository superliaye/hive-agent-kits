// Typed gateway failure for the Effect `E` channel. Mirrors the legacy
// `GatewayError` class (errors.ts) but as a Data.TaggedError value, narrowed
// by `_tag`. `toErrorEvent` maps it back to the in-band `error` GatewayEvent
// that the legacy AsyncIterable contract emits.

import { Data } from "effect";
import { isRetryable } from "../errors.ts";
import type { GatewayErrorCode, GatewayEvent } from "../types.ts";

export class GatewayFailure extends Data.TaggedError("GatewayFailure")<{
  readonly code: GatewayErrorCode;
  readonly message: string;
}> {
  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

export function toErrorEvent(failure: GatewayFailure): Extract<GatewayEvent, { type: "error" }> {
  return {
    type: "error",
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}
