// Source wire contract — the daemon↔UI types for the Sources bounded context
// (ADR-0023). A Source is a git repository of Capabilities the user has added.
// Zod only — daemon-independent, so the UI bundles it without dragging Effect/
// Hono in. The Source DTO uses no capability-schema types.

import { ConformanceError } from "@hive/capability-schema";
import { z } from "zod";
import { SourceSyncStatus } from "./kit.ts";

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
  .regex(/^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/, "tracked ref must be a safe fully-qualified branch or tag ref");

export const SourceLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starter") }).strict(),
  z
    .object({
      kind: z.literal("git"),
      repoUrl: GitHttpsUrl,
      revision: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("track"), ref: TrackedGitRef }).strict(),
        z.object({ mode: z.literal("pin"), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
      ]),
      subpath: SafeRelativeSubpath,
    })
    .strict(),
  z
    .object({
      kind: z.literal("working-tree"),
      repoRoot: z.string().min(1),
      subpath: SafeRelativeSubpath,
    })
    .strict(),
]);
export type SourceLocator = z.infer<typeof SourceLocator>;

// A tracked Source. `id` is a stable opaque identity (a uuid), decoupled from
// `origin` (the git URL can change). `active` toggles whether the Source
// participates in sync/aggregation. `locator.kind` selects the authoritative
// transport; the legacy `kind` field remains a display compatibility seam.
// `rank` is the stored precedence signal (ADR-0023): higher wins a cross-Source
// collision. It is a FREE total order — the user may re-rank any Source above any
// other (the Starter above a git Source is allowed). The default SEED reproduces
// "user-added git > local Starter, newest-first" (Starter lowest, each add the new
// highest) without a runtime kind-band. `createdAt` is NOT the precedence signal.
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

export const AddSourceBody = z
  .object({
    label: z.string().min(1).max(160),
    locator: SourceLocator.refine((locator) => locator.kind !== "starter", {
      message: "the built-in Starter cannot be added",
    }),
  })
  .strict();
export type AddSourceBody = z.infer<typeof AddSourceBody>;
export type AddSourceInput = { label: string; locator: Exclude<SourceLocator, { kind: "starter" }> };

// POST /api/sources/:id/reorder body: raise ("up") or lower ("down") a Source one
// precedence step. The only re-rank control (decision: move-up/down buttons, not
// drag-and-drop). A free total order — the swap may cross kinds.
export const ReorderSourceBody = z.object({
  direction: z.enum(["up", "down"]),
});
export type ReorderSourceBody = z.infer<typeof ReorderSourceBody>;

// The conformance report produced when a Source is synced + validated on add
// (#33). `conformant` is the strict-validate verdict; `errors` are the located
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

// POST /api/sources 201 body (#33): the kept Source plus a point-in-time snapshot
// of the add-time sync (reusing the per-Source freshness wire shape) and the
// conformance report. A sync or validation failure is FOLDED HERE — the add is
// never rejected for it (Q2/Q3). `sync` is the same `SourceSyncStatus` GET
// /api/kit/state re-derives from disk; a later read may report a different
// errorReason (e.g. `no_mirror`) for the same failed add — both mean failure.
export const AddSourceResult = z.object({
  source: Source,
  sync: SourceSyncStatus,
  validation: SourceValidationReport,
});
export type AddSourceResult = z.infer<typeof AddSourceResult>;
