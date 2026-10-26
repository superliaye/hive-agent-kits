// Content hashing of deployed artifacts — the SINGLE hash function shared by
// Deploy staging and recovery (deploy-coordinator.ts) and the Overview's
// would-deploy and on-disk observations (overview.ts). One hash so drift
// detection can never false-positive on an incompatible second algorithm.
//
// Each function hashes what deploy ACTUALLY wrote to disk for a kind under a
// target, matching Deploy's write semantics exactly:
//   skill       — stable hash over the deployed file-set (sorted relative paths,
//                 exec bits, and bytes); the on-disk folder already includes the
//                 Codex sidecar.
//   agent       — hash of the rendered .md (claude) / .toml (codex) file bytes.
//   instruction — hash of the written whole-file body (CLAUDE.md / AGENTS.md).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployTarget, DeployTargets } from "../targets.ts";
import { type SkillFile, skillFileMode } from "./transforms.ts";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Stable hash of a skill file-set: sort by relative path, join `${rel}\n` + bytes
// with a NUL separator. That is the encoding text-only skills always hashed
// with, so their hashes held when files became bytes; an executable adds a mode
// marker (a path holds no NUL), so an exec bit change is a change. Rendered and
// deployed skill hashes both go through here.
export function hashSkillFiles(files: readonly SkillFile[]): string {
  const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = createHash("sha256");
  sorted.forEach((f, index) => {
    if (index > 0) hash.update("\0");
    hash.update(f.mode === 0o755 ? `${f.rel}\u0000755\n` : `${f.rel}\n`);
    hash.update(f.bytes);
  });
  return hash.digest("hex");
}

// The on-disk skills root for a target: claude skills live under claudeHome/skills,
// codex skills under agentsHome/skills.
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
  const files: SkillFile[] = [];
  const walk = (d: string, base: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) {
        files.push({ rel, mode: skillFileMode(lstatSync(full).mode), bytes: readFileSync(full) });
      }
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
