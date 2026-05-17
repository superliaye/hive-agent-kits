/**
 * Tiered manifest store — the shared scan-and-diff machinery behind the
 * Capability Registry and the Agent Catalog. Tested in isolation with a
 * synthetic scan function so we never touch the filesystem here.
 */

import { describe, expect, test } from "bun:test";
import { createTieredManifestStore, type ScanDiff } from "../tiered-store.ts";

type Item = { key: string; payload: string };

function makeScan(items: Item[]): () => { items: Item[]; errors: never[] } {
  return () => ({ items, errors: [] });
}

describe("createTieredManifestStore", () => {
  test("start() reports every item as added", async () => {
    const diffs: ScanDiff<Item>[] = [];
    const store = createTieredManifestStore<Item>({
      watchRoots: [],
      watch: false,
      scan: makeScan([
        { key: "a", payload: "1" },
        { key: "b", payload: "1" },
      ]),
      key: (i) => i.key,
      same: (a, b) => a.payload === b.payload,
      onDiff: (d) => {
        diffs.push(d);
      },
    });
    await store.start();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.added.map((i) => i.key).sort()).toEqual(["a", "b"]);
    expect(diffs[0]?.removed).toHaveLength(0);
    expect(diffs[0]?.changed).toHaveLength(0);
    expect(store.current()).toHaveLength(2);
    expect(store.get("a")?.payload).toBe("1");
  });

  test("rescan() classifies added / removed / changed correctly", async () => {
    let items: Item[] = [
      { key: "a", payload: "1" },
      { key: "b", payload: "1" },
    ];
    const diffs: ScanDiff<Item>[] = [];
    const store = createTieredManifestStore<Item>({
      watchRoots: [],
      watch: false,
      scan: () => ({ items, errors: [] }),
      key: (i) => i.key,
      same: (a, b) => a.payload === b.payload,
      onDiff: (d) => {
        diffs.push(d);
      },
    });
    await store.start();
    diffs.length = 0;

    items = [
      { key: "a", payload: "2" }, // changed
      { key: "c", payload: "1" }, // added
      // b removed
    ];
    await store.rescan();

    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d?.added.map((i) => i.key)).toEqual(["c"]);
    expect(d?.removed.map((i) => i.key)).toEqual(["b"]);
    expect(d?.changed.map((i) => i.key)).toEqual(["a"]);
  });

  test("first-scan scan() throw is fatal", async () => {
    const store = createTieredManifestStore<Item>({
      watchRoots: [],
      watch: false,
      scan: () => {
        throw new Error("boom");
      },
      key: (i) => i.key,
      same: () => true,
      onDiff: () => {},
    });
    await expect(store.start()).rejects.toThrow("boom");
  });

  test("rescan() scan() throw is reported, prior state preserved", async () => {
    let shouldThrow = false;
    let items: Item[] = [{ key: "a", payload: "1" }];
    const rescanErrors: Error[] = [];
    const store = createTieredManifestStore<Item>({
      watchRoots: [],
      watch: false,
      scan: () => {
        if (shouldThrow) throw new Error("boom");
        return { items, errors: [] };
      },
      key: (i) => i.key,
      same: (a, b) => a.payload === b.payload,
      onDiff: () => {},
      onRescanError: (err) => {
        rescanErrors.push(err);
      },
    });
    await store.start();
    expect(store.current()).toHaveLength(1);

    shouldThrow = true;
    items = []; // would normally remove "a"
    await store.rescan();

    expect(rescanErrors).toHaveLength(1);
    expect(rescanErrors[0]?.message).toBe("boom");
    // Prior state preserved — "a" is still there.
    expect(store.current().map((i) => i.key)).toEqual(["a"]);
  });

  test("loader errors are reported via onLoaderError without aborting the scan", async () => {
    const seen: Array<{ path: string; message: string }> = [];
    const store = createTieredManifestStore<Item>({
      watchRoots: [],
      watch: false,
      scan: () => ({
        items: [{ key: "a", payload: "1" }],
        errors: [{ path: "/bad", message: "malformed" }],
      }),
      key: (i) => i.key,
      same: () => true,
      onDiff: () => {},
      onLoaderError: (e) => {
        seen.push(e);
      },
    });
    await store.start();
    expect(seen).toEqual([{ path: "/bad", message: "malformed" }]);
    expect(store.current()).toHaveLength(1);
  });

  test("dispose() is safe and idempotent", async () => {
    const store = createTieredManifestStore<Item>({
      watchRoots: [],
      watch: false,
      scan: makeScan([]),
      key: (i) => i.key,
      same: () => true,
      onDiff: () => {},
    });
    await store.start();
    expect(() => store.dispose()).not.toThrow();
    expect(() => store.dispose()).not.toThrow();
  });
});
