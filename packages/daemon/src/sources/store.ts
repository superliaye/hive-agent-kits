// In-memory store for the Sources registry.
//
// The store holds the Source list. Persistence (when in "file" mode) is
// injected — the store calls `persist.write(...)` after every mutation. The
// Effect service (`effect/sources-live.ts`) wraps these verbs in the typed
// error channel and owns the audit emitter; the store itself stays plain (an
// I/O edge), mirroring the secrets store's plain core.

import type { AddSourceInput, Source, SourceLocator } from "@hive/contract";
import {
  locatorIdentity,
  normalizeLocator,
  SOURCES_FILE_VERSION,
  type SourcesFile,
} from "./types.ts";

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
export type PreparedSourceMutation<Result> = {
  result: Result;
  commit(): Result;
};

export type SourcesStore = {
  list(): readonly Source[];
  prepareAdd(input: AddSourceInput): PreparedSourceMutation<AddResult>;
  add(input: AddSourceInput): AddResult;
  // Register a bundled `local` Source with a caller-supplied fixed id. Idempotent
  // on the id, so a re-seed after the file already carries it is a clean no-op,
  // never a duplicate row.
  prepareSeedLocal(id: string, origin: string): PreparedSourceMutation<SeedLocalResult>;
  seedLocal(id: string, origin: string): SeedLocalResult;
  prepareActivate(id: string): PreparedSourceMutation<MutateResult>;
  activate(id: string): MutateResult;
  prepareDeactivate(id: string): PreparedSourceMutation<MutateResult>;
  deactivate(id: string): MutateResult;
  prepareDelete(id: string): PreparedSourceMutation<DeleteResult>;
  delete(id: string): DeleteResult;
  snapshot(): SourcesFile;
};

export type MintId = () => string;

function cloneLocator(locator: SourceLocator): SourceLocator {
  switch (locator.kind) {
    case "starter":
      return { kind: "starter" };
    case "git":
      return { ...locator, revision: { ...locator.revision } };
    case "working-tree":
      return { ...locator };
  }
}

function cloneSource(source: Source): Source {
  return { ...source, locator: cloneLocator(source.locator) };
}

function cloneSources(sources: readonly Source[]): Source[] {
  return sources.map(cloneSource);
}

export function createSourcesStore(
  initial: SourcesFile,
  persist?: SourcesWriter,
  mintId: MintId = () => crypto.randomUUID(),
  now: () => number = Date.now,
): SourcesStore {
  const sources: Source[] = cloneSources(initial.sources);
  let revision = initial.revision;

  function snapshot(): SourcesFile {
    return { version: SOURCES_FILE_VERSION, revision, sources: cloneSources(sources) };
  }

  // Persist the candidate state BEFORE committing it to the in-memory array, so
  // a write fault (the persist call throws) leaves memory and disk consistent
  // (both unchanged) rather than mutating memory and diverging from disk until
  // the next restart silently reloads the old file.
  function commit(next: Source[]): void {
    const nextRevision = revision + 1;
    if (persist)
      persist.write({
        version: SOURCES_FILE_VERSION,
        revision: nextRevision,
        sources: cloneSources(next),
      });
    sources.splice(0, sources.length, ...cloneSources(next));
    revision = nextRevision;
  }

  function unchanged<Result>(result: Result): PreparedSourceMutation<Result> {
    return { result, commit: () => result };
  }

  function prepared<Result>(next: Source[], result: Result): PreparedSourceMutation<Result> {
    const expectedRevision = revision;
    let committed = false;
    return {
      result,
      commit: () => {
        if (committed) return result;
        if (revision !== expectedRevision) {
          throw new Error("source registry changed before prepared mutation committed");
        }
        commit(next);
        committed = true;
        return result;
      },
    };
  }

  function prepareSetActive(id: string, active: boolean): PreparedSourceMutation<MutateResult> {
    const idx = sources.findIndex((s) => s.id === id);
    if (idx === -1) return unchanged({ ok: false, reason: "not-found" });
    const next = cloneSources(sources);
    const target = next[idx];
    if (!target) return unchanged({ ok: false, reason: "not-found" });
    target.active = active;
    return prepared(next, { ok: true, source: cloneSource(target) });
  }

  // The next rank for a new Source: max(existing ranks)+1, so each add becomes the
  // new highest precedence (and an empty registry's first seed is rank 0).
  function nextRank(): number {
    if (sources.length === 0) return 0;
    return Math.max(...sources.map((s) => s.rank)) + 1;
  }

  function prepareAdd(input: AddSourceInput): PreparedSourceMutation<AddResult> {
    const locator = cloneLocator(normalizeLocator(input.locator)) as Exclude<
      SourceLocator,
      { kind: "starter" }
    >;
    const exists = sources.some((s) => locatorIdentity(s.locator) === locatorIdentity(locator));
    if (exists) return unchanged({ ok: false, reason: "duplicate" });
    const origin = locator.kind === "git" ? locator.repoUrl : locator.repoRoot;
    const source: Source = {
      id: mintId(),
      label: input.label,
      locator,
      origin,
      kind: locator.kind === "git" ? "git" : "local",
      active: true,
      createdAt: now(),
      rank: nextRank(),
    };
    return prepared([...sources, source], { ok: true, source: cloneSource(source) });
  }

  function prepareSeedLocal(id: string, origin: string): PreparedSourceMutation<SeedLocalResult> {
    // Idempotent on the fixed id — never normalize/dedupe by origin (a local
    // origin is a non-URL sentinel, not a git URL).
    if (sources.some((s) => s.id === id)) return unchanged({ ok: false, reason: "duplicate-id" });
    const source: Source = {
      id,
      label: origin,
      locator: { kind: "starter" },
      origin,
      kind: "local",
      active: true,
      createdAt: now(),
      rank: nextRank(),
    };
    return prepared([...sources, source], { ok: true, source: cloneSource(source) });
  }

  function prepareDelete(id: string): PreparedSourceMutation<DeleteResult> {
    const idx = sources.findIndex((s) => s.id === id);
    if (idx === -1) return unchanged({ ok: false, reason: "not-found" });
    return prepared(
      sources.filter((s) => s.id !== id),
      { ok: true },
    );
  }

  return {
    list() {
      return cloneSources(sources);
    },

    prepareAdd,
    add: (input) => prepareAdd(input).commit(),

    prepareSeedLocal,
    seedLocal: (id, origin) => prepareSeedLocal(id, origin).commit(),

    prepareActivate: (id) => prepareSetActive(id, true),
    activate: (id) => prepareSetActive(id, true).commit(),
    prepareDeactivate: (id) => prepareSetActive(id, false),
    deactivate: (id) => prepareSetActive(id, false).commit(),

    prepareDelete,
    delete: (id) => prepareDelete(id).commit(),

    snapshot,
  };
}
