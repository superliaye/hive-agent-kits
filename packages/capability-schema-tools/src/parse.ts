// Lenient parse over a SourceTree — the resilient read model. Never throws: a
// malformed frontmatter yields an empty description (the leaf still loads), a
// within-kind leaf-name collision marks every colliding member not-resolvable.
//
// Format-native field names: `resolvable` / `collisionReason` are the format-level
// "this leaf-name is uniquely resolvable within its kind" property — NOT the
// daemon's deploy vocabulary (`deployable` / `blockedReason`). The daemon adapter
// translates across that anti-corruption seam.

import { type CapabilityKind, CapabilityKind as CapabilityKindSchema } from "@hive/capability-schema";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import type { SourceTree } from "./source-tree.ts";
import { enumerateLeaves } from "./walk.ts";

export const ParsedCapability = z.object({
  kind: CapabilityKindSchema,
  name: z.string(),
  description: z.string(),
  group: z.string(),
  resolvable: z.boolean(),
  collisionReason: z.string().optional(),
});
export type ParsedCapability = z.infer<typeof ParsedCapability>;

export const Problem = z.object({
  kind: z.string(),
  name: z.string(),
  problem: z.string(),
});
export type Problem = z.infer<typeof Problem>;

export const ParsedCatalog = z.object({
  capabilities: z.array(ParsedCapability),
  problems: z.array(Problem),
});
export type ParsedCatalog = z.infer<typeof ParsedCatalog>;

// Lenient frontmatter parse — never throws; returns {} on malformed input.
function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = yamlParse(content.slice(3, end).trim());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

type RawEntry = {
  kind: CapabilityKind;
  name: string;
  description: string;
  group: string;
};

export function parse(tree: SourceTree): ParsedCatalog {
  const walk = enumerateLeaves(tree);
  const problems: Problem[] = [...walk.problems];

  const raw: RawEntry[] = walk.leaves.map((leaf) => ({
    kind: leaf.kind,
    name: leaf.name,
    description: asString(parseFrontmatter(leaf.markerContent ?? "").description),
    group: leaf.group,
  }));

  const capabilities = withCollisions(raw, problems);
  return { capabilities, problems };
}

// Within-kind collisions: when ≥2 entries share (kind,name), all are marked
// not-resolvable (a hard block downstream, never silent overwrite). The problem
// text is kept verbatim so the wire problem is byte-identical to the daemon's.
function withCollisions(raw: RawEntry[], problems: Problem[]): ParsedCapability[] {
  const counts = new Map<string, number>();
  for (const e of raw) {
    const key = `${e.kind}:${e.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return raw.map((e) => {
    const key = `${e.kind}:${e.name}`;
    const collides = (counts.get(key) ?? 0) > 1;
    if (collides) {
      problems.push({
        kind: e.kind,
        name: e.name,
        problem: "within-kind leaf-name collision — un-deployable",
      });
    }
    return {
      kind: e.kind,
      name: e.name,
      description: e.description,
      group: e.group,
      resolvable: !collides,
      ...(collides ? { collisionReason: "duplicate leaf name within kind" } : {}),
    };
  });
}
