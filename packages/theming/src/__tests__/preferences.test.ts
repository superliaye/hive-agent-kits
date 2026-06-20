// Tests for the preferences controller — pure-JS state machine extracted
// from ThemeProvider. The state-machine bugs the controller is built to
// avoid (stale rollback target under rapid edits, swallowed save errors,
// snapshot identity churn) are testable directly here, no React tree
// needed.

import { describe, expect, test } from "bun:test";
import { createPreferencesController } from "../preferences.ts";
import type { Persistence, Preferences } from "../types.ts";

const DEFAULTS: Preferences = {
  mode: "system",
  light: {},
  dark: {},
  reduceMotion: "system",
  pointerCursors: false,
  useSystemAccent: false,
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePersistence(
  opts: {
    load?: () => Promise<Preferences | null>;
    save?: (prefs: Preferences) => Promise<void>;
  } = {},
): Persistence {
  return {
    load: opts.load ?? (async () => null),
    save: opts.save ?? (async () => undefined),
  };
}

describe("createPreferencesController", () => {
  test("initial snapshot uses bootstrap, ready false", () => {
    const c = createPreferencesController(makePersistence(), DEFAULTS);
    const s = c.getSnapshot();
    expect(s.preferences).toEqual(DEFAULTS);
    expect(s.ready).toBe(false);
    expect(s.saveError).toBeNull();
  });

  test("load completes → ready true, preferences replaced by loaded", async () => {
    const loaded: Preferences = { ...DEFAULTS, mode: "dark" };
    const c = createPreferencesController(makePersistence({ load: async () => loaded }), DEFAULTS);
    await Promise.resolve(); // let load microtask resolve
    await Promise.resolve();
    const s = c.getSnapshot();
    expect(s.ready).toBe(true);
    expect(s.preferences).toEqual(loaded);
  });

  test("load failure → ready true, preferences stay at bootstrap", async () => {
    const c = createPreferencesController(
      makePersistence({
        load: async () => {
          throw new Error("boom");
        },
      }),
      DEFAULTS,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(c.getSnapshot().ready).toBe(true);
    expect(c.getSnapshot().preferences).toEqual(DEFAULTS);
  });

  test("snapshot reference is stable when nothing changes", () => {
    const c = createPreferencesController(makePersistence(), DEFAULTS);
    expect(c.getSnapshot()).toBe(c.getSnapshot());
  });

  test("set() applies optimistically and notifies subscribers", async () => {
    const c = createPreferencesController(makePersistence(), DEFAULTS);
    const events: Preferences[] = [];
    c.subscribe(() => events.push(c.getSnapshot().preferences));
    await c.set({ ...DEFAULTS, mode: "dark" });
    expect(c.getSnapshot().preferences.mode).toBe("dark");
    expect(events.some((p) => p.mode === "dark")).toBe(true);
  });

  test("set() rolls back to LAST SAVED, not bootstrap (rapid-edit safety)", async () => {
    // The bug the controller was built to fix: closing over React state
    // captures a stale "previous" under rapid sets. The controller's
    // lastSaved cell tracks the last accepted value across all calls.
    let saveBehavior: "ok" | "throw" = "ok";
    const c = createPreferencesController(
      makePersistence({
        save: async () => {
          if (saveBehavior === "throw") throw new Error("rejected");
        },
      }),
      DEFAULTS,
    );

    // A succeeds → lastSaved becomes mode:"dark"
    await c.set({ ...DEFAULTS, mode: "dark" });
    expect(c.getSnapshot().preferences.mode).toBe("dark");
    expect(c.getSnapshot().saveError).toBeNull();

    // B fails → rolls back to A, not to DEFAULTS bootstrap
    saveBehavior = "throw";
    await c.set({ ...DEFAULTS, mode: "light" });
    expect(c.getSnapshot().preferences.mode).toBe("dark");
    expect(c.getSnapshot().saveError).toBe("rejected");
  });

  test("set() rollback clears the save error on next success", async () => {
    let saveBehavior: "ok" | "throw" = "ok";
    const c = createPreferencesController(
      makePersistence({
        save: async () => {
          if (saveBehavior === "throw") throw new Error("first failed");
        },
      }),
      DEFAULTS,
    );
    saveBehavior = "throw";
    await c.set({ ...DEFAULTS, mode: "dark" });
    expect(c.getSnapshot().saveError).toBe("first failed");
    saveBehavior = "ok";
    await c.set({ ...DEFAULTS, mode: "light" });
    expect(c.getSnapshot().saveError).toBeNull();
    expect(c.getSnapshot().preferences.mode).toBe("light");
  });

  test("subscribe disposer stops notifications", async () => {
    const c = createPreferencesController(makePersistence(), DEFAULTS);
    let count = 0;
    const dispose = c.subscribe(() => count++);
    await c.set({ ...DEFAULTS, mode: "dark" });
    const after1 = count;
    dispose();
    await c.set({ ...DEFAULTS, mode: "light" });
    expect(count).toBe(after1);
  });

  test("dispose() ignores in-flight load resolution", async () => {
    const d = deferred<Preferences | null>();
    const c = createPreferencesController(makePersistence({ load: () => d.promise }), DEFAULTS);
    c.dispose();
    d.resolve({ ...DEFAULTS, mode: "dark" });
    await Promise.resolve();
    await Promise.resolve();
    // ready should remain false — load was ignored after dispose
    expect(c.getSnapshot().ready).toBe(false);
  });
});
