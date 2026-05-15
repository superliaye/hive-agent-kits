// Atomic YAML persistence + file watcher with self-write suppression.
// Per ADR-0006. Storage format is YAML for human editability.

import {
  type FSWatcher,
  existsSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

export class ConfigPersistence {
  // Window after a self-write during which incoming file-change events are
  // ignored — prevents the watcher from re-triggering on our own writes.
  // Generous enough to survive a debounced write + fsync cycle.
  private static readonly SUPPRESS_MS = 200;
  private lastSelfWriteAt = 0;

  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): unknown {
    const raw = readFileSync(this.path, "utf-8");
    return parse(raw);
  }

  write(value: unknown): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const yaml = stringify(value);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, yaml, "utf-8");
    renameSync(tmp, this.path);
    this.lastSelfWriteAt = Date.now();
  }

  // Returns a disposer. Fires `onExternalChange` only for events that occur
  // more than SUPPRESS_MS after the most recent self-write.
  watchExternal(onExternalChange: () => void): () => void {
    let watcher: FSWatcher;
    try {
      watcher = watch(this.path, (eventType) => {
        if (eventType !== "change") return;
        if (Date.now() - this.lastSelfWriteAt < ConfigPersistence.SUPPRESS_MS) return;
        onExternalChange();
      });
    } catch {
      // If the file doesn't exist or watch isn't supported on this platform,
      // degrade gracefully — config still works without external-edit reload.
      return () => {};
    }
    return () => {
      watcher.close();
    };
  }
}
