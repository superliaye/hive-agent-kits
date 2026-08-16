import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@hive/contract";
import { openSelectionStore, SelectionConflictError, SelectionFile } from "../selection-store.ts";

const ledger: Ledger = {
  kitVersion: "",
  agents: ["claude", "codex"],
  skills: [{ name: "alpha" }],
  agentDefs: [{ name: "helper" }],
  instructions: [],
  plugins: [],
  bundles: [],
};

const key = { kind: "skill" as const, name: "alpha" };
const codex: ("claude" | "codex")[] = ["codex"];
let root = "";

function path(): string {
  return join(root, "selection.json");
}

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("SelectionStore", () => {
  test("seeds only applicable Ledger targets and rejects new ghost target pairs", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    const seeded = store.seedOnce({
      ...ledger,
      plugins: [{ name: "claude-only" }],
    });
    expect(seeded.enabled).toContainEqual({
      key: { kind: "plugin", name: "claude-only" },
      targets: ["claude"],
    });
    expect(() =>
      store.mutate({
        expectedRevision: seeded.revision,
        changes: [
          {
            key: { kind: "plugin", name: "claude-only" },
            enabled: true,
            targets: ["codex"],
          },
        ],
      }),
    ).toThrow("selection_target_not_applicable");
  });

  test("migrates persisted ghost target pairs out of Selection", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    writeFileSync(
      path(),
      JSON.stringify({
        schemaVersion: 2,
        initialized: true,
        revision: 9,
        enabled: [
          { key: { kind: "plugin", name: "plug" }, targets: ["claude", "codex"] },
          { key: { kind: "skill", name: "skill" }, targets: ["codex"] },
        ],
        removalIntents: [
          {
            key: { kind: "plugin", name: "plug" },
            targets: ["codex"],
            generation: "ghost",
          },
        ],
      }),
    );

    expect(openSelectionStore(path()).read()).toEqual({
      revision: 9,
      enabled: [
        { key: { kind: "plugin", name: "plug" }, targets: ["claude"] },
        { key: { kind: "skill", name: "skill" }, targets: ["codex"] },
      ],
      removalIntents: [],
    });
  });
  test("persists a seeded selection across restart and seeds only once", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    expect(store.read()).toEqual({ revision: 0, enabled: [], removalIntents: [] });
    expect(existsSync(path())).toBe(false);
    expect(store.seedOnce(ledger)).toEqual({
      revision: 1,
      enabled: [
        { key: { kind: "agent", name: "helper" }, targets: ["claude", "codex"] },
        { key, targets: ["claude", "codex"] },
      ],
      removalIntents: [],
    });
    expect(openSelectionStore(path()).seedOnce({ ...ledger, skills: [{ name: "other" }] })).toEqual(
      store.read(),
    );
  });

  test("keeps an initialized empty selection empty", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(null);
    expect(store.read()).toEqual({ revision: 1, enabled: [], removalIntents: [] });
    expect(store.seedOnce(ledger)).toEqual({ revision: 1, enabled: [], removalIntents: [] });
  });

  test("rejects corrupt current-version content without reseeding", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    writeFileSync(path(), JSON.stringify({ schemaVersion: 1, initialized: true, revision: "bad" }));
    const store = openSelectionStore(path());
    expect(() => store.seedOnce(ledger)).toThrow("selection_corrupt");
    expect(readFileSync(path(), "utf8")).toContain('"bad"');
  });

  test("migrates v1 target intents to generated current identities", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    writeFileSync(
      path(),
      JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        revision: 4,
        enabled: [],
        removalIntents: [{ key, targets: ["claude", "codex"] }],
      }),
    );
    const generations = ["migrated-claude", "migrated-codex"];
    const store = openSelectionStore(path(), {
      generation: () => generations.shift() ?? "unexpected",
    });

    expect(store.read()).toEqual({
      revision: 4,
      enabled: [],
      removalIntents: [
        { key, targets: ["claude"], generation: "migrated-claude" },
        { key, targets: ["codex"], generation: "migrated-codex" },
      ],
    });
    expect(JSON.parse(readFileSync(path(), "utf8"))).toMatchObject({ schemaVersion: 3 });
  });

  test("keeps exact target sets and exposes no mutable internal state", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(ledger);
    const changed = store.mutate({
      expectedRevision: 1,
      changes: [{ key, enabled: false, targets: codex }],
    });
    expect(changed.revision).toBe(2);
    expect(changed.enabled.find((entry) => entry.key.name === "alpha")).toEqual({
      key,
      targets: ["claude"],
    });
    expect(changed.removalIntents).toEqual([
      { key, targets: ["codex"], generation: expect.any(String) },
    ]);
    changed.enabled[0]?.targets.push("codex");
    expect(store.read().enabled.find((entry) => entry.key.name === "alpha")?.targets).toEqual([
      "claude",
    ]);
  });

  test("creates target-scoped removal intents for ledger-owned unavailable keys and cancels them on enable", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(null);
    const unavailable = { kind: "skill" as const, name: "alpha" };
    expect(
      store.mutate(
        { expectedRevision: 1, changes: [{ key: unavailable, enabled: false, targets: codex }] },
        ledger,
      ).removalIntents,
    ).toEqual([{ key: unavailable, targets: ["codex"], generation: expect.any(String) }]);
    expect(
      store.mutate({
        expectedRevision: 2,
        changes: [{ key: unavailable, enabled: true, targets: codex }],
      }).removalIntents,
    ).toEqual([]);
    expect(
      store.mutate({
        expectedRevision: 3,
        changes: [{ key: { kind: "skill", name: "absent" }, enabled: false, targets: codex }],
      }).removalIntents,
    ).toEqual([]);
  });

  test("creates removal intents only for targets that were selected or Ledger-owned", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const claudeOnlyLedger: Ledger = { ...ledger, agents: ["claude"] };
    const store = openSelectionStore(path());
    const seeded = store.seedOnce(claudeOnlyLedger);

    const changed = store.mutate(
      {
        expectedRevision: seeded.revision,
        changes: [{ key, enabled: false, targets: ["claude", "codex"] }],
      },
      claudeOnlyLedger,
    );

    expect(changed.enabled.find((entry) => entry.key.name === "alpha")).toBeUndefined();
    expect(changed.removalIntents).toEqual([
      { key, targets: ["claude"], generation: expect.any(String) },
    ]);
  });

  test("clears only completed removal intents through the internal atomic seam", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(ledger);
    store.mutate({ expectedRevision: 1, changes: [{ key, enabled: false, targets: codex }] });
    const generation = store.read().removalIntents[0]?.generation;
    if (!generation) throw new Error("missing removal generation");
    expect(store.clearRemovalIntents([{ key, target: "claude", generation }])).toMatchObject({
      revision: 2,
      removalIntents: [{ key, targets: ["codex"], generation }],
    });
    expect(store.clearRemovalIntents([{ key, target: "codex", generation }])).toEqual({
      revision: 3,
      enabled: [
        { key: { kind: "agent", name: "helper" }, targets: ["claude", "codex"] },
        { key, targets: ["claude"] },
      ],
      removalIntents: [],
    });
  });

  test("successful removal clearing preserves Selection edits committed after acceptance", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(ledger);
    store.mutate({ expectedRevision: 1, changes: [{ key, enabled: false, targets: codex }] });
    const generation = store.read().removalIntents[0]?.generation;
    if (!generation) throw new Error("missing removal generation");
    const later = { kind: "skill" as const, name: "later" };
    store.mutate({
      expectedRevision: 2,
      changes: [{ key: later, enabled: true, targets: ["claude"] }],
    });

    expect(store.clearRemovalIntents([{ key, target: "codex", generation }])).toMatchObject({
      revision: 4,
      enabled: expect.arrayContaining([{ key: later, targets: ["claude"] }]),
      removalIntents: [],
    });
  });

  test("old completion cannot clear a recreated same-target removal intent", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const generations = ["intent-old", "intent-new"];
    const store = openSelectionStore(path(), {
      generation: () => generations.shift() ?? "unexpected-generation",
    });
    store.seedOnce(ledger);
    store.mutate({ expectedRevision: 1, changes: [{ key, enabled: false, targets: codex }] });
    const acceptedGeneration = store.read().removalIntents[0]?.generation;
    expect(acceptedGeneration).toBe("intent-old");
    store.mutate({ expectedRevision: 2, changes: [{ key, enabled: true, targets: codex }] });
    store.mutate({ expectedRevision: 3, changes: [{ key, enabled: false, targets: codex }] });
    expect(store.read().removalIntents[0]?.generation).toBe("intent-new");

    store.clearRemovalIntents([
      { key, target: "codex", generation: acceptedGeneration ?? "missing" },
    ]);

    expect(store.read().removalIntents).toEqual([
      { key, targets: ["codex"], generation: "intent-new" },
    ]);
  });

  test("rejects a stale revision with the current revision", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(ledger);
    store.mutate({ expectedRevision: 1, changes: [] });
    expect(() => store.mutate({ expectedRevision: 1, changes: [] })).toThrow(
      SelectionConflictError,
    );
    expect(() => store.mutate({ expectedRevision: 1, changes: [] })).toThrow("selection_conflict");
  });

  test("retains the prior committed bytes when an atomic write fails", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const initial = openSelectionStore(path());
    initial.seedOnce(ledger);
    const before = readFileSync(path(), "utf8");
    const failing = openSelectionStore(path(), {
      rename: () => {
        throw new Error("disk full");
      },
    });
    expect(() => failing.mutate({ expectedRevision: 1, changes: [] })).toThrow("disk full");
    expect(readFileSync(path(), "utf8")).toBe(before);
  });

  test("completes partial writes before fsync and rename", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const initial = openSelectionStore(path());
    initial.seedOnce(ledger);
    let writes = 0;
    const partial = openSelectionStore(path(), {
      write: (fd, bytes, offset, length) => {
        writes += 1;
        return writeSync(fd, bytes, offset, Math.min(length, 7));
      },
    });

    const committed = partial.mutate({ expectedRevision: 1, changes: [] });

    expect(writes).toBeGreaterThan(1);
    expect(SelectionFile.parse(JSON.parse(readFileSync(path(), "utf8")))).toMatchObject({
      schemaVersion: 3,
      revision: 2,
    });
    expect(openSelectionStore(path()).read()).toEqual(committed);
  });

  test("rejects zero-progress writes without replacing the committed selection", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const initial = openSelectionStore(path());
    initial.seedOnce(ledger);
    const before = readFileSync(path(), "utf8");
    let writes = 0;
    const stalled = openSelectionStore(path(), {
      write: () => {
        writes += 1;
        return 0;
      },
    });

    expect(() => stalled.mutate({ expectedRevision: 1, changes: [] })).toThrow(
      "selection_write_failed",
    );
    expect(writes).toBe(1);
    expect(readFileSync(path(), "utf8")).toBe(before);
  });

  test("retains the committed selection when a write throws", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const initial = openSelectionStore(path());
    initial.seedOnce(ledger);
    const before = readFileSync(path(), "utf8");
    const failing = openSelectionStore(path(), {
      write: () => {
        throw new Error("write interrupted");
      },
    });

    expect(() => failing.mutate({ expectedRevision: 1, changes: [] })).toThrow("write interrupted");
    expect(readFileSync(path(), "utf8")).toBe(before);
  });
});
