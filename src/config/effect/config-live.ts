// Effect-native Config module (ADR-0011, Phase 3a).
//
// Phase-3a decisions baked in:
//   - C1: SubscriptionRef<S> is the reactive state cell; its `.changes` Stream
//     is exposed for a future Effect-native watch (Phase 4) but NOT consumed
//     yet. watch() and the audit event stream stay on the store's TypedEmitter,
//     which alone carries {key, previous, current, source} — SubscriptionRef
//     .changes is whole-S, current-first, with no previous/source.
//   - C2: the store's writeQueue serialization + deep-equals no-op are kept.
//   - C3: the legacy `ConfigResource` lifecycle tag is module-internal and
//     non-generic ({dispose}); the generic ConfigSvc<S> is returned through
//     `configRuntime`'s closure, so S is never erased onto that nominal tag. The
//     shared `Config` tag below fixes S = AppConfig at definition, so root
//     composition (Phase 4) retrieves a typed ConfigSvc<AppConfig> straight off
//     the tag — no closure holder, no cast.

import { Context, Effect, Layer, ManagedRuntime, type Stream, SubscriptionRef } from "effect";
import type { ZodType } from "zod";
import { ConfigPersistence } from "../persistence.ts";
import type { AppConfig } from "../schema.ts";
import { createConfigStore } from "../store.ts";
import type { Config as ConfigSurface, CreateConfigOptions } from "../types.ts";
import { deepMerge } from "../utils.ts";

export type ConfigSvc<S extends Record<string, unknown>> = ConfigSurface<S> & {
  /** Reactive state stream for future Effect-native consumers (Phase 4). */
  changes: Stream.Stream<S>;
  dispose(): void;
};

// Non-generic lifecycle resource owned by the ManagedRuntime. The typed
// ConfigSvc<S> is handed back through `configRuntime`'s closure, never through
// this tag (decision C3).
class ConfigResource extends Context.Service<ConfigResource, { dispose(): void }>()(
  "config/ConfigResource",
) {}

function loadOrSeed<S>(persistence: ConfigPersistence, defaults: S, schema: ZodType<S>): S {
  if (!persistence.exists()) {
    persistence.write(defaults);
    return defaults;
  }
  const raw = persistence.read();
  const merged = deepMerge(defaults, raw);
  return schema.parse(merged);
}

function buildConfigSvc<S extends Record<string, unknown>>(
  opts: CreateConfigOptions<S>,
): ConfigSvc<S> {
  let store: ConfigSurface<S> & { dispose(): void; snapshot(): S };
  if (opts.mode === "memory") {
    store = createConfigStore(opts.initial, opts.schema);
  } else {
    const persistence = new ConfigPersistence(opts.path);
    store = createConfigStore(
      loadOrSeed(persistence, opts.defaults, opts.schema),
      opts.schema,
      persistence,
    );
  }

  // The SubscriptionRef is the reactive state cell, kept in lockstep with the
  // store's validated `current` via the change stream (set/setPath/reload).
  const ref = Effect.runSync(SubscriptionRef.make(store.snapshot()));
  const unsubscribe = store.events.on("change", () => {
    Effect.runSync(SubscriptionRef.set(ref, store.snapshot()));
  });

  return {
    get: store.get,
    set: store.set,
    setPath: store.setPath,
    watch: store.watch,
    events: store.events,
    changes: SubscriptionRef.changes(ref),
    dispose: () => {
      unsubscribe();
      store.dispose();
    },
  };
}

// Shared tag for root composition (Phase 4). S is fixed to AppConfig at the tag
// definition, so the service VALUE type is the concrete ConfigSvc<AppConfig> —
// the generic is carried, not erased onto the nominal tag. Root consumers
// `yield* Config` and read `cfg.get("daemon").httpPort` typed `number`, with no
// closure holder and no cast (uniform with HiveDb fixing its handle type).
export class Config extends Context.Service<Config, ConfigSvc<AppConfig>>()("config/Config") {}

export function ConfigLive(opts: CreateConfigOptions<AppConfig>): Layer.Layer<Config> {
  return Layer.effect(
    Config,
    Effect.acquireRelease(
      Effect.sync(() => buildConfigSvc(opts)),
      (svc) => Effect.sync(() => svc.dispose()),
    ),
  );
}

// Build the Config service and a ManagedRuntime that owns its disposal (uniform
// with Secrets/HiveDb). The generic ConfigSvc<S> is preserved via the closure
// holder rather than retrieved through the non-generic ConfigResource tag.
export function configRuntime<S extends Record<string, unknown>>(
  opts: CreateConfigOptions<S>,
): { svc: ConfigSvc<S>; dispose: () => void } {
  const holder: { svc?: ConfigSvc<S> } = {};
  const layer = Layer.effect(
    ConfigResource,
    Effect.acquireRelease(
      Effect.sync(() => {
        const svc = buildConfigSvc(opts);
        holder.svc = svc;
        return { dispose: svc.dispose };
      }),
      (resource) => Effect.sync(() => resource.dispose()),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  // Force the synchronous acquire so `holder.svc` is set and disposal is
  // registered with the runtime's scope.
  runtime.runSync(ConfigResource);
  if (!holder.svc) {
    throw new Error("config: ConfigLive layer failed to initialize");
  }
  return {
    svc: holder.svc,
    dispose: () => {
      void runtime.dispose();
    },
  };
}
