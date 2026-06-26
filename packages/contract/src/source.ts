// Source wire contract — the daemon↔UI types for the Sources bounded context
// (ADR-0023). A Source is a git repository of Capabilities the user has added.
// Zod only — daemon-independent, so the UI bundles it without dragging Effect/
// Hono in. The Source DTO uses no capability-schema types.

import { ConformanceError } from "@hive/capability-schema";
import { z } from "zod";
import { SourceSyncStatus } from "./kit.ts";

// A tracked Source. `id` is a stable opaque identity (a uuid), decoupled from
// `origin` (the git URL can change). `active` toggles whether the Source
// participates in sync/aggregation. `kind` distinguishes a remote `git` Source
// (synced over the network) from the bundled `local` Starter Source (copied from
// the in-repo package, no network) — the public add route only ever mints `git`.
// `rank` is the stored precedence signal (ADR-0023): higher wins a cross-Source
// collision. It is a FREE total order — the user may re-rank any Source above any
// other (the Starter above a git Source is allowed). The default SEED reproduces
// "user-added git > local Starter, newest-first" (Starter lowest, each add the new
// highest) without a runtime kind-band. `createdAt` is NOT the precedence signal.
export const Source = z.object({
  id: z.string(),
  origin: z.string(),
  kind: z.enum(["git", "local"]),
  active: z.boolean(),
  createdAt: z.number().int(),
  rank: z.number().int(),
});
export type Source = z.infer<typeof Source>;

// Restrict an add to https git URLs. `git@`/ssh origins are out of scope for
// this slice (a later sync issue may add them); reject mailto:/ftp:/non-clonable
// schemes. The registry normalizes before storing/comparing (strip trailing `/`
// and `.git`), so this only fixes the accepted shape.
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
      // https only, with a host, and no embedded credentials — the origin is
      // persisted and echoed back over the wire, so a `user:token@` URL would
      // leak a secret into ~/.hive/sources.json and the Source DTO.
      return (
        parsed.protocol === "https:" &&
        parsed.hostname.length > 0 &&
        parsed.username === "" &&
        parsed.password === ""
      );
    },
    { message: "origin must be an https URL with a host and no embedded credentials" },
  );

export const AddSourceBody = z.object({
  origin: GitHttpsUrl,
});
export type AddSourceBody = z.infer<typeof AddSourceBody>;

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
