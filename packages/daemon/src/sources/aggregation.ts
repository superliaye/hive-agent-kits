// AggregationService (ADR-0023:82) — the PURE Core of the multi-Source capability
// model. Merge-by-ContentSha + Source precedence → one winner Variant per
// CapabilityKey, the rest Shadowed. No I/O, no Effect, no filesystem: it is
// referentially transparent over (key, contentSha, sourceId, rank), so the
// precedence/merge/shadow rules are unit-testable without Layer plumbing (grill
// Q1 — a functional core in the Sources context, NOT a new Effect service Tag).
//
//   Variant — a distinct ContentSha under one CapabilityKey. Identical ContentSha
//             across N Sources = ONE Variant (a Merge, N Source labels). Different
//             ContentSha = separate Variants.
//   Winner  — among a key's Variants, the one whose highest-precedence Source
//             outranks every sibling's; it is `deployable`. Every other Variant is
//             `shadowed:true` (non-blocking duplicate).

import { serializeCapabilityKey } from "@hive/capability-schema";
import type { CapabilityKind, Source } from "@hive/contract";

// One parsed Capability tagged with its providing Source and its content hash.
// `contentSha:null` = its Mirror bytes went missing/unreadable between parse and
// hash (un-hashable — it cannot win with no readable bytes).
export type AggInput = {
  kind: CapabilityKind;
  name: string;
  sourceId: string;
  contentSha: string | null;
  resolvable: boolean;
  blockedReason?: string;
  description: string;
  group: string;
};

// One aggregated catalog entry (one Variant). Carries the #0 wire fields; the kit
// read path translates this 1:1 to a wire `CapabilityEntry`.
export type AggEntry = {
  kind: CapabilityKind;
  name: string;
  description: string;
  group: string;
  deployable: boolean;
  shadowed: boolean;
  sourceIds: string[];
  contentSha: string;
  blockedReason?: string;
};

// Assign a precedence rank per `source.id` (higher wins) from the DERIVED
// comparator (grill Q4), matching ADR-0023:67-68 registration-order:
//   - kind:"git" outranks kind:"local" (the Starter ranks lowest);
//   - among kind:"git", the LATER insertion index wins ("a newly-added Source
//     outranks existing ones").
// `sources` arrives in registration (insertion) order (the store appends). The
// array index — NOT `createdAt` (a coarse wall-clock ms stamp that can tie or
// invert under clock skew) — is the ADR's actual signal and a total deterministic
// order.
export function sourcePrecedence(sources: readonly Source[]): Map<string, number> {
  // Rank by a tuple (kindRank, insertionIndex). git=1 outranks local=0; within a
  // kind, later index ranks higher. A single dense integer encodes both: local
  // Sources occupy the low band, git Sources the high band, each ordered by index.
  const n = sources.length;
  const rank = new Map<string, number>();
  sources.forEach((s, idx) => {
    const kindBand = s.kind === "git" ? n : 0;
    rank.set(s.id, kindBand + idx);
  });
  return rank;
}

// Aggregate parsed inputs into winner+shadow Variant entries. `rank` is the
// precedence map (higher wins). Pure.
export function aggregate(
  inputs: readonly AggInput[],
  rank: ReadonlyMap<string, number>,
): AggEntry[] {
  const out: AggEntry[] = [];
  const participating: AggInput[] = [];

  // Pass 1 — blocked entries pass through (deployable:false, shadowed:false). A
  // non-resolvable input (single-Source malformed dup) OR a resolvable input with
  // a null ContentSha (un-hashable: its Mirror bytes went missing) neither wins nor
  // merges. A null-ContentSha input must NEVER win over a real-content Variant.
  for (const inp of inputs) {
    if (!inp.resolvable || inp.contentSha === null) {
      out.push({
        kind: inp.kind,
        name: inp.name,
        description: inp.description,
        group: inp.group,
        deployable: false,
        shadowed: false,
        sourceIds: [inp.sourceId],
        // A null-ContentSha (un-hashable) entry has no content identity; surface a
        // stable empty marker rather than a fake hash.
        contentSha: inp.contentSha ?? "",
        blockedReason:
          inp.blockedReason ?? (inp.contentSha === null ? "source bytes missing" : undefined),
      });
    } else {
      participating.push(inp);
    }
  }

  // Pass 2 — group the resolvable, hashable inputs by CapabilityKey.
  const byKey = new Map<string, AggInput[]>();
  for (const inp of participating) {
    const key = serializeCapabilityKey({ kind: inp.kind, name: inp.name });
    const arr = byKey.get(key) ?? [];
    arr.push(inp);
    byKey.set(key, arr);
  }

  for (const keyInputs of byKey.values()) {
    // Pass 3 — group by ContentSha → Variants. A non-null contentSha is guaranteed
    // here (participating inputs filtered nulls out).
    const byContent = new Map<string, AggInput[]>();
    for (const inp of keyInputs) {
      const sha = inp.contentSha;
      if (sha === null) continue; // unreachable; narrows the type
      const arr = byContent.get(sha) ?? [];
      arr.push(inp);
      byContent.set(sha, arr);
    }

    type Variant = { contentSha: string; providers: AggInput[]; topRank: number };
    const variants: Variant[] = [];
    const seenSource = new Set<string>();
    for (const [contentSha, providers] of byContent) {
      // Invariant: a Source provides exactly one ContentSha per CapabilityKey, so
      // each Source lands in exactly one Variant of a key. A Source seen in two
      // Variants is a bug — fail loudly (unit-tested).
      for (const p of providers) {
        if (seenSource.has(p.sourceId)) {
          throw new Error(
            `aggregate: Source ${p.sourceId} appears in two Variants of ${serializeCapabilityKey({
              kind: p.kind,
              name: p.name,
            })}`,
          );
        }
        seenSource.add(p.sourceId);
      }
      // Order providers winner-first (rank descending). An absent rank (a Source
      // not in the map) sorts lowest.
      const sorted = [...providers].sort(
        (a, b) => (rank.get(b.sourceId) ?? -1) - (rank.get(a.sourceId) ?? -1),
      );
      const top = sorted[0];
      if (!top) continue; // a ContentSha with no providers can't occur
      variants.push({
        contentSha,
        providers: sorted,
        topRank: rank.get(top.sourceId) ?? -1,
      });
    }

    // Pass 4 — the winning Variant: highest topRank across the key's Variants
    // (unique by the one-Source-per-Variant invariant). Deterministic final
    // tiebreak: lexicographically smallest contentSha, a defensive guard.
    variants.sort((a, b) => {
      if (b.topRank !== a.topRank) return b.topRank - a.topRank;
      return a.contentSha < b.contentSha ? -1 : a.contentSha > b.contentSha ? 1 : 0;
    });

    variants.forEach((variant, idx) => {
      const winner = idx === 0;
      const lead = variant.providers[0];
      if (!lead) return;
      out.push({
        kind: lead.kind,
        name: lead.name,
        description: lead.description,
        group: lead.group,
        deployable: winner,
        shadowed: !winner,
        sourceIds: variant.providers.map((p) => p.sourceId),
        contentSha: variant.contentSha,
      });
    });
  }

  return out;
}
