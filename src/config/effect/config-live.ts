// Effect-native Config module (ADR-0011, Phase 3a).
//
// Phase-3a decisions baked in:
//   - C1: SubscriptionRef<S> is the reactive state cell; its `.changes` Stream
//     is exposed for a future Effect-native watch (Phase 4) but NOT consumed
//     yet. watch() and the audit event stream stay on the store's TypedEmitter,
//     which alone carries {key, previous, current, source} — SubscriptionRef
//     .changes is whole-S, current-first, with no previous/source.
//   - C2: the store's writeQueue serialization + deep-equals no-op are kept.
//   - C3: the lifecycle tag is module-internal and non-generic ({dispose}); the
//     typed ConfigSvc<S> is returned via closure, so S is never erased onto a
//     nominal tag.

import { Context, Effect, Layer, ManagedRuntime, type Stream, SubscriptionRef } from "effect";
import type { ZodType } from "zod";
import { ConfigPersistence } from "../persistence.ts";
import { createConfigStore } from "../store.ts";
import type { Config, CreateConfigOptions } from "../types.ts";
import { deepMerge } from "../utils.ts";

export type ConfigSvc<S extends Record<string, unknown>> = Config<S> & {
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
  let store: Config<S> & { dispose(): void; snapshot(): S };
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

// Build the Config service and a ManagedRuntime that owns its disposal (uniform
// with Secrets/HiveDb). The generic ConfigSvc<S> is preserved via the closure
// holder rather than retrieved through the non-generic tag.
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
