// Content hashing of deployed artifacts — the SINGLE hash function shared by the
// Deploy Diff's `changed` detection (selection.ts), the integrity fingerprint
// sidecar (fingerprint.ts), and the on-disk verify pass (verify.ts). One hash so
// drift detection can never false-positive on an incompatible second algorithm.
//
// Each function hashes what deploy ACTUALLY wrote to disk for a kind under a
// target, matching the engine's write semantics exactly:
//   skill       — stable hash over the deployed file-set (sorted relative paths +
//                 bytes); the on-disk folder already includes the Codex sidecar.
//   agent       — hash of the rendered .md (claude) / .toml (codex) file bytes.
//   instruction — hash of the written whole-file body (CLAUDE.md / AGENTS.md).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployTarget, DeployTargets } from "../targets.ts";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Stable hash of a skill file-set: sort by relative path, join `${rel}\n${content}`
// with a NUL separator. Matches selection.ts renderedHash/deployedHash exactly.
export function hashSkillFiles(files: { rel: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
  return sha256(sorted.map((f) => `${f.rel}\n${f.content}`).join("\0"));
}

// The on-disk skills root for a target: claude skills live under claudeHome/skills,
// codex skills under agentsHome/skills (per the deploy engine).
function skillsRootFor(targets: DeployTargets, target: DeployTarget): string {
  return target === "claude" ? targets.claudeHome() : targets.agentsHome();
}

// The deployed skill folder for a name under a target.
export function deployedSkillDir(
  targets: DeployTargets,
  name: string,
  target: DeployTarget,
): string {
  return join(skillsRootFor(targets, target), "skills", name);
}

// The deployed agent file for a name under a target.
export function deployedAgentPath(
  targets: DeployTargets,
  name: string,
  target: DeployTarget,
): string {
  return target === "claude"
    ? join(targets.claudeHome(), "agents", `${name}.md`)
    : join(targets.codexHome(), "agents", `${name}.toml`);
}

// The deployed whole-file instruction path for a target.
export function deployedInstructionPath(targets: DeployTargets, target: DeployTarget): string {
  return target === "claude"
    ? join(targets.claudeHome(), "CLAUDE.md")
    : join(targets.codexHome(), "AGENTS.md");
}

// Hash a deployed skill folder on disk (recursive, all files incl. the sidecar).
// Returns null when the folder doesn't exist.
export function hashDeployedSkill(
  targets: DeployTargets,
  name: string,
  target: DeployTarget,
): string | null {
  const dir = deployedSkillDir(targets, name, target);
  if (!existsSync(dir)) return null;
  const files: { rel: string; content: string }[] = [];
  const walk = (d: string, base: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) files.push({ rel, content: readFileSync(full, "utf8") });
    }
  };
  walk(dir, "");
  return hashSkillFiles(files);
}

// Hash a deployed agent file on disk. Returns null when absent.
export function hashDeployedAgent(
  targets: DeployTargets,
  name: string,
  target: DeployTarget,
): string | null {
  const p = deployedAgentPath(targets, name, target);
  if (!existsSync(p)) return null;
  return sha256(readFileSync(p, "utf8"));
}

// Hash a deployed instruction whole-file on disk. Returns null when absent.
export function hashDeployedInstruction(
  targets: DeployTargets,
  target: DeployTarget,
): string | null {
  const p = deployedInstructionPath(targets, target);
  if (!existsSync(p)) return null;
  return sha256(readFileSync(p, "utf8"));
}
