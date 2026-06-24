// On-disk layout SSOT for the capability format (ADR-0024). How each kind is
// recognized on disk — the kind→dir/marker/suffix table — so a standalone tool
// or starter can enumerate capabilities without the daemon. Pure data; no fs.
//
// Two disk styles, discriminated by `style`:
//   - "folder": a directory holding a marker file IS the leaf (e.g. skills/foo/
//     SKILL.md). Marker-less dirs are @-group ancestors that flatten to the leaf.
//   - "file": one file per capability, named `<leaf><suffix>` in the kind dir.

import type { CapabilityKind } from "./identity.ts";

export type FolderLayout = { style: "folder"; dir: string; marker: string };
export type FileLayout = { style: "file"; dir: string; suffix: string };
export type KindLayout = FolderLayout | FileLayout;

export const capabilityLayout: Record<CapabilityKind, KindLayout> = {
  instruction: { style: "file", dir: "instructions", suffix: ".instructions.md" },
  skill: { style: "folder", dir: "skills", marker: "SKILL.md" },
  agent: { style: "folder", dir: "agents", marker: "AGENT.md" },
  plugin: { style: "file", dir: "plugins", suffix: ".plugin.md" },
  bundle: { style: "file", dir: "bundles", suffix: ".bundle.md" },
};
