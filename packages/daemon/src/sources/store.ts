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
// Seeding a local Source is idempotent: a duplicate fixed id no-ops (the Starter
// is the sole minter of its well-known id).
export type SeedLocalResult = { ok: true; source: Source } | { ok: false; reason: "duplicate-id" };

export type SourcesStore = {
  list(): readonly Source[];
  // The public add path — always a `git` Source (the add route is git-only).
  add(origin: string): AddResult;
  // Register a bundled `local` Source with a caller-supplied fixed id. A SYSTEM
  // action (not the audited user `add`). Idempotent on the id, so a re-seed
  // after the file already carries it is a clean no-op, never a duplicate row.
  seedLocal(id: string, origin: string): SeedLocalResult;
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
        kind: "git",
        active: true,
        createdAt: now(),
      };
      commit([...sources, source]);
      return { ok: true, source: { ...source } };
    },

    seedLocal(id, origin) {
      // Idempotent on the fixed id — never normalize/dedupe by origin (a local
      // origin is a non-URL sentinel, not a git URL).
      if (sources.some((s) => s.id === id)) return { ok: false, reason: "duplicate-id" };
      const source: Source = {
        id,
        origin,
        kind: "local",
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
