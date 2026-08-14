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
  normalizeOrigin,
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
// Reorder is a total-order swap. An unknown id is not-found. `changed` tells a
// genuine swap (ranks moved + persisted) apart from a no-op (already at the
// requested end) so the audited service emits an audit row only for a real
// mutation — never for a no-op that wrote nothing.
export type ReorderResult =
  | { ok: true; changed: boolean; source: Source }
  | { ok: false; reason: "not-found" };
export type ReorderDirection = "up" | "down";
// Seeding a local Source is idempotent: a duplicate fixed id no-ops (the Starter
// is the sole minter of its well-known id).
export type SeedLocalResult = { ok: true; source: Source } | { ok: false; reason: "duplicate-id" };

export type SourcesStore = {
  list(): readonly Source[];
  // The public add path — always a `git` Source (the add route is git-only).
  add(input: string | AddSourceInput): AddResult;
  // Register a bundled `local` Source with a caller-supplied fixed id. A SYSTEM
  // action (not the audited user `add`). Idempotent on the id, so a re-seed
  // after the file already carries it is a clean no-op, never a duplicate row.
  seedLocal(id: string, origin: string): SeedLocalResult;
  activate(id: string): MutateResult;
  deactivate(id: string): MutateResult;
  delete(id: string): DeleteResult;
  // Raise ("up") or lower ("down") a Source one precedence step by swapping its
  // stored rank with its adjacent neighbor in rank order. A free total order — the
  // swap may cross kinds (the local Starter above a git Source). A swap at the end
  // in the requested direction is a no-op (returns the unchanged Source).
  reorder(id: string, direction: ReorderDirection): ReorderResult;
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
  let revision = initial.revision;

  function snapshot(): SourcesFile {
    return { version: SOURCES_FILE_VERSION, revision, sources: [...sources] };
  }

  // Persist the candidate state BEFORE committing it to the in-memory array, so
  // a write fault (the persist call throws) leaves memory and disk consistent
  // (both unchanged) rather than mutating memory and diverging from disk until
  // the next restart silently reloads the old file.
  function commit(next: Source[]): void {
    const nextRevision = revision + 1;
    if (persist)
      persist.write({ version: SOURCES_FILE_VERSION, revision: nextRevision, sources: next });
    sources.splice(0, sources.length, ...next);
    revision = nextRevision;
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

  // The next rank for a new Source: max(existing ranks)+1, so each add becomes the
  // new highest precedence (and an empty registry's first seed is rank 0).
  function nextRank(): number {
    if (sources.length === 0) return 0;
    return Math.max(...sources.map((s) => s.rank)) + 1;
  }

  return {
    list() {
      return sources.map((s) => ({ ...s }));
    },

    add(input) {
      const canonical: AddSourceInput =
        typeof input === "string"
          ? {
              label: normalizeOrigin(input),
              locator: {
                kind: "git",
                repoUrl: normalizeOrigin(input),
                revision: { mode: "track", ref: "refs/heads/main" },
                subpath: ".",
              },
            }
          : input;
      const locator = normalizeLocator(canonical.locator) as Exclude<
        SourceLocator,
        { kind: "starter" }
      >;
      const exists = sources.some((s) => locatorIdentity(s.locator) === locatorIdentity(locator));
      if (exists) return { ok: false, reason: "duplicate" };
      const origin = locator.kind === "git" ? locator.repoUrl : locator.repoRoot;
      const source: Source = {
        id: mintId(),
        label: canonical.label,
        locator,
        origin,
        kind: locator.kind === "git" ? "git" : "local",
        active: true,
        createdAt: now(),
        rank: nextRank(),
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
        label: origin,
        locator: { kind: "starter" },
        origin,
        kind: "local",
        active: true,
        createdAt: now(),
        rank: nextRank(),
      };
      commit([...sources, source]);
      return { ok: true, source: { ...source } };
    },

    activate: (id) => setActive(id, true),
    deactivate: (id) => setActive(id, false),

    reorder(id, direction) {
      if (!sources.some((s) => s.id === id)) return { ok: false, reason: "not-found" };
      // Order by stored rank ascending, id-tiebroken so adjacency is defined
      // identically to the UI's rank-desc+id sort (robust to any duplicate-rank
      // input, which normal max+1 minting never produces). The neighbor to swap
      // with is the next one up ("up" = toward higher precedence) or down. At the
      // end in that direction there is no neighbor → a clean no-op.
      const ordered = [...sources].sort((a, b) =>
        a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const pos = ordered.findIndex((s) => s.id === id);
      const neighborPos = direction === "up" ? pos + 1 : pos - 1;
      const self = ordered[pos];
      const neighbor = ordered[neighborPos];
      if (!self) return { ok: false, reason: "not-found" };
      if (!neighbor) return { ok: true, changed: false, source: { ...self } };
      const next = sources.map((s) => {
        if (s.id === self.id) return { ...s, rank: neighbor.rank };
        if (s.id === neighbor.id) return { ...s, rank: self.rank };
        return { ...s };
      });
      commit(next);
      const updated = next.find((s) => s.id === id);
      // `updated` is always present (id was found above); guard for the typechecker.
      if (!updated) return { ok: false, reason: "not-found" };
      return { ok: true, changed: true, source: { ...updated } };
    },

    delete(id) {
      const idx = sources.findIndex((s) => s.id === id);
      if (idx === -1) return { ok: false, reason: "not-found" };
      commit(sources.filter((s) => s.id !== id));
      return { ok: true };
    },

    snapshot,
  };
}
