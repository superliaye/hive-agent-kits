/**
 * Capability filter + group helpers — pure functions, sub-millisecond.
 */

import { describe, expect, test } from "bun:test";
import type { CapabilityWire } from "../api.ts";
import {
  applyFilter,
  capabilitySource,
  capabilityWorkspace,
  EMPTY_FILTER,
  extractFacets,
  extractRepoSlug,
  groupCapabilities,
  sourceKey,
  workspaceKey,
} from "../capability-filters.ts";

function cap(overrides: Partial<CapabilityWire> & { name: string }): CapabilityWire {
  return {
    kind: "skill",
    description: `desc ${overrides.name}`,
    origin: "personal",
    layer: "bundled",
    discovery: "filesystem",
    ...overrides,
  };
}

describe("extractRepoSlug", () => {
  test("github short form", () => {
    expect(extractRepoSlug("github.com/heygen-com/hyperframes")).toBe(
      "heygen-com/hyperframes",
    );
  });
  test("github full URL", () => {
    expect(extractRepoSlug("https://github.com/mattpocock/skills")).toBe(
      "mattpocock/skills",
    );
  });
  test("github URL with path", () => {
    expect(
      extractRepoSlug("https://github.com/owner/repo/blob/main/README.md"),
    ).toBe("owner/repo");
  });
  test("non-github URL returns null", () => {
    expect(extractRepoSlug("https://example.com/foo/bar")).toBeNull();
  });
  test("gitlab URL works", () => {
    expect(extractRepoSlug("gitlab.com/owner/repo")).toBe("owner/repo");
  });
  test("bitbucket URL works", () => {
    expect(extractRepoSlug("https://bitbucket.org/owner/repo")).toBe("owner/repo");
  });
  test("rejects junk characters in slug (tightened regex)", () => {
    // Tightened char class — anything outside [A-Za-z0-9._-] must not match.
    expect(extractRepoSlug("github.com/<script>/x")).toBeNull();
    expect(extractRepoSlug("github.com/owner/<img>")).toBeNull();
    expect(extractRepoSlug("github.com/with spaces/repo")).toBeNull();
  });
});

describe("capabilityWorkspace", () => {
  test("personal", () => {
    expect(capabilityWorkspace(cap({ name: "x" }))).toEqual({ kind: "personal" });
  });
  test("workplace with id", () => {
    expect(
      capabilityWorkspace(
        cap({ name: "x", origin: "workplace", workplaceId: "acme" }),
      ),
    ).toEqual({ kind: "workplace", workplaceId: "acme" });
  });
});

describe("capabilitySource", () => {
  test("no upstream → local", () => {
    expect(capabilitySource(cap({ name: "x" }))).toEqual({ kind: "local" });
  });
  test("github upstream → slug", () => {
    expect(
      capabilitySource(
        cap({ name: "x", upstream: { url: "github.com/heygen-com/hyperframes", ref: "0.6.14" } }),
      ),
    ).toEqual({ kind: "upstream", slug: "heygen-com/hyperframes" });
  });
});

describe("extractFacets", () => {
  test("dedupes and sorts tags, workspaces, sources", () => {
    const caps = [
      cap({ name: "a", tags: ["zeta", "alpha"] }),
      cap({ name: "b", tags: ["alpha"] }),
      cap({
        name: "c",
        origin: "workplace",
        workplaceId: "acme",
        upstream: { url: "github.com/heygen-com/hyperframes", ref: "1" },
      }),
      cap({ name: "d", upstream: { url: "github.com/mattpocock/skills", ref: "1" } }),
    ];
    const f = extractFacets(caps);
    expect(f.tags).toEqual(["alpha", "zeta"]);
    // personal first, workplaces alpha after.
    expect(f.workspaces.map(workspaceKey)).toEqual(["personal", "workplace/acme"]);
    // upstream slugs alpha, then `local` last.
    expect(f.sources.map(sourceKey)).toEqual([
      "heygen-com/hyperframes",
      "mattpocock/skills",
      "local",
    ]);
  });
});

