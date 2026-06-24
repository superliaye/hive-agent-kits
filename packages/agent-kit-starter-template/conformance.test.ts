// CI self-validation for the Starter Source (ADR-0024, Q6=q6b). Runs inside the
// root `bun test` gate — no separate CI wiring. `validate` strictly gates only
// `skill` leaves today (skills are the only ratified per-kind schema), so a lone
// "zero problems" assertion would miss a malformed instruction/agent. The
// three-part assertion proves what it claims:
//   (i)  validate reports no skill conformance errors;
//   (ii) parse().problems is empty (the lenient walk's all-kind resilience check);
//   (iii) every authored capability is picked up as resolvable (not silently skipped).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse, validate } from "@hive/capability-schema-tools";
import { nodeFsSourceTree } from "@hive/capability-schema-tools/node";

const CAPABILITIES_ROOT = join(import.meta.dir, "capabilities");

// The capabilities authored under capabilities/, by kind+name. Keep in lockstep
// with the on-disk content — the test asserts each appears as resolvable.
const AUTHORED: ReadonlyArray<{ kind: string; name: string }> = [
  { kind: "instruction", name: "starter-conduct" },
  { kind: "skill", name: "summarize-changes" },
  { kind: "skill", name: "review-diff" },
  { kind: "agent", name: "starter-explorer" },
];

describe("agent-kit-starter-template conformance", () => {
  const tree = nodeFsSourceTree(CAPABILITIES_ROOT);

  test("(i) validate reports no skill conformance errors", () => {
    const result = validate(tree);
    expect(result.errors).toEqual([]);
    expect(result.conformant).toBe(true);
  });

  test("(ii) parse().problems is empty (covers all kinds)", () => {
    const { problems } = parse(tree);
    expect(problems).toEqual([]);
  });

  test("(iii) every authored capability is resolvable (picked up, not skipped)", () => {
    const { capabilities } = parse(tree);
    for (const want of AUTHORED) {
      const found = capabilities.find((c) => c.kind === want.kind && c.name === want.name);
      expect(found, `${want.kind}:${want.name} must be parsed`).toBeDefined();
      expect(found?.resolvable, `${want.kind}:${want.name} must be resolvable`).toBe(true);
    }
    // No extra/unexpected capabilities (e.g. an accidental plugin/bundle).
    expect(capabilities).toHaveLength(AUTHORED.length);
  });

  test("(iv) no plugin or bundle capability is shipped (offline-safe only)", () => {
    const { capabilities } = parse(tree);
    expect(capabilities.some((c) => c.kind === "plugin" || c.kind === "bundle")).toBe(false);
  });
});
