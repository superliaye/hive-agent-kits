#!/usr/bin/env bun
// The recognition lever (ADR-0033): opens a real git snapshot of a repository in
// a throwaway cache with Sync's code and limits, recognizes it, and reports the
// Recipe, each projected capability, and what the Mirror would ingest.
// --compare-npx also lists the repository with `npx skills@1.7.2 add --list` and
// fails when its skills differ from the skills Hive projects.
//
//   bun run recipe-lever <https-github-url> [--ref <ref>] [--compare-npx]

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { capabilityLayout } from "@hive/capability-schema";
import type { SourceLocator } from "@hive/contract";
import { Cause, Effect, Exit } from "effect";
import pino from "pino";
import { gitSnapshot } from "../src/kit/acquisition/git-source.ts";
import { DEFAULT_TREE_LIMITS } from "../src/kit/acquisition/tree-guard.ts";
import { SyncError } from "../src/kit/effect/errors.ts";
import { materialize } from "../src/kit/mirror.ts";
import { sanitizeName } from "../src/kit/recipes/published-skills.ts";
import { recipeTree, recognizeSource } from "../src/kit/recipes/recipe.ts";
import { setLogger } from "../src/lib/log.ts";

const SKILLS_CLI = "skills@1.7.2";

type Args = { url: string; ref: string; compareNpx: boolean };

function parseArgs(argv: readonly string[]): Args | null {
  let url: string | undefined;
  let ref = "refs/heads/main";
  let compareNpx = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--compare-npx") compareNpx = true;
    else if (arg === "--ref") {
      const value = argv[++index];
      if (!value) return null;
      ref = value.startsWith("refs/") ? value : `refs/heads/${value}`;
    } else if (arg && !arg.startsWith("--") && url === undefined) url = arg;
    else return null;
  }
  return url?.startsWith("https://") ? { url, ref, compareNpx } : null;
}

type MirrorFile = { rel: string; size: number };

function mirrorFiles(stage: string): MirrorFile[] {
  return readdirSync(stage, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { rel: relative(stage, path), size: statSync(path).size };
    });
}

// A capability as the Catalog would name it: a folder kind is its outermost
// marker folder, a file kind its file. Anything else is grouped by top folder.
function capabilityOf(rel: string, markerDirs: readonly string[]): string {
  const marker = markerDirs.find((dir) => rel.startsWith(`${dir}/`));
  if (marker) {
    const kind = marker.split("/")[1] === "agents" ? "agent" : "skill";
    return `${kind} ${marker.slice(marker.lastIndexOf("/") + 1)}`;
  }
  for (const [kind, layout] of Object.entries(capabilityLayout)) {
    const prefix = `capabilities/${layout.dir}/`;
    if (layout.style === "file" && rel.startsWith(prefix) && rel.endsWith(layout.suffix)) {
      return `${kind} ${rel.slice(prefix.length, -layout.suffix.length)}`;
    }
  }
  return `other ${rel.split("/").slice(0, 2).join("/")}`;
}

function markerDirsOf(files: readonly MirrorFile[]): string[] {
  const markers: string[] = [];
  for (const layout of Object.values(capabilityLayout)) {
    if (layout.style !== "folder") continue;
    for (const { rel } of files) {
      if (rel.startsWith(`capabilities/${layout.dir}/`) && rel.endsWith(`/${layout.marker}`)) {
        markers.push(rel.slice(0, -layout.marker.length - 1));
      }
    }
  }
  return markers
    .filter((dir) => !markers.some((outer) => outer !== dir && dir.startsWith(`${outer}/`)))
    .sort();
}

type Report = {
  commit: string;
  listed: number;
  recipe: { id: string; label: string; unit: string };
  capabilities: Map<string, { files: number; bytes: number }>;
  files: number;
  bytes: number;
};

function recognize(args: Args, work: string): Effect.Effect<Report, SyncError> {
  const locator = {
    kind: "git",
    repoUrl: args.url,
    revision: { mode: "track", ref: args.ref },
    subpath: ".",
  } satisfies SourceLocator;
  return Effect.scoped(
    Effect.gen(function* () {
      const snapshot = yield* gitSnapshot(locator, {
        cacheRoot: join(work, "git-cache"),
        limits: DEFAULT_TREE_LIMITS,
      });
      const recognition = yield* recognizeSource(recipeTree(snapshot, DEFAULT_TREE_LIMITS));
      const staged = yield* materialize(
        snapshot,
        recognition,
        join(work, "tmp"),
        DEFAULT_TREE_LIMITS,
      );
      const files = mirrorFiles(staged.stage);
      const markers = markerDirsOf(files);
      const capabilities = new Map<string, { files: number; bytes: number }>();
      for (const file of files) {
        const name = capabilityOf(file.rel, markers);
        const total = capabilities.get(name) ?? { files: 0, bytes: 0 };
        capabilities.set(name, { files: total.files + 1, bytes: total.bytes + file.size });
      }
      return {
        commit: snapshot.origin.transport === "git" ? snapshot.origin.resolvedCommit : "",
        listed: snapshot.entries.size,
        recipe: recognition.recipe,
        capabilities,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
      };
    }),
  );
}

