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

  test("large stderr is drained without deadlock and retained as a 64 KiB head+tail window", async () => {
    // stderr is drained eagerly by the adapter, so a stderr write larger than the
    // pipe buffer cannot block the child even if the consumer only reads stdout.
    // The RETAINED stderr is bounded to a 64 KiB head+tail window (first 32 KiB +
    // dropped-middle marker + last 32 KiB), NOT unbounded accumulation.
    const spawner = createDefaultCliSpawner();
    const result = spawner.spawn({
      command: [
        NODE,
        "-e",
        // Distinct head/tail sentinels around 2 MiB of filler so we can prove the
        // head and tail survived and the middle was dropped.
        "process.stderr.write('HEAD' + 'x'.repeat(2 * 1024 * 1024) + 'TAIL'); process.stdout.write('DONE')",
      ],
      cwd: process.cwd(),
    });
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    // Consume only stdout first to prove the child still completes (drain did not
    // deadlock past the cap).
    const out = await collect(result.stdout);
    expect(out).toContain("DONE");
    expect(await result.exit).toEqual({ exitCode: 0 });

    const err = await collect(result.stderr);
    // Bounded: total retained ≤ 64 KiB (head 32 KiB + marker + tail 32 KiB), far
    // below the 2 MiB written.
    expect(err.length).toBeLessThanOrEqual(64 * 1024 + 64);
    // Head survived, tail survived, middle was dropped via the marker.
    expect(err.startsWith("HEAD")).toBe(true);
    expect(err.endsWith("TAIL")).toBe(true);
    expect(err).toContain("truncated");
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
