import { describe, expect, test } from "bun:test";
import {
  CapabilityKey,
  CapabilityKind,
  ContentSha,
  formatVersion,
} from "@hive/capability-schema";

describe("barrel exports (import-smoke)", () => {
  test("formatVersion is the string \"1\"", () => {
    expect(formatVersion).toBe("1");
  });

  test("the four identity exports are importable from the barrel", () => {
    expect(CapabilityKind).toBeDefined();
    expect(CapabilityKey).toBeDefined();
    expect(ContentSha).toBeDefined();
    expect(formatVersion).toBeDefined();
  });
});
