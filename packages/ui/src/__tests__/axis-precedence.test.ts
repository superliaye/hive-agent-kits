// resolveAxis — the shared pick > default > fallback tier-precedence (P11).
// One pure helper now backs the composer's model/effort/backend axes; these
// tests pin the ordering and the per-axis offerability/fallback behaviour so the
// three axes can't drift back into hand-reimplemented copies.

import { describe, expect, test } from "bun:test";
import { resolveAxis } from "../axis-precedence.ts";

describe("resolveAxis — tier precedence", () => {
  test("a valid pick wins over default and fallback", () => {
    expect(
      resolveAxis<string>({
        pick: "picked",
        pickValid: () => true,
        def: "def",
        defOfferable: () => true,
        fallback: "fb",
      }),
    ).toBe("picked");
  });

  test("an invalid pick is skipped; offerable default wins", () => {
    expect(
      resolveAxis<string>({
        pick: "stale",
        pickValid: () => false,
        def: "def",
        defOfferable: () => true,
        fallback: "fb",
      }),
    ).toBe("def");
  });

  test("a non-offerable default falls through to the fallback (offerability rule)", () => {
    expect(
      resolveAxis<string>({
        pick: null,
        pickValid: () => true,
        def: "unrunnable",
        defOfferable: () => false,
        fallback: "native",
      }),
    ).toBe("native");
  });

  test("no pick and no default → fallback", () => {
    expect(
      resolveAxis<string>({
        pick: null,
        pickValid: () => true,
        def: null,
        defOfferable: () => true,
        fallback: "fb",
      }),
    ).toBe("fb");
  });

  test("fallback may itself be null (effort axis with no supported levels)", () => {
    expect(
      resolveAxis<string>({
        pick: null,
        pickValid: () => true,
        def: null,
        defOfferable: () => true,
        fallback: null,
      }),
    ).toBeNull();
  });
});
