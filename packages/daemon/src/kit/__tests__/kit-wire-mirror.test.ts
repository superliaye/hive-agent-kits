// Cross-package drift guard for the Kit wire shapes.
//
// The daemon owns the authoritative Selection Zod schema + the CapabilityKind /
// DeployTarget enums (src/kit/types.ts + targets.ts). The UI hand-mirrors them
// as plain TS (ui/src/api.ts: KitSelection, KitCapabilityKind, KitDeployTarget).
// Nothing in the build couples the two — pin them here.

import { describe, expect, test } from "bun:test";
import type {
  KitVerifyEntry,
  KitVerifyReport,
  KitVerifyStatus,
  KitVerifyTargetStatus,
} from "../../../../ui/src/kit-wire.ts";
import type { VerifyEntry, VerifyReport, VerifyStatus, VerifyTargetStatus } from "../types.ts";
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

  // Verify wire shape: the UI hand-mirror (KitVerify*) must stay structurally
  // identical to the daemon types (Verify*). These bidirectional assignments fail
  // to compile (`bun run typecheck`) the instant either side drifts.
  test("Verify wire types are bidirectionally assignable daemon<->UI", () => {
    const daemonStatus: VerifyStatus = "drifted";
    const uiStatus: KitVerifyStatus = daemonStatus;
    const roundtrip: VerifyStatus = uiStatus;
    expect(roundtrip).toBe("drifted");

    const daemonReport: VerifyReport = {
      entries: [
        {
          kind: "skill",
          name: "my-commit",
          targets: [
            { target: "claude", status: "present" },
            { target: "codex", status: "missing" },
          ],
        },
      ],
    };
    const asUi: KitVerifyReport = daemonReport;
    const backToDaemon: VerifyReport = asUi;
    expect(backToDaemon.entries[0]?.name).toBe("my-commit");

    // Element-level mirror (catches a field rename on either entry/target type).
    const t: VerifyTargetStatus = { target: "codex", status: "recorded" };
    const tUi: KitVerifyTargetStatus = t;
    const e: VerifyEntry = { kind: "plugin", name: "p", targets: [tUi] };
    const eUi: KitVerifyEntry = e;
    expect(eUi.targets[0]?.status).toBe("recorded");
  });
});
