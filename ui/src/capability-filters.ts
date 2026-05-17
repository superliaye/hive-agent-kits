// Filter + group helpers for the Capabilities page. Pure functions — no
// React, no fetch. The UI applies them to the in-memory CapabilityWire[]
// the daemon returns; with single-author personal scale the whole set is
// always small enough to filter client-side.
//
// Facet semantics: OR within a facet, AND across facets. Selecting two
// tag chips shows items matching either tag; selecting a tag chip AND
// a workspace chip shows items matching both.

import type { CapabilityWire } from "./api.ts";

// ── Workspace facet ──────────────────────────────────────────────────────
// Personal is the always-present default; each distinct workplaceId at the
// bundled layer is a separate workspace. UI hides the chip group when only
// one workspace value is present (the typical first-launch state today).

export type Workspace =
  | { kind: "personal" }
  | { kind: "workplace"; workplaceId: string };

export function workspaceKey(w: Workspace): string {
  return w.kind === "personal" ? "personal" : `workplace/${w.workplaceId}`;
}

export function workspaceLabel(w: Workspace): string {
  return w.kind === "personal" ? "personal" : w.workplaceId;
}

export function capabilityWorkspace(c: CapabilityWire): Workspace {
  if (c.origin === "personal") return { kind: "personal" };
  return { kind: "workplace", workplaceId: c.workplaceId ?? "unknown" };
}

// ── Source facet ─────────────────────────────────────────────────────────
// "Source" here means "where the manifest was vendored from" (the manifest's
// upstream pin), not the registry-discovery enum. Skills without an upstream
// pin (handwritten locals) collapse into a single "local" bucket.

export type SourceFacet = { kind: "local" } | { kind: "upstream"; slug: string };

export function sourceKey(s: SourceFacet): string {
  return s.kind === "local" ? "local" : s.slug;
}

export function sourceLabel(s: SourceFacet): string {
  return s.kind === "local" ? "local" : s.slug;
}

// github.com/heygen-com/hyperframes → heygen-com/hyperframes
// https://github.com/owner/repo/path → owner/repo
// Anything else → null (caller falls back to the raw URL).
//
// Character class is intentionally tight: alphanumerics + `.`, `_`, `-` —
// the exhaustive set of legal characters in GitHub/GitLab/Bitbucket owner
// and repo names. Anything outside this class (including `<`, `>`, spaces)
// fails the match, so manifests with junky urls never produce a slug that
// flows into a grouping key.
export function extractRepoSlug(url: string): string | null {
  const match = url.match(
    /^(?:https?:\/\/)?(?:github\.com|gitlab\.com|bitbucket\.org)\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/,
  );
  return match?.[1] ?? null;
}

export function capabilitySource(c: CapabilityWire): SourceFacet {
  if (!c.upstream) return { kind: "local" };
  const slug = extractRepoSlug(c.upstream.url) ?? c.upstream.url;
  return { kind: "upstream", slug };
}

// ── Facet extraction ─────────────────────────────────────────────────────

export type Facets = {
  tags: string[];
  workspaces: Workspace[];
  sources: SourceFacet[];
};

// Ordering rules — workspaces show `personal` first (the default home,
// largest bucket), workplaces alpha after. Sources show concrete upstream
// slugs alpha, then `local` last (the catch-all). Same ordering is used
// for both chip lists and grouped views.
function compareWorkspaces(a: Workspace, b: Workspace): number {
  if (a.kind === "personal") return b.kind === "personal" ? 0 : -1;
  if (b.kind === "personal") return 1;
  return a.workplaceId.localeCompare(b.workplaceId);
}

function compareSources(a: SourceFacet, b: SourceFacet): number {
  if (a.kind === "local") return b.kind === "local" ? 0 : 1;
  if (b.kind === "local") return -1;
  return a.slug.localeCompare(b.slug);
}

export function extractFacets(caps: readonly CapabilityWire[]): Facets {
  const tags = new Set<string>();
  const workspaceMap = new Map<string, Workspace>();
  const sourceMap = new Map<string, SourceFacet>();

  for (const c of caps) {
    for (const t of c.tags ?? []) tags.add(t);
    const w = capabilityWorkspace(c);
    workspaceMap.set(workspaceKey(w), w);
    const s = capabilitySource(c);
    sourceMap.set(sourceKey(s), s);
  }

  return {
    tags: Array.from(tags).sort(),
    workspaces: Array.from(workspaceMap.values()).sort(compareWorkspaces),
    sources: Array.from(sourceMap.values()).sort(compareSources),
  };
}

