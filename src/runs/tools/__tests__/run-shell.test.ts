import { describe, expect, test } from "bun:test";
import type { ShellRunnerPort } from "../../effect/ports.ts";
import { buildToolRegistry, toolsForBindings } from "../registry.ts";
import { createDefaultShellRunner, makeRunShellTool, resolveWorkingDir } from "../run-shell.ts";

const ctx = { agentId: "a", runId: "r", cwd: process.cwd() };

function stubShell(impl: ShellRunnerPort["run"]): ShellRunnerPort {
  return { run: impl };
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

  test("resolveWorkingDir stub returns a per-Agent workspace default", () => {
    const dir = resolveWorkingDir("my-agent");
    expect(dir).toContain("my-agent");
    expect(dir).toContain("workspace");
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
});

describe("tool registry + bindings filter", () => {
  test("run_shell present in registry", () => {
    const reg = buildToolRegistry({ shell: createDefaultShellRunner() });
    expect(reg.has("run_shell")).toBe(true);
  });

  test("toolsForBindings sends run_shell only when bound", () => {
    const reg = buildToolRegistry({ shell: createDefaultShellRunner() });
    expect(toolsForBindings(reg, ["run_shell"])?.map((d) => d.name)).toEqual(["run_shell"]);
    // Unbound → omitted entirely (undefined).
    expect(toolsForBindings(reg, [])).toBeUndefined();
    expect(toolsForBindings(reg, ["some_other_tool"])).toBeUndefined();
  });
});
