// Source wire contract — the daemon↔UI types for the Sources bounded context
// (ADR-0023). A Source is a located collection of Capabilities the user has added.
// Zod only — daemon-independent, so the UI bundles it without dragging Effect/
// Hono in. The Source DTO uses no capability-schema types.

import { ConformanceError } from "@hive/capability-schema";
import { z } from "zod";
import { RecipeSummary, SourceSyncStatus } from "./kit.ts";

const SafeRelativeSubpath = z.string().refine(
  (value) => {
    if (value === ".") return true;
    if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
    const segments = value.split("/");
    return segments.every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("-"),
    );
  },
  { message: "subpath must be '.' or a traversal-free relative POSIX path" },
);

const GitHttpsUrl = z
  .string()
  .url()
  .refine(
    (s) => {
      let parsed: URL;
      try {
        parsed = new URL(s);
      } catch {
        return false;
      }
      return (
        parsed.protocol === "https:" &&
        parsed.hostname.length > 0 &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === ""
      );
    },
    {
      message:
        "repository URL must be https with a host and no embedded credentials, query, or fragment",
    },
  );

const TrackedGitRef = z
  .string()
  .regex(
    /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/,
    "tracked ref must be a safe fully-qualified branch or tag ref",
  );

const GitSourceLocator = z
  .object({
    kind: z.literal("git"),
    repoUrl: GitHttpsUrl,
    revision: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("track"), ref: TrackedGitRef }).strict(),
      z.object({ mode: z.literal("pin"), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
    ]),
    subpath: SafeRelativeSubpath,
  })
  .strict();
const WorkingTreeSourceLocator = z
  .object({
    kind: z.literal("working-tree"),
    repoRoot: z.string().min(1),
    subpath: SafeRelativeSubpath,
  })
  .strict();

// `starter`: a kit bundled inside Hive's repository, which only the dev fixture
// Sources use. Users add git and working-tree Sources.
export const SourceLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starter") }).strict(),
  GitSourceLocator,
  WorkingTreeSourceLocator,
]);
export type SourceLocator = z.infer<typeof SourceLocator>;

// A tracked Source. `id` is a stable opaque identity (a uuid), decoupled from
// `origin` (the git URL can change). `active` toggles whether the Source
// participates in sync/aggregation. `locator.kind` selects the authoritative
// transport; the legacy `kind` field remains a display compatibility seam.
// `rank` is the stored precedence signal (ADR-0023): higher wins a cross-Source
// collision. Each add takes the new highest rank, so the newest Source wins,
// without a runtime kind-band. `createdAt` is NOT the precedence signal.
export const Source = z.object({
  id: z.string(),
  label: z.string().min(1).max(160),
  locator: SourceLocator,
  // Compatibility display fields while the existing catalog page moves to the
  // locator-native Overview. Acquisition and duplicate identity never use them.
  origin: z.string(),
  kind: z.enum(["git", "local"]),
  active: z.boolean(),
  createdAt: z.number().int(),
  rank: z.number().int(),
});
export type Source = z.infer<typeof Source>;

// Session-facing Source projection. Locators and compatibility origins stay on
// the Daemon because working-tree locators contain absolute machine paths.
export const SourceSummary = Source.pick({
  id: true,
  label: true,
  kind: true,
  active: true,
  createdAt: true,
  rank: true,
});
export type SourceSummary = z.infer<typeof SourceSummary>;

const PastedSourceBody = z
  .object({
    label: z.string().min(1).max(160),
    locator: z.discriminatedUnion("kind", [
      GitSourceLocator.extend({
        revision: z.union([
          GitSourceLocator.shape.revision,
          z.object({ mode: z.literal("track"), ref: z.literal("HEAD") }).strict(),
        ]),
      }),
      WorkingTreeSourceLocator,
    ]),
  })
  .strict();

// POST /api/sources body: a pasted locator, or a Tile id whose label and
// locator the Daemon supplies. A pasted body cannot name a Tile.
export const AddSourceBody = z.union([
  PastedSourceBody,
  z.object({ tile: z.string().min(1) }).strict(),
]);
export type AddSourceBody = z.infer<typeof AddSourceBody>;
export type PastedSourceInput = z.infer<typeof PastedSourceBody>;
export type AddSourceInput = {
  label: string;
  locator: Exclude<SourceLocator, { kind: "starter" }>;
};

// One shelf entry for GET /api/tiles. `url` is the repository's web page at the
// Tile's ref and subpath. `sourceId` is the Source whose locator is this Tile's,
// or null.
export const TileSummary = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  url: z.string().url(),
  recipe: RecipeSummary,
  sourceId: z.string().nullable(),
});
export type TileSummary = z.infer<typeof TileSummary>;

// The conformance report produced when a Source is synced + validated on add.
// `conformant` is the strict-validate verdict; `errors` are the located
// violations (the hoisted SSOT shape — @hive/capability-schema). `capabilityCount`
// counts EVERY enumerated capability leaf (resolvable AND non-resolvable), so 0
// honestly means "no capability-shaped content found" — the soft "empty repo"
// signal, never a rejection.
export const SourceValidationReport = z.object({
  conformant: z.boolean(),
  errors: z.array(ConformanceError),
  capabilityCount: z.number().int(),
});
export type SourceValidationReport = z.infer<typeof SourceValidationReport>;

// POST /api/sources 201 body: the kept Source plus a point-in-time snapshot
// of the add-time sync (reusing the per-Source freshness wire shape) and the
// conformance report. A sync or validation failure is FOLDED HERE — the add is
// never rejected for it. `sync` is the same `SourceSyncStatus` GET
// /api/kit/state re-derives from disk; a later read may report a different
// errorReason (e.g. `no_mirror`) for the same failed add — both mean failure.
export const AddSourceResult = z.object({
  source: SourceSummary,
  sync: SourceSyncStatus,
  validation: SourceValidationReport,
});
export type AddSourceResult = z.infer<typeof AddSourceResult>;
