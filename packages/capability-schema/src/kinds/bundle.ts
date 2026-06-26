// Bundle capability schema — a wrapped upstream installer (ADR-0026). A
// `.bundle.md` frontmatter describes how to install an upstream toolkit into the
// CLI homes via one of two installers, discriminated on `installer.kind`:
//
//   - "setup-script": clone `source` at `pinned_commit`, run `installer.command`
//     (e.g. gstack). The discriminator is ABSENT in every existing fixture, so an
//     absent `installer.kind` defaults to "setup-script" (forced — the uneditable
//     gstack Source omits it).
//   - "npx-skills": invoke `npx skills add installer.package` (e.g. hyperframes).
//
// A LENIENT SUPERSET, strict only on the load-bearing coordinates:
//   - `description` required on both arms.
//   - setup-script requires `source` + `pinned_commit` (top-level) + `command`
//     (inside `installer`), all non-empty. `pinned_commit` is required for
//     reproducibility even though the clone command consumes `source`@`pinned_commit`
//     through the kit, not directly.
//   - npx-skills requires `installer.package` (non-empty).
//   - everything else (`requires`, `verify_paths`, `scope`, `installer.flags`,
//     `installer.host_flag_map`, `license`) is optional or rides through passthrough.
//
// CROSS-LEVEL INVARIANT: the discriminant (`kind`) lives INSIDE `installer`, while
// the conditionally-required `source`/`pinned_commit` live at the TOP level. So the
// discriminated union is built on the `installer` sub-object, and a bundle-level
// `.superRefine` — NOT a union arm — ties the top-level fields to the setup-script
// arm. A future edit must not migrate those requirements into the union (that would
// silently require them on npx-skills too).

import { z } from "zod";

const SetupScriptInstaller = z
  .object({
    kind: z.literal("setup-script"),
    command: z.string().min(1),
    flags: z.array(z.string()).optional(),
    host_flag_map: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough();

const NpxSkillsInstaller = z
  .object({
    kind: z.literal("npx-skills"),
    package: z.string().min(1),
  })
  .passthrough();

// Inject `kind ?? "setup-script"` on the raw installer object before the
// discriminated union runs, WITHOUT any/casts: narrow `unknown` via typeof to a
// `Record<string, unknown>` and default only an ABSENT `kind` (undefined/null). A
// present blank `kind: ""` is NOT defaulted — it falls through to the union and
// fails as an invalid discriminator, surfacing the malformed value rather than
// silently coercing it to setup-script.
const Installer = z.preprocess((raw) => {
  // Pass non-objects (including arrays) straight to the union so they surface as a
  // clean "expected object" error at the `installer` path, not a misleading
  // missing-field error from a spread-coerced shape.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  // `raw` is now narrowed to a non-null, non-array object; spreading reads its own
  // string keys into a fresh `Record<string, unknown>` with no cast.
  const obj: Record<string, unknown> = { ...raw };
  if (obj.kind === undefined || obj.kind === null) obj.kind = "setup-script";
  return obj;
}, z.discriminatedUnion("kind", [SetupScriptInstaller, NpxSkillsInstaller]));

export const BundleFrontmatter = z
  .object({
    description: z.string().min(1),
    source: z.string().min(1).optional(),
    pinned_commit: z.string().min(1).optional(),
    installer: Installer,
  })
  .passthrough()
  .superRefine((bundle, ctx) => {
    if (bundle.installer.kind !== "setup-script") return;
    if (typeof bundle.source !== "string" || bundle.source.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "setup-script bundle requires a non-empty source",
      });
    }
    if (typeof bundle.pinned_commit !== "string" || bundle.pinned_commit.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pinned_commit"],
        message: "setup-script bundle requires a non-empty pinned_commit",
      });
    }
  });
export type BundleFrontmatter = z.infer<typeof BundleFrontmatter>;
