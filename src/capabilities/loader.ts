// Filesystem scanner for Capability manifests.
//
// Pure functions over the filesystem. Returns the raw set of discovered
// Capabilities (both layers, both origins) plus malformed-manifest errors.
// Precedence resolution lives in registry.ts, not here.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CapabilityKind, CapabilityLayer, Origin } from "../lib/capability-types.ts";
import { bundled, runtime } from "../lib/paths.ts";
import { McpManifest, SkillManifest, SnippetManifest } from "./schemas.ts";
import type { Capability, McpCapability, SkillCapability, SnippetCapability } from "./types.ts";

export type LoaderError = {
  path: string;
  message: string;
};

export type LoaderResult = {
  capabilities: Capability[];
  errors: LoaderError[];
};

const FILENAME_BY_KIND: Record<"skill" | "snippet" | "mcp", string> = {
  skill: "SKILL.md",
  snippet: "SNIPPET.md",
  mcp: "MCP.yaml",
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

type ScanCtx = {
  kind: "skill" | "snippet" | "mcp";
  layer: CapabilityLayer;
  origin: Origin;
  workplaceId?: string;
  root: string;
};

function loadSkill(ctx: ScanCtx, name: string, filePath: string): SkillCapability | LoaderError {
  try {
    const { fm, body } = readFrontmatter(filePath);
    const result = SkillManifest.safeParse(fm);
    if (!result.success) return { path: filePath, message: formatIssues(result.error.issues) };
    if (result.data.name !== name) {
      return { path: filePath, message: `manifest.name '${result.data.name}' != folder '${name}'` };
    }
    return {
      kind: "skill",
      name: result.data.name,
      description: result.data.description,
      origin: ctx.origin,
      source: "filesystem",
      layer: ctx.layer,
      workplaceId: ctx.workplaceId,
      path: filePath,
      manifest: result.data,
      body,
    };
  } catch (err) {
    return { path: filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

function loadSnippet(
  ctx: ScanCtx,
  name: string,
  filePath: string,
): SnippetCapability | LoaderError {
  try {
    const { fm, body } = readFrontmatter(filePath);
    const result = SnippetManifest.safeParse(fm);
    if (!result.success) return { path: filePath, message: formatIssues(result.error.issues) };
    if (result.data.name !== name) {
      return { path: filePath, message: `manifest.name '${result.data.name}' != folder '${name}'` };
    }
    return {
      kind: "snippet",
      name: result.data.name,
      description: result.data.description,
      origin: ctx.origin,
      source: "filesystem",
      layer: ctx.layer,
      workplaceId: ctx.workplaceId,
      path: filePath,
      manifest: result.data,
      body,
    };
  } catch (err) {
    return { path: filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

function loadMcp(ctx: ScanCtx, name: string, filePath: string): McpCapability | LoaderError {
  try {
    const fm = parseYaml(readFileSync(filePath, "utf8"));
    const result = McpManifest.safeParse(fm);
    if (!result.success) return { path: filePath, message: formatIssues(result.error.issues) };
    if (result.data.name !== name) {
      return { path: filePath, message: `manifest.name '${result.data.name}' != folder '${name}'` };
    }
    return {
      kind: "mcp",
      name: result.data.name,
      description: result.data.description,
      origin: ctx.origin,
      source: "filesystem",
      layer: ctx.layer,
      workplaceId: ctx.workplaceId,
      path: filePath,
      manifest: result.data,
    };
  } catch (err) {
    return { path: filePath, message: err instanceof Error ? err.message : String(err) };
  }
}

function scan(ctx: ScanCtx): LoaderResult {
  const capabilities: Capability[] = [];
  const errors: LoaderError[] = [];
  for (const name of listSubdirs(ctx.root)) {
    const filename = FILENAME_BY_KIND[ctx.kind];
    const filePath = join(ctx.root, name, filename);
    if (!existsSync(filePath)) {
      errors.push({ path: filePath, message: `missing ${filename}` });
      continue;
    }
    const result =
      ctx.kind === "skill"
        ? loadSkill(ctx, name, filePath)
        : ctx.kind === "snippet"
          ? loadSnippet(ctx, name, filePath)
          : loadMcp(ctx, name, filePath);
    if ("kind" in result) capabilities.push(result);
    else errors.push(result);
  }
  return { capabilities, errors };
}

const KINDS_ON_DISK: Array<"skill" | "snippet" | "mcp"> = ["skill", "snippet", "mcp"];

// Scan all four (kind × layer × origin) buckets and return the flat result.
// The Registry consumes this and applies precedence rules.
export function scanAll(): LoaderResult {
  const capabilities: Capability[] = [];
  const errors: LoaderError[] = [];

  for (const kind of KINDS_ON_DISK) {
    const personalRoot =
      kind === "skill"
        ? bundled.skillsDir("personal")
        : kind === "snippet"
          ? bundled.snippetsDir("personal")
          : bundled.mcpDir("personal");
    const r = scan({ kind, layer: "bundled", origin: "personal", root: personalRoot });
    capabilities.push(...r.capabilities);
    errors.push(...r.errors);
  }

  const workplaceRoot = bundled.workplaceDir();
  if (existsSync(workplaceRoot)) {
    for (const workplaceId of listSubdirs(workplaceRoot)) {
      for (const kind of KINDS_ON_DISK) {
        const root = join(workplaceRoot, workplaceId, kindSubdir(kind));
        const r = scan({ kind, layer: "bundled", origin: "workplace", workplaceId, root });
        capabilities.push(...r.capabilities);
        errors.push(...r.errors);
      }
    }
  }

  for (const kind of KINDS_ON_DISK) {
    const root =
      kind === "skill"
        ? runtime.skillsDir()
        : kind === "snippet"
          ? runtime.snippetsDir()
          : runtime.mcpDir();
    // Runtime is implicitly personal-origin per ADR-0007.
    const r = scan({ kind, layer: "runtime", origin: "personal", root });
    capabilities.push(...r.capabilities);
    errors.push(...r.errors);
  }

  return { capabilities, errors };
}

function kindSubdir(kind: CapabilityKind): string {
  switch (kind) {
    case "skill":
      return "skills";
    case "snippet":
      return "snippets";
    case "mcp":
      return "mcp";
    case "tool":
      throw new Error("tools are not scanned from disk");
  }
}
