// Capability Registry factory per ADR-0007.
//
// Two-tier (bundled + runtime) with runtime > bundled resolution. Same-name
// collision at the bundled layer (personal vs workplace) is a load-time error.
// Hot-reload via node:fs.watch on both roots; rescans on debounced changes.

import { watch, type FSWatcher } from "node:fs";
import type { CapabilityKind } from "../lib/capability-types.ts";
import { bundledRoot, runtimeRoot } from "../lib/paths.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import { type LoaderResult, scanAll } from "./loader.ts";
import type { Capability, Registry, RegistryEvents, ResolutionAddress } from "./types.ts";

export class RegistryCollisionError extends Error {
  constructor(public readonly collisions: ReadonlyArray<ReadonlyArray<Capability>>) {
    const summary = collisions
      .map(
        (group) =>
          `${group[0]?.kind}:${group[0]?.name} (` +
          group
            .map((c) => `${c.origin}${c.workplaceId ? `/${c.workplaceId}` : ""}`)
            .join(" vs ") +
          ")",
      )
      .join("; ");
    super(`bundled-layer name collisions: ${summary}`);
    this.name = "RegistryCollisionError";
  }
}

export type CreateRegistryOptions = {
  // Override the scanner — used in tests to inject synthetic results.
  scanner?: () => LoaderResult;
  // Disable filesystem hot-reload watcher. Default true.
  watch?: boolean;
  // Forwarded to console.warn on malformed manifests. Default true; tests
  // can silence noise.
  logErrors?: boolean;
};

const RESCAN_DEBOUNCE_MS = 250;

function key(kind: CapabilityKind, name: string): string {
  return `${kind}:${name}`;
}

function resolve(loaded: Capability[]): {
  resolved: Map<string, Capability>;
  collisions: Capability[][];
} {
  type Bucket = { runtime?: Capability; bundled: Capability[] };
  const buckets = new Map<string, Bucket>();
  for (const cap of loaded) {
    const k = key(cap.kind, cap.name);
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = { bundled: [] };
      buckets.set(k, bucket);
    }
    if (cap.layer === "runtime") {
      bucket.runtime = cap;
    } else {
      bucket.bundled.push(cap);
    }
  }

  const resolved = new Map<string, Capability>();
  const collisions: Capability[][] = [];

  for (const [k, bucket] of buckets) {
    if (bucket.bundled.length > 1) {
      collisions.push(bucket.bundled);
      // Skip from resolved set — but allow a runtime entry to still win.
      if (bucket.runtime) {
        resolved.set(k, withShadows(bucket.runtime, bucket.bundled));
      }
      continue;
    }
    if (bucket.runtime) {
      resolved.set(k, withShadows(bucket.runtime, bucket.bundled));
    } else {
      const only = bucket.bundled[0];
      if (only) resolved.set(k, only);
    }
  }

  return { resolved, collisions };
}

function withShadows(winner: Capability, bundledGroup: Capability[]): Capability {
  if (bundledGroup.length === 0) return winner;
  const shadows: ResolutionAddress[] = bundledGroup.map((b) => ({
    layer: b.layer,
    origin: b.origin,
    workplaceId: b.workplaceId,
  }));
  return { ...winner, shadows };
}

function sameResolution(a: Capability, b: Capability): boolean {
  return (
    a.path === b.path &&
    a.origin === b.origin &&
    a.layer === b.layer &&
    a.workplaceId === b.workplaceId &&
    a.description === b.description
  );
}

export function createRegistry(opts: CreateRegistryOptions = {}): Registry {
  const events = new TypedEmitter<RegistryEvents>();
  const scanner = opts.scanner ?? scanAll;
  const logErrors = opts.logErrors ?? true;
  const enableWatch = opts.watch ?? true;

  let current = new Map<string, Capability>();
  const watchers: FSWatcher[] = [];
  let started = false;
  let pendingRescan: ReturnType<typeof setTimeout> | undefined;

  async function performScan(emitAsDiff: boolean): Promise<void> {
    const { capabilities, errors } = scanner();
    if (logErrors) {
      for (const e of errors) {
        console.warn(`[capabilities] skipped ${e.path}: ${e.message}`);
      }
    }
    const { resolved, collisions } = resolve(capabilities);
    if (collisions.length > 0) {
      const err = new RegistryCollisionError(collisions);
      // First scan: throw so the daemon refuses to start (ADR-0007 V#4).
      // Subsequent scans (hot-reload): log; the prior resolved map remains.
      if (!emitAsDiff) throw err;
      if (logErrors) console.warn(`[capabilities] ${err.message}`);
      return;
    }

    if (!emitAsDiff) {
      for (const cap of resolved.values()) {
        await events.emit("capability.registered", {
          name: cap.name,
          kind: cap.kind,
          origin: cap.origin,
          layer: cap.layer,
          source: cap.source,
          shadows: cap.shadows,
        });
      }
      current = resolved;
      return;
    }

    for (const [k, cap] of resolved) {
      const prior = current.get(k);
      if (!prior) {
        await events.emit("capability.registered", {
          name: cap.name,
          kind: cap.kind,
          origin: cap.origin,
          layer: cap.layer,
          source: cap.source,
          shadows: cap.shadows,
        });
      } else if (!sameResolution(prior, cap)) {
        await events.emit("capability.changed", {
          name: cap.name,
          kind: cap.kind,
          origin: cap.origin,
          layer: cap.layer,
        });
      }
    }
    for (const [k, prior] of current) {
      if (!resolved.has(k)) {
        await events.emit("capability.unregistered", {
          name: prior.name,
          kind: prior.kind,
          origin: prior.origin,
          layer: prior.layer,
        });
      }
    }
    current = resolved;
  }

  function scheduleRescan(): void {
    if (pendingRescan) clearTimeout(pendingRescan);
    pendingRescan = setTimeout(() => {
      pendingRescan = undefined;
      performScan(true).catch((err) => {
        if (logErrors) console.warn(`[capabilities] hot-reload error: ${err}`);
      });
    }, RESCAN_DEBOUNCE_MS);
  }

  function attachWatchers(): void {
    const roots = [bundledRoot(), runtimeRoot()];
    for (const root of roots) {
      try {
        // recursive works on macOS and Windows; on Linux it falls back per-dir
        // in newer Node. Wrap in try/catch — missing dirs are normal in dev.
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
    list(filter) {
      const all = Array.from(current.values());
      return filter?.kind ? all.filter((c) => c.kind === filter.kind) : all;
    },
    get(kind, name) {
      return current.get(key(kind, name));
    },
    async start() {
      if (started) return;
      started = true;
      await performScan(false);
      if (enableWatch) attachWatchers();
    },
    async rescan() {
      await performScan(true);
    },
    events,
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
