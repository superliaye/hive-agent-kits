// Tiered Manifest Store — the shared filesystem-scan-and-diff machinery
// behind the Capability Registry and the Agent Catalog. Both modules deal
// in items scanned from a two-tier directory layout (bundled + runtime),
// resolved into a current map, diffed on rescan, watched for hot-reload.
// The store owns scan + watch + diff; the consumer owns its typed events
// and the resolution/loader logic. See ADR-0007 ("share lower-level
// storage primitives but are separate at the registry seam").
//
// The store is generic over `T` — the resolved item type. Consumers pass
// a `scan` function that already returns resolved items (after running any
// shadowing or collision rules) and a `key`/`same` pair for diffing.

import { watch, type FSWatcher } from "node:fs";

export type LoaderError = { path: string; message: string };

export type ScanResult<T> = {
  items: T[];
  errors: LoaderError[];
};

export type ScanDiff<T> = {
  added: T[];
  removed: T[];
  changed: T[];
};

export type TieredManifestStore<T> = {
  // Initial scan. May throw if `scan()` throws (fatal config errors land here).
  // The diff handed to `onDiff` lists all items as `added`.
  start(): Promise<void>;
  // Force a fresh scan. Swallows `scan()` throws via `onRescanError` so the
  // daemon survives transient invalid states during hot-reload.
  rescan(): Promise<void>;
  current(): readonly T[];
  get(key: string): T | undefined;
  dispose(): void;
};

export type CreateStoreOptions<T> = {
  // Filesystem roots to watch for changes. Missing roots are silently
  // tolerated (no watcher attached for that root).
  watchRoots: string[];
  // Returns the resolved set of items. Throws are fatal on first scan;
  // on rescan they fire `onRescanError` and the previous map is kept.
  scan: () => ScanResult<T>;
  // Identity for diffing — `kind:name` or `agentId` etc.
  key: (item: T) => string;
  // Equality for the "changed" classification. Two items with the same key
  // are "changed" iff `same` returns false.
  same: (a: T, b: T) => boolean;
  onDiff: (diff: ScanDiff<T>) => Promise<void> | void;
  // Per-manifest parse failure (one row in `errors[]`). Module-specific
  // logging happens in the callback so we can prefix with the module name.
  onLoaderError?: (err: LoaderError) => void;
  // `scan()` threw during a rescan. First-scan throws are not routed here.
  onRescanError?: (err: Error) => void;
  watch?: boolean;
};

const RESCAN_DEBOUNCE_MS = 250;

export function createTieredManifestStore<T>(
  opts: CreateStoreOptions<T>,
): TieredManifestStore<T> {
  let items = new Map<string, T>();
  const watchers: FSWatcher[] = [];
  let started = false;
  let pendingRescan: ReturnType<typeof setTimeout> | undefined;

  function diffMaps(prior: Map<string, T>, next: Map<string, T>): ScanDiff<T> {
    const added: T[] = [];
    const removed: T[] = [];
    const changed: T[] = [];
    for (const [k, v] of next) {
      const before = prior.get(k);
      if (!before) added.push(v);
      else if (!opts.same(before, v)) changed.push(v);
    }
    for (const [k, v] of prior) {
      if (!next.has(k)) removed.push(v);
    }
    return { added, removed, changed };
  }

  async function runScan(isFirst: boolean): Promise<void> {
    let result: ScanResult<T>;
    try {
      result = opts.scan();
    } catch (err) {
      if (isFirst) throw err;
      opts.onRescanError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (opts.onLoaderError) {
      for (const e of result.errors) opts.onLoaderError(e);
    }
    const next = new Map<string, T>(result.items.map((it) => [opts.key(it), it]));
    const diff = isFirst
      ? { added: [...next.values()], removed: [] as T[], changed: [] as T[] }
      : diffMaps(items, next);
    items = next;
    await opts.onDiff(diff);
  }

  function scheduleRescan(): void {
    if (pendingRescan) clearTimeout(pendingRescan);
    pendingRescan = setTimeout(() => {
      pendingRescan = undefined;
      runScan(false).catch((err) => {
        opts.onRescanError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, RESCAN_DEBOUNCE_MS);
  }

  function attachWatchers(): void {
    for (const root of opts.watchRoots) {
      try {
        const w = watch(root, { recursive: true }, () => scheduleRescan());
        w.on("error", () => {
          // Swallow watcher errors; the dir may not exist yet.
        });
        watchers.push(w);
      } catch {
        // Root may not exist (e.g., runtimeRoot before first launch). Skip.
      }
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await runScan(true);
      if (opts.watch !== false) attachWatchers();
    },
    async rescan() {
      await runScan(false);
    },
    current() {
      return Array.from(items.values());
    },
    get(key) {
      return items.get(key);
    },
    dispose() {
      if (pendingRescan) {
        clearTimeout(pendingRescan);
        pendingRescan = undefined;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // best-effort
        }
      }
      watchers.length = 0;
    },
  };
}
