import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppearance } from "../index.ts";
import { AppearancePersistence } from "../persistence.ts";
import { createAppearanceStore } from "../store.ts";
import { APPEARANCE_FILE_VERSION, type AppearanceFile, DEFAULT_PREFERENCES } from "../types.ts";

const EMPTY: AppearanceFile = {
  version: APPEARANCE_FILE_VERSION,
  preferences: DEFAULT_PREFERENCES,
};

describe("createAppearanceStore", () => {
  test("get returns initial preferences", () => {
    const store = createAppearanceStore(EMPTY);
    expect(store.get()).toEqual(DEFAULT_PREFERENCES);
  });

  test("set replaces preferences and emits appearance.changed", async () => {
    const store = createAppearanceStore(EMPTY);
    const log: string[] = [];
    store.events.on("appearance.changed", (e) => {
      log.push(e.mode);
    });
    store.set({ ...DEFAULT_PREFERENCES, mode: "dark" });
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, mode: "dark" });
    await Promise.resolve();
    expect(log).toEqual(["dark"]);
  });

  test("set with per-mode overrides + fonts roundtrips through get", () => {
    const store = createAppearanceStore(EMPTY);
    const prefs = {
      mode: "dark" as const,
      light: {},
      dark: {
        accent: "#4a8eff",
        fontCode: '"JetBrains Mono", monospace',
        fontCodeSize: 14,
        contrast: 65,
      },
      reduceMotion: "system" as const,
      pointerCursors: false,
    };
    store.set(prefs);
    expect(store.get()).toEqual(prefs);
  });

  test("get emits appearance.read", async () => {
    const store = createAppearanceStore(EMPTY);
    const log: string[] = [];
    store.events.on("appearance.read", (e) => {
      log.push(e.mode);
    });
    store.get();
    await Promise.resolve();
    expect(log).toEqual([DEFAULT_PREFERENCES.mode]);
  });
});

describe("createAppearance (memory mode)", () => {
  test("returns DEFAULT_PREFERENCES on first read", () => {
    const a = createAppearance({ mode: "memory" });
    expect(a.get()).toEqual(DEFAULT_PREFERENCES);
  });

  test("set + get roundtrips", () => {
    const a = createAppearance({ mode: "memory" });
    a.set({
      ...DEFAULT_PREFERENCES,
      mode: "dark",
      dark: { background: "#000" },
      pointerCursors: true,
    });
    expect(a.get()).toEqual({
      ...DEFAULT_PREFERENCES,
      mode: "dark",
      dark: { background: "#000" },
      pointerCursors: true,
    });
  });
});

describe("createAppearance (file mode)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-appearance-test-"));
    path = join(dir, "appearance.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists across new instances", () => {
    const a = createAppearance({ mode: "file", path });
    a.set({ ...DEFAULT_PREFERENCES, mode: "dark" });
    const b = createAppearance({ mode: "file", path });
    expect(b.get()).toEqual({ ...DEFAULT_PREFERENCES, mode: "dark" });
  });

  test("returns defaults when file is missing", () => {
    const a = createAppearance({ mode: "file", path });
    expect(a.get()).toEqual(DEFAULT_PREFERENCES);
  });

  test("atomic write leaves no .tmp on disk", () => {
    const a = createAppearance({ mode: "file", path });
    a.set({ ...DEFAULT_PREFERENCES, mode: "light" });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("read throws on shape violation", () => {
    const p = new AppearancePersistence(path);
    p.write({ version: APPEARANCE_FILE_VERSION, preferences: DEFAULT_PREFERENCES });
    Bun.write(path, JSON.stringify({ version: 999, preferences: {} }));
    const p2 = new AppearancePersistence(path);
    expect(() => p2.read()).toThrow();
  });
});
