import { describe, expect, test } from "bun:test";
import { PluginFrontmatter } from "../index.ts";

const VALID = {
  description: "Distinctive frontend interfaces.",
  marketplace_source: "anthropics/claude-plugins-official",
  marketplace_name: "claude-plugins-official",
};

describe("PluginFrontmatter — valid fixtures (lenient superset)", () => {
  test("minimal required fields pass (no plugin_name)", () => {
    expect(PluginFrontmatter.safeParse(VALID).success).toBe(true);
  });

  test("with optional plugin_name passes", () => {
    expect(PluginFrontmatter.safeParse({ ...VALID, plugin_name: "frontend-design" }).success).toBe(true);
  });

  // The three my-agent-kits reference plugins must validate verbatim (regression
  // guard): they carry author-specific keys (`applyTo`, `added_in`) that ride
  // through passthrough.
  test("reference: frontend-design.plugin.md", () => {
    const fm = {
      description:
        "Distinctive, production-grade frontend interfaces — web components, landing pages, dashboards, React/HTML/CSS layouts.",
      applyTo: "**",
      added_in: "0.10.2",
      marketplace_source: "anthropics/claude-plugins-official",
      marketplace_name: "claude-plugins-official",
      plugin_name: "frontend-design",
    };
    expect(PluginFrontmatter.safeParse(fm).success).toBe(true);
  });

  test("reference: superpowers.plugin.md", () => {
    const fm = {
      description: "Agentic skills (TDD, debugging, brainstorming, planning, code review)",
      applyTo: "**",
      added_in: "0.2.0",
      marketplace_source: "anthropics/claude-plugins-official",
      marketplace_name: "claude-plugins-official",
      plugin_name: "superpowers",
    };
    expect(PluginFrontmatter.safeParse(fm).success).toBe(true);
  });

  test("reference: ui-ux-pro-max.plugin.md (third-party marketplace)", () => {
    const fm = {
      description:
        "Design intelligence skill — 50+ UI styles, 97 color palettes, 57 font pairings, 99 UX guidelines, 25 chart types across 9 stacks.",
      applyTo: "**",
      added_in: "0.10.2",
      marketplace_source: "nextlevelbuilder/ui-ux-pro-max-skill",
      marketplace_name: "ui-ux-pro-max-skill",
      plugin_name: "ui-ux-pro-max",
    };
    expect(PluginFrontmatter.safeParse(fm).success).toBe(true);
  });

  test("a URL marketplace_source passes (no org/repo regex)", () => {
    expect(
      PluginFrontmatter.safeParse({ ...VALID, marketplace_source: "https://example.com/market.git" }).success,
    ).toBe(true);
  });

  test("unknown keys are PRESERVED on the parsed object (passthrough, not stripped)", () => {
    const result = PluginFrontmatter.safeParse({ ...VALID, added_in: "0.1.0", upstream: "x" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data: Record<string, unknown> = result.data;
    expect(data.added_in).toBe("0.1.0");
    expect(data.upstream).toBe("x");
  });
});

describe("PluginFrontmatter — one invalid case per rule", () => {
  function reject(obj: unknown): { msg: string } | null {
    const result = PluginFrontmatter.safeParse(obj);
    if (result.success) return null;
    return { msg: result.error.issues.map((i) => `${i.message} ${i.path.join(".")}`).join(" | ") };
  }

  test("missing description", () => {
    const r = reject({ marketplace_source: VALID.marketplace_source, marketplace_name: VALID.marketplace_name });
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("description");
  });

  test("empty description", () => {
    expect(reject({ ...VALID, description: "" })).not.toBeNull();
  });

  test("missing marketplace_source — names the field", () => {
    const r = reject({ description: VALID.description, marketplace_name: VALID.marketplace_name });
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("marketplace_source");
  });

  test("empty marketplace_source", () => {
    expect(reject({ ...VALID, marketplace_source: "" })).not.toBeNull();
  });

  test("missing marketplace_name — names the field", () => {
    const r = reject({ description: VALID.description, marketplace_source: VALID.marketplace_source });
    expect(r).not.toBeNull();
    expect(r?.msg).toContain("marketplace_name");
  });

  test("empty marketplace_name", () => {
    expect(reject({ ...VALID, marketplace_name: "" })).not.toBeNull();
  });

  test("empty plugin_name (declared but blank)", () => {
    expect(reject({ ...VALID, plugin_name: "" })).not.toBeNull();
  });
});
