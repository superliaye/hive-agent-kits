// Sources module — disk file schema for the Hive-private Source registry.
//
// On-disk format (`~/.hive/sources.json`):
//
//   { "version": 3, "sources": [ { id, origin, kind, active, createdAt, rank }, ... ] }
//
// Zod-validated at the disk boundary (AGENTS.md: "Zod at every external
// boundary"). `version` is for schema migrations. The `Source` shape itself is
// the wire DTO from `@hive/contract` — the disk store reuses it verbatim.

import { Source, type SourceLocator } from "@hive/contract";
import { z } from "zod";

// Bumped to 3 when `Source` gained `rank` (#51, the stored precedence signal).
// Greenfield (no users): a file at any other version is discarded and re-seeded
// (see persistence.read), not migrated — no rank back-fill code.
export const SOURCES_FILE_VERSION = 4;

export const SourcesFileSchema = z.object({
  version: z.literal(SOURCES_FILE_VERSION),
  revision: z.number().int().nonnegative(),
  sources: z.array(Source),
});

export type SourcesFile = z.infer<typeof SourcesFileSchema>;

// A minimal probe over just `version` — read FIRST so a stale-version file can be
// told apart from a same-version corrupt file. `version` in SourcesFileSchema is a
// `z.literal`, so a stale v1 file and a v2-but-garbage file both fail the SAME
// full parse and are indistinguishable by catching the throw; this dedicated
// schema makes the distinction without any cast.
export const SourcesFileVersionProbe = z.object({ version: z.number() });

// ---- Audit events (source: 'sources') ----
//
// Source add/activate/deactivate/delete/reorder are user actions, so each emits
// one audit event. Payloads are refs-only — the opaque SourceId, plus the (already
// normalized, credential-free) origin on add, plus the new rank on reorder. A
// registry mutation has neither a Run nor an Agent, so run_id/agent_id are null at
// the normalizer.
export type SourcesAuditEvents = {
  "source.added": { id: string; origin: string };
  "source.activated": { id: string };
  "source.deactivated": { id: string };
  "source.removed": { id: string };
  "source.reordered": { id: string; rank: number };
};

// Normalize an origin for storage / duplicate comparison so that clones of the
// same repo collapse to one entry: lowercase the scheme + host (both
// case-insensitive; the path is left as-is, significant on some forges), strip a
// trailing `.git`, and strip any trailing slashes. `https://x/y`,
// `https://X/y/`, `https://x/y.git`, and `https://x/y//` all become the same
// origin for the duplicate check. Falls back to a plain string strip if the
// input doesn't parse as a URL (the wire schema already rejects non-URLs, but
// the store must not throw on a malformed persisted value).
export function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  let s = trimmed;
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    s = url.toString();
  } catch {
    // Not a URL — normalize the raw string below.
  }
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function normalizeSubpath(subpath: string): string {
  if (subpath === ".") return subpath;
  return subpath.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function normalizeLocator(locator: SourceLocator): SourceLocator {
  switch (locator.kind) {
    case "starter":
      return locator;
    case "git":
      return {
        ...locator,
        repoUrl: normalizeOrigin(locator.repoUrl),
        subpath: normalizeSubpath(locator.subpath),
      };
    case "working-tree":
      return {
        ...locator,
        repoRoot: locator.repoRoot.replace(/\/+$/, "") || "/",
        subpath: normalizeSubpath(locator.subpath),
      };
  }
}

export function locatorIdentity(locator: SourceLocator): string {
  const normalized = normalizeLocator(locator);
  switch (normalized.kind) {
    case "starter":
      return "starter";
    case "git":
      return `git\u0000${normalized.repoUrl}\u0000${JSON.stringify(normalized.revision)}\u0000${normalized.subpath}`;
    case "working-tree":
      return `working-tree\u0000${normalized.repoRoot}\u0000${normalized.subpath}`;
  }
}
