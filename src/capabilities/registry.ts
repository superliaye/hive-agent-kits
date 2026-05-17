// Capability Registry factory per ADR-0007.
//
// Two-tier (bundled + runtime) with runtime > bundled resolution. Same-name
// collision at the bundled layer (personal vs workplace) is a load-time error.
// Scan + watch + diff machinery lives in TieredManifestStore; this file owns
// the resolution rule, the typed event surface, and the public seam.

import type { CapabilityKind } from "../lib/capability-types.ts";
import { log } from "../lib/log.ts";
import { bundledRoot, runtimeRoot } from "../lib/paths.ts";
import { createTieredManifestStore } from "../lib/tiered-store.ts";
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
  // Forwarded to trace log on malformed manifests. Default true; tests can
  // silence noise.
  logErrors?: boolean;
};

function key(kind: CapabilityKind, name: string): string {
  return `${kind}:${name}`;
}

// Resolution rule: runtime shadows bundled; collisions at the bundled layer
// (personal vs workplace for the same name) are reported back so the caller
// can decide first-scan-fatal vs hot-reload-tolerant.
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

  const store = createTieredManifestStore<Capability>({
    watchRoots: [bundledRoot(), runtimeRoot()],
    watch: opts.watch,
    scan: () => {
      const { capabilities, errors } = scanner();
      const { resolved, collisions } = resolve(capabilities);
      if (collisions.length > 0) {
        // Throws on first scan (fatal); routed to onRescanError on rescan.
        throw new RegistryCollisionError(collisions);
      }
      return { items: Array.from(resolved.values()), errors };
    },
    key: (c) => key(c.kind, c.name),
    same: sameResolution,
    onLoaderError: logErrors
      ? (e) => log().warn({ module: "capabilities", path: e.path, err: e.message }, "skipped malformed manifest")
      : undefined,
    onRescanError: logErrors
      ? (err) => log().warn({ module: "capabilities", err: err.message }, "hot-reload error")
      : undefined,
    onDiff: async ({ added, removed, changed }) => {
      for (const c of added) {
        await events.emit("capability.registered", {
          name: c.name,
          kind: c.kind,
          origin: c.origin,
          layer: c.layer,
          source: c.source,
          shadows: c.shadows,
        });
      }
      for (const c of removed) {
        await events.emit("capability.unregistered", {
          name: c.name,
          kind: c.kind,
          origin: c.origin,
          layer: c.layer,
        });
      }
      for (const c of changed) {
        await events.emit("capability.changed", {
          name: c.name,
          kind: c.kind,
          origin: c.origin,
          layer: c.layer,
        });
      }
    },
  });

  return {
    list(filter) {
      const all = store.current();
      return filter?.kind ? all.filter((c) => c.kind === filter.kind) : all;
    },
    get(kind, name) {
      return store.get(key(kind, name));
    },
    start: () => store.start(),
    rescan: () => store.rescan(),
    events,
    dispose: () => store.dispose(),
  };
}
