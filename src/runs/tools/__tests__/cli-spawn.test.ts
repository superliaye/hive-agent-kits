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

  test("stderr is exposed and drained (decoded UTF-8)", async () => {
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: [NODE, "-e", "process.stderr.write('DIAG'); process.stdout.write('OUT')"],
      cwd: process.cwd(),
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    const [out, err] = await Promise.all([collect(result.stdout), collect(result.stderr)]);
    expect(out).toContain("OUT");
    expect(err).toContain("DIAG");
    expect(await result.exit).toEqual({ exitCode: 0 });
  });

  test("stderr is a live stream — distinct lines arrive as multiple chunks, not one post-exit replay", async () => {
    // A child emits three distinct stderr lines spaced over time. A promptly
    // pulling consumer must receive them as they arrive (multiple chunks), not as
    // a single chunk replayed after the process exits.
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: [
        NODE,
        "-e",
        "process.stderr.write('one\\n'); setTimeout(() => { process.stderr.write('two\\n'); setTimeout(() => process.stderr.write('three\\n'), 20); }, 20)",
      ],
      cwd: process.cwd(),
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;

    const chunks: string[] = [];
    for await (const chunk of result.stderr) chunks.push(chunk);
    // Faithful live delivery: every line made it through (consumer kept pace).
    expect(chunks.join("")).toContain("one");
    expect(chunks.join("")).toContain("two");
    expect(chunks.join("")).toContain("three");
    // Live, not a single post-exit replay: the spaced-out writes arrive as
    // separate chunks rather than one finalized blob.
    expect(chunks.length).toBeGreaterThan(1);
    expect(await result.exit).toEqual({ exitCode: 0 });
  });

  test("large stderr does not clog the child when the consumer never reads stderr", async () => {
    // The adapter pump always reads stderr to completion, so a stderr write far
    // larger than the OS pipe buffer cannot deadlock the child even if the
    // consumer iterates ONLY stdout (never stderr). Nothing is retained — the
    // pump drops what the (absent) stderr consumer can't take.
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: [
        NODE,
        "-e",
        "process.stderr.write('x'.repeat(256 * 1024)); process.stdout.write('DONE')",
      ],
      cwd: process.cwd(),
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    // Consume only stdout. If the pump did not drain stderr, the >pipe-buffer
    // write would block the child and this would hang.
    const out = await collect(result.stdout);
    expect(out).toContain("DONE");
    expect(await result.exit).toEqual({ exitCode: 0 });
  });

  test("large stdin to a child that exits without reading does not crash", async () => {
    // r1-general-0 regression: Bun FileSink write/end reject (EOF) when the child
    // closes stdin early. Those rejections must be swallowed, not floated into an
    // unhandled rejection that crashes the daemon.
    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const spawner = createDefaultCliSpawner();
      const result = spawner.spawn({
        command: [NODE, "-e", "process.exit(0)"],
        cwd: process.cwd(),
        stdin: "y".repeat(8 * 1024 * 1024),
      });
      expect(result.kind).toBe("spawned");
      if (result.kind !== "spawned") return;
      await result.exit;
      // Give a microtask/macrotask window for any rejection to surface.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
