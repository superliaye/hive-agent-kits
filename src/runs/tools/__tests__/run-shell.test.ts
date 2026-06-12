import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runtimeRoot } from "../../../lib/paths.ts";
import type { FsRunnerPort, ShellRunnerPort, SkillResolverPort } from "../../effect/ports.ts";
import { type BuildRegistryDeps, buildToolRegistry, toolsForBindings } from "../registry.ts";
import { createDefaultShellRunner, makeRunShellTool, resolveWorkingDir } from "../run-shell.ts";

const ctx = {
  agentId: "a",
  runId: "r",
  cwd: process.cwd(),
  boundSkills: [],
  signal: new AbortController().signal,
};

function stubShell(impl: ShellRunnerPort["run"]): ShellRunnerPort {
  return { run: impl };
}

// Minimal deps to build the registry — the file/skill ports are stubbed; these
// tests only assert run_shell presence + the bindings filter.
function registryDeps(): BuildRegistryDeps {
  const fs: FsRunnerPort = {
    readFile: async () => "",
    writeFile: async () => {},
    fileExists: async () => false,
  };
  const skills: SkillResolverPort = { list: () => [], load: () => undefined };
  return { shell: createDefaultShellRunner(), fs, skills };
}

describe("run_shell tool", () => {
  test("folds exit code + stdout into a non-error ToolResult", async () => {
    const tool = makeRunShellTool(
      stubShell(async () => ({ stdout: "hi", stderr: "", exitCode: 0 })),
    );
    const r = await tool.run({ command: "echo", args: ["hi"] }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("exit code: 0");
    expect(r.content).toContain("hi");
  });

  test("non-zero exit code → isError result", async () => {
    const tool = makeRunShellTool(
      stubShell(async () => ({ stdout: "", stderr: "boom", exitCode: 1 })),
    );
    const r = await tool.run({ command: "false", args: [] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit code: 1");
    expect(r.content).toContain("boom");
  });

  test("malformed input → isError result, runner never invoked", async () => {
    let invoked = false;
    const tool = makeRunShellTool(
      stubShell(async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    const r = await tool.run({ notACommand: true }, ctx);
    expect(r.isError).toBe(true);
    expect(invoked).toBe(false);
  });

  describe("resolveWorkingDir three-tier (ADR-0016 C4)", () => {
    test("tier 1 — Thread workingDir wins over agent default + fallback", () => {
      const dir = resolveWorkingDir({
        agentId: "my-agent",
        threadWorkingDir: "/thread/dir",
        agentDefaultWorkingDir: "/agent/dir",
      });
      expect(dir).toBe("/thread/dir");
    });

    test("tier 2 — agent default wins when no Thread pick", () => {
      const dir = resolveWorkingDir({
        agentId: "my-agent",
        threadWorkingDir: null,
        agentDefaultWorkingDir: "/agent/dir",
      });
      expect(dir).toBe("/agent/dir");
    });

    test("tier 3 — fallback equals the old per-Agent workspace path (no regression)", () => {
      const dir = resolveWorkingDir({ agentId: "my-agent" });
      expect(dir).toBe(join(runtimeRoot(), "agents", "my-agent", "workspace"));
      expect(dir).toContain("my-agent");
      expect(dir).toContain("workspace");
    });

    test("empty strings fall through to the next tier", () => {
      const dir = resolveWorkingDir({
        agentId: "my-agent",
        threadWorkingDir: "",
        agentDefaultWorkingDir: "",
      });
      expect(dir).toBe(join(runtimeRoot(), "agents", "my-agent", "workspace"));
    });

    test("determinism — same inputs yield the same output across calls", () => {
      const input = {
        agentId: "my-agent",
        threadWorkingDir: null,
        agentDefaultWorkingDir: "/agent/dir",
      };
      expect(resolveWorkingDir(input)).toBe(resolveWorkingDir(input));
    });
  });

  test("default ShellRunner actually runs node -e cross-platform", async () => {
    const runner = createDefaultShellRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('OK')"],
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  test("default ShellRunner caps a >64KiB stream and marks it truncated", async () => {
    const runner = createDefaultShellRunner();
    // Emit ~128 KiB to stdout — well past the 64 KiB cap.
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(128 * 1024))"],
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(70 * 1024);
    expect(result.stdout).toContain("…(truncated)");
  });

  test("default ShellRunner kills the child on abort → exit 130", async () => {
    const runner = createDefaultShellRunner();
    const controller = new AbortController();
    const promise = runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("process killed (run cancelled)");
  });
});

describe("tool registry + bindings filter", () => {
  test("run_shell present in registry", () => {
    const reg = buildToolRegistry(registryDeps());
    expect(reg.has("run_shell")).toBe(true);
  });

  test("file tools + load_skill present in registry", () => {
    const reg = buildToolRegistry(registryDeps());
    expect(reg.has("read")).toBe(true);
    expect(reg.has("write")).toBe(true);
    expect(reg.has("edit")).toBe(true);
    expect(reg.has("load_skill")).toBe(true);
  });

  test("toolsForBindings sends run_shell only when bound", () => {
    const reg = buildToolRegistry(registryDeps());
    expect(toolsForBindings(reg, ["run_shell"])?.map((d) => d.name)).toEqual(["run_shell"]);
    // Unbound → omitted entirely (undefined).
    expect(toolsForBindings(reg, [])).toBeUndefined();
    expect(toolsForBindings(reg, ["some_other_tool"])).toBeUndefined();
  });
});
