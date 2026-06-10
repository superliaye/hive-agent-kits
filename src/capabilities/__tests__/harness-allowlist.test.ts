// The `commandAllowlist` field on HarnessManifest is strictly additive (F1):
// existing manifests without it stay valid, and a manifest with it parses. Pins
// the additivity contract so a future widening doesn't silently break old
// manifests (and so review can confirm no collision with F2's HarnessManifest
// work).

import { describe, expect, test } from "bun:test";
import { HarnessManifest } from "../schemas.ts";

const base = {
  agentId: "test-agent",
  backend: "native",
  domain: "test",
  bindings: { skills: [], snippets: [], tools: ["run_shell"], mcp: [] },
  config: {},
};

describe("HarnessManifest.commandAllowlist (additive, F1)", () => {
  test("parses WITHOUT the field (existing manifests stay valid)", () => {
    const r = HarnessManifest.safeParse(base);
    expect(r.success).toBe(true);
  });

  test("parses WITH the field", () => {
    const r = HarnessManifest.safeParse({ ...base, commandAllowlist: ["node", "echo"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.commandAllowlist).toEqual(["node", "echo"]);
  });

  test("rejects a non-array allowlist", () => {
    const r = HarnessManifest.safeParse({ ...base, commandAllowlist: "node" });
    expect(r.success).toBe(false);
  });
});