// ── Filtering ────────────────────────────────────────────────────────────

export type FilterState = {
  search: string;
  tags: ReadonlySet<string>;
  workspaces: ReadonlySet<string>; // keys from workspaceKey()
  sources: ReadonlySet<string>; // keys from sourceKey()
};

export const EMPTY_FILTER: FilterState = {
  search: "",
  tags: new Set(),
  workspaces: new Set(),
  sources: new Set(),
};

// True when any facet has a selection or search has any text. Single source
// of truth so callers don't drift on the predicate.
export function isFilterActive(f: FilterState): boolean {
  return (
    f.search.length > 0 ||
    f.tags.size > 0 ||
    f.workspaces.size > 0 ||
    f.sources.size > 0
  );
}

// Convenience: toggle a value in/out of one facet axis without callers
// having to spread/Set-construct manually.
export type FilterAxis = "tags" | "workspaces" | "sources";

export function toggleFilterValue(
  filter: FilterState,
  axis: FilterAxis,
  value: string,
): FilterState {
  const set = new Set(filter[axis]);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return { ...filter, [axis]: set };
}

export function applyFilter(
  caps: readonly CapabilityWire[],
  filter: FilterState,
): CapabilityWire[] {
  const q = filter.search.trim().toLowerCase();
  return caps.filter((c) => {
    if (q) {
      if (
        !c.name.toLowerCase().includes(q) &&
        !c.description.toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    if (filter.tags.size > 0) {
      const ts = c.tags ?? [];
      if (!ts.some((t) => filter.tags.has(t))) return false;
    }
    if (filter.workspaces.size > 0) {
      if (!filter.workspaces.has(workspaceKey(capabilityWorkspace(c)))) return false;
    }
    if (filter.sources.size > 0) {
      if (!filter.sources.has(sourceKey(capabilitySource(c)))) return false;
    }
    return true;
  });
}

// ── Grouping ─────────────────────────────────────────────────────────────

export type GroupKey = "none" | "source" | "tag" | "workspace";

export type Group = {
  label: string;
  items: CapabilityWire[];
};

export function groupCapabilities(
  caps: readonly CapabilityWire[],
  by: GroupKey,
): Group[] {
  if (by === "none") {
    return [{ label: "", items: [...caps] }];
  }

  const buckets = new Map<string, Group>();
  const order: string[] = [];

  function push(key: string, label: string, cap: CapabilityWire): void {
    let g = buckets.get(key);
    if (!g) {
      g = { label, items: [] };
      buckets.set(key, g);
      order.push(key);
    }
    g.items.push(cap);
  }

  for (const c of caps) {
    if (by === "source") {
      const s = capabilitySource(c);
      push(sourceKey(s), sourceLabel(s), c);
    } else if (by === "workspace") {
      const w = capabilityWorkspace(c);
      push(workspaceKey(w), workspaceLabel(w), c);
    } else {
      // by === "tag" — multi-bucketed when an item has multiple tags.
      const tags = c.tags ?? [];
      if (tags.length === 0) {
        push("__untagged", "(no tags)", c);
      } else {
        for (const t of tags) push(t, t, c);
      }
    }
  }

  order.sort((a, b) => {
    if (by === "workspace") {
      // `personal` first, workplaces alpha. Keys are `personal` or `workplace/<id>`.
      if (a === "personal") return b === "personal" ? 0 : -1;
      if (b === "personal") return 1;
      return a.localeCompare(b);
    }
    if (by === "source") {
      // upstream slugs alpha, `local` last.
      if (a === "local") return b === "local" ? 0 : 1;
      if (b === "local") return -1;
      return a.localeCompare(b);
    }
    // by === "tag" — "(no tags)" last, real tags alpha.
    if (a === "__untagged") return b === "__untagged" ? 0 : 1;
    if (b === "__untagged") return -1;
    return a.localeCompare(b);
  });

  return order.map((k) => buckets.get(k)!);
}
