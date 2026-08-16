import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIndependentFileLock, withIndependentFileLockAsync } from "../cooperative-file-lock.ts";

test("async lock contention yields the Daemon event loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-lock-async-contention-"));
  const resource = join(root, "manifest.json");
  let competing: Promise<void> | undefined;
  try {
    await withIndependentFileLockAsync(
      resource,
      async () => {
        let timerFired = false;
        setTimeout(() => {
          timerFired = true;
        }, 0);
        competing = withIndependentFileLockAsync(resource, async () => {}, {
          timeoutMs: 500,
          staleMs: 100,
          updateMs: 10,
        });
        await Bun.sleep(30);
        expect(timerFired).toBe(true);
      },
      { timeoutMs: 500, staleMs: 100, updateMs: 10 },
    );
    await competing;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "a timed-out release kills its exact keeper and retires the owned lock",
  () => {
    const root = mkdtempSync(join(tmpdir(), "hive-lock-release-timeout-"));
    const resource = join(root, "manifest.json");
    let keeperPid: number | undefined;
    try {
      expect(() =>
        withIndependentFileLock(
          resource,
          () => {
            const owner = JSON.parse(readFileSync(`${resource}.lock/owner.json`, "utf8")) as {
              keeper: { pid: number };
            };
            keeperPid = owner.keeper.pid;
            process.kill(keeperPid, "SIGSTOP");
          },
          { timeoutMs: 25, staleMs: 25, updateMs: 5 },
        ),
      ).toThrow("Timed out releasing manifest lock");

      expect(() =>
        withIndependentFileLock(resource, () => {}, {
          timeoutMs: 500,
          staleMs: 25,
          updateMs: 5,
        }),
      ).not.toThrow();
    } finally {
      if (keeperPid !== undefined) {
        try {
          process.kill(keeperPid, "SIGKILL");
        } catch {
          // The release cleanup already reaped it.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
