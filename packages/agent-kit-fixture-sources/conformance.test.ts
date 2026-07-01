import { describe, expect, test } from "bun:test";
import { parse, validate } from "@hive/capability-schema-tools";
import { capabilitiesRoot } from "@hive/capability-schema-tools/node";

const SOURCES = ["alpha", "beta", "gamma"] as const;

describe("agent-kit-fixture-sources conformance", () => {
  for (const source of SOURCES) {
    test(`${source} is conformant Source-layout content`, () => {
      const tree = capabilitiesRoot(`${import.meta.dir}/sources/${source}`);
      const validation = validate(tree);
      const parsed = parse(tree);
      expect(validation.errors).toEqual([]);
      expect(validation.conformant).toBe(true);
      expect(parsed.problems).toEqual([]);
      expect(parsed.capabilities.length).toBeGreaterThanOrEqual(10);
      for (const kind of ["instruction", "skill", "agent", "plugin", "bundle"]) {
        expect(
          parsed.capabilities.some((cap) => cap.kind === kind && cap.resolvable),
          `${source} should include ${kind}`,
        ).toBe(true);
      }
    });
  }
});
