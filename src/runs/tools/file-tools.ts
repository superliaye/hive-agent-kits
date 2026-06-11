// File tools (N2) — `read` / `write` / `edit`. They join the registry next to
// `run_shell` (the template). Each is a ToolHandler: a `ToolDef` sent to the
// model + a `run` verb the loop dispatches + a `describe()` projection for
// gate/audit. Malformed input → `isError` result, never a throw (the loop
// continues — same contract as run-shell.ts).
//
// These tools carry NO `command`, so the executor's permission gate allows
// them unconditionally (permission.ts: command-less ⇒ allow). The real guard
// is WORKSPACE CONFINEMENT: every path is resolved relative to `ctx.cwd` (the
// per-Agent workspace) and must stay inside it — absolute paths and `..`
// escapes are rejected with an `isError` result. This is a value-level
// invariant in each handler, independent of the command allowlist.
//
// File CONTENT never enters audit (ADR-0004 redaction): `describe()` returns
// {} for read, and {} for write/edit too — no content, no path-as-arg. The
// tool name + tool_use_id (refs) are the audit record.

import { existsSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ToolDef } from "../../model-gateway/types.ts";
import type { FsRunnerPort } from "../effect/ports.ts";
import type { ToolContext, ToolHandler, ToolResult } from "./registry.ts";

// Cap read output the same way run_shell caps stream capture, so a large file
// can't balloon the tool_result / context.
const MAX_FILE_BYTES = 64 * 1024;

// Resolve a model-provided relative path against the workspace root and confine
// it. Returns the absolute path, or null when the input escapes the workspace
// (absolute path, or `..` traversal above `cwd`).
//
// KNOWN LIMITATION (string-level guard, no realpath): a symlink residing inside
// the workspace that targets a path outside it passes confinement — the fs verb
// then follows it and escapes. These tools cannot create symlinks (write only
// emits file content), so the only vector is a symlink Hive itself placed in the
// workspace. A hard boundary would realpath `abs` (and its parent, for write)
// and re-check containment under realpath(cwd); deferred until the G2 permission
// system replaces this interim confinement guard.
function confine(cwd: string, path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (isAbsolute(path)) return null;
  const abs = resolvePath(cwd, path);
  const rel = relative(cwd, abs);
  // Outside the workspace iff the relative path climbs out (`..`) or is itself
  // absolute (different drive on Windows).
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return abs;
}

// ─── read ────────────────────────────────────────────────────────────────────

const READ_DEF: ToolDef = {
  name: "read",
  description:
    "Read a UTF-8 text file from the Agent's workspace and return its contents. The path is relative to the workspace; paths outside it are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to read." },
    },
    required: ["path"],
  },
};

function parseRead(input: unknown): { path: string } | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.path !== "string" || rec.path.length === 0) return null;
  return { path: rec.path };
}

export function makeReadTool(fs: FsRunnerPort): ToolHandler {
  return {
    def: READ_DEF,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseRead(input);
      if (!parsed) {
        return { content: "read: invalid input — expected { path: string }", isError: true };
      }
      const abs = confine(ctx.cwd, parsed.path);
      if (abs === null) {
        return {
          content: `read: path escapes the workspace: ${parsed.path}`,
          isError: true,
        };
      }
      if (!(await fs.fileExists(abs))) {
        return { content: `read: file not found: ${parsed.path}`, isError: true };
      }
      let content = await fs.readFile(abs);
      if (content.length > MAX_FILE_BYTES) {
        content = `${content.slice(0, MAX_FILE_BYTES)}\n…(truncated)`;
      }
      return { content, isError: false };
    },
    // No command, no content in audit (ADR-0004): the tool name + id are the ref.
    describe() {
      return {};
    },
  };
}

// ─── write ─────────────────────────────────────────────────────────────────

const WRITE_DEF: ToolDef = {
  name: "write",
  description:
    "Create or overwrite a UTF-8 text file in the Agent's workspace, creating parent directories as needed. The path is relative to the workspace; paths outside it are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to write." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
  },
};

function parseWrite(input: unknown): { path: string; content: string } | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.path !== "string" || rec.path.length === 0) return null;
  if (typeof rec.content !== "string") return null;
  return { path: rec.path, content: rec.content };
}

export function makeWriteTool(fs: FsRunnerPort): ToolHandler {
  return {
    def: WRITE_DEF,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseWrite(input);
      if (!parsed) {
        return {
          content: "write: invalid input — expected { path: string, content: string }",
          isError: true,
        };
      }
      const abs = confine(ctx.cwd, parsed.path);
      if (abs === null) {
        return { content: `write: path escapes the workspace: ${parsed.path}`, isError: true };
      }
      await fs.writeFile(abs, parsed.content);
      return { content: `wrote ${parsed.content.length} bytes to ${parsed.path}`, isError: false };
    },
    describe() {
      return {};
    },
  };
}

// ─── edit ────────────────────────────────────────────────────────────────────

const EDIT_DEF: ToolDef = {
  name: "edit",
  description:
    "Replace an exact string in a workspace file. `old_str` must appear exactly once; the call fails if it is missing or non-unique. Matches the str_replace contract.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to edit." },
      old_str: {
        type: "string",
        description: "Exact text to replace (must be unique in the file).",
      },
      new_str: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old_str", "new_str"],
  },
};

function parseEdit(input: unknown): { path: string; oldStr: string; newStr: string } | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.path !== "string" || rec.path.length === 0) return null;
  if (typeof rec.old_str !== "string" || rec.old_str.length === 0) return null;
  if (typeof rec.new_str !== "string") return null;
  return { path: rec.path, oldStr: rec.old_str, newStr: rec.new_str };
}

export function makeEditTool(fs: FsRunnerPort): ToolHandler {
  return {
    def: EDIT_DEF,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseEdit(input);
      if (!parsed) {
        return {
          content:
            "edit: invalid input — expected { path: string, old_str: string, new_str: string }",
          isError: true,
        };
      }
      const abs = confine(ctx.cwd, parsed.path);
      if (abs === null) {
        return { content: `edit: path escapes the workspace: ${parsed.path}`, isError: true };
      }
      if (!(await fs.fileExists(abs))) {
        return { content: `edit: file not found: ${parsed.path}`, isError: true };
      }
      const original = await fs.readFile(abs);
      const first = original.indexOf(parsed.oldStr);
      if (first === -1) {
        return { content: `edit: old_str not found in ${parsed.path}`, isError: true };
      }
      const second = original.indexOf(parsed.oldStr, first + parsed.oldStr.length);
      if (second !== -1) {
        return {
          content: `edit: old_str is not unique in ${parsed.path} — provide more surrounding context`,
          isError: true,
        };
      }
      const next =
        original.slice(0, first) + parsed.newStr + original.slice(first + parsed.oldStr.length);
      await fs.writeFile(abs, next);
      return { content: `edited ${parsed.path}`, isError: false };
    },
    describe() {
      return {};
    },
  };
}

// Default FsRunner — the true external I/O edge. Plain async around
// node:fs/promises (AGENTS.md "plain async only at I/O edges"); wrapped inward
// at the executor. `writeFile` mkdir -p's the parent (mirror run-shell.ts).
export function createDefaultFsRunner(): FsRunnerPort {
  return {
    readFile: (path) => fsReadFile(path, "utf8"),
    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, "utf8");
    },
    fileExists: async (path) => existsSync(path),
  };
}
