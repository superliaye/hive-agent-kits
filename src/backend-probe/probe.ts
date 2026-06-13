// Probe logic: run a CLI backend's `--version` and classify the outcome.
//
// `probeBackend` is pure given a CommandRunner — it performs no I/O and no
// logging, so tests inject a fake runner and assert the BackendStatus. The
// real subprocess lives in `bunCommandRunner` (the I/O edge); memory mode uses
// `notInstalledRunner` so booting a test server never spawns anything.

import type { BackendStatus, ProbeableBackend } from "./types.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

// The version-detection invocation per backend. `claude-code` ships the
// `claude` binary; `codex` ships `codex` (ADR-0016, capability-types.ts).
const BACKEND_COMMANDS: Record<ProbeableBackend, readonly string[]> = {
  "claude-code": ["claude", "--version"],
  codex: ["codex", "--version"],
};

// The self-update invocation per backend (ADR-0016 "detect, don't manage" —
// Hive delegates to each CLI's OWN updater, it never installs/manages packages).
// One backend-keyed table so the exact invocation is changed in a single place;
// the UI copy never advertises a specific flag (OQ-3).
export const BACKEND_UPDATE_COMMANDS: Record<ProbeableBackend, readonly string[]> = {
  "claude-code": ["claude", "update"],
  codex: ["codex", "update"],
};

// The binary name the update invocation runs — a ref for the audit payload
// (never the full arg vector). command[0] of the backend's self-update command.
export function updateBinary(backend: ProbeableBackend): string {
  return BACKEND_UPDATE_COMMANDS[backend][0] ?? backend;
}

// First semver-ish token in the output. Tolerant on purpose: CLIs decorate
// their version string differently (`2.0.13 (Claude Code)`, `codex-cli 0.5.0`),
// so we extract rather than match a fixed format.
const VERSION_RE = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/;

export function parseVersion(output: string): string | null {
  return output.match(VERSION_RE)?.[0] ?? null;
}

export type CommandResult =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string }
  // Could not start the process — binary not on PATH (ENOENT).
  | { kind: "spawn_failed"; message: string }
  | { kind: "timeout" };

// Consumer-owned port for running a short-lived command. The real adapter
// wraps Bun.spawn; tests and memory mode provide their own.
export type CommandRunner = (
  command: readonly string[],
  opts: { timeoutMs: number },
) => Promise<CommandResult>;

export const bunCommandRunner: CommandRunner = async (command, { timeoutMs }) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    return { kind: "spawn_failed", message: err instanceof Error ? err.message : String(err) };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    // The process was killed; drain its pipes so the OS handles are released.
    proc.stdout.cancel().catch(() => {});
    proc.stderr.cancel().catch(() => {});
    return { kind: "timeout" };
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { kind: "exited", exitCode, stdout, stderr };
};

// Memory-mode / disabled runner: reports every backend as not installed
// without touching the system. Keeps test-server boot free of subprocesses.
export const notInstalledRunner: CommandRunner = async () => ({
  kind: "spawn_failed",
  message: "backend probe disabled",
});

// A delegated-update outcome. `ok` re-probes and returns the fresh status; a
// failure is a TYPED value (never a thrown untyped error) — `spawn_failed` =
// binary not on PATH, `update_failed` = the updater exited non-zero, `timeout` =
// the updater ran past its budget. The route maps these to a JSON error.
export type UpdateResult =
  | { kind: "ok"; status: BackendStatus }
  | { kind: "spawn_failed"; message: string }
  | { kind: "update_failed"; exitCode: number }
  | { kind: "timeout" };

// Run a backend's OWN self-update command, then re-probe. Pure given a
// CommandRunner — the live service injects the real runner; tests inject a fake.
// Hive never installs/manages the CLI itself (ADR-0016): it delegates to the
// CLI's updater and reports the re-probed status.
export async function updateBackend(
  backend: ProbeableBackend,
  runner: CommandRunner,
  opts: { timeoutMs: number },
): Promise<UpdateResult> {
  const result = await runner(BACKEND_UPDATE_COMMANDS[backend], { timeoutMs: opts.timeoutMs });
  switch (result.kind) {
    case "spawn_failed":
      return { kind: "spawn_failed", message: result.message };
    case "timeout":
      return { kind: "timeout" };
    case "exited":
      if (result.exitCode !== 0) return { kind: "update_failed", exitCode: result.exitCode };
      return { kind: "ok", status: await probeBackend(backend, runner, opts) };
  }
}

export async function probeBackend(
  backend: ProbeableBackend,
  runner: CommandRunner,
  opts: { timeoutMs: number },
): Promise<BackendStatus> {
  const result = await runner(BACKEND_COMMANDS[backend], { timeoutMs: opts.timeoutMs });
  const checkedAt = Date.now();

  switch (result.kind) {
    case "spawn_failed":
      return { backend, installed: false, version: null, reason: "not_installed", checkedAt };
    case "timeout":
      // The process spawned (so the binary exists) but ran past the budget.
      return { backend, installed: true, version: null, reason: "timeout", checkedAt };
    case "exited": {
      if (result.exitCode !== 0) {
        return { backend, installed: true, version: null, reason: "probe_failed", checkedAt };
      }
      const version = parseVersion(result.stdout) ?? parseVersion(result.stderr);
      if (!version) {
        return { backend, installed: true, version: null, reason: "version_unreadable", checkedAt };
      }
      return { backend, installed: true, version, reason: "ok", checkedAt };
    }
  }
}
