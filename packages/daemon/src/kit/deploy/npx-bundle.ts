import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { DeployTarget } from "@hive/contract";
import type { DeployTargets } from "../targets.ts";
import { sha256 } from "./artifact-hash.ts";
import type { BundleMeta } from "./sources.ts";

const PINNED_GITHUB_TREE =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-fA-F]{40}(?:\/[^?#]*)?$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ManagedNpxBundleMeta = {
  package: string;
  skills: string[];
  verifyPaths: string[];
};

export type ManagedNpxBundleProbe = "all-present" | "all-absent" | "mixed";

type BundleHomes = Pick<DeployTargets, "claudeHome" | "agentsHome">;

function resolveVerifyPath(
  configured: string,
  target: DeployTarget,
  targets: BundleHomes,
): string | null {
  const prefix = target === "claude" ? "~/.claude/" : "~/.agents/";
  if (!configured.startsWith(prefix)) return null;
  const suffix = configured.slice(prefix.length);
  if (!suffix.startsWith("skills/") || suffix.length === "skills/".length) return null;
  if (suffix.includes("\\")) return null;
  const segments = suffix.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  const base = target === "claude" ? targets.claudeHome() : targets.agentsHome();
  const resolved = normalize(join(base, ...segments));
  const fromBase = relative(base, resolved);
  if (fromBase.length === 0 || fromBase.startsWith("..") || isAbsolute(fromBase)) return null;
  return resolved;
}

export function managedNpxBundleMeta(
  meta: BundleMeta,
  target: DeployTarget,
  targets: BundleHomes,
): ManagedNpxBundleMeta | null {
  if (meta.installerKind !== "npx-skills" || !PINNED_GITHUB_TREE.test(meta.pkg)) return null;
  if (meta.skills.length === 0 || meta.skills.some((skill) => !SKILL_NAME.test(skill))) return null;
  const configured = meta.verifyPaths[target];
  if (!configured || configured.length === 0) return null;
  const verifyPaths = configured.map((path) => resolveVerifyPath(path, target, targets));
  if (verifyPaths.some((path) => path === null)) return null;
  return {
    package: meta.pkg,
    skills: [...meta.skills],
    verifyPaths: verifyPaths.filter((path): path is string => path !== null),
  };
}

export function managedNpxBundleHash(meta: ManagedNpxBundleMeta, target: DeployTarget): string {
  return sha256(JSON.stringify([target, meta.package, meta.skills, meta.verifyPaths]));
}

export function probeManagedNpxBundle(meta: ManagedNpxBundleMeta): ManagedNpxBundleProbe {
  const present = meta.verifyPaths.filter((path) => existsSync(path)).length;
  if (present === 0) return "all-absent";
  if (present === meta.verifyPaths.length) return "all-present";
  return "mixed";
}
