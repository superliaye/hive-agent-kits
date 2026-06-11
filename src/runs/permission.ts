// Default PermissionPort for the Run executor (F1).
//
// The full G2 Permission System (ADR-0003) is unbuilt; F1 ships only this
// narrow default so the dispatch point has a gate. When G2 lands it provides
// the PermissionPort and this default is dropped (AGENTS.md "discharge DI at
// the module boundary").
//
// Posture is command-presence-driven (the gate is tool-agnostic — it never
// inspects a tool's wire shape). A tool projects its own metadata via
// ToolHandler.describe; the executor passes the resulting `command` here:
//   - No command present → allow. A non-command-bearing tool (e.g. the N2 file
//     tools) gates with its own policy, not this command allowlist.
//   - Command present → deny-by-default against the per-Agent allowlist (the
//     typed HarnessManifest `commandAllowlist` field); an absent or empty
//     allowlist denies everything. A hard-coded destructive DENYLIST is an
//     INDEPENDENT floor: an allowlisted command that also matches the denylist
//     is still denied.

import type { CatalogPort, PermissionDecision, PermissionPort } from "./effect/ports.ts";

// Hard floor — commands that are never allowed regardless of the allowlist.
// Matched on the command basename (case-insensitive). Conservative, not
// exhaustive; G2 owns the real guardrail policy.
const DESTRUCTIVE_DENYLIST = new Set([
  "rm",
  "rmdir",
  "del",
  "format",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
]);

function basename(command: string): string {
  const parts = command.split(/[\\/]/);
  return (parts[parts.length - 1] ?? command).toLowerCase();
}

export function createDefaultPermission(catalog: CatalogPort): PermissionPort {
  return {
    async decide(input): Promise<PermissionDecision> {
      const command = input.command;
      if (command === undefined || command.length === 0) {
        return { outcome: "allow" };
      }

      // Hard floor first — independent of the allowlist.
      if (DESTRUCTIVE_DENYLIST.has(basename(command))) {
        return { outcome: "deny", reason: `destructive command denied: ${command}` };
      }

      const agent = catalog.get(input.agentId);
      const allowlist = agent?.commandAllowlist ?? [];
      if (allowlist.length === 0) {
        return {
          outcome: "deny",
          reason: "no run_shell allowlist configured for this agent (deny-by-default)",
        };
      }
      if (!allowlist.includes(command)) {
        return { outcome: "deny", reason: `command not in allowlist: ${command}` };
      }
      return { outcome: "allow" };
    },
  };
}
