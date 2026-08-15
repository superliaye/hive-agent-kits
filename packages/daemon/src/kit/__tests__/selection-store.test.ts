import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@hive/contract";
import { openSelectionStore, SelectionConflictError } from "../selection-store.ts";

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
    expect(changed.removalIntents).toEqual([{ key, targets: ["codex"] }]);
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
    ).toEqual([{ key: unavailable, targets: ["codex"] }]);
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

  test("clears only completed removal intents through the internal atomic seam", () => {
    root = mkdtempSync(join(tmpdir(), "hive-selection-"));
    const store = openSelectionStore(path());
    store.seedOnce(ledger);
    store.mutate({ expectedRevision: 1, changes: [{ key, enabled: false, targets: codex }] });
    expect(store.clearRemovalIntents(2, [{ key, targets: ["claude"] }])).toMatchObject({
      revision: 2,
      removalIntents: [{ key, targets: ["codex"] }],
    });
    expect(store.clearRemovalIntents(2, [{ key, targets: codex }])).toEqual({
      revision: 3,
      enabled: [
        { key: { kind: "agent", name: "helper" }, targets: ["claude", "codex"] },
        { key, targets: ["claude"] },
      ],
      removalIntents: [],
    });
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
});
