// Cross-package drift guard for the Kit wire shapes.
//
// The daemon owns the authoritative Selection Zod schema + the CapabilityKind /
// DeployTarget enums (src/kit/types.ts + targets.ts). The UI hand-mirrors them
// as plain TS (ui/src/api.ts: KitSelection, KitCapabilityKind, KitDeployTarget).
// Nothing in the build couples the two — pin them here.

import { describe, expect, test } from "bun:test";
import { CapabilityKind, SelectionSchema } from "../types.ts";

describe("Kit wire mirror (drift guard)", () => {
  test("a fully-populated UI-shaped KitSelection parses against the daemon Zod schema", () => {
    const uiShaped = {
      presets: ["engineering"],
      add: { instructions: ["core"], skills: ["my-commit"], agents: [], plugins: [], bundles: [] },
      remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
      targets: ["claude", "codex"],
    };
    expect(() => SelectionSchema.parse(uiShaped)).not.toThrow();
  });

  test("Selection requires at least one target (the UI invariant)", () => {
    const noTargets = {
      presets: [],
      add: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
      remove: { instructions: [], skills: [], agents: [], plugins: [], bundles: [] },
      targets: [],
    };
    expect(SelectionSchema.safeParse(noTargets).success).toBe(false);
  });

  test("CapabilityKind options equal the UI literal union", () => {
    const UI_KINDS = ["instruction", "skill", "agent", "plugin", "bundle"] as const;
    expect(new Set(CapabilityKind.options)).toEqual(new Set(UI_KINDS));
  });

  test("Selection target options equal the UI deploy-target union", () => {
    const UI_TARGETS = ["claude", "codex"] as const;
    expect(new Set(SelectionSchema.shape.targets.element.options)).toEqual(new Set(UI_TARGETS));
  });
});
