// Binding resolution (slice F2): an Agent's `bindings.skills` -> the actual
// Skill capabilities, resolved against the in-memory Capability Registry at
// Run start. Pure plumbing — no executor or UI coupling.
//
// Two consumers share this one port:
//   - N3 (progressive disclosure) reads `name` + `description` to surface
//     one-line skill listings, then pulls `body` on `load_skill`.
//   - C3 (capability projection) uses `path` + `origin` to copy each bound
//     skill's files into a Hive-owned location.
//
// A bound name with no resolved Skill entry — unknown, removed since the
// Harness was authored, or malformed-and-skipped by the loader — is collected
// into `missing` and trace-logged. It is never a thrown error: a stale binding
// must not crash a Run.

import { Context, Effect, Layer } from "effect";
import type { Origin } from "../../lib/capability-types.ts";
import { log } from "../../lib/log.ts";
import type { Registry } from "../types.ts";

// A bound skill resolved against the Registry. `path` is the skill's SKILL.md
// manifest; C3 copies its containing directory.
export type ResolvedSkill = {
  name: string;
  description: string;
  body: string;
  path: string;
  origin: Origin;
};

export type SkillResolution = {
  // Resolved skills in binding order, de-duplicated by name.
  resolved: readonly ResolvedSkill[];
  // Bound names with no resolved Skill entry. Trace-logged; never fatal.
  missing: readonly string[];
};

export type BindingResolverSvc = {
  // Resolution never fails: misses are data, not errors (E = never).
  resolveSkills(skillNames: readonly string[]): Effect.Effect<SkillResolution>;
};

export class BindingResolver extends Context.Service<BindingResolver, BindingResolverSvc>()(
  "capabilities/BindingResolver",
) {}

// The slice of the Registry the resolver reads. Narrow by construction: the
// resolver only looks skills up by name — it never lists, watches, or disposes.
export type SkillRegistry = Pick<Registry, "get">;

function makeResolver(registry: SkillRegistry): BindingResolverSvc {
  return {
    resolveSkills: (skillNames) =>
      Effect.sync(() => {
        const resolved: ResolvedSkill[] = [];
        const missing: string[] = [];
        const seen = new Set<string>();
        for (const name of skillNames) {
          if (seen.has(name)) continue;
          seen.add(name);
          const cap = registry.get("skill", name);
          if (cap?.kind === "skill") {
            resolved.push({
              name: cap.name,
              description: cap.description,
              body: cap.body,
              path: cap.path,
              origin: cap.origin,
            });
          } else {
            missing.push(name);
          }
        }
        if (missing.length > 0) {
          log().warn({ module: "capabilities", missing }, "unresolved skill bindings skipped");
        }
        return { resolved, missing };
      }),
  };
}

export function BindingResolverLive(registry: SkillRegistry): Layer.Layer<BindingResolver> {
  return Layer.succeed(BindingResolver, makeResolver(registry));
}
