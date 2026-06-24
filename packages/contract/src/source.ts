// Source wire contract — the daemon↔UI types for the Sources bounded context
// (ADR-0023). A Source is a git repository of Capabilities the user has added.
// Zod only — daemon-independent, so the UI bundles it without dragging Effect/
// Hono in. The Source DTO uses no capability-schema types.

import { z } from "zod";

// A tracked Source. `id` is a stable opaque identity (a uuid), decoupled from
// `origin` (the git URL can change). `active` toggles whether the Source
// participates in sync/aggregation. `kind` distinguishes a remote `git` Source
// (synced over the network) from the bundled `local` Starter Source (copied from
// the in-repo package, no network) — the public add route only ever mints `git`.
export const Source = z.object({
  id: z.string(),
  origin: z.string(),
  kind: z.enum(["git", "local"]),
  active: z.boolean(),
  createdAt: z.number().int(),
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