describe("applyFilter", () => {
  const caps = [
    cap({ name: "alpha-thing", tags: ["a", "b"] }),
    cap({ name: "beta-thing", tags: ["b"] }),
    cap({ name: "gamma", tags: ["c"], origin: "workplace", workplaceId: "acme" }),
    cap({
      name: "delta",
      upstream: { url: "github.com/x/y", ref: "1" },
    }),
  ];

  test("empty filter returns everything", () => {
    expect(applyFilter(caps, EMPTY_FILTER)).toHaveLength(4);
  });

  test("search hits name", () => {
    expect(
      applyFilter(caps, { ...EMPTY_FILTER, search: "alpha" }).map((c) => c.name),
    ).toEqual(["alpha-thing"]);
  });

  test("search hits description", () => {
    expect(
      applyFilter(caps, { ...EMPTY_FILTER, search: "desc gamma" }).map((c) => c.name),
    ).toEqual(["gamma"]);
  });

  test("tags facet is OR within", () => {
    expect(
      applyFilter(caps, {
        ...EMPTY_FILTER,
        tags: new Set(["a", "c"]),
      }).map((c) => c.name),
    ).toEqual(["alpha-thing", "gamma"]);
  });

  test("facets are AND across", () => {
    expect(
      applyFilter(caps, {
        ...EMPTY_FILTER,
        tags: new Set(["b"]),
        workspaces: new Set(["personal"]),
      }).map((c) => c.name),
    ).toEqual(["alpha-thing", "beta-thing"]);
  });

  test("workspace filter selects workplace", () => {
    expect(
      applyFilter(caps, {
        ...EMPTY_FILTER,
        workspaces: new Set(["workplace/acme"]),
      }).map((c) => c.name),
    ).toEqual(["gamma"]);
  });

  test("source filter selects upstream", () => {
    expect(
      applyFilter(caps, {
        ...EMPTY_FILTER,
        sources: new Set(["x/y"]),
      }).map((c) => c.name),
    ).toEqual(["delta"]);
  });

  test("search is case-insensitive", () => {
    // `caps` includes alpha-thing, beta-thing, gamma, delta. Uppercased query
    // must still match the lowercased name.
    expect(
      applyFilter(caps, { ...EMPTY_FILTER, search: "ALPHA" }).map((c) => c.name),
    ).toEqual(["alpha-thing"]);
  });
});

describe("groupCapabilities", () => {
  const caps = [
    cap({ name: "a", tags: ["arch"] }),
    cap({ name: "b", tags: ["arch", "debug"] }),
    cap({ name: "c", tags: ["debug"] }),
    cap({ name: "d" }), // untagged
    cap({
      name: "e",
      upstream: { url: "github.com/x/y", ref: "1" },
    }),
  ];

  test("none → single empty-label group with everything", () => {
    const g = groupCapabilities(caps, "none");
    expect(g).toHaveLength(1);
    expect(g[0]?.label).toBe("");
    expect(g[0]?.items).toHaveLength(5);
  });

  test("by source → upstreams first, local at the end", () => {
    const g = groupCapabilities(caps, "source");
    expect(g.map((x) => x.label)).toEqual(["x/y", "local"]);
    expect(g[0]?.items.map((c) => c.name)).toEqual(["e"]);
    expect(g[1]?.items.map((c) => c.name)).toEqual(["a", "b", "c", "d"]);
  });

  test("by tag → multi-bucketed, '(no tags)' last", () => {
    const g = groupCapabilities(caps, "tag");
    const labels = g.map((x) => x.label);
    expect(labels).toEqual(["arch", "debug", "(no tags)"]);
    expect(g[0]?.items.map((c) => c.name)).toEqual(["a", "b"]);
    expect(g[1]?.items.map((c) => c.name)).toEqual(["b", "c"]);
    // Both `d` (no tags field) and `e` (upstream pin but no tags) are untagged.
    expect(g[2]?.items.map((c) => c.name)).toEqual(["d", "e"]);
  });

  test("by workspace with only personal → one group", () => {
    const g = groupCapabilities(caps, "workspace");
    expect(g).toHaveLength(1);
    expect(g[0]?.label).toBe("personal");
  });

  test("by workspace with multiple workplaces → personal first, workplaces alpha", () => {
    const multi = [
      cap({ name: "p1" }), // personal
      cap({ name: "p2" }), // personal
      cap({ name: "w-zeta", origin: "workplace", workplaceId: "zeta" }),
      cap({ name: "w-acme", origin: "workplace", workplaceId: "acme" }),
    ];
    const g = groupCapabilities(multi, "workspace");
    expect(g.map((x) => x.label)).toEqual(["personal", "acme", "zeta"]);
    expect(g[0]?.items.map((c) => c.name)).toEqual(["p1", "p2"]);
  });
});
