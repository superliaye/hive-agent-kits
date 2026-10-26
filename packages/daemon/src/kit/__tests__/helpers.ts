// Shared test helpers for the Kit module suite.
//
// - redirected temp homes (so the real ~/.claude is never touched)
// - in-memory ustar tar + gzip fixture builder (content-derived top folder)
// - in-memory tree snapshots and a hermetic Git process

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";
import type { GitProcess } from "../acquisition/git-process.ts";
import {
  type ListedEntry,
  resolveListing,
  type TreeOrigin,
  type TreePath,
  type TreeSnapshot,
} from "../acquisition/snapshot.ts";

const HIVE_ENV_KEYS = [
  "HIVE_RUNTIME_ROOT",
  "HIVE_CLAUDE_HOME",
  "HIVE_CODEX_HOME",
  "HIVE_AGENTS_HOME",
  "HIVE_LEDGER_PATH",
] as const;

export type RedirectedHome = {
  root: string;
  claudeHome: string;
  codexHome: string;
  agentsHome: string;
  ledgerPath: string;
  runtimeRoot: string;
};

// Point every HIVE_* env at subdirs of `root` BEFORE defaultDeployTargets() is
// called (the port reads env at call time). Returns the resolved paths.
//
// Homes are DOTTED siblings under a single `<root>/homes` parent (mirroring the
// dev-sandbox layout), so the B2a childEnv invariant holds for this redirect too:
// childEnv sets $HOME = dirname(claudeHome()) = <root>/homes, and an installer
// resolving ~/.codex / ~/.agents from $HOME lands on exactly codexHome()/
// agentsHome(). A non-dotted layout (`<root>/codex`) would split the two.
export function redirectHomeEnv(root: string): RedirectedHome {
  const homes = `${root}/homes`;
  const claudeHome = `${homes}/.claude`;
  const codexHome = `${homes}/.codex`;
  const agentsHome = `${homes}/.agents`;
  const ledgerPath = `${homes}/.agent-kit/manifest.json`;
  const runtimeRoot = `${root}/runtime`;
  process.env.HIVE_RUNTIME_ROOT = runtimeRoot;
  process.env.HIVE_CLAUDE_HOME = claudeHome;
  process.env.HIVE_CODEX_HOME = codexHome;
  process.env.HIVE_AGENTS_HOME = agentsHome;
  process.env.HIVE_LEDGER_PATH = ledgerPath;
  return { root, claudeHome, codexHome, agentsHome, ledgerPath, runtimeRoot };
}

// Clear all HIVE_* overrides so the real home is never touched and state never
// bleeds between tests.
export function clearHomeEnv(): void {
  for (const k of HIVE_ENV_KEYS) delete process.env[k];
}

// ---- in-memory ustar tar builder ----

const BLOCK = 512;

export type TarFixtureEntry = {
  // POSIX path relative to (and including) the top folder, e.g.
  // "renamed-top/capabilities/skills/foo/SKILL.md".
  path: string;
  content?: string; // omit/undefined -> directory entry
};

function writeStr(buf: Uint8Array, offset: number, str: string, length: number): void {
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < length; i++) buf[offset + i] = i < bytes.length ? (bytes[i] ?? 0) : 0;
}

function writeOctal(buf: Uint8Array, offset: number, value: number, length: number): void {
  // ustar numeric fields: zero-padded octal, NUL-terminated.
  const s = value.toString(8).padStart(length - 1, "0");
  writeStr(buf, offset, s, length - 1);
  buf[offset + length - 1] = 0;
}

function header(path: string, size: number, isDir: boolean): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeStr(h, 0, path, 100);
  writeOctal(h, 100, isDir ? 0o755 : 0o644, 8); // mode
  writeOctal(h, 108, 0, 8); // uid
  writeOctal(h, 116, 0, 8); // gid
  writeOctal(h, 124, size, 12); // size
  writeOctal(h, 136, 0, 12); // mtime
  h[156] = (isDir ? "5" : "0").charCodeAt(0); // typeflag
  writeStr(h, 257, "ustar", 6); // magic
  writeStr(h, 263, "00", 2); // version
  // checksum: spaces during compute, then octal.
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i] ?? 0;
  writeStr(h, 148, sum.toString(8).padStart(6, "0"), 6);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

