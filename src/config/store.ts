// Reactive Config store per ADR-0006. Synchronous reads, validated writes,
// watch-with-initial-fire subscribe semantics.
//
// The store is generic over the schema shape `S` so tests can inject any
// schema. The production schema is `AppConfig` from ./schema.ts.

import type { ZodType } from "zod";
import { log } from "../lib/log.ts";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { ConfigPersistence } from "./persistence.ts";
import type { Config, ConfigChange, ConfigEvents } from "./types.ts";
import { deepEquals, deepMerge } from "./utils.ts";

export function createConfigStore<S extends Record<string, unknown>>(
  initial: S,
  schema: ZodType<S>,
  persistence?: ConfigPersistence,
): Config<S> & { dispose(): void } {
  let current: S = schema.parse(initial);
  const events = new TypedEmitter<ConfigEvents<S>>();

  // Serialize concurrent `set()` calls. Without this, two awaited sets
  // each snapshot `current` before either persistence.write lands, and
  // the second write clobbers the first key. Surfaced in /gstack-review
  // adversarial pass during the Appearance fold.
  let writeQueue: Promise<unknown> = Promise.resolve();

  const fileWatcherDispose = persistence?.watchExternal(() => {
    reloadFromDisk();
  });

  function get<K extends keyof S & string>(key: K): S[K] {
    return current[key];
  }

  async function set<K extends keyof S & string>(key: K, value: S[K]): Promise<void> {
    // Queue behind any in-flight write. Snapshotting `current` AFTER the
    // queue drains is what guarantees no last-writer-wins clobber.
    const run = async (): Promise<void> => {
      const proposed = { ...current, [key]: value } as S;
      // Validate the proposed next state as a whole — catches cross-field
      // constraints if the schema has any.
      schema.parse(proposed);

      const previous = current[key];
      if (deepEquals(previous, value)) return;

      if (persistence) {
        persistence.write(proposed);
      }
      current = proposed;

      await events.emit("change", {
        key,
        previous,
        current: value,
        source: "set",
      });
    };
    const next = writeQueue.then(run, run);
    // Keep the chain alive even if this call rejects, so subsequent writes
    // still run. Each call gets its own promise to await. Log failures
    // to trace so dropped writes are diagnosable — the original error
    // still surfaces to the awaited `next` promise for the caller.
    writeQueue = next.catch((err) => {
      log().warn({ module: "config", key, err: String(err) }, "config.set failed");
    });
    return next;
  }

  function watch<K extends keyof S & string>(key: K, listener: (value: S[K]) => void): () => void {
    // Initial fire — eliminates the "init from current state, then subscribe"
    // two-step every caller would otherwise repeat.
    listener(current[key]);
    return events.on("change", (change) => {
      if (change.key === key) listener(change.current as S[K]);
    });
  }

  function reloadFromDisk(): void {
    if (!persistence) return;
    try {
      const raw = persistence.read();
      const merged = deepMerge(current, raw);
      const validated = schema.parse(merged);

      const changes: ConfigChange<S>[] = [];
      for (const key of Object.keys(validated) as Array<keyof S & string>) {
        if (!deepEquals(current[key], validated[key])) {
          changes.push({
            key,
            previous: current[key],
            current: validated[key],
            source: "external",
          });
        }
      }
      if (changes.length === 0) return;

      current = validated;
      // Fire-and-forget: file-watcher callbacks can't await. Listener errors
      // surface to the unhandled-rejection handler (Pino in production).
      for (const change of changes) {
        void events.emit("change", change);
      }
    } catch (err) {
      // Bad external edit — keep current in-memory state. Trace channel
      // captures the rejection; the user sees their edit didn't take.
      log().error({ module: "config", err: String(err) }, "external edit rejected");
    }
  }

  function dispose(): void {
    fileWatcherDispose?.();
  }

  return { get, set, watch, dispose, events };
}
