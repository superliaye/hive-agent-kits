// Reactive Config store per ADR-0006. Synchronous reads, validated writes,
// watch-with-initial-fire subscribe semantics.
//
// The store is generic over the schema shape `S` so tests can inject any
// schema. The production schema is `AppConfig` from ./schema.ts.

import type { ZodType } from "zod";
import { TypedEmitter } from "../lib/typed-emitter.ts";
import type { ConfigPersistence } from "./persistence.ts";
import type { Config, ConfigChange, ConfigEvents } from "./types.ts";
import { deepEquals, deepMerge } from "./utils.ts";

export function createConfigStore<S extends Record<string, unknown>>(
  initial: S,
  schema: ZodType<S>,
  persistence?: ConfigPersistence,
): Config<S> & { dispose(): void; events: TypedEmitter<ConfigEvents<S>> } {
  let current: S = schema.parse(initial);
  const events = new TypedEmitter<ConfigEvents<S>>();

  const fileWatcherDispose = persistence?.watchExternal(() => {
    reloadFromDisk();
  });

  function get<K extends keyof S & string>(key: K): S[K] {
    return current[key];
  }

  async function set<K extends keyof S & string>(key: K, value: S[K]): Promise<void> {
    // Validate the proposed next state as a whole — catches cross-field
    // constraints if the schema has any.
    const proposed = { ...current, [key]: value } as S;
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
      // Bad external edit — keep current in-memory state. Pino will log
      // once we wire it up; for now, surface via console.
      // eslint-disable-next-line no-console
      console.error("[config] external edit rejected:", err);
    }
  }

  function dispose(): void {
    fileWatcherDispose?.();
  }

  return { get, set, watch, dispose, events };
}
