import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDirectoryForDurability, withCooperativeFileLock } from "../durable-file.ts";

describe("directory durability", () => {
  test("skips the POSIX directory fsync on Windows", () => {
    expect(() =>
      syncDirectoryForDurability("/path-that-must-not-be-opened", "win32"),
    ).not.toThrow();
  });

  test("cleans up a zero-timeout initialization and permits the next owner", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-zero-timeout-lock-"));
    const resource = join(root, "manifest.json");
    try {
      expect(() => withCooperativeFileLock(resource, 0, () => {})).toThrow();
      expect(existsSync(`${resource}.lock`)).toBe(false);
      expect(withCooperativeFileLock(resource, 5_000, () => "acquired")).toBe("acquired");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
