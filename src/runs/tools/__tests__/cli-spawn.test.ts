import { describe, expect, test } from "bun:test";
import { createDefaultCliSpawner, memoryCliSpawner } from "../cli-spawn.ts";

// Real-executable approach, mirroring run-shell.test.ts. `process.execPath`
// (node) — not `echo`, which doesn't spawn bare on Windows.
const NODE = process.execPath;

async function collect(stdout: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stdout) out += chunk;
  return out;
}

describe("createDefaultCliSpawner", () => {
  test("streams stdout incrementally and reports the exit code", async () => {
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: [
        NODE,
        "-e",
        "process.stdout.write('A'); setTimeout(() => process.stdout.write('B'), 20)",
      ],
      cwd: process.cwd(),
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    const out = await collect(result.stdout);
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(await result.exit).toEqual({ exitCode: 0 });
  });

  test("abort kills the child — stream terminates and exit resolves", async () => {
    const spawner = createDefaultCliSpawner();
    const controller = new AbortController();
    const result = spawner.spawn({
      command: [NODE, "-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    controller.abort();
    // The killed proc closes stdout (iterable terminates) and exit resolves.
    await collect(result.stdout);
    await result.exit;
  });

  test("nonexistent binary → spawn_failed value (not a throw)", () => {
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: ["definitely-not-a-real-binary-xyz"],
      cwd: process.cwd(),
    });
    expect(result.kind).toBe("spawn_failed");
    if (result.kind !== "spawn_failed") return;
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("stdin is written then closed before streaming", async () => {
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: [NODE, "-e", "process.stdin.pipe(process.stdout)"],
      cwd: process.cwd(),
      stdin: "hello",
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    const out = await collect(result.stdout);
    expect(out).toContain("hello");
    expect(await result.exit).toEqual({ exitCode: 0 });
  });
});

describe("memoryCliSpawner", () => {
  test("is subprocess-free: every spawn is spawn_failed", () => {
    const result = memoryCliSpawner.spawn({ command: [NODE], cwd: process.cwd() });
    expect(result.kind).toBe("spawn_failed");
    if (result.kind !== "spawn_failed") return;
    expect(result.message).toBe("cli spawn disabled");
  });
});
