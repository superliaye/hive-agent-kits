// Loader for HARNESS.md files. Resolves bundled + runtime forks per ADR-0007.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessManifest } from "../capabilities/schemas.ts";
import { bundled, runtime } from "../lib/paths.ts";
import type { Agent } from "./types.ts";

export type LoaderError = { path: string; message: string };

export type LoaderResult = {
  agents: Agent[];
  errors: LoaderError[];
};

function readFrontmatter(path: string): { fm: unknown; body: string } {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match || match[1] === undefined) {
    throw new Error("no YAML frontmatter");
  }
  return { fm: parseYaml(match[1]), body: match[2] ?? "" };
}

function listSubdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => {
    try {
      return statSync(join(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function formatIssues(issues: Array<{ path: (string | number)[]; message: string }>): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function loadAgent(
  agentId: string,
  path: string,
  layer: "bundled" | "runtime",
  hasFork: boolean,
): Agent | LoaderError {
  try {
    const { fm, body } = readFrontmatter(path);
    const result = HarnessManifest.safeParse(fm);
    if (!result.success) return { path, message: formatIssues(result.error.issues) };
    if (result.data.agentId !== agentId) {
      return { path, message: `agentId '${result.data.agentId}' != folder '${agentId}'` };
    }
    return {
      agentId: result.data.agentId,
      backend: result.data.backend,
      domain: result.data.domain,
      bindings: result.data.bindings,
      config: result.data.config,
      promptBody: body,
      layer,
      hasFork,
      path,
    };
  } catch (err) {
    return { path, message: err instanceof Error ? err.message : String(err) };
  }
}

// Scan both tiers and resolve runtime > bundled. Returns the resolved Agent
// list; agents with malformed manifests on both layers are skipped (errors
// returned alongside).
export function scanAll(): LoaderResult {
  const errors: LoaderError[] = [];
  const bundledIds = new Set(listSubdirs(bundled.agentsDir()));
  const runtimeIds = new Set(listSubdirs(runtime.agentsDir()));
  const allIds = new Set([...bundledIds, ...runtimeIds]);

  const agents: Agent[] = [];

  for (const id of allIds) {
    const runtimePath = join(runtime.agent(id), "HARNESS.md");
    const bundledPath = join(bundled.agent(id), "HARNESS.md");
    const runtimeHas = existsSync(runtimePath);
    const bundledHas = existsSync(bundledPath);
    const hasFork = runtimeHas;
    let forkError: string | undefined;

    if (runtimeHas) {
      const r = loadAgent(id, runtimePath, "runtime", hasFork);
      if ("agentId" in r) {
        agents.push(r);
        continue;
      }
      errors.push(r);
      // Surface to the UI: the runtime fork failed to parse and we'll fall
      // back to bundled. Without this the user has no signal their edits
      // are being ignored.
      forkError = r.message;
    }
    if (bundledHas) {
      const r = loadAgent(id, bundledPath, "bundled", hasFork);
      if ("agentId" in r) {
        agents.push(forkError ? { ...r, forkError } : r);
        continue;
      }
      errors.push(r);
    }
  }

  return { agents, errors };
}
