import type { GatewayErrorCode } from "./types.ts";

const RETRYABLE: ReadonlySet<GatewayErrorCode> = new Set<GatewayErrorCode>([
  "rate_limited",
  "model_overloaded",
  "network",
  "server",
]);

export function isRetryable(code: GatewayErrorCode): boolean {
  return RETRYABLE.has(code);
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryable = isRetryable(code);
  }
}
