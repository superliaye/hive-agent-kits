import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginFrontmatter } from "@hive/capability-schema";
import { parse as yamlParse } from "yaml";
import { materializeMarketplacePlugins } from "../acquisition/marketplace.ts";

const REPO = "https://github.com/acme/stack";
const COMMIT = "c".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "hive-marketplace-"));
  roots.push(root);
  for (const [rel, value] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof value === "string" ? value : JSON.stringify(value));
  }
  return root;
}

function pointer(root: string, name: string): Record<string, unknown> {
  const content = readFileSync(join(root, "capabilities", "plugins", `${name}.plugin.md`), "utf8");
  const end = content.indexOf("\n---", 3);
  return yamlParse(content.slice(3, end)) as Record<string, unknown>;
}

const claudeMarket = (plugins: unknown[]) => ({ name: "stack", owner: { name: "acme" }, plugins });
const codexMarket = (plugins: unknown[]) => ({ name: "stack", plugins });

describe("marketplace Source ingestion", () => {
  test("a plugin listed by both marketplaces targets both CLIs and is managed", () => {
    const root = tree({
      ".claude-plugin/marketplace.json": claudeMarket([
        { name: "ye", source: "./plugins/ye", description: "Personal skills." },
      ]),
      ".agents/plugins/marketplace.json": codexMarket([
        { name: "ye", source: { source: "local", path: "./plugins/ye" } },
      ]),
    });

    materializeMarketplacePlugins(root, REPO, COMMIT);

    const fm = pointer(root, "ye");
    expect(PluginFrontmatter.safeParse(fm).success).toBe(true);
    expect(fm).toEqual({
      description: "Personal skills.",
      marketplace_source: REPO,
      marketplace_name: "stack",
      plugin_name: "ye",
      targets: ["claude", "codex"],
      managed_install: true,
      source_commit: COMMIT,
    });
  });

  test("targets follow the marketplace files that list each plugin", () => {
    const root = tree({
      ".claude-plugin/marketplace.json": claudeMarket([{ name: "claude-side", source: "./a" }]),
      ".agents/plugins/marketplace.json": codexMarket([
        { name: "codex-side", source: { source: "local", path: "./b" } },
      ]),
      "b/.codex-plugin/plugin.json": { name: "codex-side", description: "From the manifest." },
    });

    materializeMarketplacePlugins(root, REPO, COMMIT);

    expect(pointer(root, "claude-side")).toMatchObject({
      targets: ["claude"],
      description: "claude-side",
    });
    expect(pointer(root, "codex-side")).toMatchObject({
      targets: ["codex"],
      description: "From the manifest.",
    });
  });

  test("a capability kit is never treated as a marketplace", () => {
    const root = tree({
      ".claude-plugin/marketplace.json": claudeMarket([{ name: "ye", source: "./plugins/ye" }]),
      "capabilities/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\n",
    });

    materializeMarketplacePlugins(root, REPO, COMMIT);

    expect(existsSync(join(root, "capabilities", "plugins"))).toBe(false);
  });

  test("differing marketplace names ingest nothing", () => {
    const root = tree({
      ".claude-plugin/marketplace.json": claudeMarket([{ name: "ye", source: "./plugins/ye" }]),
      ".agents/plugins/marketplace.json": { name: "other", plugins: [{ name: "ye" }] },
    });

    materializeMarketplacePlugins(root, REPO, COMMIT);

    expect(existsSync(join(root, "capabilities"))).toBe(false);
  });

  test("a plugin name outside the capability name rules is skipped", () => {
    const root = tree({
      ".claude-plugin/marketplace.json": claudeMarket([
        { name: "Bad_Name", source: "./bad" },
        { name: "good", source: "./good" },
      ]),
    });

    materializeMarketplacePlugins(root, REPO, COMMIT);

    expect(existsSync(join(root, "capabilities", "plugins", "Bad_Name.plugin.md"))).toBe(false);
    expect(pointer(root, "good")).toMatchObject({ plugin_name: "good" });
  });

  test("a tree with no marketplace file is left unchanged", () => {
    const root = tree({ "README.md": "plain repository" });

    materializeMarketplacePlugins(root, REPO, COMMIT);

    expect(existsSync(join(root, "capabilities"))).toBe(false);
  });
});
