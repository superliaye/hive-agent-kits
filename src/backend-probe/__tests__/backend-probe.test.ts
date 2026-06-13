import { describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { BackendProbe, BackendProbeLive } from "../effect/backend-probe-live.ts";
import {
  BACKEND_UPDATE_COMMANDS,
  type CommandResult,
  type CommandRunner,
  parseVersion,
  probeBackend,
  updateBackend,
} from "../probe.ts";
import type { BackendUpdateEvents } from "../types.ts";

// A runner that returns canned results keyed by binary name.
function fakeRunner(byBinary: Record<string, CommandResult>): CommandRunner {
  return async (command) => {
    const bin = command[0] ?? "";
    return byBinary[bin] ?? { kind: "spawn_failed", message: "unknown" };
  };
}

const opts = { timeoutMs: 1000 };

describe("probeBackend", () => {
  test("installed: exit 0 with a parseable version → ok", async () => {
    const runner = fakeRunner({
      claude: { kind: "exited", exitCode: 0, stdout: "2.0.13 (Claude Code)\n", stderr: "" },
    });
    const status = await probeBackend("claude-code", runner, opts);
    expect(status.reason).toBe("ok");
    expect(status.installed).toBe(true);
    expect(status.version).toBe("2.0.13");
  });

  test("missing: spawn failure → not_installed, not an error", async () => {
    const runner = fakeRunner({});
    const status = await probeBackend("codex", runner, opts);
    expect(status.reason).toBe("not_installed");
    expect(status.installed).toBe(false);
    expect(status.version).toBeNull();
  });

  test("present but exit non-zero → probe_failed, still installed", async () => {
    const runner = fakeRunner({
      claude: { kind: "exited", exitCode: 1, stdout: "", stderr: "boom" },
    });
    const status = await probeBackend("claude-code", runner, opts);
    expect(status.reason).toBe("probe_failed");
    expect(status.installed).toBe(true);
    expect(status.version).toBeNull();
  });

  test("clean exit but no version in output → version_unreadable", async () => {
    const runner = fakeRunner({
      codex: { kind: "exited", exitCode: 0, stdout: "no version here\n", stderr: "" },
    });
    const status = await probeBackend("codex", runner, opts);
    expect(status.reason).toBe("version_unreadable");
    expect(status.installed).toBe(true);
  });

  test("timeout → timeout reason", async () => {
    const runner: CommandRunner = async () => ({ kind: "timeout" });
    const status = await probeBackend("codex", runner, opts);
    expect(status.reason).toBe("timeout");
    expect(status.installed).toBe(true);
  });

  test("version is read from stderr when stdout is empty", async () => {
    const runner = fakeRunner({
      codex: { kind: "exited", exitCode: 0, stdout: "", stderr: "codex-cli 0.5.1\n" },
    });
    const status = await probeBackend("codex", runner, opts);
    expect(status.version).toBe("0.5.1");
    expect(status.reason).toBe("ok");
  });
});

describe("parseVersion", () => {
  test.each([
    ["2.0.13 (Claude Code)", "2.0.13"],
    ["codex-cli 0.5.0", "0.5.0"],
    ["v1.2.3-beta.1", "1.2.3-beta.1"],
    ["no digits", null],
  ])("%s → %s", (input, expected) => {
    expect(parseVersion(input)).toBe(expected);
  });
});

describe("BackendProbeLive", () => {
  test("probeAll probes both backends through the injected runner", async () => {
    const runner = fakeRunner({
      claude: { kind: "exited", exitCode: 0, stdout: "2.0.0", stderr: "" },
      codex: { kind: "spawn_failed", message: "ENOENT" },
    });
    const rt = ManagedRuntime.make(BackendProbeLive({ runner }));
    const svc = rt.runSync(BackendProbe);
    const statuses = await svc.probeAll();
    expect(statuses.map((s) => s.backend).sort()).toEqual(["claude-code", "codex"]);
    expect(statuses.find((s) => s.backend === "claude-code")?.reason).toBe("ok");
    expect(statuses.find((s) => s.backend === "codex")?.reason).toBe("not_installed");
    rt.dispose();
  });
});

describe("BACKEND_UPDATE_COMMANDS (pinned self-update argv, P5)", () => {
  // Pin the exact argv so a copy-edit to the table is caught. The codex CLI's
  // self-update is the `update` subcommand (the `--upgrade` flag was removed).
  test("codex self-update is the `update` subcommand, not a flag", () => {
    expect(BACKEND_UPDATE_COMMANDS.codex).toEqual(["codex", "update"]);
  });

  test("claude-code self-update is `claude update`", () => {
    expect(BACKEND_UPDATE_COMMANDS["claude-code"]).toEqual(["claude", "update"]);
  });
});

describe("updateBackend (delegated self-update, OQ-3/OQ-5)", () => {
  test("ok: updater exits 0 → re-probes and returns the fresh status", async () => {
    const runner = fakeRunner({
      claude: { kind: "exited", exitCode: 0, stdout: "2.1.0", stderr: "" },
    });
    const result = await updateBackend("claude-code", runner, opts);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.status.reason).toBe("ok");
      expect(result.status.version).toBe("2.1.0");
    }
  });

  test("update_failed: updater exits non-zero → typed failure (no throw)", async () => {
    const runner = fakeRunner({
      codex: { kind: "exited", exitCode: 1, stdout: "", stderr: "boom" },
    });
    const result = await updateBackend("codex", runner, opts);
    expect(result.kind).toBe("update_failed");
  });

  test("spawn_failed: updater binary missing → typed failure", async () => {
    const result = await updateBackend("codex", fakeRunner({}), opts);
    expect(result.kind).toBe("spawn_failed");
  });

  test("timeout: updater runs past budget → typed failure", async () => {
    const runner: CommandRunner = async () => ({ kind: "timeout" });
    const result = await updateBackend("claude-code", runner, opts);
    expect(result.kind).toBe("timeout");
  });
});

describe("BackendProbeLive.upgrade (audit-first delegated update, OQ-6)", () => {
  test("emits backend.update.requested BEFORE running the updater, then re-probes", async () => {
    const runner = fakeRunner({
      claude: { kind: "exited", exitCode: 0, stdout: "2.1.0", stderr: "" },
    });
    const rt = ManagedRuntime.make(BackendProbeLive({ runner }));
    const svc = rt.runSync(BackendProbe);
    const seen: BackendUpdateEvents["backend.update.requested"][] = [];
    svc.events.on("backend.update.requested", (e) => {
      seen.push(e);
    });
    const result = await svc.upgrade("claude-code");
    expect(result.kind).toBe("ok");
    // Audit-first: the event fired, carrying the backend id + the binary ref.
    expect(seen).toEqual([{ backend: "claude-code", binary: "claude" }]);
    rt.dispose();
  });
});
