// `run_shell` — the single tracer Tool for F1. File tools (read/write/edit,
// N2) and load_skill (N3) join the registry later; the ADR-0003
// `capabilities/tools/` + `defineTool` infra is out of scope, so this Tool
// lives in `runs/tools/` for now.
//
// The handler does NOT enforce the allowlist — the executor's PermissionPort
// gate runs BEFORE dispatch (ADR-0003 G2 "pre-tool guardrails"). The handler is
// the I/O edge: it spawns through the injected ShellRunnerPort and folds the
// {stdout, stderr, exitCode} into a ToolResult.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeRoot } from "../../lib/paths.ts";
import type { ToolDef } from "../../model-gateway/types.ts";
import type { ShellRunnerPort } from "../effect/ports.ts";
import type { ToolContext, ToolHandler, ToolResult } from "./registry.ts";

const RUN_SHELL_DEF: ToolDef = {
  name: "run_shell",
  description:
    'Run an executable directly (no shell) in the Agent\'s workspace and return its stdout, stderr, and exit code. Shell builtins like `echo` and `cd` are unavailable — pass an executable plus its arguments (e.g. command "node", args ["-e", "…"]).',
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The executable to run." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments passed to the command.",
      },
    },
    required: ["command"],
  },
};

// Narrow the model-provided `unknown` input to the run_shell shape. Returns null
// for a malformed input so the handler yields an `isError` result rather than
// throwing (the loop continues).
function parseInput(input: unknown): { command: string; args: string[] } | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.command !== "string" || rec.command.length === 0) return null;
  let args: string[] = [];
  if (rec.args !== undefined) {
    if (!Array.isArray(rec.args) || !rec.args.every((a) => typeof a === "string")) return null;
    args = rec.args as string[];
  }
  return { command: rec.command, args };
}

export function makeRunShellTool(shell: ShellRunnerPort): ToolHandler {
  return {
    def: RUN_SHELL_DEF,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseInput(input);
      if (!parsed) {
        return {
          content: "run_shell: invalid input — expected { command: string, args?: string[] }",
          isError: true,
        };
      }
      const { stdout, stderr, exitCode } = await shell.run({
        command: parsed.command,
        args: parsed.args,
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
      const parts: string[] = [`exit code: ${exitCode}`];
      if (stdout.length > 0) parts.push(`stdout:\n${stdout}`);
      if (stderr.length > 0) parts.push(`stderr:\n${stderr}`);
      return { content: parts.join("\n"), isError: exitCode !== 0 };
    },
    describe(input: unknown) {
      const parsed = parseInput(input);
      if (!parsed) return {};
      return { command: parsed.command, argSummary: { count: parsed.args.length } };
    },
  };
}

// Working-directory resolution seam (Q7). F1 defaults `cwd` to a per-Agent
// `~/.hive` workspace dir. F/C4 owns the real three-tier Working Directory
// resolution and replaces this stub body — keep the signature stable.
export function resolveWorkingDir(agentId: string): string {
  return join(runtimeRoot(), "agents", agentId, "workspace");
}

// Per-stream capture cap. Bounds accumulation at the runner so a runaway
// process can't OOM the daemon or balloon the tool_result.
const MAX_STREAM_BYTES = 64 * 1024;

// Default ShellRunner — the true external I/O edge. Plain async around
// node:child_process; wrapped inward at the executor. `spawn` (not exec) with
// `shell: false` so args are passed as a vector, never shell-interpolated.
export function createDefaultShellRunner(): ShellRunnerPort {
  return {
    run({ command, args, cwd, signal }) {
      return new Promise((resolvePromise) => {
        // Ensure the per-Agent workspace exists; spawn fails if cwd is missing.
        try {
          mkdirSync(cwd, { recursive: true });
        } catch {
          // Best-effort — spawn will surface a usable error if cwd is unusable.
        }
        const child = spawn(command, args, { cwd, shell: false });
        let stdout = "";
        let stderr = "";
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let killed = false;

        const append = (current: string, chunk: string, truncated: boolean) => {
          if (truncated) return { value: current, truncated };
          const next = current + chunk;
          if (next.length >= MAX_STREAM_BYTES) {
            return { value: `${next.slice(0, MAX_STREAM_BYTES)}\n…(truncated)`, truncated: true };
          }
          return { value: next, truncated: false };
        };

        child.stdout?.on("data", (d: Buffer) => {
          const r = append(stdout, d.toString(), stdoutTruncated);
          stdout = r.value;
          stdoutTruncated = r.truncated;
        });
        child.stderr?.on("data", (d: Buffer) => {
          const r = append(stderr, d.toString(), stderrTruncated);
          stderr = r.value;
          stderrTruncated = r.truncated;
        });
        child.on("error", (err: Error) => {
          resolvePromise({ stdout, stderr: stderr + err.message, exitCode: 127 });
        });
        child.on("close", (code: number | null) => {
          if (killed) {
            resolvePromise({
              stdout,
              stderr: `${stderr}\nprocess killed (run cancelled)`,
              exitCode: 130,
            });
            return;
          }
          resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
        });

        if (signal?.aborted) {
          killed = true;
          child.kill();
        } else {
          signal?.addEventListener("abort", () => {
            killed = true;
            child.kill();
          });
        }
      });
    },
  };
}
