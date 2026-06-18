// Cross-package drift guard for the BackendReadiness wire shape.
//
// The daemon owns the authoritative BackendReadiness Zod schema
// (src/backend-readiness/types.ts). The UI hand-mirrors it as plain TS
// (ui/src/api.ts). Nothing in the build couples the two — they can silently
// drift. This test pins them:
//   1. A fully-populated UI-shaped object parses against the daemon Zod schema.
//   2. The BackendAuthState option set equals the UI literal union.
//   3. Because the shape composes BackendStatus, the `reason` field equals
//      ProbeReasonCode's option set (health fields can't drift independently).

import { describe, expect, test } from "bun:test";
import { ProbeReasonCode } from "../../backend-probe/types.ts";
import { BackendAuthState, BackendReadiness } from "../../backend-readiness/index.ts";

describe("BackendReadiness wire mirror (drift guard)", () => {
  test("a fully-populated UI-shaped BackendReadiness parses against the daemon Zod schema", () => {
    const uiShaped = {
      backend: "claude-code",
      installed: true,
      version: "2.0.0",
      reason: "ok",
      checkedAt: 1700000000000,
      provider: "anthropic",
      auth: {
        state: "api-key",
        stored: {
          kind: "apiKey",
          status: "ok",
          addedAt: 1700000000000,
          refreshedAt: 1700000003600,
        },
      },
    };
    expect(() => BackendReadiness.parse(uiShaped)).not.toThrow();
  });

  test("a cli-managed oauth row parses (the honesty shape)", () => {
    const uiShaped = {
      backend: "codex",
      installed: false,
      version: null,
      reason: "not_installed",
      checkedAt: 1700000000000,
      provider: "openai-codex",
      auth: {
        state: "cli-managed",
        stored: { kind: "oauth", status: "expired", addedAt: 1700000000000 },
      },
    };
    expect(() => BackendReadiness.parse(uiShaped)).not.toThrow();
  });

  test("BackendAuthState options equal the UI literal union", () => {
    const UI_AUTH_STATES = ["api-key", "cli-managed"] as const;
    expect(new Set(BackendAuthState.options)).toEqual(new Set(UI_AUTH_STATES));
  });

  test("StoredSecretMeta kind/status options equal the UI literal unions", () => {
    // Pin the nested auth.stored enums the same way as auth.state, read off the
    // composed wire schema so an added kind/status can't drift past the UI mirror
    // (ui/src/api.ts StoredSecretMeta) silently.
    const stored = BackendReadiness.shape.auth.shape.stored.unwrap();
    const UI_KINDS = ["apiKey", "oauth"] as const;
    const UI_STATUSES = ["ok", "expired"] as const;
    expect(new Set(stored.shape.kind.options)).toEqual(new Set(UI_KINDS));
    expect(new Set(stored.shape.status.options)).toEqual(new Set(UI_STATUSES));
  });

  test("composed reason field equals ProbeReasonCode options (health can't drift)", () => {
    const reasonSchema = BackendReadiness.shape.reason;
    expect(new Set(reasonSchema.options)).toEqual(new Set(ProbeReasonCode.options));
  });
});
