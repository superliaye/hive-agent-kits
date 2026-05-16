#!/usr/bin/env bun
/**
 * One-shot vendoring script for Phase 2 of the my-agent-kits migration.
 *
 * Copies skills from the local ~/.claude/skills/ installation into
 * bundled/personal/skills/, transforms frontmatter to Hive's Skill schema,
 * and adds a source: block tracking the upstream pin.
 *
 * Source pin:
 *   - hyperframes: npm hyperframes@<pinned version>
 *
 * gstack was previously vendored but has been removed — gstack commands are
 * dev-tooling CLI commands (used by developers directly), not agent-bound
 * skills the Hive Agent invokes. See docs/migration-from-my-agent-kits.md.
 *
 * Not intended as a general refresh tool; pnpm refresh:skills is the future home.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

const SOURCE_ROOT = join(homedir(), ".claude", "skills");
const TARGET_ROOT = resolve(import.meta.dir, "..", "bundled", "personal", "skills");
const FETCHED_AT = new Date().toISOString().slice(0, 10);

const HYPERFRAMES_PIN = {
  url: "github.com/heygen-com/hyperframes",
  ref: "0.6.14",
  fetchedAt: FETCHED_AT,
};

const HYPERFRAMES_SKILLS = new Set([
  "hyperframes",
  "hyperframes-cli",
  "hyperframes-media",
  "hyperframes-registry",
  "gsap",
  "animejs",
  "css-animations",
  "lottie",
  "three",
  "waapi",
  "tailwind",
  "typegpu",
  "remotion-to-hyperframes",
  "website-to-hyperframes",
  "contribute-catalog",
]);

const PHASE_1_SKILLS = new Set([
  "diagnose",
  "grill-me",
  "grill-with-docs",
  "improve-codebase-architecture",
  "my-clean-code",
  "my-commit",
  "my-commit-and-push",
  "my-create-pr",
  "my-explain",
  "my-fix-build",
]);

// Frontmatter keys we deliberately drop with rationale.
// Tracked so the script's report makes the loss visible.
const DROPPED_KNOWN: Record<string, string> = {
  "preamble-tier": "gstack-internal preamble control",
  triggers: "voice/speech aliases for Claude Code matcher; Hive matches by description",
  "added_in": "my-agent-kits internal kit version",
  "marketplace_source": "Claude Code plugin marketplace pointer",
  "marketplace_name": "Claude Code plugin marketplace pointer",
  "plugin_name": "Claude Code plugin marketplace pointer",
  "applyTo": "CLAUDE.md glob; superseded by Hive tag-based selection",
};

const KEPT_KEYS = new Set([
  "name",
  "title",
  "description",
  "tags",
  "allowed-tools",
  "disable-model-invocation",
  "argument-hint",
]);

type Source = { url: string; ref: string; fetchedAt: string };
type DropReport = Record<string, { count: number; reason: string }>;

export function classify(skillName: string): Source | null {
  if (HYPERFRAMES_SKILLS.has(skillName)) return HYPERFRAMES_PIN;
  return null;
}

export function transformFrontmatter(
  raw: Record<string, unknown>,
  source: Source,
  dropped: DropReport,
): Record<string, unknown> {
  const transformed: Record<string, unknown> = {};

  if (typeof raw.name === "string") transformed.name = raw.name;
  if (typeof raw.title === "string") transformed.title = raw.title;
  if (typeof raw.description === "string" || raw.description != null) {
    transformed.description =
      typeof raw.description === "string"
        ? raw.description.trim()
        : String(raw.description).trim();
  }

  if (Array.isArray(raw["allowed-tools"])) {
    transformed.allowedTools = raw["allowed-tools"];
  } else if (typeof raw["allowed-tools"] === "string") {
    transformed.allowedTools = splitAllowedToolsString(raw["allowed-tools"] as string);
  }

  if (raw["disable-model-invocation"] === true) {
    transformed.manualInvocationOnly = true;
  }

  if (typeof raw["argument-hint"] === "string") {
    transformed.argumentHint = raw["argument-hint"];
  }

  transformed.source = source;

  // Track dropped keys for the report.
  for (const key of Object.keys(raw)) {
    if (KEPT_KEYS.has(key)) continue;
    const reason = DROPPED_KNOWN[key] ?? "unknown — review";
    const entry = dropped[key] ?? { count: 0, reason };
    entry.count += 1;
    dropped[key] = entry;
  }

  return transformed;
}

/**
 * Split a comma-separated allowed-tools string while respecting parentheses.
 *   "Bash(npm:*, rushx:*), Read" -> ["Bash(npm:*, rushx:*)", "Read"]
 */