// The skill names `skills add --list` prints: clack indents a name two spaces
// past the gutter and its description four.
function npxSkillNames(args: Args): string[] | string {
  const target =
    args.ref === "refs/heads/main"
      ? args.url
      : `${args.url}/tree/${args.ref.replace(/^refs\/(heads|tags)\//, "")}`;
  const run = spawnSync("npx", ["-y", SKILLS_CLI, "add", target, "--list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  const output = stripVTControlCharacters(`${run.stdout ?? ""}`);
  if (run.status !== 0) return `npx exited ${run.status}: ${output.trim().split("\n").pop() ?? ""}`;
  const names: string[] = [];
  let listing = false;
  for (const line of output.split("\n")) {
    if (line.includes("Available Skills")) listing = true;
    else if (line.includes("Use --skill")) listing = false;
    else if (listing) {
      const match = /^│ {4}(\S.*)$/.exec(line);
      if (match?.[1]) names.push(match[1].trim());
    }
  }
  return names;
}

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    console.error("usage: recipe-lever <https-url> [--ref <ref>] [--compare-npx]");
    return 2;
  }
  const notes: string[] = [];
  setLogger(
    pino(
      { level: "info" },
      {
        write: (line: string) => {
          const record: unknown = JSON.parse(line);
          if (typeof record !== "object" || record === null) return;
          const { module, msg, skill, dir } = record as Record<string, unknown>;
          if (module === "kit/recipes") notes.push(`${String(skill)} (${String(dir)}): ${msg}`);
        },
      },
    ),
  );
  const work = mkdtempSync(join(tmpdir(), "recipe-lever-"));
  try {
    const exit = await Effect.runPromiseExit(recognize(args, work));
    console.log(`Repository  ${args.url} @ ${args.ref}`);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      if (!(error instanceof SyncError)) throw error;
      console.log(`Sync fails  ${error.reason}: ${error.detail ?? error.message}`);
      for (const note of notes) console.log(`  note: ${note}`);
      return 1;
    }
    const report = exit.value;
    const { maxFiles, maxBytes } = DEFAULT_TREE_LIMITS;
    console.log(`Commit      ${report.commit}  (${report.listed} entries listed)`);
    console.log(
      `Recipe      ${report.recipe.id} (${report.recipe.label}, unit ${report.recipe.unit})`,
    );
    console.log("Capabilities");
    for (const [name, total] of [...report.capabilities].sort(([a], [b]) => (a < b ? -1 : 1))) {
      console.log(`  ${name}  ${total.files} files  ${megabytes(total.bytes)}`);
    }
    for (const note of notes) console.log(`  skipped: ${note}`);
    console.log(
      `Ingested    ${report.files} / ${maxFiles} files, ${report.bytes} / ${maxBytes} bytes (${megabytes(report.bytes)})`,
    );
    if (!args.compareNpx) return 0;

    const npx = npxSkillNames(args);
    if (typeof npx === "string") {
      console.log(`npx         ${npx}`);
      return 1;
    }
    const hive = new Set(
      [...report.capabilities.keys()]
        .filter((name) => name.startsWith("skill "))
        .map((name) => name.slice("skill ".length)),
    );
    const listed = new Set(npx.map(sanitizeName));
    const npxOnly = [...listed].filter((name) => !hive.has(name)).sort();
    const hiveOnly = [...hive].filter((name) => !listed.has(name)).sort();
    console.log(`npx         ${SKILLS_CLI} lists ${npx.length}: ${npx.join(", ") || "-"}`);
    console.log(`  npx only:  ${npxOnly.join(", ") || "-"}`);
    console.log(`  Hive only: ${hiveOnly.join(", ") || "-"}`);
    console.log(npxOnly.length + hiveOnly.length === 0 ? "Match" : "MISMATCH");
    return npxOnly.length + hiveOnly.length === 0 ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