// Build a raw (uncompressed) ustar archive from entries.
export function buildTar(entries: TarFixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    const isDir = e.content === undefined;
    const data = isDir ? new Uint8Array(0) : new TextEncoder().encode(e.content);
    const path = isDir && !e.path.endsWith("/") ? `${e.path}/` : e.path;
    chunks.push(header(path, data.length, isDir));
    if (!isDir && data.length > 0) {
      const padded = Math.ceil(data.length / BLOCK) * BLOCK;
      const block = new Uint8Array(padded);
      block.set(data);
      chunks.push(block);
    }
  }
  // Two zero blocks mark end-of-archive.
  chunks.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Build a gzip'd ustar archive (what codeload serves).
export function buildGzipTar(entries: TarFixtureEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(buildTar(entries))));
}

// ---- in-memory tree snapshot ----

export type MemoryFile = string | Uint8Array | { exec: string } | { link: string };

export const MEMORY_GIT_ORIGIN = {
  transport: "git",
  repoUrl: "https://github.com/acme/stack",
  requestedRevision: { mode: "track", ref: "refs/heads/main" },
  resolvedCommit: "c".repeat(40),
  subpath: ".",
  treeIdentity: "d".repeat(40),
} satisfies TreeOrigin;

// A snapshot over literal files that records every path it was asked to read.
export function memorySnapshot(
  files: Record<string, MemoryFile>,
  origin: TreeOrigin = MEMORY_GIT_ORIGIN,
): { snapshot: TreeSnapshot; reads: string[] } {
  const reads: string[] = [];
  const listed = new Map<TreePath, ListedEntry>();
  const bytes = new Map<string, Uint8Array>();
  for (const [path, file] of Object.entries(files)) {
    if (file instanceof Uint8Array) {
      listed.set(path as TreePath, { mode: "file" });
      bytes.set(path, file);
      continue;
    }
    if (typeof file === "object" && "link" in file) {
      listed.set(path as TreePath, { mode: "link", text: file.link });
      continue;
    }
    const exec = typeof file === "object";
    listed.set(path as TreePath, { mode: exec ? "exec" : "file" });
    bytes.set(path, new TextEncoder().encode(exec ? file.exec : file));
  }
  const snapshot: TreeSnapshot = {
    origin,
    entries: resolveListing(listed),
    read: (paths) =>
      Effect.sync(() => {
        reads.push(...paths);
        const out = new Map<TreePath, Uint8Array>();
        for (const path of paths) {
          const data = bytes.get(path);
          if (!data) throw new Error(`unlisted read ${path}`);
          out.set(path, data);
        }
        return out;
      }),
    confirm: () => Effect.void,
  };
  return { snapshot, reads };
}

// ---- hermetic Git process over literal files ----

export type FakeGitFile = { path: string; content: string; mode?: "100644" | "100755" | "120000" };

// Answers the commands the git snapshot runs, and records which blob ids
// `cat-file --batch` was asked for.
export function fakeGitProcess(
  files: readonly FakeGitFile[],
  commit = "a".repeat(40),
): { process: GitProcess; batched: string[] } {
  const batched: string[] = [];
  const byId = new Map<string, FakeGitFile>();
  const listing = files
    .map((file) => {
      const id = createHash("sha1").update(file.path).digest("hex");
      byId.set(id, file);
      return `${file.mode ?? "100644"} blob ${id}\t${file.path}\0`;
    })
    .join("");
  const result = (stdout: string | Uint8Array = "") => ({
    exitCode: 0,
    stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout,
    stderr: "",
  });
  const process: GitProcess = {
    async run(args, options) {
      if (args.includes("--is-bare-repository")) return result("true\n");
      if (args.includes("cat-file") && args.includes("-t")) return result("tree\n");
      if (args.includes("ls-tree")) return result(listing);
      if (args.includes("cat-file") && args.includes("--batch")) {
        const ids = new TextDecoder().decode(options?.stdin).trim().split("\n").filter(Boolean);
        batched.push(...ids);
        const chunks = ids.flatMap((id) => {
          const content = new TextEncoder().encode(byId.get(id)?.content ?? "");
          return [
            new TextEncoder().encode(`${id} blob ${content.byteLength}\n`),
            content,
            new Uint8Array([10]),
          ];
        });
        return result(Buffer.concat(chunks));
      }
      if (args.includes("rev-parse") && args.some((arg) => arg.includes("FETCH_HEAD"))) {
        return result(`${commit}\n`);
      }
      if (args.includes("rev-parse")) return result(`${"b".repeat(40)}\n`);
      return result();
    },
  };
  return { process, batched };
}