export function splitAllowedToolsString(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error("no YAML frontmatter found");
  }
  return { frontmatter: match[1], body: match[2] };
}

/**
 * Refuse-to-vendor if the source looks like a dev worktree, not a skill folder.
 * Catches the case where ~/.claude/skills/foo is a symlink into a full project
 * repo (the 1.4 GB gstack-as-full-repo trap from the earlier session).
 */
export function looksLikeProjectRoot(src: string): string | null {
  if (lstatSync(src).isSymbolicLink()) {
    return "source is a symbolic link";
  }
  const markers = ["package.json", ".git", "bun.lock", "VERSION", "CHANGELOG.md"];
  const found = markers.filter((m) => existsSync(join(src, m)));
  if (found.length >= 2) {
    return `source contains project-root markers: ${found.join(", ")}`;
  }
  return null;
}

function vendorSkill(
  name: string,
  source: Source,
  dropped: DropReport,
): "vendored" | "skipped-exists" {
  const src = join(SOURCE_ROOT, name);
  const dst = join(TARGET_ROOT, name);

  if (existsSync(dst)) {
    return "skipped-exists";
  }

  const refuseReason = looksLikeProjectRoot(src);
  if (refuseReason) {
    throw new Error(refuseReason);
  }

  cpSync(src, dst, { recursive: true, dereference: false });

  const skillPath = join(dst, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md missing in ${dst}`);
  }

  const original = readFileSync(skillPath, "utf8");
  const { frontmatter, body } = splitFrontmatter(original);
  const parsed = parse(frontmatter) as Record<string, unknown>;
  const transformed = transformFrontmatter(parsed, source, dropped);

  const newFrontmatter = stringify(transformed, { lineWidth: 0 }).trimEnd();
  const bodyPrefix = body.startsWith("\n") ? body : `\n${body}`;
  const newContent = `---\n${newFrontmatter}\n---\n${bodyPrefix}`;
  writeFileSync(skillPath, newContent, "utf8");

  return "vendored";
}

function main() {
  if (!existsSync(SOURCE_ROOT)) {
    console.error(`source root missing: ${SOURCE_ROOT}`);
    process.exit(1);
  }
  mkdirSync(TARGET_ROOT, { recursive: true });

  const entries = readdirSync(SOURCE_ROOT);
  const results: Record<string, string> = {};
  const dropped: DropReport = {};

  for (const name of entries) {
    if (PHASE_1_SKILLS.has(name)) continue;
    const src = join(SOURCE_ROOT, name);
    if (!statSync(src).isDirectory()) continue;
    if (!existsSync(join(src, "SKILL.md"))) continue;

    const source = classify(name);
    if (!source) continue;

    try {
      results[name] = vendorSkill(name, source, dropped);
    } catch (err) {
      results[name] = `error: ${(err as Error).message}`;
    }
  }

  const vendored = Object.entries(results).filter(([, v]) => v === "vendored");
  const skipped = Object.entries(results).filter(([, v]) => v === "skipped-exists");
  const errors = Object.entries(results).filter(([, v]) => v.startsWith("error:"));

  console.log(`\nVendored ${vendored.length} skills:`);
  for (const [name] of vendored) console.log(`  ${name}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} (already exist):`);
    for (const [name] of skipped) console.log(`  ${name}`);
  }

  if (Object.keys(dropped).length > 0) {
    console.log(`\nDropped frontmatter keys (${vendored.length} skills processed):`);
    const entries = Object.entries(dropped).sort((a, b) => b[1].count - a[1].count);
    for (const [key, { count, reason }] of entries) {
      console.log(`  ${key} (${count})  -- ${reason}`);
    }
  }

  if (errors.length) {
    console.log(`\nErrors:`);
    for (const [name, err] of errors) console.log(`  ${name}: ${err}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
