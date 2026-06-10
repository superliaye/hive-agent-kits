import { describe, expect, test } from "bun:test";
import { MODEL_FALLBACK } from "../defaults.ts";
import { resolve } from "../resolve.ts";

// Base input — no tiers set. Each test overrides exactly the tier under test so
// the precedence ordering (override > user default > harness config > fallback)
// is pinned independently per tier.
function base() {
  return {
    configuredModel: undefined,
    configuredEffort: undefined,
    userModelDefault: undefined,
    userEffortDefault: undefined,
    backend: "native" as const,
  };
}

describe("resolve — model tier (delegates to resolveAgentModel, ADR-0013)", () => {
  test("falls back to MODEL_FALLBACK when nothing is set", () => {
    const r = resolve(base());
    expect("failure" in r).toBe(false);
    if (!("failure" in r)) expect(r.model).toBe(MODEL_FALLBACK);
  });

  test("harness config.model used when nothing earlier resolves", () => {
    const r = resolve({ ...base(), configuredModel: "anthropic/claude-haiku-4-5" });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-haiku-4-5");
  });

  test("user default beats harness config.model", () => {
    const r = resolve({
      ...base(),
      configuredModel: "anthropic/claude-haiku-4-5",
      userModelDefault: "anthropic/claude-sonnet-4-6",
    });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-sonnet-4-6");
  });

  test("per-Run override beats the user default", () => {
    const r = resolve({
      ...base(),
      configuredModel: "anthropic/claude-haiku-4-5",
      userModelDefault: "anthropic/claude-sonnet-4-6",
      modelOverride: "anthropic/claude-opus-4-7",
    });
    if (!("failure" in r)) expect(r.model).toBe("anthropic/claude-opus-4-7");
  });

  test("malformed model surfaces a failure", () => {
    const r = resolve({ ...base(), configuredModel: "no-provider-here" });
    expect("failure" in r).toBe(true);
  });
});

describe("resolve — effort tier (preserves no-effort fallback)", () => {
  test("no effort anywhere → undefined (loop omits thinking)", () => {
    const r = resolve(base());
    if (!("failure" in r)) expect(r.effort).toBeUndefined();
  });

  test("harness config.thinkingEffort used when nothing earlier resolves", () => {
    const r = resolve({ ...base(), configuredEffort: "medium" });
    if (!("failure" in r)) expect(r.effort).toBe("medium");
  });

  test("unrecognized harness effort is ignored (stays undefined)", () => {
    const r = resolve({ ...base(), configuredEffort: "bogus" });
    if (!("failure" in r)) expect(r.effort).toBeUndefined();
  });

  test("user effort default beats harness config", () => {
    const r = resolve({ ...base(), configuredEffort: "low", userEffortDefault: "high" });
    if (!("failure" in r)) expect(r.effort).toBe("high");
  });

  test("per-Run effort override beats the user default", () => {
    const r = resolve({
      ...base(),
      configuredEffort: "low",
      userEffortDefault: "high",
      effortOverride: "xhigh",
    });
    if (!("failure" in r)) expect(r.effort).toBe("xhigh");
  });
});

describe("resolve — backend passthrough", () => {
  test("native passes through", () => {
    const r = resolve({ ...base(), backend: "native" });
    if (!("failure" in r)) expect(r.backend).toBe("native");
  });

  test("claude-code passes through unchanged", () => {
    const r = resolve({ ...base(), backend: "claude-code" });
    if (!("failure" in r)) expect(r.backend).toBe("claude-code");
  });

  test("codex passes through unchanged", () => {
    const r = resolve({ ...base(), backend: "codex" });
    if (!("failure" in r)) expect(r.backend).toBe("codex");
  });
});
