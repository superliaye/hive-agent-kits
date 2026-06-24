// In-memory store for the Sources registry.
//
// The store holds the Source list. Persistence (when in "file" mode) is
// injected — the store calls `persist.write(...)` after every mutation. The
// Effect service (`effect/sources-live.ts`) wraps these verbs in the typed
// error channel and owns the audit emitter; the store itself stays plain (an
// I/O edge), mirroring the secrets store's plain core.

import type { Source } from "@hive/contract";
import { normalizeOrigin, SOURCES_FILE_VERSION, type SourcesFile } from "./types.ts";

// The narrow persistence port the store needs: just commit a file snapshot.
// `SourcesPersistence` satisfies this structurally; tests can supply a plain
// stub without a cast.
export type SourcesWriter = { write(file: SourcesFile): void };

export type AddResult = { ok: true; source: Source } | { ok: false; reason: "duplicate" };
export type MutateResult = { ok: true; source: Source } | { ok: false; reason: "not-found" };
export type DeleteResult = { ok: true } | { ok: false; reason: "not-found" };

export type SourcesStore = {
  list(): readonly Source[];
  add(origin: string): AddResult;
  activate(id: string): MutateResult;
  deactivate(id: string): MutateResult;
  delete(id: string): DeleteResult;
  snapshot(): SourcesFile;
};

export type MintId = () => string;

export function createSourcesStore(
  initial: SourcesFile,
  persist?: SourcesWriter,
  mintId: MintId = () => crypto.randomUUID(),
  now: () => number = Date.now,
): SourcesStore {
  const sources: Source[] = [...initial.sources];

  function snapshot(): SourcesFile {
    return { version: SOURCES_FILE_VERSION, sources: [...sources] };
  }

  // Persist the candidate state BEFORE committing it to the in-memory array, so
  // a write fault (the persist call throws) leaves memory and disk consistent
  // (both unchanged) rather than mutating memory and diverging from disk until
  // the next restart silently reloads the old file.
  function commit(next: Source[]): void {
    if (persist) persist.write({ version: SOURCES_FILE_VERSION, sources: next });
    sources.splice(0, sources.length, ...next);
  }

  function setActive(id: string, active: boolean): MutateResult {
    const idx = sources.findIndex((s) => s.id === id);
    if (idx === -1) return { ok: false, reason: "not-found" };
    const next = sources.map((s) => ({ ...s }));
    const target = next[idx];
    if (!target) return { ok: false, reason: "not-found" };
    target.active = active;
    commit(next);
    return { ok: true, source: { ...target } };
  }

  return {
    list() {
      return sources.map((s) => ({ ...s }));
    },

    add(origin) {
      const normalized = normalizeOrigin(origin);
      const exists = sources.some((s) => normalizeOrigin(s.origin) === normalized);
      if (exists) return { ok: false, reason: "duplicate" };
      const source: Source = {
        id: mintId(),
        origin: normalized,
        active: true,
        createdAt: now(),
      };
      commit([...sources, source]);
      return { ok: true, source: { ...source } };
    },

    activate: (id) => setActive(id, true),
    deactivate: (id) => setActive(id, false),

    delete(id) {
      const idx = sources.findIndex((s) => s.id === id);
      if (idx === -1) return { ok: false, reason: "not-found" };
      commit(sources.filter((s) => s.id !== id));
      return { ok: true };
    },

    snapshot,
  };
}
